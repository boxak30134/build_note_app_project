import { useCallback, useEffect, useRef, useState } from 'react';
import type { NoteSession } from '../session/NoteSession';
import { newStrokeId, type Stroke } from '../core/strokes/StrokeStore';
import {
  clientPointToPageLocal,
  extractClosedLassoPolygon,
  isApproximatelyStraight,
  isEraserPointer,
  resolveLassoPolygonOnRelease,
  straightenStrokePoints,
  strokeInPolygon,
  type Point,
  type StrokePoint,
} from '../core/geometry/geometry';
import { useSettings, activeColor } from '../store/settingsStore';
import { useSessions } from '../store/sessionStore';
import { useContextMenu } from '../store/contextMenuStore';
import { cachedBounds, drawIncrementalStrokeSegment, drawStroke, intersects, renderLassoFeedback } from './render';
import {
  appendStrokePoint,
  coalescedEventsOf,
  getLowLatencyContext,
  getStandardContext,
  predictedEventsOf,
} from './lowLatency';
import {
  globalPalmRejectionState,
  normalizePenPressure,
  recordGlobalPenDown,
  recordGlobalPenMove,
  recordGlobalPenUp,
  type PalmRejectionState,
} from '../core/android/androidDeployment';
import { isPointerInsidePageCanvasSurface } from '../core/input/gestureRouting';

const LONG_PRESS_MS = 500;
const LONG_PRESS_RADIUS = 5;

type Live =
  | { kind: 'draw'; pointerId: number; stroke: Stroke; lastRenderedIndex: number }
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
 * 단일 타일 캔버스의 높이 (px).
 * 태블릿(DPR 2.5~3.0) 환경에서도 1600 * 3.0 = 4800px 로 GPU 텍스처 상한(8192px) 내에 완벽하게 안착하여,
 * 25,000px 이상의 긴 다중 페이지 문서에서도 DPR 다운스케일 없이 100% 무손실 고해상도를 영구 유지한다.
 */
export const CHUNK_HEIGHT = 1600;

/**
 * [Layer 2] 2계층 더블 버퍼링 투명 벡터 캔버스:
 * - Committed Canvas (`canvasRef` / `chunkCanvasesRef`): 확정된 누적 필기 전용.
 * - Active Canvas (`wetRef`, `desynchronized: true`): 진행 중인 활성 획 전용 저지연 캔버스.
 */
