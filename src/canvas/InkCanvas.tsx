import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import type { NoteSession } from '../session/NoteSession';
import { newStrokeId, type Stroke } from '../core/strokes/StrokeStore';
import { eraserHitsStroke, strokeInPolygon, type Point, type StrokePoint } from '../core/geometry/geometry';
import { useSettings, activeColor } from '../store/settingsStore';
import { useSessions } from '../store/sessionStore';
import { useContextMenu } from '../store/contextMenuStore';
import { cachedBounds, drawStroke, intersects } from './render';

const LONG_PRESS_MS = 500;
const LONG_PRESS_RADIUS = 5;

type Live =
  | { kind: 'draw'; pointerId: number; stroke: Stroke }
  | { kind: 'erase'; pointerId: number; ids: Set<string>; trail: Point[] }
  | { kind: 'lasso'; pointerId: number; poly: Point[] }
  | { kind: 'move'; pointerId: number; ids: string[]; start: Point; applied: Point; target: Point }
  | null;

interface Props {
  session: NoteSession;
  viewportRef: React.RefObject<HTMLDivElement | null>;
  active: boolean;
}

/**
 * [Layer 2] 투명 벡터 캔버스.
 * - pointerType 'pen' 은 캔버스가 가로채 필기, 'touch' 는 스크롤/롱프레스, 'mouse' 는 에디터로 통과(마우스 필기 모드 제외)
 * - 좌표계: 페이지(중앙 고정폭 노트 컬럼) 기준 → 스크롤·사이드바 개폐와 무관하게 텍스트 위 필기가 고정된다.
 */
