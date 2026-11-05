import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import type { NoteSession } from '../session/NoteSession';
import { newStrokeId, type Stroke } from '../core/strokes/StrokeStore';
import {
  extractClosedLassoPolygon,
  isEraserPointer,
  strokeInPolygon,
  type Point,
  type StrokePoint,
} from '../core/geometry/geometry';
import { useSettings, activeColor } from '../store/settingsStore';
import { useSessions } from '../store/sessionStore';
import { useContextMenu } from '../store/contextMenuStore';
import { cachedBounds, drawStroke, intersects } from './render';
import {
  normalizePenPressure,
  shouldRejectPalmTouch,
  type PalmRejectionState,
} from '../core/android/androidDeployment';

const LONG_PRESS_MS = 500;
const LONG_PRESS_RADIUS = 5;

type Live =
  | { kind: 'draw'; pointerId: number; stroke: Stroke }
  | { kind: 'erase'; pointerId: number; commandId?: string; trail: Point[] }
  | { kind: 'lasso'; pointerId: number; poly: Point[]; closedPoly: Point[] | null }
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
  const zoom = useSessions((s) => s.sessions[session.id]?.zoom ?? 1);

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
    const currentZoom = useSessions.getState().sessions[session.id]?.zoom || 1;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, vr.width, vr.height);
    ctx.translate(ox, oy);
    ctx.scale(currentZoom, currentZoom);
    const view = {
      minX: -ox / currentZoom,
      minY: -oy / currentZoom,
      maxX: (-ox + vr.width) / currentZoom,
      maxY: (-oy + vr.height) / currentZoom,
    };
    const l = live.current;
    for (const s of session.strokes.getAll()) {
      if (!intersects(cachedBounds(s), view)) continue;
      drawStroke(ctx, s);
    }
    if (l?.kind === 'draw') drawStroke(ctx, l.stroke);
    if (l?.kind === 'lasso' && l.poly.length > 1) {
      ctx.save();
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = '#6366f1';
      ctx.lineWidth = 1.5;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      // 올가미는 무조건 스타일러스 펜 궤적(l.poly)만 그대로 따라간다 (강제 closePath 직선 연결 금지)
      ctx.beginPath();
      l.poly.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.stroke();

      // 폐곡선(closed curve)이 형성된 경우에만 해당 closure 내부 영역을 반투명하게 채운다
      if (l.closedPoly && l.closedPoly.length > 2) {
        ctx.fillStyle = 'rgba(99,102,241,0.08)';
        ctx.beginPath();
        l.closedPoly.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
        ctx.closePath();
        ctx.fill();
      }
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
  }, [strokes, lassoIds, zoom, active, requestDraw]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    let orientationTimer: ReturnType<typeof setTimeout> | null = null;
    const onOrientationChange = () => {
      requestDraw();
      if (orientationTimer) clearTimeout(orientationTimer);
      orientationTimer = setTimeout(requestDraw, 120);
    };
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(requestDraw) : null;
    ro?.observe(viewport);
    if (session.pageEl) ro?.observe(session.pageEl);
    viewport.addEventListener('scroll', requestDraw, { passive: true });
    window.addEventListener('resize', requestDraw);
    window.addEventListener('orientationchange', onOrientationChange);
    window.visualViewport?.addEventListener('resize', requestDraw);
    return () => {
      if (orientationTimer) clearTimeout(orientationTimer);
      ro?.disconnect();
      viewport.removeEventListener('scroll', requestDraw);
      window.removeEventListener('resize', requestDraw);
      window.removeEventListener('orientationchange', onOrientationChange);
      window.visualViewport?.removeEventListener('resize', requestDraw);
    };
  }, [viewportRef, session, requestDraw]);

  // ---------- 입력 처리 ----------
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    let longPress: { timer: ReturnType<typeof setTimeout>; x: number; y: number; pointerId: number; pointerType: string } | null = null;
    let moveRaf = 0;
    const palmState: PalmRejectionState = { isPenDrawing: false, lastPenTimestamp: 0 };
    const activeTouchIds = new Set<number>();

    const toPage = (e: PointerEvent): Point => {
      const r = session.pageEl!.getBoundingClientRect();
      const z = session.ui.zoom || 1;
      return { x: (e.clientX - r.left) / z, y: (e.clientY - r.top) / z };
    };
    const cancelLongPress = () => {
      if (longPress) clearTimeout(longPress.timer);
      longPress = null;
    };

    const isStylusPointer = (e: PointerEvent) =>
      e.pointerType === 'pen' || e.pointerType === 'eraser' || isEraserPointer(e);

    const isDrawPointer = (e: PointerEvent) => {
      const s = useSettings.getState();
      return isStylusPointer(e) || (e.pointerType === 'mouse' && s.mouseDraw && e.button === 0);
    };

    const handleEraserMove = (x: number, y: number, radius = useSettings.getState().eraserSize) => {
      const l = live.current;
      if (l?.kind !== 'erase') return;
      const { removedIds, commandId } = session.strokes.eraseAt(x, y, radius, l.commandId);
      l.commandId = commandId;
      if (removedIds.length > 0) {
        if (session.ui.lassoIds.length > 0) {
          const removedSet = new Set(removedIds);
          const nextLasso = session.ui.lassoIds.filter((id) => !removedSet.has(id));
          if (nextLasso.length !== session.ui.lassoIds.length) {
            session.patch({ lassoIds: nextLasso });
          }
        }
        requestDraw();
      }
    };

    const onPointerDown = (e: PointerEvent) => {
      if (!session.pageEl) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest?.('[data-overlay]')) return; // 핀/말풍선/액션바
      const settings = useSettings.getState();
      const ui = session.ui;
      const hardwareEraser = isEraserPointer(e);

      if (isStylusPointer(e)) {
        palmState.isPenDrawing = true;
        palmState.lastPenTimestamp = Date.now();
        // 손바닥이 먼저 닿아 대기 중이던 터치 롱프레스가 있으면 즉시 취소
        if (longPress?.pointerType === 'touch') cancelLongPress();
      } else if (
        shouldRejectPalmTouch(e.pointerType, {
          isPenDrawing: live.current !== null || palmState.isPenDrawing,
          lastPenTimestamp: palmState.lastPenTimestamp,
        })
      ) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      if (e.pointerType === 'touch') {
        activeTouchIds.add(e.pointerId);
        // 두 손가락 이상(핀치 줌 등) 터치 시 롱프레스 메뉴 즉시 취소
        if (activeTouchIds.size >= 2) {
          cancelLongPress();
          return;
        }
      }

      // REQ-1: 하드웨어 지우개(후면 지우개 팁 / S펜 측면 버튼) 감지 시 UI 도구 변경 없이 지우개 동작으로 자동 분기
      const effectiveTool = hardwareEraser ? 'eraser' : settings.tool;

      // 롱프레스 (펜/손가락): 500ms, 반경 5px (지우개 입력 중에는 롱프레스 메뉴 비활성화)
      if (e.pointerType !== 'mouse' && effectiveTool !== 'eraser' && activeTouchIds.size < 2) {
        cancelLongPress();
        const cx = e.clientX;
        const cy = e.clientY;
        const pp = toPage(e);
        longPress = {
          x: cx,
          y: cy,
          pointerId: e.pointerId,
          pointerType: e.pointerType,
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
      } else if (effectiveTool === 'eraser') {
        cancelLongPress();
      }

      if (ui.readOnly || (!isDrawPointer(e) && !hardwareEraser) || effectiveTool === 'none') return;
      e.preventDefault();
      e.stopPropagation();
      if (typeof viewport.setPointerCapture === 'function') {
        try {
          viewport.setPointerCapture(e.pointerId);
        } catch {
          /* ignore synthetic event capture errors */
        }
      }
      const p = toPage(e);
      const pressure = normalizePenPressure(e.pressure, e.pointerType);

      if (effectiveTool === 'lasso') {
        const box = ui.lassoIds.length ? session.strokes.boundsOf(ui.lassoIds) : null;
        const inBox = box && p.x >= box.minX - 8 && p.x <= box.maxX + 8 && p.y >= box.minY - 8 && p.y <= box.maxY + 8;
        if (box && inBox) {
          live.current = { kind: 'move', pointerId: e.pointerId, ids: ui.lassoIds.slice(), start: p, applied: { x: 0, y: 0 }, target: { x: 0, y: 0 } };
        } else {
          session.patch({ lassoIds: [], moveMode: false });
          live.current = { kind: 'lasso', pointerId: e.pointerId, poly: [p], closedPoly: null };
        }
      } else if (effectiveTool === 'eraser') {
        live.current = { kind: 'erase', pointerId: e.pointerId, commandId: undefined, trail: [p] };
        handleEraserMove(p.x, p.y, settings.eraserSize);
      } else {
        const tool = effectiveTool;
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

    const onPointerMove = (e: PointerEvent) => {
      if (isStylusPointer(e)) {
        palmState.lastPenTimestamp = Date.now();
        if (longPress?.pointerType === 'touch') cancelLongPress();
      } else if (
        shouldRejectPalmTouch(e.pointerType, {
          isPenDrawing: live.current !== null || palmState.isPenDrawing,
          lastPenTimestamp: palmState.lastPenTimestamp,
        })
      ) {
        if (longPress?.pointerType === 'touch') cancelLongPress();
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      if (longPress && longPress.pointerId === e.pointerId && Math.hypot(e.clientX - longPress.x, e.clientY - longPress.y) > LONG_PRESS_RADIUS) {
        cancelLongPress();
      }
      // S-Pen / 하드웨어 지우개 호버 시 터치 스크롤 제스처가 필기/지우기를 가로채지 않도록
      if (isStylusPointer(e) && (useSettings.getState().tool !== 'none' || isEraserPointer(e))) {
        viewport.style.touchAction = 'none';
      }
      const l = live.current;
      if (!l || l.pointerId !== e.pointerId) return;
      e.preventDefault();
      const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [e];
      const list = events.length ? events : [e];
      if (l.kind === 'draw') {
        for (const ce of list) {
          const p = toPage(ce);
          const pressure = normalizePenPressure(ce.pressure, ce.pointerType);
          l.stroke = { ...l.stroke, points: [...l.stroke.points, [p.x, p.y, pressure] as StrokePoint] };
        }
      } else if (l.kind === 'lasso') {
        for (const ce of list) l.poly.push(toPage(ce));
        const closed = extractClosedLassoPolygon(l.poly, { closeDistance: 24, minLoopLength: 36 });
        if (closed) {
          l.closedPoly = closed;
          const ids = session.strokes.getAll().filter((s) => strokeInPolygon(s.points, closed)).map((s) => s.id);
          session.patch({ lassoIds: ids, moveMode: ids.length > 0 });
        } else if (l.closedPoly) {
          l.closedPoly = null;
          if (session.ui.lassoIds.length > 0) {
            session.patch({ lassoIds: [], moveMode: false });
          }
        }
      } else if (l.kind === 'erase') {
        const radius = useSettings.getState().eraserSize;
        for (const ce of list) {
          const p = toPage(ce);
          l.trail.push(p);
          handleEraserMove(p.x, p.y, radius);
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
      if (e.pointerType === 'touch') {
        activeTouchIds.delete(e.pointerId);
      }
      if (isStylusPointer(e)) {
        palmState.isPenDrawing = false;
        palmState.lastPenTimestamp = Date.now();
      }
      if (longPress?.pointerId === e.pointerId) cancelLongPress();
      const l = live.current;
      if (!l || l.pointerId !== e.pointerId) return;
      live.current = null;
      if (typeof viewport.hasPointerCapture === 'function' && viewport.hasPointerCapture(e.pointerId)) {
        try {
          viewport.releasePointerCapture(e.pointerId);
        } catch {
          /* ignore synthetic event capture errors */
        }
      }
      if (l.kind === 'draw' && !cancelled) {
        session.strokes.addStroke(l.stroke);
      } else if (l.kind === 'lasso') {
        if (cancelled) {
          session.patch({ lassoIds: [], moveMode: false });
        } else {
          const closed = l.closedPoly ?? extractClosedLassoPolygon(l.poly, { closeDistance: 36, minLoopLength: 36 });
          if (closed) {
            const ids = session.strokes.getAll().filter((s) => strokeInPolygon(s.points, closed)).map((s) => s.id);
            session.patch({ lassoIds: ids, moveMode: ids.length > 0 });
          } else {
            // 올가미가 closed curve 가 되지 않고 S펜이 태블릿 화면에서 떼어지면 올가미는 사라지고 선택 해제된다
            session.patch({ lassoIds: [], moveMode: false });
          }
        }
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
      if (isStylusPointer(e)) viewport.style.touchAction = '';
    };
    const onContextMenu = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest('[data-overlay]')) return;
      e.preventDefault();
      const r = session.pageEl!.getBoundingClientRect();
      const z = session.ui.zoom || 1;
      useContextMenu.getState().show({
        x: e.clientX,
        y: e.clientY,
        noteId: session.id,
        pagePoint: { x: (e.clientX - r.left) / z, y: (e.clientY - r.top) / z },
      });
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
