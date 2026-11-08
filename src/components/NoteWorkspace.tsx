import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AlertTriangle, RefreshCw, Lock, Plus, ArrowUp } from 'lucide-react';
import { openSession, type NoteSession } from '../session/NoteSession';
import { useSessionUI } from '../store/sessionStore';
import { useSettings } from '../store/settingsStore';
import { useTabs } from '../store/tabsStore';
import { toast } from '../store/uiStore';
import { InkCanvas } from '../canvas/InkCanvas';
import { cachedBounds } from '../canvas/render';
import { OverlayLayer } from './OverlayLayer';
import { SelectionMenu } from './SelectionMenu';
import { WikiPreview, openWikiTarget } from './WikiPreview';
import {
  clampNoteZoom,
  computeFocalZoomScrollOffsets,
  computePdfPageLayout,
  computePinchZoom,
  createFocalZoomAnchor,
  DEFAULT_NOTE_ZOOM,
  extractInkTemplateDimensions,
  getPageDimensions,
  PAGE_STYLE_LABELS,
  PULL_UP_THRESHOLD_PX,
  shouldCreatePageOnPullUp,
  touchDistance,
  touchMidpoint,
  type FocalZoomAnchor,
} from '../core/page/pageTypes';
import { resolveFontById } from '../core/font/fontManager';
import {
  globalPalmRejectionState,
  recordGlobalPenDown,
  recordGlobalPenMove,
  recordGlobalPenUp,
  type PalmRejectionState,
} from '../core/android/androidDeployment';
import {
  computeSingleFingerPan,
  fingerTouchesOf,
  isGesturePointerType,
  isPointerInsidePageCanvasSurface,
  isStylusPointerType,
  PAN_INERTIA_DECAY,
  PAN_INERTIA_MIN_VELOCITY,
  updatePanVelocity,
  type Point2D,
} from '../core/input/gestureRouting';
import type { WorkspacePaneId } from '../core/android/nativeStylusBridge';

export const PAGE_WIDTH = 840;

/** 탭 하나의 하이브리드 워크스페이스 (Layer1 에디터 / Layer2 캔버스 / Layer3 오버레이) */
export function NoteWorkspace({
  noteId,
  active,
  paneId = 'primary',
}: {
  noteId: string;
  active: boolean;
  paneId?: WorkspacePaneId;
}) {
  const [session, setSession] = useState<NoteSession | null>(null);

  useEffect(() => {
    let alive = true;
    void openSession(noteId).then((s) => {
      if (!alive) return;
      if (!s) {
        toast.error('노트를 찾을 수 없어 탭을 닫았습니다.');
        useTabs.getState().closeTab(noteId);
        return;
      }
      setSession(s);
    });
    return () => {
      alive = false;
    };
  }, [noteId]);

  if (!session) {
    return <div className={active ? 'flex flex-1 items-center justify-center text-sm text-slate-400' : 'hidden'}>불러오는 중…</div>;
  }
  return <LoadedWorkspace session={session} active={active} paneId={paneId} />;
}