export function InkCanvas({ session, viewportRef, active }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const live = useRef<Live>(null);
  const frame = useRef(0);
  const strokes = useSyncExternalStore(session.strokes.subscribe, session.strokes.getAll);
  const lassoIds = useSessions((s) => s.sessions[session.id]?.lassoIds);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const viewport = viewportRef.current;
    const page = session.pageEl;
    if (!canvas || !viewport || !page) return;
    const vr = viewport.getBoundingClientRect();
    if (vr.width === 0 || vr.height === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(vr.width * dpr);
    const h = Math.round(vr.height * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const pr = page.getBoundingClientRect();
    const ox = pr.left - vr.left;
    const oy = pr.top - vr.top;
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, vr.width, vr.height);
    ctx.translate(ox, oy);
    const view = { minX: -ox, minY: -oy, maxX: -ox + vr.width, maxY: -oy + vr.height };
    const l = live.current;
    const erasing = l?.kind === 'erase' ? l.ids : null;
    for (const s of session.strokes.getAll()) {
      if (!intersects(cachedBounds(s), view)) continue;
      drawStroke(ctx, s, { faded: erasing?.has(s.id) });
    }
    if (l?.kind === 'draw') drawStroke(ctx, l.stroke);
    if (l?.kind === 'lasso' && l.poly.length > 1) {
      ctx.save();
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = '#6366f1';
      ctx.lineWidth = 1.5;
      ctx.fillStyle = 'rgba(99,102,241,0.06)';
      ctx.beginPath();
      l.poly.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
    if (l?.kind === 'erase' && l.trail.length) {
      const p = l.trail[l.trail.length - 1];
      ctx.save();
      ctx.strokeStyle = 'rgba(100,116,139,0.8)';
      ctx.beginPath();
      ctx.arc(p.x, p.y, useSettings.getState().eraserSize, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    const sel = useSessions.getState().sessions[session.id]?.lassoIds ?? [];
    if (sel.length) {
      const b = session.strokes.boundsOf(sel);
      if (b) {
        ctx.save();
        ctx.setLineDash([5, 4]);
        ctx.strokeStyle = '#6366f1';
        ctx.lineWidth = 1.2;
        ctx.strokeRect(b.minX - 6, b.minY - 6, b.maxX - b.minX + 12, b.maxY - b.minY + 12);
        ctx.restore();
      }
    }
  }, [session, viewportRef]);

  const requestDraw = useCallback(() => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(draw);
  }, [draw]);

  useEffect(() => {
    requestDraw();
  }, [strokes, lassoIds, active, requestDraw]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const ro = new ResizeObserver(requestDraw);
    ro.observe(viewport);
    if (session.pageEl) ro.observe(session.pageEl);
    viewport.addEventListener('scroll', requestDraw, { passive: true });
    window.addEventListener('resize', requestDraw);
    return () => {
      ro.disconnect();
      viewport.removeEventListener('scroll', requestDraw);
      window.removeEventListener('resize', requestDraw);
    };
  }, [viewportRef, session, requestDraw]);

  // ---------- 입력 처리 ----------
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    let longPress: { timer: ReturnType<typeof setTimeout>; x: number; y: number; pointerId: number } | null = null;
    let moveRaf = 0;

    const toPage = (e: PointerEvent): Point => {
      const r = session.pageEl!.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const cancelLongPress = () => {
      if (longPress) clearTimeout(longPress.timer);
      longPress = null;
    };

    const isDrawPointer = (e: PointerEvent) => {
      const s = useSettings.getState();
      return e.pointerType === 'pen' || (e.pointerType === 'mouse' && s.mouseDraw && e.button === 0);
    };

    const onPointerDown = (e: PointerEvent) => {
      if (!session.pageEl) return;
      const target = e.target as HTMLElement;
      if (target.closest('[data-overlay]')) return; // 핀/말풍선/액션바
      const settings = useSettings.getState();
      const ui = session.ui;

      // 롱프레스 (펜/손가락): 500ms, 반경 5px
      if (e.pointerType !== 'mouse') {
        cancelLongPress();
        const cx = e.clientX;
        const cy = e.clientY;
        const pp = toPage(e);
        longPress = {
          x: cx,
          y: cy,
          pointerId: e.pointerId,
          timer: setTimeout(() => {
            longPress = null;
            if (live.current?.kind === 'draw' || live.current?.kind === 'lasso') {
              live.current = null; // 진행 중이던 필기 취소
              requestDraw();
            }
            navigator.vibrate?.(20);
            useContextMenu.getState().show({ x: cx, y: cy, noteId: session.id, pagePoint: pp });
          }, LONG_PRESS_MS),
        };
      }

      if (ui.readOnly || !isDrawPointer(e) || settings.tool === 'none') return;
      e.preventDefault();
      e.stopPropagation();
      viewport.setPointerCapture(e.pointerId);
      const p = toPage(e);
      const pressure = e.pointerType === 'pen' ? e.pressure || 0.5 : 0.5;

      if (settings.tool === 'lasso') {
        const box = ui.lassoIds.length ? session.strokes.boundsOf(ui.lassoIds) : null;
        const inBox = box && p.x >= box.minX - 8 && p.x <= box.maxX + 8 && p.y >= box.minY - 8 && p.y <= box.maxY + 8;
        if (box && (ui.moveMode || inBox)) {
          live.current = { kind: 'move', pointerId: e.pointerId, ids: ui.lassoIds.slice(), start: p, applied: { x: 0, y: 0 }, target: { x: 0, y: 0 } };
        } else {
          session.patch({ lassoIds: [], moveMode: false });
          live.current = { kind: 'lasso', pointerId: e.pointerId, poly: [p] };
        }
      } else if (settings.tool === 'eraser') {
        live.current = { kind: 'erase', pointerId: e.pointerId, ids: new Set(), trail: [p] };
        eraseAt(p);
      } else {
        const tool = settings.tool;
        live.current = {
          kind: 'draw',
          pointerId: e.pointerId,
          stroke: {
            id: newStrokeId(),
            tool,
            color: activeColor(),
            size: tool === 'highlighter' ? settings.highlighterSize : settings.penSize,
            points: [[p.x, p.y, pressure]],
          },
        };
      }
      requestDraw();
    };

    const eraseAt = (p: Point) => {
      const l = live.current;
      if (l?.kind !== 'erase') return;
      const r = useSettings.getState().eraserSize;
      for (const s of session.strokes.getAll()) {
        if (l.ids.has(s.id)) continue;
        const b = cachedBounds(s);
        if (p.x < b.minX - r || p.x > b.maxX + r || p.y < b.minY - r || p.y > b.maxY + r) continue;
        if (eraserHitsStroke(p, r, s.points, s.size)) l.ids.add(s.id);
      }
    };

    const onPointerMove = (e: PointerEvent) => {
      if (longPress && longPress.pointerId === e.pointerId && Math.hypot(e.clientX - longPress.x, e.clientY - longPress.y) > LONG_PRESS_RADIUS) {
        cancelLongPress();
      }
      // S-Pen 호버 시 터치 스크롤 제스처가 필기를 가로채지 않도록
      if (e.pointerType === 'pen' && useSettings.getState().tool !== 'none') viewport.style.touchAction = 'none';
      const l = live.current;
      if (!l || l.pointerId !== e.pointerId) return;
      e.preventDefault();
      const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [e];
      const list = events.length ? events : [e];
      if (l.kind === 'draw') {
        for (const ce of list) {
          const p = toPage(ce);
          const pressure = ce.pointerType === 'pen' ? ce.pressure || 0.5 : 0.5;
          l.stroke = { ...l.stroke, points: [...l.stroke.points, [p.x, p.y, pressure] as StrokePoint] };
        }
      } else if (l.kind === 'lasso') {
        for (const ce of list) l.poly.push(toPage(ce));
      } else if (l.kind === 'erase') {
        for (const ce of list) {
          const p = toPage(ce);
          l.trail.push(p);
          eraseAt(p);
        }
      } else if (l.kind === 'move') {
        const p = toPage(e);
        l.target = { x: p.x - l.start.x, y: p.y - l.start.y };
        // requestAnimationFrame 으로 변위를 실시간 가산
        if (!moveRaf) {
          moveRaf = requestAnimationFrame(() => {
            moveRaf = 0;
            const cur = live.current;
            if (cur?.kind !== 'move') return;
            const dx = cur.target.x - cur.applied.x;
            const dy = cur.target.y - cur.applied.y;
            if (dx || dy) {
              session.strokes.previewTranslate(cur.ids, dx, dy);
              cur.applied = { ...cur.target };
            }
          });
        }
        return;
      }
      requestDraw();
    };

    const finish = (e: PointerEvent, cancelled: boolean) => {
      if (longPress?.pointerId === e.pointerId) cancelLongPress();
      const l = live.current;
      if (!l || l.pointerId !== e.pointerId) return;
      live.current = null;
      if (viewport.hasPointerCapture(e.pointerId)) viewport.releasePointerCapture(e.pointerId);
      if (l.kind === 'draw' && !cancelled) {
        session.strokes.addStroke(l.stroke);
      } else if (l.kind === 'erase') {
        session.strokes.removeStrokes([...l.ids]);
      } else if (l.kind === 'lasso' && !cancelled) {
        const ids = l.poly.length > 2 ? session.strokes.getAll().filter((s) => strokeInPolygon(s.points, l.poly)).map((s) => s.id) : [];
        session.patch({ lassoIds: ids, moveMode: false });
      } else if (l.kind === 'move') {
        cancelAnimationFrame(moveRaf);
        moveRaf = 0;
        const dx = l.target.x - l.applied.x;
        const dy = l.target.y - l.applied.y;
        if (dx || dy) session.strokes.previewTranslate(l.ids, dx, dy);
        session.strokes.commitMove(l.ids, l.target.x, l.target.y);
      }
      requestDraw();
    };
    const onUp = (e: PointerEvent) => finish(e, false);
    const onCancel = (e: PointerEvent) => finish(e, true);
    const onLeave = (e: PointerEvent) => {
      if (e.pointerType === 'pen') viewport.style.touchAction = '';
    };
    const onContextMenu = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest('[data-overlay]')) return;
      e.preventDefault();
      const r = session.pageEl!.getBoundingClientRect();
      useContextMenu.getState().show({ x: e.clientX, y: e.clientY, noteId: session.id, pagePoint: { x: e.clientX - r.left, y: e.clientY - r.top } });
    };

    viewport.addEventListener('pointerdown', onPointerDown, { capture: true });
    viewport.addEventListener('pointermove', onPointerMove, { capture: true });
    viewport.addEventListener('pointerup', onUp, { capture: true });
    viewport.addEventListener('pointercancel', onCancel, { capture: true });
    viewport.addEventListener('pointerleave', onLeave);
    viewport.addEventListener('contextmenu', onContextMenu);
    return () => {
      cancelLongPress();
      viewport.removeEventListener('pointerdown', onPointerDown, { capture: true });
      viewport.removeEventListener('pointermove', onPointerMove, { capture: true });
      viewport.removeEventListener('pointerup', onUp, { capture: true });
      viewport.removeEventListener('pointercancel', onCancel, { capture: true });
      viewport.removeEventListener('pointerleave', onLeave);
      viewport.removeEventListener('contextmenu', onContextMenu);
    };
  }, [session, viewportRef, requestDraw]);

  return <canvas ref={canvasRef} className="ink-canvas pointer-events-none absolute inset-0 h-full w-full" aria-hidden />;
}
