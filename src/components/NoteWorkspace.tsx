import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AlertTriangle, RefreshCw, Lock, Plus, ArrowUp } from 'lucide-react';
import { openSession, type NoteSession } from '../session/NoteSession';
import { useSessionUI } from '../store/sessionStore';
import { useSettings } from '../store/settingsStore';
import { useTabs } from '../store/tabsStore';
import { toast } from '../store/uiStore';
import { InkCanvas } from '../canvas/InkCanvas';
import { OverlayLayer } from './OverlayLayer';
import { SelectionMenu } from './SelectionMenu';
import { WikiPreview, openWikiTarget } from './WikiPreview';
import {
  computePinchZoom,
  DEFAULT_NOTE_ZOOM,
  getPageDimensions,
  PAGE_STYLE_LABELS,
  PULL_UP_THRESHOLD_PX,
  shouldCreatePageOnPullUp,
  touchDistance,
} from '../core/page/pageTypes';
import { resolveFontById } from '../core/font/fontManager';
import { shouldRejectPalmTouch, type PalmRejectionState } from '../core/android/androidDeployment';

export const PAGE_WIDTH = 840;

/** 탭 하나의 하이브리드 워크스페이스 (Layer1 에디터 / Layer2 캔버스 / Layer3 오버레이) */
export function NoteWorkspace({ noteId, active }: { noteId: string; active: boolean }) {
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
  return <LoadedWorkspace session={session} active={active} />;
}

