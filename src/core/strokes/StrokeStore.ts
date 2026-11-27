import type { AABB, Point, StrokePoint } from '../geometry/geometry';
import { boundsOfPoints, eraserHitsStroke, translatePoints, unionBounds } from '../geometry/geometry';
import type { CompositeHistoryManager } from '../history/CompositeHistoryManager';
import { newCommandId } from '../history/CompositeHistoryManager';

export type StrokeTool = 'pencil' | 'highlighter';
export type PenType = 'fountain-sharp' | 'fountain-flat' | 'ballpoint' | 'pencil' | 'brush';

export interface Stroke {
  id: string;
  tool: StrokeTool;
  penType?: PenType;
  color: string;
  size: number;
  points: StrokePoint[];
  /** 1-based page number for page-indexed storage and incremental rendering */
  pageNumber?: number;
}

export interface PageYRange {
  pageNumber: number;
  minY: number;
  maxY: number;
}

type Listener = () => void;
type PageChangeListener = (changedPages: number[]) => void;

const EMPTY_PAGE_STROKES: Stroke[] = [];

let strokeCounter = 0;
export function newStrokeId(): string {
  strokeCounter++;
  return `s-${Date.now().toString(36)}-${strokeCounter}-${Math.random().toString(36).slice(2, 6)}`;
}

export function strokeBounds(s: Stroke): AABB {
  const b = boundsOfPoints(s.points);
  const pad = s.size / 2;
  return { minX: b.minX - pad, minY: b.minY - pad, maxX: b.maxX + pad, maxY: b.maxY + pad };
}

const strokeBoundsCache = new WeakMap<Stroke, AABB>();

export function cachedStrokeBounds(s: Stroke): AABB {
  let b = strokeBoundsCache.get(s);
  if (!b) {
    b = strokeBounds(s);
    strokeBoundsCache.set(s, b);
  }
  return b;
}

/**
 * 스트로크의 중심 Y 좌표와 페이지 Y 범위를 기준으로 1-based 페이지 번호를 결정한다.
 */
export function resolveStrokePageNumber(stroke: Stroke, pageRanges: ReadonlyArray<PageYRange>): number {
  if (typeof stroke.pageNumber === 'number' && Number.isInteger(stroke.pageNumber) && stroke.pageNumber >= 1) {
    return stroke.pageNumber;
  }
  if (pageRanges.length === 0) return 1;
  const b = cachedStrokeBounds(stroke);
  const centerY = (b.minY + b.maxY) * 0.5;
  for (let i = 0; i < pageRanges.length; i++) {
    const r = pageRanges[i];
    if (centerY >= r.minY && centerY <= r.maxY) {
      return r.pageNumber;
    }
  }
  if (centerY < pageRanges[0].minY) {
    return pageRanges[0].pageNumber;
  }
  for (let i = 0; i < pageRanges.length - 1; i++) {
    const cur = pageRanges[i];
    const next = pageRanges[i + 1];
    if (centerY > cur.maxY && centerY < next.minY) {
      return centerY - cur.maxY <= next.minY - centerY ? cur.pageNumber : next.pageNumber;
    }
  }
  return pageRanges[pageRanges.length - 1].pageNumber;
}

/**
 * 캔버스 스트로크 상태 저장소.
 * - `strokesByPage` 맵으로 페이지별 O(1) 조회 및 `dirtyPages` 증분 저장을 지원한다.
 * - 모든 변이는 CompositeHistoryManager 로 기록되며 React useSyncExternalStore 와 호환된다.
 */
export class StrokeStore {
  private strokes: Stroke[] = [];
  private strokesByPageMap = new Map<number, Stroke[]>();
  private strokePageIndex = new Map<string, number>();
  private dirtyPages = new Set<number>();
  private lastChangedPages: number[] = [];
  private pageRanges: PageYRange[] = [];
  private listeners = new Set<Listener>();
  private pageChangeListeners = new Set<PageChangeListener>();
  private eraseBatches = new Map<string, Array<Array<{ stroke: Stroke; index: number }>>>();
  private cachedMaxY: number | null = null;