function LoadedWorkspace({
  session,
  active,
  paneId: _paneId,
}: {
  session: NoteSession;
  active: boolean;
  paneId: WorkspacePaneId;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const sizerRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const ui = useSessionUI(session.id);
  const settings = useSettings();
  const {
    docFormat,
    defaultPaperSize,
    defaultPageStyle,
    defaultOrientation,
    selectedFontId,
    customFonts,
    fontSize,
  } = settings;
  const maxY = useSyncExternalStore(session.strokes.subscribe, () => {
    let m = 0;
    for (const s of session.strokes.getAll()) {
      const b = cachedBounds(s);
      if (b.maxY > m) m = b.maxY;
    }
    return m > 0 ? Math.ceil(m / 200) * 200 : 0;
  });
  const [hoverLink, setHoverLink] = useState<HTMLElement | null>(null);
  const [pullUpDelta, setPullUpDelta] = useState(0);
  const pendingScroll = useTabs((s) => s.pendingScroll[session.id]);

  const activeFont = resolveFontById(selectedFontId, customFonts);
  const liveContent = session.editor && !session.editor.isDestroyed ? session.editor.getJSON() : session.record.content;
  const isPdfDoc = useMemo(() => {
    try {
      return JSON.stringify(liveContent).includes('inkTemplate');
    } catch {
      return false;
    }
  }, [liveContent, ui.pages.length]);
  const pages =
    ui.pages.length > 0
      ? ui.pages
      : [{ id: 'default-page', size: defaultPaperSize, style: defaultPageStyle, orientation: defaultOrientation }];
  const currentPageIndex = Math.max(0, Math.min(pages.length - 1, ui.currentPageIndex));
  const currentPage = pages[currentPageIndex] ?? pages[0];
  const currentDims = getPageDimensions(currentPage.size, currentPage.orientation);

  const paginatedTotalHeight = pages.reduce((acc, p) => acc + getPageDimensions(p.size, p.orientation).height, 0);
  const pdfLayout = useMemo(
    () =>
      isPdfDoc
        ? computePdfPageLayout(extractInkTemplateDimensions(liveContent, pages), currentDims.width)
        : null,
    [isPdfDoc, liveContent, pages, currentDims.width],
  );
  const minHeight = isPdfDoc && pdfLayout && pdfLayout.totalHeight > 0
    ? Math.max(pdfLayout.totalHeight, maxY > pdfLayout.totalHeight ? maxY + 48 : 0)
    : docFormat === 'paginated'
      ? Math.max(paginatedTotalHeight, maxY + 400)
      : Math.max(currentDims.height, 1400, maxY + 600);

  // 에디터 DOM 호스트 부착 (탭 전환 시에도 동일 인스턴스 유지)
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.appendChild(session.host);
    session.pageEl = pageRef.current;
    session.scrollEl = viewportRef.current;
    return () => {
      if (session.host.parentElement === host) host.removeChild(session.host);
    };
  }, [session]);

  // 위키링크 더블클릭 이동 → 타깃 단락 스크롤
  useEffect(() => {
    if (!active || !pendingScroll) return;
    const t = setTimeout(() => {
      const blockId = useTabs.getState().consumeScroll(session.id);
      if (!blockId) return;
      const el = pageRef.current?.querySelector(`[data-block-id="${CSS.escape(blockId)}"]`) as HTMLElement | null;
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        el.classList.add('flash-block');
        setTimeout(() => el.classList.remove('flash-block'), 1600);
      }
    }, 60);
    return () => clearTimeout(t);
  }, [active, pendingScroll, session]);

  // 위키링크 호버 미리보기 / 더블클릭 이동 (이벤트 위임)
  useEffect(() => {
    const page = pageRef.current;
    if (!page) return;
    let hideTimer: ReturnType<typeof setTimeout> | null = null;
    const over = (e: PointerEvent) => {
      const link = (e.target as HTMLElement).closest('.wiki-link') as HTMLElement | null;
      if (link) {
        if (hideTimer) clearTimeout(hideTimer);
        setHoverLink(link);
      }
    };
    const out = (e: PointerEvent) => {
      const link = (e.target as HTMLElement).closest('.wiki-link');
      if (link) {
        hideTimer = setTimeout(() => setHoverLink(null), 220);
      }
    };
    const dbl = (e: MouseEvent) => {
      const link = (e.target as HTMLElement).closest('.wiki-link') as HTMLElement | null;
      if (!link) return;
      e.preventDefault();
      setHoverLink(null);
      void openWikiTarget(link.dataset.targetDoc ?? '', link.dataset.targetBlock || null);
    };
    const onClickTemplate = (e: MouseEvent) => {
      const tpl = (e.target as HTMLElement).closest('[data-ink-template]') as HTMLElement | null;
      if (!tpl) return;
      const pageNum = Number(tpl.dataset.page);
      if (Number.isFinite(pageNum) && pageNum >= 1) {
        session.setCurrentPageIndex(pageNum - 1);
      }
    };
    page.addEventListener('pointerover', over);
    page.addEventListener('pointerout', out);
    page.addEventListener('dblclick', dbl);
    page.addEventListener('click', onClickTemplate);
    return () => {
      page.removeEventListener('pointerover', over);
      page.removeEventListener('pointerout', out);
      page.removeEventListener('dblclick', dbl);
      page.removeEventListener('click', onClickTemplate);
    };
  }, [session]);

  useEffect(() => {
    session.editor.setEditable(!ui.readOnly);
  }, [ui.readOnly, session]);

  // 터치 제스처:
  // 1) 두 손가락 핀치(확대/축소) 터치 무브먼트 → 노트 영역 실시간 확대/축소
  // 2) 한 손가락 위로 밀어 올리기(Pull-up) 제스처 → 현재 페이지 바로 밑에 동일 규격·동일 스타일 페이지 자동 생성
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    interface PinchSession {
      startDistance: number;
      startZoom: number;
      anchor: FocalZoomAnchor;
    }

    let gesture: { startY: number; lastY: number; atBottom: boolean; pageIndex: number } | null = null;
    let touchPinch: PinchSession | null = null;
    let pointerPinch: PinchSession | null = null;
    let pendingPinchZoom: number | null = null;
    const activeTouchPointers = new Map<number, { x: number; y: number }>();
    const palmState: PalmRejectionState = { isPenDrawing: false, lastPenTimestamp: 0 };
    // 뷰포트는 touch-action:none 이므로 1손가락 패닝(+관성)을 JS 로 직접 처리한다 (S-Pen 은 절대 진입 불가)
    let panVelocity: Point2D = { x: 0, y: 0 };
    let lastPanTime = 0;
    let inertiaRaf = 0;

    const stopInertia = () => {
      if (inertiaRaf) cancelAnimationFrame(inertiaRaf);
      inertiaRaf = 0;
    };

    const commitPinchZoomIfPending = () => {
      if (pendingPinchZoom !== null) {
        const finalZoom = pendingPinchZoom;
        pendingPinchZoom = null;
        session.setZoom(finalZoom);
        panVelocity = { x: 0, y: 0 };
      }
    };

    const startInertia = () => {
      stopInertia();
      if (Math.hypot(panVelocity.x, panVelocity.y) < PAN_INERTIA_MIN_VELOCITY) return;
      let last = performance.now();
      const step = (now: number) => {
        const dt = Math.min(64, now - last);
        last = now;
        viewport.scrollLeft -= panVelocity.x * dt;
        viewport.scrollTop -= panVelocity.y * dt;
        const decay = Math.pow(PAN_INERTIA_DECAY, dt / 16);
        panVelocity = { x: panVelocity.x * decay, y: panVelocity.y * decay };
        inertiaRaf = Math.hypot(panVelocity.x, panVelocity.y) < PAN_INERTIA_MIN_VELOCITY ? 0 : requestAnimationFrame(step);
      };
      inertiaRaf = requestAnimationFrame(step);
    };

    const applyZoomWithFocalOffsets = (
      nextZoom: number,
      offsets: { scrollTop: number; scrollLeft: number },
      isDirectGesture = false,
    ) => {
      const sizer = sizerRef.current;
      const page = pageRef.current;
      if (sizer) {
        sizer.style.width = `${Math.round(currentDims.width * nextZoom)}px`;
        sizer.style.minHeight = `${Math.round(minHeight * nextZoom)}px`;
      }
      if (page) {
        page.style.transform = nextZoom === 1 ? '' : `scale(${nextZoom})`;
        page.style.transformOrigin = 'top left';
      }
      viewport.scrollTop = offsets.scrollTop;
      viewport.scrollLeft = offsets.scrollLeft;
      if (isDirectGesture) {
        pendingPinchZoom = nextZoom;
      } else {
        session.setZoom(nextZoom);
      }
    };

    const buildPinchSession = (p1: { x: number; y: number }, p2: { x: number; y: number }, d: number): PinchSession => {
      const z0 = session.ui.zoom || DEFAULT_NOTE_ZOOM;
      const focal = touchMidpoint(p1, p2);
      const vRect = viewport.getBoundingClientRect();
      const pRect = pageRef.current?.getBoundingClientRect();
      return {
        startDistance: d,
        startZoom: z0,
        anchor: createFocalZoomAnchor(
          focal,
          z0,
          {
            scrollTop: viewport.scrollTop,
            scrollLeft: viewport.scrollLeft,
            rect: vRect,
          },
          pRect,
        ),
      };
    };

    const isAtBottom = () => {
      const remaining = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      return remaining <= 80;
    };

    const cancelPullUp = () => {
      if (gesture) {
        gesture = null;
        setPullUpDelta(0);
      }
    };

    const startGesture = (clientY: number, target: EventTarget | null) => {
      if (useSettings.getState().docFormat !== 'paginated') return;
      const sheetEl = (target as HTMLElement | null)?.closest?.('[data-page-index]') as HTMLElement | null;
      const pageIdx = sheetEl ? Number(sheetEl.dataset.pageIndex ?? session.ui.currentPageIndex) : session.ui.currentPageIndex;
      if (!Number.isNaN(pageIdx)) session.setCurrentPageIndex(pageIdx);
      gesture = {
        startY: clientY,
        lastY: clientY,
        atBottom: isAtBottom() || Boolean(sheetEl),
        pageIndex: Number.isNaN(pageIdx) ? session.ui.currentPageIndex : pageIdx,
      };
    };

    const moveGesture = (clientY: number) => {
      if (!gesture) return;
      gesture.lastY = clientY;
      const deltaUp = Math.max(0, gesture.startY - clientY);
      setPullUpDelta(deltaUp);
    };

    const endGesture = (clientY?: number) => {
      if (!gesture) return;
      const endY = clientY ?? gesture.lastY;
      const shouldAdd = shouldCreatePageOnPullUp({
        startY: gesture.startY,
        endY,
        pointerType: 'touch',
        atBottom: gesture.atBottom,
      });
      const targetIdx = gesture.pageIndex;
      gesture = null;
      setPullUpDelta(0);
      if (shouldAdd && (useSettings.getState().docFormat === 'paginated' || isPdfDoc)) {
        const created = session.addPageBelow(targetIdx);
        toast.success(`현재 페이지 아래에 동일한 규격(${created.size} · ${PAGE_STYLE_LABELS[created.style]})의 새 페이지가 생성되었습니다.`);
      }
    };

    const onTouchStart = (e: TouchEvent) => {
      if (palmState.isPenDrawing || globalPalmRejectionState.isPenDrawing) return;
      // S-Pen(stylus) 터치는 핀치/패닝 판정에서 배제 — 펜 + 손바닥이 2-터치 줌으로 오인되지 않도록 한다
      const fingers = fingerTouchesOf(e.touches);
      if (fingers.length >= 2) {
        cancelPullUp();
        const t1 = { x: fingers[0].clientX, y: fingers[0].clientY };
        const t2 = { x: fingers[1].clientX, y: fingers[1].clientY };
        const d0 = touchDistance(t1, t2);
        if (d0 > 0) {
          touchPinch = buildPinchSession(t1, t2, d0);
        }
        return;
      }
      if (fingers.length === 1 && e.touches.length === 1 && !touchPinch) {
        startGesture(fingers[0].clientY, e.target);
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      if (palmState.isPenDrawing || globalPalmRejectionState.isPenDrawing) {
        cancelPullUp();
        touchPinch = null;
        return;
      }
      const fingers = fingerTouchesOf(e.touches);
      if (fingers.length >= 2) {
        cancelPullUp();
        const t1 = { x: fingers[0].clientX, y: fingers[0].clientY };
        const t2 = { x: fingers[1].clientX, y: fingers[1].clientY };
        const d = touchDistance(t1, t2);
        if (!touchPinch && d > 0) {
          touchPinch = buildPinchSession(t1, t2, d);
        } else if (touchPinch && d > 0) {
          if (e.cancelable) e.preventDefault();
          const nextZoom = computePinchZoom({
            startDistance: touchPinch.startDistance,
            currentDistance: d,
            startZoom: touchPinch.startZoom,
          });
          const focal = touchMidpoint(t1, t2);
          const vRect = viewport.getBoundingClientRect();
          const offsets = computeFocalZoomScrollOffsets(touchPinch.anchor, nextZoom, focal, vRect);
          applyZoomWithFocalOffsets(nextZoom, offsets, true);
        }
        return;
      }
      if (!gesture || fingers.length !== 1 || e.touches.length !== 1 || touchPinch) return;
      moveGesture(fingers[0].clientY);
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (palmState.isPenDrawing || globalPalmRejectionState.isPenDrawing) {
        cancelPullUp();
        touchPinch = null;
        commitPinchZoomIfPending();
        return;
      }
      if (touchPinch) {
        if (fingerTouchesOf(e.touches).length < 2) {
          touchPinch = null;
          commitPinchZoomIfPending();
        }
        cancelPullUp();
        return;
      }
      const touch = e.changedTouches[0];
      endGesture(touch ? touch.clientY : undefined);
    };

    const onTouchCancel = () => {
      touchPinch = null;
      commitPinchZoomIfPending();
      cancelPullUp();
    };

    const onPointerDown = (e: PointerEvent) => {
      stopInertia();
      if (isStylusPointerType(e.pointerType)) {
        // 노트 용지(.page-canvas-surface) 바깥(회색 여백, 버튼 등)을 펜으로 터치할 때는 팜 리젝션/드로잉을 활성화하지 않고 바이패스
        if (!isPointerInsidePageCanvasSurface(e, pageRef.current, viewport)) {
          return;
        }
        palmState.isPenDrawing = true;
        palmState.lastPenTimestamp = Date.now();
        recordGlobalPenDown(palmState.lastPenTimestamp);
        cancelPullUp();
        activeTouchPointers.clear();
        pointerPinch = null;
        return;
      }
      // [가드] S-Pen·마우스는 뷰포트 이동/줌 추적 맵에 절대 등록하지 않으며, 타 패널 펜 필기 중에도 차단한다
      if (!isGesturePointerType(e.pointerType) || palmState.isPenDrawing || globalPalmRejectionState.isPenDrawing) return;
      activeTouchPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      panVelocity = { x: 0, y: 0 };
      lastPanTime = e.timeStamp || performance.now();
      if (activeTouchPointers.size >= 2) {
        cancelPullUp();
        const [p1, p2] = [...activeTouchPointers.values()];
        const d0 = touchDistance(p1, p2);
        if (d0 > 0) {
          pointerPinch = buildPinchSession(p1, p2, d0);
        }
        return;
      }
      startGesture(e.clientY, e.target);
    };

    const onPointerMove = (e: PointerEvent) => {
      if (isStylusPointerType(e.pointerType)) {
        if (palmState.isPenDrawing) {
          palmState.lastPenTimestamp = Date.now();
          recordGlobalPenMove(palmState.lastPenTimestamp);
        }
        return;
      }
      if (!isGesturePointerType(e.pointerType) || palmState.isPenDrawing || globalPalmRejectionState.isPenDrawing) return;
      const prev = activeTouchPointers.get(e.pointerId);
      if (!prev) return;
      activeTouchPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (activeTouchPointers.size >= 2) {
        cancelPullUp();
        const [p1, p2] = [...activeTouchPointers.values()];
        const d = touchDistance(p1, p2);
        if (!pointerPinch && d > 0) {
          pointerPinch = buildPinchSession(p1, p2, d);
        } else if (pointerPinch && d > 0) {
          const nextZoom = computePinchZoom({
            startDistance: pointerPinch.startDistance,
            currentDistance: d,
            startZoom: pointerPinch.startZoom,
          });
          const focal = touchMidpoint(p1, p2);
          const vRect = viewport.getBoundingClientRect();
          const offsets = computeFocalZoomScrollOffsets(pointerPinch.anchor, nextZoom, focal, vRect);
          applyZoomWithFocalOffsets(nextZoom, offsets, true);
        }
        return;
      }
      if (pointerPinch) return;
      // 1손가락 패닝: 손가락 이동량만큼 뷰포트 스크롤 이동 + 관성용 속도 추적
      const next = computeSingleFingerPan(prev, { x: e.clientX, y: e.clientY }, {
        scrollTop: viewport.scrollTop,
        scrollLeft: viewport.scrollLeft,
      });
      viewport.scrollLeft = next.scrollLeft;
      viewport.scrollTop = next.scrollTop;
      const now = e.timeStamp || performance.now();
      panVelocity = updatePanVelocity(panVelocity, { x: e.clientX - prev.x, y: e.clientY - prev.y }, now - lastPanTime);
      lastPanTime = now;
      if (!gesture) return;
      moveGesture(e.clientY);
    };

    const onPointerUp = (e: PointerEvent) => {
      if (isStylusPointerType(e.pointerType)) {
        palmState.isPenDrawing = false;
        palmState.lastPenTimestamp = 0;
        recordGlobalPenUp(Date.now());
        return;
      }
      if (!isGesturePointerType(e.pointerType)) return;
      if (!activeTouchPointers.delete(e.pointerId)) return;
      if (pointerPinch) {
        if (activeTouchPointers.size < 2) {
          pointerPinch = null;
          commitPinchZoomIfPending();
        }
        cancelPullUp();
        return;
      }
      // 손가락을 떼기 직전 100ms 이상 정지했다면 관성 없음
      if (activeTouchPointers.size === 0 && (e.timeStamp || performance.now()) - lastPanTime < 100) startInertia();
      if (!gesture) return;
      endGesture(e.clientY);
    };

    const onPointerCancel = (e: PointerEvent) => {
      if (isStylusPointerType(e.pointerType)) {
        palmState.isPenDrawing = false;
        palmState.lastPenTimestamp = 0;
        recordGlobalPenUp(Date.now());
      }
      activeTouchPointers.delete(e.pointerId);
      if (activeTouchPointers.size < 2) {
        pointerPinch = null;
        commitPinchZoomIfPending();
      }
      cancelPullUp();
    };

    const onWheel = (e: WheelEvent) => {
      stopInertia();
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const currentZoom = session.ui.zoom || DEFAULT_NOTE_ZOOM;
      const delta = e.deltaY < 0 ? 0.1 : -0.1;
      const nextZoom = clampNoteZoom(currentZoom + delta);
      if (nextZoom === currentZoom) return;

      const vRect = viewport.getBoundingClientRect();
      const pRect = pageRef.current?.getBoundingClientRect();
      const focal = { x: e.clientX, y: e.clientY };
      const anchor = createFocalZoomAnchor(
        focal,
        currentZoom,
        {
          scrollTop: viewport.scrollTop,
          scrollLeft: viewport.scrollLeft,
          rect: vRect,
        },
        pRect,
      );
      const offsets = computeFocalZoomScrollOffsets(anchor, nextZoom, focal, vRect);
      applyZoomWithFocalOffsets(nextZoom, offsets);
    };

    viewport.addEventListener('touchstart', onTouchStart, { passive: true });
    viewport.addEventListener('touchmove', onTouchMove, { passive: false });
    viewport.addEventListener('touchend', onTouchEnd);
    viewport.addEventListener('touchcancel', onTouchCancel);
    viewport.addEventListener('pointerdown', onPointerDown);
    viewport.addEventListener('pointermove', onPointerMove);
    viewport.addEventListener('pointerup', onPointerUp);
    viewport.addEventListener('pointercancel', onPointerCancel);
    viewport.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      stopInertia();
      viewport.removeEventListener('touchstart', onTouchStart);
      viewport.removeEventListener('touchmove', onTouchMove);
      viewport.removeEventListener('touchend', onTouchEnd);
      viewport.removeEventListener('touchcancel', onTouchCancel);
      viewport.removeEventListener('pointerdown', onPointerDown);
      viewport.removeEventListener('pointermove', onPointerMove);
      viewport.removeEventListener('pointerup', onPointerUp);
      viewport.removeEventListener('pointercancel', onPointerCancel);
      viewport.removeEventListener('wheel', onWheel);
    };
  }, [session, currentDims.width, minHeight]);

  // 뷰포트 스크롤 시 현재 화면에 보이는 페이지를 실시간 감지하여 currentPageIndex 동기화
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    let scrollRaf = 0;
    const onScroll = () => {
      cancelAnimationFrame(scrollRaf);
      scrollRaf = requestAnimationFrame(() => {
        const page = pageRef.current;
        if (!viewport || !page) return;
        const viewTop = viewport.scrollTop + 100;

        // 1. PDF 템플릿 페이지 감지
        const pdfPages = page.querySelectorAll<HTMLElement>('[data-ink-template]');
        if (pdfPages.length > 0) {
          for (let i = 0; i < pdfPages.length; i++) {
            const el = pdfPages[i];
            const top = el.offsetTop;
            const bottom = top + el.offsetHeight;
            if (viewTop >= top && viewTop <= bottom) {
              const pNum = Number(el.dataset.page || i + 1);
              session.setCurrentPageIndex(pNum - 1);
              return;
            }
          }
          return;
        }

        // 2. 분리형 페이지 시트 감지
        const sheets = page.querySelectorAll<HTMLElement>('[data-page-index]');
        if (sheets.length > 0) {
          for (let i = 0; i < sheets.length; i++) {
            const el = sheets[i];
            const top = el.offsetTop;
            const bottom = top + el.offsetHeight;
            if (viewTop >= top && viewTop <= bottom) {
              session.setCurrentPageIndex(i);
              return;
            }
          }
        }
      });
    };

    viewport.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(scrollRaf);
      viewport.removeEventListener('scroll', onScroll);
    };
  }, [session]);

  const zoom = ui.zoom || DEFAULT_NOTE_ZOOM;

  // [안정화 조치]: 불안정한 네이티브 오버레이 브릿지 비활성화 (순수 웹 고해상도 2계층 캔버스 단일 엔진 운영)
  useEffect(() => {
    // 네이티브 오버레이 터치 인터셉트 및 독자 렌더링을 비활성화하여
    // 좌표 불일치(상단바 이탈 등) 및 브릿지 레이스 컨디션(획 증발) 원천 차단
  }, []);

  return (
    <div className={active ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
      {ui.external === 'modified' && (
        <div className="flex items-center gap-3 border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
          <AlertTriangle size={16} />
          <span className="flex-1">이 파일이 다른 프로그램에서 변경되었습니다. 현재 편집 중인 내용과 다릅니다.</span>
          <button className="btn-ghost" onClick={() => void session.reloadFromDisk()}>
            <RefreshCw size={13} /> 디스크 내용으로 다시 불러오기
          </button>
          <button className="btn-ghost" onClick={() => session.keepMine()}>
            내 편집 내용 유지
          </button>
        </div>
      )}
      {ui.external === 'deleted' && (
        <div className="flex items-center gap-3 border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800">
          <Lock size={16} />
          <span className="flex-1">원본 파일이 외부에서 삭제되었습니다. 문서가 읽기 전용으로 전환되었습니다.</span>
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        <div
          ref={(el) => {
            viewportRef.current = el;
            if (el) session.scrollEl = el;
          }}
          data-testid="note-viewport"
          className="note-viewport absolute inset-0 overflow-auto"
        >
          <div
            ref={sizerRef}
            data-testid="note-zoom-sizer"
            className="mx-auto"
            style={{
              width: Math.round(currentDims.width * zoom),
              minHeight: Math.round(minHeight * zoom),
            }}
          >
            <div
              ref={(el) => {
                pageRef.current = el;
                if (el) session.pageEl = el;
              }}
              data-testid="note-page"
              data-doc-format={docFormat}
              data-paper-size={currentPage.size}
              data-zoom={zoom}
              className={`note-page page-canvas-surface relative ${docFormat === 'continuous' ? `page-style-${currentPage.style}` : 'note-page-paginated'} ${isPdfDoc ? 'note-page-pdf' : ''}`}
              style={{
                width: currentDims.width,
                minHeight,
                fontFamily: activeFont.family,
                fontSize: `${fontSize}px`,
                ['--note-font-size' as string]: `${fontSize}px`,
                transform: zoom === 1 ? undefined : `scale(${zoom})`,
                transformOrigin: 'top left',
              }}
            >
              {/* 페이지 분리형(paginated)일 때 각 페이지 규격 시트 및 구분선 렌더링 (PDF 템플릿 문서는 자체 ink-template 시트를 사용하므로 제외) */}
              {docFormat === 'paginated' && !isPdfDoc && (
                <div className="pointer-events-none absolute inset-0 z-0 flex flex-col">
                  {pages.map((p, idx) => {
                    const d = getPageDimensions(p.size, p.orientation);
                    const isCurrent = idx === currentPageIndex;
                    return (
                      <div
                        key={p.id}
                        data-testid="note-page-sheet"
                        data-page-index={idx}
                        data-page-size={p.size}
                        data-page-style={p.style}
                        data-page-orientation={p.orientation}
                        onClick={() => session.setCurrentPageIndex(idx)}
                        style={{ height: d.height, width: d.width }}
                        className={`page-sheet page-canvas-surface pointer-events-auto relative mx-auto shrink-0 page-style-${p.style} ${
                          isCurrent ? 'ring-1 ring-indigo-300/70' : ''
                        } ${idx < pages.length - 1 ? 'border-b-8 border-slate-200/90' : ''}`}
                      >
                        <div className="pointer-events-none absolute right-3 top-2 flex items-center gap-1.5 rounded bg-slate-100/80 px-2 py-0.5 text-[10px] font-medium text-slate-500">
                          <span>
                            Page {idx + 1} / {pages.length}
                          </span>
                          <span>·</span>
                          <span>{p.size}</span>
                          <span>·</span>
                          <span>{PAGE_STYLE_LABELS[p.style]}</span>
                        </div>
                        <div className="pointer-events-auto absolute bottom-2 right-3 z-20 flex items-center gap-1 opacity-75 transition hover:opacity-100">
                          <button
                            type="button"
                            data-testid={`add-page-below-${idx}`}
                            className="flex items-center gap-1 rounded-md border border-indigo-200 bg-white/90 px-2 py-0.5 text-[11px] font-medium text-indigo-600 shadow-sm hover:bg-indigo-50"
                            onClick={(e) => {
                              e.stopPropagation();
                              const created = session.addPageBelow(idx);
                              toast.success(`페이지 ${idx + 1} 아래에 새 페이지(${created.size})를 추가했습니다.`);
                            }}
                            title="이 페이지 바로 밑에 동일 규격·스타일 페이지 추가"
                          >
                            <Plus size={11} /> 아래에 페이지 추가
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              <div
                ref={hostRef}
                className="relative z-10"
                style={{
                  fontFamily: activeFont.family,
                  fontSize: `${fontSize}px`,
                  ['--note-font-size' as string]: `${fontSize}px`,
                }}
              />
              <InkCanvas session={session} viewportRef={viewportRef} active={active} />
              <OverlayLayer session={session} />
            </div>
          </div>
          {(docFormat === 'paginated' || isPdfDoc) && pullUpDelta > 15 && (
            <div
              data-testid="pull-up-indicator"
              className="mx-auto mb-6 flex w-fit items-center gap-1.5 rounded-full border border-indigo-200 bg-indigo-50 px-3 py-1 text-xs font-medium text-indigo-700 shadow-sm"
            >
              <ArrowUp size={13} className={pullUpDelta >= PULL_UP_THRESHOLD_PX ? 'animate-bounce text-indigo-600' : 'text-slate-400'} />
              {pullUpDelta >= PULL_UP_THRESHOLD_PX
                ? `손을 떼면 동일한 규격(${currentPage.size})의 새 페이지가 아래에 생성됩니다`
                : `위로 밀어 올려 새 페이지(${currentPage.size}) 추가`}
            </div>
          )}
        </div>
      </div>
      {active && <SelectionMenu session={session} />}
      {active && hoverLink && <WikiPreview reference={hoverLink} onHoverChange={(h) => !h && setHoverLink(null)} />}
    </div>
  );
}