function LoadedWorkspace({ session, active }: { session: NoteSession; active: boolean }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const ui = useSessionUI(session.id);
  const { docFormat, defaultPaperSize, defaultPageStyle, defaultOrientation, selectedFontId, customFonts } = useSettings();
  const strokes = useSyncExternalStore(session.strokes.subscribe, session.strokes.getAll);
  const [hoverLink, setHoverLink] = useState<HTMLElement | null>(null);
  const [pullUpDelta, setPullUpDelta] = useState(0);
  const pendingScroll = useTabs((s) => s.pendingScroll[session.id]);

  const activeFont = resolveFontById(selectedFontId, customFonts);
  const pages =
    ui.pages.length > 0
      ? ui.pages
      : [{ id: 'default-page', size: defaultPaperSize, style: defaultPageStyle, orientation: defaultOrientation }];
  const currentPageIndex = Math.max(0, Math.min(pages.length - 1, ui.currentPageIndex));
  const currentPage = pages[currentPageIndex] ?? pages[0];
  const currentDims = getPageDimensions(currentPage.size, currentPage.orientation);

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
    page.addEventListener('pointerover', over);
    page.addEventListener('pointerout', out);
    page.addEventListener('dblclick', dbl);
    return () => {
      page.removeEventListener('pointerover', over);
      page.removeEventListener('pointerout', out);
      page.removeEventListener('dblclick', dbl);
    };
  }, []);

  useEffect(() => {
    session.editor.setEditable(!ui.readOnly);
  }, [ui.readOnly, session]);

  // 터치 제스처:
  // 1) 두 손가락 핀치(확대/축소) 터치 무브먼트 → 노트 영역 실시간 확대/축소
  // 2) 한 손가락 위로 밀어 올리기(Pull-up) 제스처 → 현재 페이지 바로 밑에 동일 규격·동일 스타일 페이지 자동 생성
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    let gesture: { startY: number; lastY: number; atBottom: boolean; pageIndex: number } | null = null;
    let touchPinch: { startDistance: number; startZoom: number } | null = null;
    let pointerPinch: { startDistance: number; startZoom: number } | null = null;
    const activeTouchPointers = new Map<number, { x: number; y: number }>();
    const palmState: PalmRejectionState = { isPenDrawing: false, lastPenTimestamp: 0 };

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
      if (shouldAdd && useSettings.getState().docFormat === 'paginated') {
        const created = session.addPageBelow(targetIdx);
        toast.success(`현재 페이지 아래에 동일한 규격(${created.size} · ${PAGE_STYLE_LABELS[created.style]})의 새 페이지가 생성되었습니다.`);
      }
    };

    const onTouchStart = (e: TouchEvent) => {
      if (shouldRejectPalmTouch('touch', palmState)) return;
      if (e.touches.length >= 2) {
        cancelPullUp();
        const d0 = touchDistance(
          { x: e.touches[0].clientX, y: e.touches[0].clientY },
          { x: e.touches[1].clientX, y: e.touches[1].clientY },
        );
        if (d0 > 0) {
          touchPinch = {
            startDistance: d0,
            startZoom: session.ui.zoom || DEFAULT_NOTE_ZOOM,
          };
        }
        return;
      }
      if (e.touches.length === 1 && !touchPinch) {
        startGesture(e.touches[0].clientY, e.target);
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      if (shouldRejectPalmTouch('touch', palmState)) {
        cancelPullUp();
        touchPinch = null;
        return;
      }
      if (e.touches.length >= 2) {
        cancelPullUp();
        const d = touchDistance(
          { x: e.touches[0].clientX, y: e.touches[0].clientY },
          { x: e.touches[1].clientX, y: e.touches[1].clientY },
        );
        if (!touchPinch && d > 0) {
          touchPinch = {
            startDistance: d,
            startZoom: session.ui.zoom || DEFAULT_NOTE_ZOOM,
          };
        } else if (touchPinch && d > 0) {
          if (e.cancelable) e.preventDefault();
          const nextZoom = computePinchZoom({
            startDistance: touchPinch.startDistance,
            currentDistance: d,
            startZoom: touchPinch.startZoom,
          });
          session.setZoom(nextZoom);
        }
        return;
      }
      if (!gesture || e.touches.length !== 1 || touchPinch) return;
      moveGesture(e.touches[0].clientY);
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (shouldRejectPalmTouch('touch', palmState)) {
        cancelPullUp();
        touchPinch = null;
        return;
      }
      if (touchPinch) {
        if (e.touches.length < 2) {
          touchPinch = null;
        }
        cancelPullUp();
        return;
      }
      const touch = e.changedTouches[0];
      endGesture(touch ? touch.clientY : undefined);
    };

    const onTouchCancel = () => {
      touchPinch = null;
      cancelPullUp();
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType === 'pen' || e.pointerType === 'eraser') {
        palmState.isPenDrawing = true;
        palmState.lastPenTimestamp = Date.now();
        cancelPullUp();
        activeTouchPointers.clear();
        pointerPinch = null;
        return;
      }
      if (e.pointerType !== 'touch' || shouldRejectPalmTouch(e.pointerType, palmState)) return;
      activeTouchPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (activeTouchPointers.size >= 2) {
        cancelPullUp();
        const [p1, p2] = [...activeTouchPointers.values()];
        const d0 = touchDistance(p1, p2);
        if (d0 > 0) {
          pointerPinch = {
            startDistance: d0,
            startZoom: session.ui.zoom || DEFAULT_NOTE_ZOOM,
          };
        }
        return;
      }
      startGesture(e.clientY, e.target);
    };

    const onPointerMove = (e: PointerEvent) => {
      if (e.pointerType === 'pen' || e.pointerType === 'eraser') {
        palmState.lastPenTimestamp = Date.now();
        return;
      }
      if (e.pointerType !== 'touch' || shouldRejectPalmTouch(e.pointerType, palmState)) return;
      if (activeTouchPointers.has(e.pointerId)) {
        activeTouchPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      }
      if (activeTouchPointers.size >= 2) {
        cancelPullUp();
        const [p1, p2] = [...activeTouchPointers.values()];
        const d = touchDistance(p1, p2);
        if (!pointerPinch && d > 0) {
          pointerPinch = {
            startDistance: d,
            startZoom: session.ui.zoom || DEFAULT_NOTE_ZOOM,
          };
        } else if (pointerPinch && d > 0) {
          const nextZoom = computePinchZoom({
            startDistance: pointerPinch.startDistance,
            currentDistance: d,
            startZoom: pointerPinch.startZoom,
          });
          session.setZoom(nextZoom);
        }
        return;
      }
      if (!gesture || pointerPinch) return;
      moveGesture(e.clientY);
    };

    const onPointerUp = (e: PointerEvent) => {
      if (e.pointerType === 'pen' || e.pointerType === 'eraser') {
        palmState.isPenDrawing = false;
        palmState.lastPenTimestamp = Date.now();
        return;
      }
      if (e.pointerType !== 'touch') return;
      activeTouchPointers.delete(e.pointerId);
      if (pointerPinch) {
        if (activeTouchPointers.size < 2) {
          pointerPinch = null;
        }
        cancelPullUp();
        return;
      }
      if (!gesture) return;
      endGesture(e.clientY);
    };

    const onPointerCancel = (e: PointerEvent) => {
      activeTouchPointers.delete(e.pointerId);
      if (activeTouchPointers.size < 2) pointerPinch = null;
      cancelPullUp();
    };

    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const delta = e.deltaY < 0 ? 0.1 : -0.1;
      session.zoomBy(delta);
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
  }, [session]);

  const zoom = ui.zoom || DEFAULT_NOTE_ZOOM;
  let maxY = 0;
  for (const s of strokes) for (const p of s.points) if (p[1] > maxY) maxY = p[1];
  const paginatedTotalHeight = pages.reduce((acc, p) => acc + getPageDimensions(p.size, p.orientation).height, 0);
  const minHeight =
    docFormat === 'paginated'
      ? Math.max(paginatedTotalHeight, maxY + 400)
      : Math.max(currentDims.height, 1400, maxY + 600);

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
        <div ref={viewportRef} data-testid="note-viewport" className="note-viewport absolute inset-0 overflow-auto">
          <div
            data-testid="note-zoom-sizer"
            className="mx-auto"
            style={{
              width: Math.round(currentDims.width * zoom),
              minHeight: Math.round(minHeight * zoom),
            }}
          >
            <div
              ref={pageRef}
              data-testid="note-page"
              data-doc-format={docFormat}
              data-paper-size={currentPage.size}
              data-zoom={zoom}
              className={`note-page relative ${docFormat === 'continuous' ? `page-style-${currentPage.style}` : 'note-page-paginated'}`}
              style={{
                width: currentDims.width,
                minHeight,
                fontFamily: activeFont.family,
                transform: zoom === 1 ? undefined : `scale(${zoom})`,
                transformOrigin: 'top left',
              }}
            >
              {/* 페이지 분리형(paginated)일 때 각 페이지 규격 시트 및 구분선 렌더링 */}
              {docFormat === 'paginated' && (
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
                        className={`page-sheet pointer-events-auto relative mx-auto shrink-0 page-style-${p.style} ${
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
              <div ref={hostRef} className="relative z-10" style={{ fontFamily: activeFont.family }} />
              <OverlayLayer session={session} />
            </div>
          </div>
          {docFormat === 'paginated' && pullUpDelta > 15 && (
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
        <InkCanvas session={session} viewportRef={viewportRef} active={active} />
      </div>
      {active && <SelectionMenu session={session} />}
      {active && hoverLink && <WikiPreview reference={hoverLink} onHoverChange={(h) => !h && setHoverLink(null)} />}
    </div>
  );
}