export function InkCanvas({ session, viewportRef, active }: Props) {
  /** Committed Canvas (Dry ink): 첫 번째 청크(chunk 0) 바인딩 및 기존 테스트 호환용 ref */
  const canvasRef = useRef<HTMLCanvasElement>(null);
  /** Active Canvas (Wet ink): 진행 중인 획/올가미/지우개 커서 전용 저지연(desynchronized) 캔버스 */
  const wetRef = useRef<HTMLCanvasElement>(null);
  /** 긴 다중 페이지 문서를 분할 렌더링하기 위한 청크 캔버스 맵 (chunkIndex -> HTMLCanvasElement) */
  const chunkCanvasesRef = useRef<Map<number, HTMLCanvasElement>>(new Map());
  const [chunkCount, setChunkCount] = useState<number>(() => {
    const page = session.pageEl;
    if (page && page.offsetHeight > 0) {
      return Math.max(1, Math.ceil(page.offsetHeight / CHUNK_HEIGHT));
    }
    return 1;
  });
  const live = useRef<Live>(null);
  const predicted = useRef<StrokePoint[]>([]);
  const frame = useRef(0);
  const wetFrame = useRef(0);
  /** 방금 pointerup 에서 Committed Canvas 에 직접 베이크 완료한 스트로크 추적 (중복 Full Redraw 방지) */
  const lastBakedStrokeId = useRef<string | null>(null);
  const lastBakedStrokeCount = useRef<number>(-1);
  const prevViewState = useRef<{ lassoIds: unknown; zoom: number; active: boolean; sessionId: string } | null>(null);
  const lassoIds = useSessions((s) => s.sessions[session.id]?.lassoIds);
  const zoom = useSessions((s) => s.sessions[session.id]?.zoom ?? 1);

  const getPageDimensions = useCallback(() => {
    const viewport = viewportRef.current;
    const page = session.pageEl ?? viewport?.querySelector<HTMLElement>('.note-page') ?? null;
    if (page && !session.pageEl) {
      session.pageEl = page;
    }
    if (!viewport || !page) return null;
    const z = useSessions.getState().sessions[session.id]?.zoom || 1;
    const pr = page.getBoundingClientRect();
    const vr = viewport.getBoundingClientRect();
    const pageW =
      page.offsetWidth > 0 ? page.offsetWidth : pr.width > 0 ? pr.width / z : vr.width / z;
    const pageH =
      page.offsetHeight > 0 ? page.offsetHeight : pr.height > 0 ? pr.height / z : vr.height / z;
    if (pageW <= 0 || pageH <= 0) return null;

    const rawDpr = window.devicePixelRatio || 1;
    // 다중 페이지에서도 DPR 다운스케일을 완전 차단하고 무손실 최고 해상도(최소 1.0, 최대 3.0) 유지
    const dpr = Math.min(Math.max(rawDpr, 1), 3.0);
    return { pageW, pageH, dpr, z, viewport, page };
  }, [session, viewportRef]);

  const updateChunkCount = useCallback(() => {
    const dims = getPageDimensions();
    if (!dims) return;
    const count = Math.max(1, Math.ceil(dims.pageH / CHUNK_HEIGHT));
    setChunkCount((prev) => (prev !== count ? count : prev));
  }, [getPageDimensions]);

  const prepareChunk = useCallback(
    (chunkIndex: number, canvas: HTMLCanvasElement | null, shouldClear = true) => {
      const dims = getPageDimensions();
      if (!canvas || !dims) return null;
      const { pageW, pageH, dpr } = dims;
      const topY = chunkIndex * CHUNK_HEIGHT;
      // CSS style.height(CHUNK_HEIGHT)와 1:1 대응되도록 고정 청크 높이를 사용하여
      // pointerup 직후 pageH 증가(maxY 갱신)로 인해 canvas.height가 재할당되며 버퍼가 증발하는 현상을 원천 차단
      const chunkH = CHUNK_HEIGHT;

      const pad = 200;
      const view = {
        minX: -pad,
        minY: topY - pad,
        maxX: pageW + pad,
        maxY: topY + chunkH + pad,
      };

      const w = Math.max(1, Math.round(pageW * dpr));
      const h = Math.max(1, Math.round(chunkH * dpr));
      let resized = false;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        resized = true;
      }
      const ctx = getStandardContext(canvas);
      if (!ctx) return null;
      ctx.setTransform(dpr, 0, 0, dpr, 0, -topY * dpr);
      if (shouldClear) {
        ctx.clearRect(0, topY, pageW, chunkH);
      } else if (resized) {
        // 최초 마운트 또는 페이지 폭 변경으로 캔버스 버퍼가 초기화된 경우 기존 확정 획을 즉시 복원
        const existingStrokes = session.strokes.getAll();
        for (const s of existingStrokes) {
          if (intersects(cachedBounds(s), view)) {
            drawStroke(ctx, s);
          }
        }
      }
      return { ctx, view, topY, chunkH, pageW, pageH, dpr };
    },
    [getPageDimensions, session],
  );

  const prepareWet = useCallback(
    (shouldClear = true) => {
      const canvas = wetRef.current;
      const dims = getPageDimensions();
      if (!canvas || !dims) return null;
      const { pageW, pageH, dpr, viewport } = dims;

      let wetTop = 0;
      let wetHeight = pageH;
      if (pageH > CHUNK_HEIGHT * 2) {
        const vTop = viewport.scrollTop;
        wetTop = Math.max(0, Math.floor(vTop / CHUNK_HEIGHT) * CHUNK_HEIGHT);
        wetHeight = Math.min(pageH - wetTop, CHUNK_HEIGHT * 2);
      }

      const w = Math.max(1, Math.round(pageW * dpr));
      const h = Math.max(1, Math.round(wetHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      canvas.style.top = `${wetTop}px`;
      canvas.style.height = `${wetHeight}px`;

      const ctx = getLowLatencyContext(canvas);
      if (!ctx) return null;
      ctx.setTransform(dpr, 0, 0, dpr, 0, -wetTop * dpr);
      if (shouldClear) {
        ctx.clearRect(0, wetTop, pageW, wetHeight);
      }
      const pad = 200;
      const view = {
        minX: -pad,
        minY: wetTop - pad,
        maxX: pageW + pad,
        maxY: wetTop + wetHeight + pad,
      };
      return { ctx, view, wetTop, wetHeight, pageW, dpr };
    },
    [getPageDimensions],
  );

  /** 기존 코드 및 테스트 호환용 prepare */
  const prepare = useCallback(
    (canvas: HTMLCanvasElement | null, shouldClear = true) => {
      if (!canvas) return null;
      if (canvas === wetRef.current) {
        return prepareWet(shouldClear);
      }
      return prepareChunk(0, canvas, shouldClear);
    },
    [prepareWet, prepareChunk],
  );

  /**
   * pointerdown / pointermove 중 Active Canvas(wetRef)에 clearRect 없이 신규 세그먼트만 증분(Incremental)으로 이어 그린다.
   * 일반 펜 필기 시에는 Committed Canvas에도 동일 세그먼트를 증분 반영하여
   * pointerup 직후 wetCanvas 가 즉시 비워질 때 컴포지터 1프레임 지연으로 인한 깜빡임을 0ms 로 제거한다.
   */
  const drawWetIncremental = useCallback(() => {
    const l = live.current;
    if (l?.kind !== 'draw') return;
    const prevIdx = l.lastRenderedIndex;
    const wr = prepareWet(false);
    if (!wr) return;
    const nextIdx = drawIncrementalStrokeSegment(wr.ctx, l.stroke, prevIdx);
    if (l.stroke.tool !== 'highlighter') {
      const lastPt = l.stroke.points[l.stroke.points.length - 1];
      const chunkIdx = lastPt ? Math.max(0, Math.floor(lastPt[1] / CHUNK_HEIGHT)) : 0;
      const targetCanvas = chunkCanvasesRef.current.get(chunkIdx) || canvasRef.current;
      if (targetCanvas) {
        const dr = prepareChunk(chunkIdx, targetCanvas, false);
        if (dr) {
          drawIncrementalStrokeSegment(dr.ctx, l.stroke, prevIdx);
        }
      }
    }
    l.lastRenderedIndex = nextIdx;
  }, [prepareWet, prepareChunk]);

  const drawWet = useCallback(() => {
    const l = live.current;
    if (l?.kind === 'draw') {
      drawWetIncremental();
      return;
    }
    const r = prepareWet(true);
    if (!r) return;
    const { ctx } = r;
    if (l?.kind === 'lasso' && l.poly.length > 0) {
      renderLassoFeedback(ctx, l.poly, l.closedPoly);
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
  }, [prepareWet, drawWetIncremental]);

  const draw = useCallback(() => {
    updateChunkCount();
    const allStrokes = session.strokes.getAll();
    const sel = useSessions.getState().sessions[session.id]?.lassoIds ?? [];
    const b = sel.length ? session.strokes.boundsOf(sel) : null;

    if (chunkCanvasesRef.current.size > 0) {
      chunkCanvasesRef.current.forEach((canvas, chunkIdx) => {
        const r = prepareChunk(chunkIdx, canvas, true);
        if (!r) return;
        const { ctx, view } = r;
        for (const s of allStrokes) {
          if (!intersects(cachedBounds(s), view)) continue;
          drawStroke(ctx, s);
        }
        if (b && intersects(b, view)) {
          ctx.save();
          ctx.setLineDash([5, 4]);
          ctx.strokeStyle = '#6366f1';
          ctx.lineWidth = 1.2;
          ctx.strokeRect(b.minX - 6, b.minY - 6, b.maxX - b.minX + 12, b.maxY - b.minY + 12);
          ctx.restore();
        }
      });
    } else if (canvasRef.current) {
      const r = prepareChunk(0, canvasRef.current, true);
      if (r) {
        const { ctx, view } = r;
        for (const s of allStrokes) {
          if (!intersects(cachedBounds(s), view)) continue;
          drawStroke(ctx, s);
        }
        if (b && intersects(b, view)) {
          ctx.save();
          ctx.setLineDash([5, 4]);
          ctx.strokeStyle = '#6366f1';
          ctx.lineWidth = 1.2;
          ctx.strokeRect(b.minX - 6, b.minY - 6, b.maxX - b.minX + 12, b.maxY - b.minY + 12);
          ctx.restore();
        }
      }
    }

    // 같은 프레임에서 wet 레이어도 갱신 → 펜을 뗄 때 dry 전환 깜빡임 없음
    drawWet();
  }, [session, prepareChunk, drawWet, updateChunkCount]);

  const requestDraw = useCallback(() => {
    cancelAnimationFrame(frame.current);
    cancelAnimationFrame(wetFrame.current);
    wetFrame.current = 0;
    frame.current = requestAnimationFrame(draw);
  }, [draw]);

  /** 필기 중에는 wet 레이어만 다시 그린다 (확정 스트로크 전체 재렌더 없음) */
  const requestWet = useCallback(() => {
    if (wetFrame.current) return;
    wetFrame.current = requestAnimationFrame(() => {
      wetFrame.current = 0;
      drawWet();
    });
  }, [drawWet]);

  // 1. 외부 스트로크 변경(Undo/Redo, 다른 모듈의 획 갱신) 구독: 필기 중이 아닐 때만 Committed Canvas 재렌더
  useEffect(() => {
    const unsubscribe = session.strokes.subscribe(() => {
      // 펜 필기 중(live kind === 'draw')에는 실시간 획을 방해하지 않음
      if (live.current !== null && live.current.kind === 'draw') return;
      const allStrokes = session.strokes.getAll();
      const latestId = allStrokes.length > 0 ? allStrokes[allStrokes.length - 1].id : null;
      if (
        allStrokes.length > 0 &&
        allStrokes.length === lastBakedStrokeCount.current &&
        latestId === lastBakedStrokeId.current
      ) {
        // pointerup 시 이미 drawImage 로 Committed Canvas 에 직접 베이크 완료된 획이므로 중복 Full Redraw 생략
        return;
      }
      lastBakedStrokeCount.current = allStrokes.length;
      lastBakedStrokeId.current = latestId;
      requestDraw();
    });
    return unsubscribe;
  }, [session, requestDraw]);

  // 2. 뷰 상태 변경(올가미 선택, 줌, 탭 활성화) 시에만 캔버스 재렌더
  useEffect(() => {
    const prev = prevViewState.current;
    const viewChanged =
      !prev ||
      prev.lassoIds !== lassoIds ||
      prev.zoom !== zoom ||
      prev.active !== active ||
      prev.sessionId !== session.id;
    prevViewState.current = { lassoIds, zoom, active, sessionId: session.id };

    if (viewChanged) {
      requestDraw();
    }
  }, [lassoIds, zoom, active, session.id, requestDraw]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    let orientationTimer: ReturnType<typeof setTimeout> | null = null;
    let lastResizeKey = '';
    const onResizeObserve = () => {
      const page = session.pageEl;
      const pr = page ? page.getBoundingClientRect() : viewport.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const pw = page && page.offsetWidth > 0 ? page.offsetWidth : pr.width;
      const ph = page && page.offsetHeight > 0 ? page.offsetHeight : pr.height;
      const key = `${Math.round(pw * dpr)}x${Math.round(ph * dpr)}`;
      if (key === lastResizeKey) return;
      lastResizeKey = key;
      updateChunkCount();
      requestDraw();
    };
    const onOrientationChange = () => {
      updateChunkCount();
      requestDraw();
      if (orientationTimer) clearTimeout(orientationTimer);
      orientationTimer = setTimeout(() => {
        updateChunkCount();
        requestDraw();
      }, 120);
    };
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onResizeObserve) : null;
    ro?.observe(viewport);
    const pageEl = session.pageEl ?? viewport.querySelector<HTMLElement>('.note-page');
    if (pageEl) ro?.observe(pageEl);
    updateChunkCount();
    // [핵심] 캔버스는 pageEl 내부(position: absolute; inset: 0)에 결합되어 브라우저 하드웨어 컴포지터에서
    // 페이지와 1:1 동시 스크롤되므로, 스크롤 시 JS clearRect/translate 재렌더링(onScroll)을 수행하지 않는다.
    window.addEventListener('resize', requestDraw);
    window.addEventListener('orientationchange', onOrientationChange);
    window.visualViewport?.addEventListener('resize', requestDraw);
    return () => {
      if (orientationTimer) clearTimeout(orientationTimer);
      ro?.disconnect();
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
      const z = session.ui.zoom || 1;
      return clientPointToPageLocal(e.clientX, e.clientY, session.pageEl!, viewport, z);
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

      // 펜이 이미 용지 내부에서 필기 중일 때 들어온 손바닥 터치는 용지 안팎 무관하게 즉시 차단
      if (e.pointerType === 'touch') {
        if (palmState.isPenDrawing || globalPalmRejectionState.isPenDrawing || live.current !== null) {
          if (longPress?.pointerType === 'touch') cancelLongPress();
          e.preventDefault();
          e.stopPropagation();
          return;
        }
      }

      // [Hit-Testing Guard] S-Pen(pointerType === 'pen')이라 하더라도 실제 활성 노트 용지(.page-canvas-surface)
      // 내부가 아닌 회색 여백, 사이드바, 툴바, 버튼 위에서 발생한 경우 preventDefault/stopPropagation/setPointerCapture를
      // 절대 호출하지 않고 하위 DOM 클릭·스크롤로 100% 바이패스한다.
      if (!isPointerInsidePageCanvasSurface(e, session.pageEl, viewport)) {
        return;
      }

      const settings = useSettings.getState();
      const ui = session.ui;
      const hardwareEraser = isEraserPointer(e);

      if (isStylusPointer(e)) {
        palmState.isPenDrawing = true;
        palmState.lastPenTimestamp = Date.now();
        recordGlobalPenDown(palmState.lastPenTimestamp);
        // 손바닥이 먼저 닿아 대기 중이던 터치 롱프레스가 있으면 즉시 취소
        if (longPress?.pointerType === 'touch') cancelLongPress();
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
      // 2.3 제스처 판정 대기 차단: 호버 없이 바로 닿은 펜도 첫 샘플부터 스크롤 판정 지연 없이 필기
      viewport.style.touchAction = 'none';
      viewport.classList.add('is-inking');
      predicted.current = [];
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
        if (wetRef.current) {
          wetRef.current.style.opacity = '1';
          wetRef.current.style.mixBlendMode = '';
        }
        const box = ui.lassoIds.length ? session.strokes.boundsOf(ui.lassoIds) : null;
        const inBox = box && p.x >= box.minX - 8 && p.x <= box.maxX + 8 && p.y >= box.minY - 8 && p.y <= box.maxY + 8;
        if (box && inBox) {
          live.current = { kind: 'move', pointerId: e.pointerId, ids: ui.lassoIds.slice(), start: p, applied: { x: 0, y: 0 }, target: { x: 0, y: 0 } };
        } else {
          session.patch({ lassoIds: [], moveMode: false });
          live.current = { kind: 'lasso', pointerId: e.pointerId, poly: [p], closedPoly: null };
          drawWet();
        }
        return;
      } else if (effectiveTool === 'eraser') {
        live.current = { kind: 'erase', pointerId: e.pointerId, commandId: undefined, trail: [p] };
        handleEraserMove(p.x, p.y, settings.eraserSize);
        // 지우개가 페이지에 닿았을 때 삭제된 획이 없으면 Committed Canvas 전체 재렌더를 호출하지 않고 지우개 커서(wet)만 갱신
        requestWet();
        return;
      } else {
        const tool = effectiveTool;
        if (wetRef.current) {
          wetRef.current.style.opacity = tool === 'highlighter' ? '0.35' : '1';
          wetRef.current.style.mixBlendMode = tool === 'highlighter' ? 'multiply' : '';
        }
        if (canvasRef.current && canvasRef.current.width === 0) {
          prepare(canvasRef.current, false);
        }
        live.current = {
          kind: 'draw',
          pointerId: e.pointerId,
          lastRenderedIndex: 0,
          stroke: {
            id: newStrokeId(),
            tool,
            penType: settings.penType,
            color: activeColor(),
            size: tool === 'highlighter' ? settings.highlighterSize : settings.penSize,
            points: [[p.x, p.y, pressure]],
          },
        };
        drawWetIncremental();
        return;
      }
      requestDraw();
    };

    const onPointerMove = (e: PointerEvent) => {
      if (isStylusPointer(e)) {
        if (live.current !== null) {
          palmState.lastPenTimestamp = Date.now();
          recordGlobalPenMove(palmState.lastPenTimestamp);
        }
        if (longPress?.pointerType === 'touch') cancelLongPress();
      } else if (e.pointerType === 'touch') {
        if (palmState.isPenDrawing || globalPalmRejectionState.isPenDrawing || live.current !== null) {
          if (longPress?.pointerType === 'touch') cancelLongPress();
          e.preventDefault();
          e.stopPropagation();
          return;
        }
      }

      if (longPress && longPress.pointerId === e.pointerId && Math.hypot(e.clientX - longPress.x, e.clientY - longPress.y) > LONG_PRESS_RADIUS) {
        cancelLongPress();
      }
      const l = live.current;
      if (!l || l.pointerId !== e.pointerId) return;
      e.preventDefault();
      e.stopPropagation(); // 필기 중 펜 이동이 상위 패닝/줌 핸들러로 버블링되어 화면이 끌리는 것을 차단
      // 2.2 S-Pen 240Hz 원시 샘플 전수 복원
      const list = coalescedEventsOf(e);
      if (l.kind === 'draw') {
        for (const ce of list) {
          const p = toPage(ce);
          appendStrokePoint(l.stroke.points, [p.x, p.y, normalizePenPressure(ce.pressure, ce.pointerType)]);
        }
        // 예측 잉크: 다음 프레임 펜 위치를 미리 그려 체감 지연을 줄인다 (저장 X)
        predicted.current = predictedEventsOf(e).map((pe) => {
          const p = toPage(pe);
          return [p.x, p.y, normalizePenPressure(pe.pressure, pe.pointerType)] as StrokePoint;
        });
        // pointermove 중에는 clearRect 를 호출하지 않고 신규 샘플 구간만 증분(Incremental) 드로잉한다
        drawWetIncremental();
        return;
      } else if (l.kind === 'lasso') {
        for (const ce of list) l.poly.push(toPage(ce));
        const closed = extractClosedLassoPolygon(l.poly, { closeDistance: 24, minLoopLength: 36 });
        if (closed) {
          l.closedPoly = closed;
        } else if (l.closedPoly) {
          l.closedPoly = null;
        }
        drawWet();
        return;
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
      // 올가미 궤적·지우개 커서는 wet 레이어만 갱신 (스트로크 변경 시 dry 는 store 구독으로 재렌더)
      requestWet();
    };

    const finish = (e: PointerEvent, cancelled: boolean) => {
      if (e.pointerType === 'touch') {
        activeTouchIds.delete(e.pointerId);
      }
      if (isStylusPointer(e)) {
        palmState.isPenDrawing = false;
        palmState.lastPenTimestamp = 0;
        recordGlobalPenUp(Date.now());
      }
      if (longPress?.pointerId === e.pointerId) cancelLongPress();
      const l = live.current;
      if (!l) return;
      if (l.pointerId !== e.pointerId && !isStylusPointer(e)) return;
      live.current = null;
      predicted.current = [];
      viewport.classList.remove('is-inking');
      // 필기 종료 즉시 뷰포트 터치 제스처·스크롤 즉각 복원
      viewport.style.touchAction = '';
      if (typeof viewport.hasPointerCapture === 'function' && viewport.hasPointerCapture(e.pointerId)) {
        try {
          viewport.releasePointerCapture(e.pointerId);
        } catch {
          /* ignore synthetic event capture errors */
        }
      }
      if (l.kind === 'draw') {
        cancelAnimationFrame(frame.current);
        frame.current = 0;
        cancelAnimationFrame(wetFrame.current);
        wetFrame.current = 0;
        const wetCanvas = wetRef.current;
        const dryCanvas = canvasRef.current;
        // pointercancel 이 발생하더라도 사용자가 실제 입력한 획 점이 있으면 절대 폐기하지 않고 영구 보존
        if (l.stroke.points.length > 0) {
          let finalStroke = l.stroke;
          let straightened = false;
          const currentSettings = useSettings.getState();
          if (
            currentSettings.autoStraighten &&
            l.stroke.tool !== 'highlighter' &&
            isApproximatelyStraight(l.stroke.points)
          ) {
            finalStroke = {
              ...l.stroke,
              points: straightenStrokePoints(l.stroke.points),
            };
            straightened = true;
          }

          // 1) 직선 보정 발동 시: 보정 전 곡선 흔적을 정리하기 위해 스토어 반영 후 전체 재렌더
          if (straightened) {
            session.strokes.addStroke(finalStroke);
            if (wetCanvas) {
              wetCanvas.style.opacity = '1';
              wetCanvas.style.mixBlendMode = '';
              prepare(wetCanvas, true);
            }
            draw();
            return;
          }

          // 2) 미렌더링 잔여 점이 있으면 Active Canvas 에 마저 증분 렌더링
          if (wetCanvas && l.lastRenderedIndex < finalStroke.points.length) {
            const wr = prepare(wetCanvas, false);
            if (wr) {
              l.lastRenderedIndex = drawIncrementalStrokeSegment(wr.ctx, finalStroke, l.lastRenderedIndex);
            }
          }

          // 3) Committed Canvas(청크 타일)에 세그먼트 반영 및 베이킹
          const dims = getPageDimensions();
          const dpr = dims?.dpr || window.devicePixelRatio || 1;
          const pageH = dims?.pageH || 0;
          const sBounds = cachedBounds(finalStroke);
          const startChunk = Math.max(0, Math.floor(sBounds.minY / CHUNK_HEIGHT));
          const endChunk = Math.max(startChunk, Math.floor(sBounds.maxY / CHUNK_HEIGHT));

          const wetTop = parseFloat(wetCanvas?.style.top || '0') || 0;
          const wetHeight = parseFloat(wetCanvas?.style.height || `${pageH}`) || pageH;
          let allChunksBaked = true;

          for (let c = startChunk; c <= endChunk; c++) {
            const chunkCanvas = chunkCanvasesRef.current.get(c) || (c === 0 ? dryCanvas : null);
            if (!chunkCanvas) {
              allChunksBaked = false;
              continue;
            }
            const cr = prepareChunk(c, chunkCanvas, false);
            const chunkCtx = cr?.ctx ?? getStandardContext(chunkCanvas);
            const topY = c * CHUNK_HEIGHT;
            const chunkH = CHUNK_HEIGHT;
            const overlapTop = Math.max(topY, wetTop);
            const overlapBottom = Math.min(topY + chunkH, wetTop + wetHeight);

            if (
              finalStroke.tool !== 'highlighter' &&
              chunkCtx &&
              wetCanvas &&
              wetCanvas.width > 0 &&
              wetCanvas.height > 0 &&
              chunkCanvas.width > 0 &&
              chunkCanvas.height > 0 &&
              overlapBottom > overlapTop
            ) {
              const overlapH = overlapBottom - overlapTop;
              const sy = Math.round((overlapTop - wetTop) * dpr);
              const sh = Math.min(wetCanvas.height - sy, Math.round(overlapH * dpr));
              const dy = Math.round((overlapTop - topY) * dpr);
              const dh = Math.min(chunkCanvas.height - dy, Math.round(overlapH * dpr));
              const sw = Math.min(wetCanvas.width, chunkCanvas.width);

              chunkCtx.save();
              chunkCtx.setTransform(1, 0, 0, 1, 0, 0); // [핵심 1] 1:1 디바이스 픽셀 전사 (DPR 중복 스케일링 완전 차단)
              if (c === 0 && sy === 0 && dy === 0 && chunkCanvas.width === wetCanvas.width) {
                // 단일 청크 1:1 원점 전사
                chunkCtx.drawImage(wetCanvas, 0, 0);
              } else if (sw > 0 && sh > 0 && dh > 0) {
                chunkCtx.drawImage(wetCanvas, 0, sy, sw, sh, 0, dy, sw, dh);
              }
              chunkCtx.restore();
            }

            // [핵심 2] desynchronized 하드웨어 오버레이 캔버스에서 drawImage가 빈 백버퍼를 복사하는 브라우저/WebView 환경을 방어하기 위해
            // 논리 좌표계(prepareChunk)에서 벡터 스트로크(drawStroke)도 확정 렌더링하여 획 증발을 100% 원천 차단
            if (cr) {
              drawStroke(cr.ctx, finalStroke);
            }
          }

          // 4) 베이크 완료 직후 Active Canvas 만 단독 초기화
          if (wetCanvas) {
            wetCanvas.style.opacity = '1';
            wetCanvas.style.mixBlendMode = '';
            prepareWet(true);
          }

          if (allChunksBaked) {
            lastBakedStrokeId.current = finalStroke.id;
            lastBakedStrokeCount.current = session.strokes.getAll().length + 1;
          }
          session.strokes.addStroke(finalStroke);
          updateChunkCount();
        } else if (wetCanvas) {
          wetCanvas.style.opacity = '1';
          wetCanvas.style.mixBlendMode = '';
          prepareWet(true);
        }
        return;
      } else if (l.kind === 'erase') {
        cancelAnimationFrame(wetFrame.current);
        wetFrame.current = 0;
        if (wetRef.current) {
          prepare(wetRef.current, true);
        }
        return;
      } else if (l.kind === 'lasso') {
        if (cancelled) {
          session.patch({ lassoIds: [], moveMode: false });
        } else {
          const closed =
            l.closedPoly ??
            resolveLassoPolygonOnRelease(l.poly, { closeDistance: 48, minLoopLength: 24 });
          if (closed) {
            const ids = session.strokes
              .getAll()
              .filter((s) => strokeInPolygon(s.points, closed))
              .map((s) => s.id);
            session.patch({ lassoIds: ids, moveMode: ids.length > 0 });
          } else {
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
      // 지연(RAF) 없이 즉시 dry 캔버스에 렌더링하고 wet 레이어를 비워 전환 시 깜빡임/소실을 0ms 로 차단
      draw();
    };
    const onUp = (e: PointerEvent) => finish(e, false);
    const onCancel = (e: PointerEvent) => finish(e, true);
    const onLeave = () => {
      viewport.style.touchAction = '';
    };
    const onContextMenu = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest('[data-overlay]')) return;
      e.preventDefault();
      const z = session.ui.zoom || 1;
      useContextMenu.getState().show({
        x: e.clientX,
        y: e.clientY,
        noteId: session.id,
        pagePoint: clientPointToPageLocal(e.clientX, e.clientY, session.pageEl!, viewport, z),
      });
    };

    viewport.addEventListener('pointerdown', onPointerDown, { capture: true });
    viewport.addEventListener('pointermove', onPointerMove, { capture: true });
    viewport.addEventListener('pointerup', onUp, { capture: true });
    viewport.addEventListener('pointercancel', onCancel, { capture: true });
    viewport.addEventListener('pointerleave', onLeave);
    viewport.addEventListener('contextmenu', onContextMenu);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    return () => {
      cancelLongPress();
      viewport.removeEventListener('pointerdown', onPointerDown, { capture: true });
      viewport.removeEventListener('pointermove', onPointerMove, { capture: true });
      viewport.removeEventListener('pointerup', onUp, { capture: true });
      viewport.removeEventListener('pointercancel', onCancel, { capture: true });
      viewport.removeEventListener('pointerleave', onLeave);
      viewport.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
    };
  }, [session, viewportRef, prepare, prepareChunk, prepareWet, drawWetIncremental, requestDraw, requestWet, draw]);

  const initializedChunkCanvases = useRef<WeakSet<HTMLCanvasElement>>(new WeakSet());
  const chunkRefCallbacks = useRef<Map<number, (el: HTMLCanvasElement | null) => void>>(new Map());
  const getChunkRefCallback = useCallback(
    (index: number) => {
      let cb = chunkRefCallbacks.current.get(index);
      if (!cb) {
        cb = (el: HTMLCanvasElement | null) => {
          if (el) {
            chunkCanvasesRef.current.set(index, el);
            if (index === 0) {
              (canvasRef as React.MutableRefObject<HTMLCanvasElement | null>).current = el;
            }
            // [핵심 3] 초기 마운트 시점에만 1회 치수 초기화하고, 불필요한 리렌더링 주기마다의 width/height 재할당 차단
            if (!initializedChunkCanvases.current.has(el)) {
              const r = prepareChunk(index, el, false);
              if (r) {
                initializedChunkCanvases.current.add(el);
              }
            }
          } else {
            chunkCanvasesRef.current.delete(index);
            if (index === 0 && canvasRef.current === el) {
              (canvasRef as React.MutableRefObject<HTMLCanvasElement | null>).current = null;
            }
          }
        };
        chunkRefCallbacks.current.set(index, cb);
      }
      return cb;
    },
    [prepareChunk],
  );

  const currentDims = getPageDimensions();
  const effectiveChunkCount = currentDims ? Math.max(1, Math.ceil(currentDims.pageH / CHUNK_HEIGHT)) : chunkCount;

  return (
    <>
      {Array.from({ length: effectiveChunkCount }, (_, i) => {
        const topY = i * CHUNK_HEIGHT;
        return (
          <canvas
            key={i}
            ref={getChunkRefCallback(i)}
            data-testid={i === 0 ? 'ink-canvas-committed' : `ink-canvas-chunk-${i}`}
            className="ink-canvas ink-canvas-chunk pointer-events-none absolute left-0 w-full"
            style={{
              top: `${topY}px`,
              height: `${CHUNK_HEIGHT}px`,
            }}
            aria-hidden
          />
        );
      })}
      <canvas
        ref={wetRef}
        data-testid="ink-canvas-wet"
        className="ink-canvas-wet pointer-events-none absolute inset-x-0 w-full"
        aria-hidden
      />
    </>
  );
}
