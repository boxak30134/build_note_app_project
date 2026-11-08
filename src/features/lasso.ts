import type { NoteSession } from '../session/NoteSession';
import { newStrokeId, type Stroke } from '../core/strokes/StrokeStore';
import { translatePoints, unionBounds } from '../core/geometry/geometry';
import { strokeBounds } from '../core/strokes/StrokeStore';
import { strokeClipboard } from '../store/contextMenuStore';
import { toast } from '../store/uiStore';

export function lassoCopy(s: NoteSession) {
  const sel = s.strokes.getMany(s.ui.lassoIds);
  if (sel.length === 0) return;
  strokeClipboard.strokes = sel.map((x) => ({ ...x, points: x.points.map((p) => [...p] as typeof p) }));
  strokeClipboard.active = true;
  s.patch({ lassoIds: [], moveMode: false });
  toast.info(`필기 ${sel.length}개 복사됨 — 길게 누르거나 우클릭하여 붙여넣기`);
}

export function lassoDelete(s: NoteSession) {
  s.strokes.removeStrokes(s.ui.lassoIds);
  s.patch({ lassoIds: [], moveMode: false });
}

export function lassoCut(s: NoteSession) {
  const ids = s.ui.lassoIds.slice();
  const sel = s.strokes.getMany(ids);
  if (sel.length === 0) return;
  strokeClipboard.strokes = sel.map((x) => ({ ...x, points: x.points.map((p) => [...p] as typeof p) }));
  strokeClipboard.active = true;
  s.strokes.removeStrokes(ids);
  s.patch({ lassoIds: [], moveMode: false });
  toast.info(`필기 ${sel.length}개 잘라냄 — 길게 누르거나 우클릭하여 붙여넣기`);
}

/** 내부 클립보드의 스트로크를 지정 지점(좌상단 기준)에 붙여넣기 */
export function pasteStrokes(s: NoteSession, at: { x: number; y: number }) {
  const src = strokeClipboard.strokes;
  if (src.length === 0) return;
  const box = unionBounds(src.map(strokeBounds))!;
  const dx = at.x - box.minX;
  const dy = at.y - box.minY;
  const copies: Stroke[] = src.map((x) => ({ ...x, id: newStrokeId(), points: translatePoints(x.points, dx, dy) }));
  s.strokes.addStrokes(copies, 'stroke-batch');
  s.patch({ lassoIds: copies.map((c) => c.id) });
}