  constructor(private history?: CompositeHistoryManager, initial: Stroke[] = [], pageRanges: PageYRange[] = []) {
    this.pageRanges = pageRanges.slice();
    this.strokes = initial;
    this.rebuildPageIndex(initial);
  }

  attachHistory(history: CompositeHistoryManager) {
    this.history = history;
  }

  private rebuildPageIndex(list: Stroke[]) {
    this.strokesByPageMap.clear();
    this.strokePageIndex.clear();
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      const pageNum = resolveStrokePageNumber(s, this.pageRanges);
      this.strokePageIndex.set(s.id, pageNum);
      let bucket = this.strokesByPageMap.get(pageNum);
      if (!bucket) {
        bucket = [];
        this.strokesByPageMap.set(pageNum, bucket);
      }
      bucket.push(s);
    }
  }

  setPageRanges(ranges: PageYRange[]) {
    this.pageRanges = ranges.slice();
    this.rebuildPageIndex(this.strokes);
  }

  getPageRanges(): PageYRange[] {
    return this.pageRanges;
  }

  getAll = (): Stroke[] => this.strokes;

  /** 특정 페이지(1-based)의 스트로크만 O(1)로 반환한다. */
  getStrokesByPage = (pageNumber: number): Stroke[] => {
    return this.strokesByPageMap.get(pageNumber) ?? EMPTY_PAGE_STROKES;
  };

  /** 페이지 번호별 스트로크 맵 스냅샷을 반환한다. */
  getStrokesByPageMap(): Record<number, Stroke[]> {
    const out: Record<number, Stroke[]> = {};
    this.strokesByPageMap.forEach((list, pageNum) => {
      if (list.length > 0) out[pageNum] = list;
    });
    return out;
  }

  /** 지정된 페이지 번호 목록에 속한 스트로크만 병합해 반환한다. */
  getStrokesByPages(pageNumbers: Iterable<number>): Stroke[] {
    const out: Stroke[] = [];
    const seen = new Set<string>();
    for (const p of pageNumbers) {
      const bucket = this.strokesByPageMap.get(p);
      if (!bucket) continue;
      for (let i = 0; i < bucket.length; i++) {
        const s = bucket[i];
        if (!seen.has(s.id)) {
          seen.add(s.id);
          out.push(s);
        }
      }
    }
    return out;
  }

  getDirtyPages(): number[] {
    return Array.from(this.dirtyPages).sort((a, b) => a - b);
  }

  markPageDirty(pageNumber: number) {
    if (pageNumber >= 1) {
      this.dirtyPages.add(pageNumber);
    }
  }

  clearDirtyPages(pages?: Iterable<number>) {
    if (!pages) {
      this.dirtyPages.clear();
      return;
    }
    for (const p of pages) {
      this.dirtyPages.delete(p);
    }
  }

  getLastChangedPages(): number[] {
    return this.lastChangedPages;
  }

  getMaxY = (): number => {
    if (this.cachedMaxY === null) {
      let m = 0;
      for (const s of this.strokes) {
        const b = cachedStrokeBounds(s);
        if (b.maxY > m) m = b.maxY;
      }
      this.cachedMaxY = m;
    }
    return this.cachedMaxY;
  };

  getQuantizedMaxY = (): number => {
    const m = this.getMaxY();
    return m > 0 ? Math.ceil(m / 200) * 200 : 0;
  };

  get(id: string): Stroke | undefined {
    return this.strokes.find((s) => s.id === id);
  }

  getMany(ids: string[]): Stroke[] {
    const set = new Set(ids);
    return this.strokes.filter((s) => set.has(s.id));
  }

  boundsOf(ids: string[]): AABB | null {
    return unionBounds(this.getMany(ids).map(cachedStrokeBounds));
  }

  /** 히스토리 기록 없이 전체 교체(로드 시) */
  reset(strokes: Stroke[], markDirty = false) {
    this.strokes = strokes;
    this.cachedMaxY = null;
    this.eraseBatches.clear();
    this.rebuildPageIndex(strokes);
    this.dirtyPages.clear();
    if (markDirty) {
      this.strokesByPageMap.forEach((_list, pageNum) => this.dirtyPages.add(pageNum));
    }
    const changed = Array.from(this.strokesByPageMap.keys());
    this.emit(changed);
  }

  /** 페이지별 맵으로 전체 교체(IndexedDB pageStrokes 증분 로드 시) */
  resetByPage(pageMap: Record<number, Stroke[]>, markDirty = false) {
    const merged: Stroke[] = [];
    this.strokesByPageMap.clear();
    this.strokePageIndex.clear();
    this.dirtyPages.clear();

    const pageNums = Object.keys(pageMap)
      .map(Number)
      .filter((n) => Number.isInteger(n) && n >= 1)
      .sort((a, b) => a - b);

    for (const pageNum of pageNums) {
      const list = pageMap[pageNum] ?? [];
      if (list.length === 0) continue;
      const bucket: Stroke[] = [];
      for (const s of list) {
        const normalized = s.pageNumber === pageNum ? s : { ...s, pageNumber: pageNum };
        bucket.push(normalized);
        merged.push(normalized);
        this.strokePageIndex.set(normalized.id, pageNum);
      }
      this.strokesByPageMap.set(pageNum, bucket);
      if (markDirty) this.dirtyPages.add(pageNum);
    }

    this.strokes = merged;
    this.cachedMaxY = null;
    this.eraseBatches.clear();
    this.emit(pageNums);
  }

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  subscribePageChanges = (fn: PageChangeListener): (() => void) => {
    this.pageChangeListeners.add(fn);
    return () => this.pageChangeListeners.delete(fn);
  };

  // ---- raw mutations (no history) ----
  rawAdd(list: Array<{ stroke: Stroke; index: number }>) {
    if (list.length === 0) return;
    const next = this.strokes.slice();
    const changed = new Set<number>();

    [...list]
      .sort((a, b) => a.index - b.index)
      .forEach(({ stroke, index }) => {
        const pageNum = resolveStrokePageNumber(stroke, this.pageRanges);
        const normalized = stroke.pageNumber === pageNum ? stroke : { ...stroke, pageNumber: pageNum };
        next.splice(Math.min(index, next.length), 0, normalized);

        const prevBucket = this.strokesByPageMap.get(pageNum) ?? [];
        this.strokesByPageMap.set(pageNum, [...prevBucket, normalized]);
        this.strokePageIndex.set(normalized.id, pageNum);
        this.dirtyPages.add(pageNum);
        changed.add(pageNum);

        if (this.cachedMaxY !== null) {
          const b = cachedStrokeBounds(normalized);
          if (b.maxY > this.cachedMaxY) this.cachedMaxY = b.maxY;
        }
      });

    this.strokes = next;
    this.emit(Array.from(changed));
  }

  rawRemove(ids: string[]): Array<{ stroke: Stroke; index: number }> {
    if (ids.length === 0) return [];
    const set = new Set(ids);
    const removed: Array<{ stroke: Stroke; index: number }> = [];
    const changed = new Set<number>();

    this.strokes.forEach((s, index) => {
      if (set.has(s.id)) {
        removed.push({ stroke: s, index });
        const pageNum = this.strokePageIndex.get(s.id) ?? resolveStrokePageNumber(s, this.pageRanges);
        changed.add(pageNum);
        this.dirtyPages.add(pageNum);
        this.strokePageIndex.delete(s.id);
      }
    });

    if (removed.length === 0) return [];

    this.strokes = this.strokes.filter((s) => !set.has(s.id));
    for (const pageNum of changed) {
      const bucket = this.strokesByPageMap.get(pageNum);
      if (bucket) {
        const filtered = bucket.filter((s) => !set.has(s.id));
        if (filtered.length > 0) {
          this.strokesByPageMap.set(pageNum, filtered);
        } else {
          this.strokesByPageMap.delete(pageNum);
        }
      }
    }

    if (this.cachedMaxY !== null) {
      const removedNearMax = removed.some((r) => cachedStrokeBounds(r.stroke).maxY >= this.cachedMaxY! - 1);
      if (removedNearMax) this.cachedMaxY = null;
    }
    this.emit(Array.from(changed));
    return removed;
  }

  rawTranslate(ids: string[], dx: number, dy: number) {
    if (ids.length === 0) return;
    const set = new Set(ids);
    const changed = new Set<number>();

    this.strokes = this.strokes.map((s) => {
      if (!set.has(s.id)) return s;
      const oldPage = this.strokePageIndex.get(s.id) ?? resolveStrokePageNumber(s, this.pageRanges);
      const movedBase: Stroke = { ...s, points: translatePoints(s.points, dx, dy) };
      delete movedBase.pageNumber;
      const newPage = resolveStrokePageNumber(movedBase, this.pageRanges);
      const moved: Stroke = { ...movedBase, pageNumber: newPage };

      changed.add(oldPage);
      changed.add(newPage);
      this.dirtyPages.add(oldPage);
      this.dirtyPages.add(newPage);
      this.strokePageIndex.set(moved.id, newPage);
      return moved;
    });

    if (changed.size > 0) {
      // 영향받은 페이지만 재인덱싱
      for (const p of changed) {
        this.strokesByPageMap.delete(p);
      }
      for (const s of this.strokes) {
        const p = this.strokePageIndex.get(s.id) ?? resolveStrokePageNumber(s, this.pageRanges);
        if (changed.has(p)) {
          const bucket = this.strokesByPageMap.get(p);
          if (bucket) bucket.push(s);
          else this.strokesByPageMap.set(p, [s]);
        }
      }
    }

    this.cachedMaxY = null;
    this.emit(Array.from(changed));
  }

  // ---- recorded mutations ----
  addStroke(stroke: Stroke) {
    this.addStrokes([stroke], 'stroke-add');
  }

  addStrokes(strokes: Stroke[], type: 'stroke-add' | 'stroke-batch' = 'stroke-batch') {
    if (strokes.length === 0) return;
    const base = this.strokes.length;
    const entries = strokes.map((stroke, i) => {
      const pageNum = resolveStrokePageNumber(stroke, this.pageRanges);
      const normalized = stroke.pageNumber === pageNum ? stroke : { ...stroke, pageNumber: pageNum };
      return { stroke: normalized, index: base + i };
    });
    this.rawAdd(entries);
    this.history?.push({
      id: newCommandId(),
      type,
      timestamp: Date.now(),
      undo: () => this.rawRemove(entries.map((e) => e.stroke.id)),
      redo: () => this.rawAdd(entries),
    });
  }

  removeStrokes(ids: string[], mergeCommandId?: string): string | undefined {
    if (ids.length === 0) return mergeCommandId;
    const removed = this.rawRemove(ids);
    if (removed.length === 0) return mergeCommandId;

    if (mergeCommandId && this.history?.peek()?.id === mergeCommandId && this.eraseBatches.has(mergeCommandId)) {
      const batches = this.eraseBatches.get(mergeCommandId)!;
      batches.push(removed);
      this.history.replaceTop({
        id: mergeCommandId,
        type: 'stroke-remove',
        timestamp: Date.now(),
        undo: () => {
          for (let i = batches.length - 1; i >= 0; i--) {
            this.rawAdd(batches[i]);
          }
        },
        redo: () => {
          const allIds = batches.flatMap((b) => b.map((r) => r.stroke.id));
          this.rawRemove(allIds);
        },
      });
      return mergeCommandId;
    }

    const cmdId = newCommandId();
    const batches = [removed];
    this.eraseBatches.set(cmdId, batches);
    this.history?.push({
      id: cmdId,
      type: 'stroke-remove',
      timestamp: Date.now(),
      undo: () => {
        for (let i = batches.length - 1; i >= 0; i--) {
          this.rawAdd(batches[i]);
        }
      },
      redo: () => {
        const allIds = batches.flatMap((b) => b.map((r) => r.stroke.id));
        this.rawRemove(allIds);
      },
    });
    return cmdId;
  }

  /**
   * 지우개 접촉 반경(radius, 기본 12px)과 충돌하는 스트로크를 즉시 삭제한다.
   * pageRanges가 존재할 때는 충돌 가능한 페이지 버킷만 검사해 O(N_page)로 처리한다.
   */
  erasePoints(
    points: ReadonlyArray<Point>,
    radius = 12,
    mergeCommandId?: string,
  ): { removedIds: string[]; removedStrokes: Stroke[]; commandId?: string; removedBounds: AABB | null } {
    if (points.length === 0) {
      return { removedIds: [], removedStrokes: [], commandId: mergeCommandId, removedBounds: null };
    }
    const ptsBounds = boundsOfPoints([...points]);
    const hitIds: string[] = [];
    const hitStrokes: Stroke[] = [];
    const hitBounds: AABB[] = [];

    let candidates: Stroke[] = this.strokes;
    if (this.pageRanges.length > 0 && this.strokesByPageMap.size > 0) {
      const minY = ptsBounds.minY - radius - 24;
      const maxY = ptsBounds.maxY + radius + 24;
      const matching: Stroke[] = [];
      for (let i = 0; i < this.pageRanges.length; i++) {
        const r = this.pageRanges[i];
        if (r.maxY < minY || r.minY > maxY) continue;
        const bucket = this.strokesByPageMap.get(r.pageNumber);
        if (bucket && bucket.length > 0) {
          for (let j = 0; j < bucket.length; j++) matching.push(bucket[j]);
        }
      }
      candidates = matching;
    }

    for (const s of candidates) {
      const b = cachedStrokeBounds(s);
      if (
        ptsBounds.maxX + radius < b.minX ||
        ptsBounds.minX - radius > b.maxX ||
        ptsBounds.maxY + radius < b.minY ||
        ptsBounds.minY - radius > b.maxY
      ) {
        continue;
      }
      for (let i = 0; i < points.length; i++) {
        const p = points[i];
        if (p.x + radius < b.minX || p.x - radius > b.maxX || p.y + radius < b.minY || p.y - radius > b.maxY) {
          continue;
        }
        if (eraserHitsStroke(p, radius, s.points, s.size)) {
          hitIds.push(s.id);
          hitStrokes.push(s);
          hitBounds.push(b);
          break;
        }
      }
    }

    if (hitIds.length === 0) {
      return { removedIds: [], removedStrokes: [], commandId: mergeCommandId, removedBounds: null };
    }
    const commandId = this.removeStrokes(hitIds, mergeCommandId);
    return {
      removedIds: hitIds,
      removedStrokes: hitStrokes,
      commandId,
      removedBounds: unionBounds(hitBounds),
    };
  }

  eraseAt(
    x: number,
    y: number,
    radius = 12,
    mergeCommandId?: string,
  ): { removedIds: string[]; removedStrokes: Stroke[]; commandId?: string; removedBounds: AABB | null } {
    return this.erasePoints([{ x, y }], radius, mergeCommandId);
  }

  /** 실시간 드래그 중 미리보기 이동(기록 안 함). 종료 시 commitMove 로 총 변위를 기록한다. */
  previewTranslate(ids: string[], dx: number, dy: number) {
    this.rawTranslate(ids, dx, dy);
  }

  /** previewTranslate 로 이미 적용된 총 변위(dx, dy)를 하나의 명령으로 기록 */
  commitMove(ids: string[], dx: number, dy: number) {
    if (ids.length === 0 || (dx === 0 && dy === 0)) return;
    const idsCopy = ids.slice();
    this.history?.push({
      id: newCommandId(),
      type: 'stroke-move',
      timestamp: Date.now(),
      undo: () => this.rawTranslate(idsCopy, -dx, -dy),
      redo: () => this.rawTranslate(idsCopy, dx, dy),
    });
  }

  /** 즉시 이동 + 기록 */
  moveStrokes(ids: string[], dx: number, dy: number) {
    this.rawTranslate(ids, dx, dy);
    this.commitMove(ids, dx, dy);
  }

  private emit(changedPages: number[] = []) {
    this.lastChangedPages = changedPages;
    this.listeners.forEach((l) => l());
    if (changedPages.length > 0) {
      this.pageChangeListeners.forEach((fn) => fn(changedPages));
    }
  }
}
