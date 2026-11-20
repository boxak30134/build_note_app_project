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
}

type Listener = () => void;

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
 * 캔버스 스트로크 상태 저장소. 모든 변이는 CompositeHistoryManager 로 기록된다.
 * 배열은 불변(immutable)으로 교체되어 React useSyncExternalStore 와 호환된다.
 */
export class StrokeStore {
  private strokes: Stroke[] = [];
  private listeners = new Set<Listener>();
  private eraseBatches = new Map<string, Array<Array<{ stroke: Stroke; index: number }>>>();
  private cachedMaxY: number | null = null;

  constructor(private history?: CompositeHistoryManager, initial: Stroke[] = []) {
    this.strokes = initial;
  }

  attachHistory(history: CompositeHistoryManager) {
    this.history = history;
  }

  getAll = (): Stroke[] => this.strokes;

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
  reset(strokes: Stroke[]) {
    this.strokes = strokes;
    this.cachedMaxY = null;
    this.eraseBatches.clear();
    this.emit();
  }

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  // ---- raw mutations (no history) ----
  rawAdd(list: Array<{ stroke: Stroke; index: number }>) {
    const next = this.strokes.slice();
    [...list].sort((a, b) => a.index - b.index).forEach(({ stroke, index }) => {
      next.splice(Math.min(index, next.length), 0, stroke);
      if (this.cachedMaxY !== null) {
        const b = cachedStrokeBounds(stroke);
        if (b.maxY > this.cachedMaxY) this.cachedMaxY = b.maxY;
      }
    });
    this.strokes = next;
    this.emit();
  }

  rawRemove(ids: string[]): Array<{ stroke: Stroke; index: number }> {
    const set = new Set(ids);
    const removed: Array<{ stroke: Stroke; index: number }> = [];
    this.strokes.forEach((s, index) => {
      if (set.has(s.id)) removed.push({ stroke: s, index });
    });
    this.strokes = this.strokes.filter((s) => !set.has(s.id));
    if (removed.length > 0 && this.cachedMaxY !== null) {
      const removedNearMax = removed.some((r) => cachedStrokeBounds(r.stroke).maxY >= this.cachedMaxY! - 1);
      if (removedNearMax) this.cachedMaxY = null;
    }
    this.emit();
    return removed;
  }

  rawTranslate(ids: string[], dx: number, dy: number) {
    const set = new Set(ids);
    this.strokes = this.strokes.map((s) => (set.has(s.id) ? { ...s, points: translatePoints(s.points, dx, dy) } : s));
    this.cachedMaxY = null;
    this.emit();
  }

  // ---- recorded mutations ----
  addStroke(stroke: Stroke) {
    this.addStrokes([stroke], 'stroke-add');
  }

  addStrokes(strokes: Stroke[], type: 'stroke-add' | 'stroke-batch' = 'stroke-batch') {
    if (strokes.length === 0) return;
    const base = this.strokes.length;
    const entries = strokes.map((stroke, i) => ({ stroke, index: base + i }));
    this.rawAdd(entries);
    this.history?.push({
      id: newCommandId(),
      type,
      timestamp: Date.now(),
      undo: () => this.rawRemove(strokes.map((s) => s.id)),
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
   * 지우개 접촉 반경(radius, 기본 12px)과 충돌하는 스트로크를 반투명 지연 없이 즉각 삭제(Instant Erase)하고
   * 동일 드래그 제스처 내 삭제 획들을 단일 Undo/Redo 명령으로 묶어 기록한다.
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

    for (const s of this.strokes) {
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

  private emit() {
    this.listeners.forEach((l) => l());
  }
}
