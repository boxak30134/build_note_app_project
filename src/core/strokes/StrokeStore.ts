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

  constructor(private history?: CompositeHistoryManager, initial: Stroke[] = []) {
    this.strokes = initial;
  }

  attachHistory(history: CompositeHistoryManager) {
    this.history = history;
  }

  getAll = (): Stroke[] => this.strokes;

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
    this.emit();
    return removed;
  }

  rawTranslate(ids: string[], dx: number, dy: number) {
    const set = new Set(ids);
    this.strokes = this.strokes.map((s) => (set.has(s.id) ? { ...s, points: translatePoints(s.points, dx, dy) } : s));
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
   * 한 프레임의 다중 지우개 궤적 좌표를 단일 패스로 판정해 충돌 획을 일괄 삭제(단일 emit)하고,
   * 삭제된 스트로크들의 합산 바운딩 박스(removedBounds)를 반환한다.
   */
  erasePoints(
    points: ReadonlyArray<Point>,
    radius = 12,
    mergeCommandId?: string,
  ): { removedIds: string[]; commandId?: string; removedBounds: AABB | null } {
    if (points.length === 0) {
      return { removedIds: [], commandId: mergeCommandId, removedBounds: null };
    }

    let qMinX = Infinity;
    let qMinY = Infinity;
    let qMaxX = -Infinity;
    let qMaxY = -Infinity;
    for (const pt of points) {
      if (pt.x < qMinX) qMinX = pt.x;
      if (pt.y < qMinY) qMinY = pt.y;
      if (pt.x > qMaxX) qMaxX = pt.x;
      if (pt.y > qMaxY) qMaxY = pt.y;
    }
    qMinX -= radius;
    qMinY -= radius;
    qMaxX += radius;
    qMaxY += radius;

    const hitIds: string[] = [];
    const hitBoxes: AABB[] = [];
    for (const s of this.strokes) {
      const b = cachedStrokeBounds(s);
      if (qMaxX < b.minX || qMinX > b.maxX || qMaxY < b.minY || qMinY > b.maxY) {
        continue;
      }
      for (const p of points) {
        if (p.x + radius < b.minX || p.x - radius > b.maxX || p.y + radius < b.minY || p.y - radius > b.maxY) {
          continue;
        }
        if (eraserHitsStroke(p, radius, s.points, s.size)) {
          hitIds.push(s.id);
          hitBoxes.push(b);
          break;
        }
      }
    }

    if (hitIds.length === 0) {
      return { removedIds: [], commandId: mergeCommandId, removedBounds: null };
    }
    const commandId = this.removeStrokes(hitIds, mergeCommandId);
    return { removedIds: hitIds, commandId, removedBounds: unionBounds(hitBoxes) };
  }

  /**
   * 지우개 접촉 반경(radius, 기본 12px)과 충돌하는 스트로크를 반투명 지연 없이 즉각 삭제(Instant Erase)하고
   * 동일 드래그 제스처 내 삭제 획들을 단일 Undo/Redo 명령으로 묶어 기록한다.
   */
  eraseAt(x: number, y: number, radius = 12, mergeCommandId?: string): { removedIds: string[]; commandId?: string } {
    const { removedIds, commandId } = this.erasePoints([{ x, y }], radius, mergeCommandId);
    return { removedIds, commandId };
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
