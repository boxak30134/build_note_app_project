import type { AABB, StrokePoint } from '../geometry/geometry';
import { boundsOfPoints, translatePoints, unionBounds } from '../geometry/geometry';
import type { CompositeHistoryManager } from '../history/CompositeHistoryManager';
import { newCommandId } from '../history/CompositeHistoryManager';

export type StrokeTool = 'pencil' | 'highlighter';

export interface Stroke {
  id: string;
  tool: StrokeTool;
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

/**
 * 캔버스 스트로크 상태 저장소. 모든 변이는 CompositeHistoryManager 로 기록된다.
 * 배열은 불변(immutable)으로 교체되어 React useSyncExternalStore 와 호환된다.
 */
export class StrokeStore {
  private strokes: Stroke[] = [];
  private listeners = new Set<Listener>();

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
    return unionBounds(this.getMany(ids).map(strokeBounds));
  }

  /** 히스토리 기록 없이 전체 교체(로드 시) */
  reset(strokes: Stroke[]) {
    this.strokes = strokes;
    this.emit();
  }

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  // ---- raw mutations (no history) ----
  private rawAdd(list: Array<{ stroke: Stroke; index: number }>) {
    const next = this.strokes.slice();
    [...list].sort((a, b) => a.index - b.index).forEach(({ stroke, index }) => {
      next.splice(Math.min(index, next.length), 0, stroke);
    });
    this.strokes = next;
    this.emit();
  }

  private rawRemove(ids: string[]): Array<{ stroke: Stroke; index: number }> {
    const set = new Set(ids);
    const removed: Array<{ stroke: Stroke; index: number }> = [];
    this.strokes.forEach((s, index) => {
      if (set.has(s.id)) removed.push({ stroke: s, index });
    });
    this.strokes = this.strokes.filter((s) => !set.has(s.id));
    this.emit();
    return removed;
  }

  private rawTranslate(ids: string[], dx: number, dy: number) {
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

  removeStrokes(ids: string[]) {
    if (ids.length === 0) return;
    const removed = this.rawRemove(ids);
    if (removed.length === 0) return;
    this.history?.push({
      id: newCommandId(),
      type: 'stroke-remove',
      timestamp: Date.now(),
      undo: () => this.rawAdd(removed),
      redo: () => this.rawRemove(removed.map((r) => r.stroke.id)),
    });
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
