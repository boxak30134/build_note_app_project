import { useEffect, useRef, useState, useCallback, useMemo, useSyncExternalStore } from 'react';
import { ChevronLeft, ChevronRight, FileText, Layers, Plus, Trash2 } from 'lucide-react';
import type { NoteSession } from '../session/NoteSession';
import { useSessionUI } from '../store/sessionStore';
import { toast } from '../store/uiStore';
import {
  createPage,
  getPageDimensions,
  PAGE_STYLE_LABELS,
  type PageStyleId,
  type PaperSizeId,
  type PageOrientation,
} from '../core/page/pageTypes';
import { drawStroke } from '../canvas/render';
import { strokeBounds, type Stroke } from '../core/strokes/StrokeStore';
import {
  THUMBNAIL_SCROLL_DEBOUNCE_MS,
  thumbnailPipeline,
  type ThumbnailRenderTarget,
} from '../core/page/thumbnailPipeline';

export const THUMBNAIL_GRID_COLS = 2;
export const THUMBNAIL_ROW_HEIGHT = 172;
export const THUMBNAIL_JS_FALLBACK_THRESHOLD = 60;
export const THUMBNAIL_MAX_FALLBACK_MOUNTED = 10;

export interface PageItem {
  pageNumber: number; // 1-based (1, 2, ... N)
  templateSrc?: string;
  pdfSrc?: string;
  pdfPage?: number;
  width?: number;
  height?: number;
  size?: PaperSizeId;
  style?: PageStyleId;
  orientation?: PageOrientation;
}

/**
 * 사이드바 가상 스크롤 가시 범위 계산 (2열 그리드 기준 약 8~10개 아이템만 마운트).
 * - viewportHeight > 0 인 실제 스크롤 컨테이너에서는 현재 가시 행 기준 8~10개만 마운트한다.
 * - viewportHeight === 0 인 jsdom 비레이아웃 환경에서는 60장 이하 기존 테스트 호환을 유지하고,
 *   60장을 초과하는 대용량 문서는 activePageIndex 기준 최대 10개 윈도우만 마운트한다.
 */
export function computeThumbnailVirtualRange(
  totalItems: number,
  scrollTop: number,
  viewportHeight: number,
  activePageIndex = 0,
): { startIdx: number; endIdx: number; topSpacerHeight: number; bottomSpacerHeight: number } {
  if (totalItems <= 0) {
    return { startIdx: 0, endIdx: -1, topSpacerHeight: 0, bottomSpacerHeight: 0 };
  }
  const totalRows = Math.ceil(totalItems / THUMBNAIL_GRID_COLS);

  if (viewportHeight <= 0) {
    if (totalItems <= THUMBNAIL_JS_FALLBACK_THRESHOLD) {
      return { startIdx: 0, endIdx: totalItems - 1, topSpacerHeight: 0, bottomSpacerHeight: 0 };
    }
    const activeRow = Math.max(0, Math.min(totalRows - 1, Math.floor(activePageIndex / THUMBNAIL_GRID_COLS)));
    const maxRows = Math.max(1, Math.floor(THUMBNAIL_MAX_FALLBACK_MOUNTED / THUMBNAIL_GRID_COLS));
    const half = Math.floor(maxRows / 2);
    const startRow = Math.max(0, Math.min(totalRows - maxRows, activeRow - half));
    const endRow = Math.min(totalRows - 1, startRow + maxRows - 1);
    const startIdx = startRow * THUMBNAIL_GRID_COLS;
    const endIdx = Math.min(totalItems - 1, (endRow + 1) * THUMBNAIL_GRID_COLS - 1);
    return {
      startIdx,
      endIdx,
      topSpacerHeight: startRow * THUMBNAIL_ROW_HEIGHT,
      bottomSpacerHeight: Math.max(0, (totalRows - 1 - endRow) * THUMBNAIL_ROW_HEIGHT),
    };
  }

  const startRow = Math.max(0, Math.min(totalRows - 1, Math.floor(scrollTop / THUMBNAIL_ROW_HEIGHT)));
  const visibleRows = Math.max(1, Math.ceil(viewportHeight / THUMBNAIL_ROW_HEIGHT));
  // 2열 기준 8~10개(4~5행) 수준만 마운트되도록 상한을 5행(10개)으로 제한
  const boundedRows = Math.min(5, Math.max(4, visibleRows + 1));
  const endRow = Math.min(totalRows - 1, startRow + boundedRows - 1);
  const startIdx = startRow * THUMBNAIL_GRID_COLS;
  const endIdx = Math.min(totalItems - 1, (endRow + 1) * THUMBNAIL_GRID_COLS - 1);

  return {
    startIdx,
    endIdx,
    topSpacerHeight: startRow * THUMBNAIL_ROW_HEIGHT,
    bottomSpacerHeight: Math.max(0, (totalRows - 1 - endRow) * THUMBNAIL_ROW_HEIGHT),
  };
}

/** 노트 컨텐트 및 UI 상태에서 페이지 항목 목록을 추출한다 */
export function extractPageItems(session: NoteSession | null): PageItem[] {
  if (!session) return [];
  const content = session.record.content as { content?: Array<{ type: string; attrs?: Record<string, unknown> }> } | undefined;
  const templates: PageItem[] = [];

  // 1. PDF 템플릿 노드 (inkTemplate) 우선 수집
  if (content && Array.isArray(content.content)) {
    for (const node of content.content) {
      if (node.type === 'inkTemplate' && node.attrs) {
        const pageNum = Number(node.attrs.page) || templates.length + 1;
        const pdfSrc = typeof node.attrs.pdfSrc === 'string' && node.attrs.pdfSrc ? node.attrs.pdfSrc : undefined;
        const pdfPage = Number(node.attrs.pdfPage) || (pdfSrc ? pageNum : undefined);
        templates.push({
          pageNumber: pageNum,
          templateSrc: typeof node.attrs.src === 'string' ? node.attrs.src : undefined,
          pdfSrc,
          pdfPage,
          width: typeof node.attrs.width === 'number' ? node.attrs.width : 595,
          height: typeof node.attrs.height === 'number' ? node.attrs.height : 842,
        });
      }
    }
  }

  if (templates.length > 0) {
    return templates;
  }

  // 2. 일반 멀티페이지 문서 (ui.pages 또는 record.pages)
  const pages = session.ui.pages && session.ui.pages.length > 0
    ? session.ui.pages
    : (session.record.pages && session.record.pages.length > 0 ? session.record.pages : [createPage()]);

  return pages.map((p, idx) => ({
    pageNumber: idx + 1,
    size: p.size,
    style: p.style,
    orientation: p.orientation,
  }));
}

const EMPTY_STROKES: Stroke[] = [];
const DUMMY_SUBSCRIBE = () => () => {};
const DUMMY_GET_ALL = () => EMPTY_STROKES;

/** 사용자 생성 소규모 일반 페이지 미리보기 (하위 호환용; 대용량/PDF는 초경량 WebP <img> 파이프라인 사용) */
export function PagePreviewCanvas({
  session,
  pageIndex,
  item,
}: {
  session: NoteSession;
  pageIndex: number;
  item: PageItem;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [containerWidth, setContainerWidth] = useState(120);

  const strokes = useSyncExternalStore(
    session.strokes?.subscribe ?? DUMMY_SUBSCRIBE,
    session.strokes?.getAll ?? DUMMY_GET_ALL,
  );
  const [htmlContent, setHtmlContent] = useState(() => (session.editor ? session.editor.getHTML() : ''));

  useEffect(() => {
    if (!session.editor) return;
    let timer: ReturnType<typeof setTimeout>;
    const update = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (session.editor) setHtmlContent(session.editor.getHTML());
      }, 150);
    };
    session.editor.on('update', update);
    return () => {
      clearTimeout(timer);
      session.editor?.off('update', update);
    };
  }, [session, session.editor]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver((entries) => {
            for (const entry of entries) {
              if (entry.contentRect.width > 0) {
                const newW = Math.round(entry.contentRect.width);
                setContainerWidth((prev) => (Math.abs(prev - newW) > 1 ? newW : prev));
              }
            }
          })
        : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, []);

  const pages =
    session.ui.pages && session.ui.pages.length > 0
      ? session.ui.pages
      : session.record.pages && session.record.pages.length > 0
        ? session.record.pages
        : [createPage()];

  let offsetY = 0;
  for (let i = 0; i < pageIndex && i < pages.length; i++) {
    const p = pages[i];
    offsetY += getPageDimensions(p.size, p.orientation).height;
  }
  const pageMeta = pages[pageIndex] || pages[0] || createPage();
  const pageDims = getPageDimensions(item.size || pageMeta.size, item.orientation || pageMeta.orientation);
  const scale = containerWidth > 0 ? containerWidth / pageDims.width : 0.15;

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = container.clientWidth || 120;
    const h = container.clientHeight || Math.round(w * (pageDims.height / pageDims.width));
    const dpr = window.devicePixelRatio || 1;

    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const currentScale = w / pageDims.width;
    ctx.save();
    ctx.scale(currentScale * dpr, currentScale * dpr);
    ctx.translate(0, -offsetY);

    const pageStrokes = session.strokes?.getStrokesByPage
      ? session.strokes.getStrokesByPage(pageIndex + 1)
      : session.strokes?.getAll
        ? session.strokes.getAll()
        : [];
    const pageMinY = offsetY;
    const pageMaxY = offsetY + pageDims.height;

    for (const s of pageStrokes) {
      const box = strokeBounds(s);
      if (box.maxY >= pageMinY && box.minY <= pageMaxY) {
        drawStroke(ctx, s);
      }
    }
    ctx.restore();
    return () => {
      canvas.width = 0;
      canvas.height = 0;
    };
  }, [strokes, pageDims.width, pageDims.height, offsetY, containerWidth, pageIndex, session.strokes]);

  const isEmpty = (!htmlContent || htmlContent === '<p></p>') && strokes.length === 0;

  return (
    <div
      ref={containerRef}
      data-testid={`page-preview-canvas-${pageIndex + 1}`}
      className={`relative h-full w-full overflow-hidden select-none pointer-events-none page-style-${item.style || pageMeta.style || 'plain'}`}
    >
      {htmlContent && htmlContent !== '<p></p>' && (
        <div
          className="absolute origin-top-left pointer-events-none select-none overflow-hidden"
          style={{
            width: `${pageDims.width}px`,
            height: `${pageDims.height}px`,
            transform: `scale(${scale})`,
            top: 0,
            left: 0,
          }}
        >
          <div
            style={{ transform: `translateY(-${offsetY}px)` }}
            className="prose prose-sm max-w-none p-6 text-slate-800 opacity-80 leading-relaxed font-sans"
            dangerouslySetInnerHTML={{ __html: htmlContent }}
          />
        </div>
      )}
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full pointer-events-none" />
      {isEmpty && (
        <div className="absolute inset-0 flex flex-col items-center justify-center p-2 text-slate-400 opacity-40">
          <FileText size={20} className="stroke-[1.2] text-slate-300" />
          {item.style && (
            <span className="mt-1 text-[8px] font-medium text-slate-400">
              {PAGE_STYLE_LABELS[item.style]}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** 좌측 사이드바: 가상 스크롤 + 초경량 180px WebP 이미지 캐시 기반 페이지 썸네일 목록 */
export function PageThumbnailList({ session }: { session: NoteSession | null }) {
  const storeUI = useSessionUI(session?.id ?? null);
  const ui = session?.ui ?? storeUI;
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [thumbnailUrls, setThumbnailUrls] = useState<Record<number, string>>(() =>
    session ? thumbnailPipeline.getNoteCacheSnapshot(session.id) : {},
  );
  const [confirmDeletePageNumber, setConfirmDeletePageNumber] = useState<number | null>(null);

  const items = useMemo(() => extractPageItems(session), [session, ui.pages, session?.record.content]);
  const totalPages = items.length;
  const currentIdx = Math.max(0, Math.min(totalPages - 1, ui.currentPageIndex));

  const virtualRange = useMemo(
    () => computeThumbnailVirtualRange(totalPages, scrollTop, viewportHeight, currentIdx),
    [totalPages, scrollTop, viewportHeight, currentIdx],
  );

  const visibleItems = useMemo(() => {
    if (virtualRange.endIdx < virtualRange.startIdx) return [];
    return items.slice(virtualRange.startIdx, virtualRange.endIdx + 1);
  }, [items, virtualRange.startIdx, virtualRange.endIdx]);

  const scheduleVisibleThumbnails = useCallback(
    (immediate = false) => {
      if (!session) return;
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }

      const enqueue = () => {
        if (!session) return;
        const targets: ThumbnailRenderTarget[] = visibleItems.map((it) => ({
          noteId: session.id,
          pageNumber: it.pageNumber,
          pdfSrc: it.pdfSrc,
          pdfPage: it.pdfPage,
          templateSrc: it.templateSrc,
          size: it.size,
          style: it.style,
          orientation: it.orientation,
          getStrokesForPage: (pageNum: number) =>
            session.strokes?.getStrokesByPage ? session.strokes.getStrokesByPage(pageNum) : [],
        }));
        thumbnailPipeline.enqueueVisiblePages(targets, true);
      };

      if (immediate) {
        enqueue();
      } else {
        debounceTimerRef.current = setTimeout(() => {
          debounceTimerRef.current = null;
          enqueue();
        }, THUMBNAIL_SCROLL_DEBOUNCE_MS);
      }
    },
    [session, visibleItems],
  );

  // 사이드바 컨테이너 높이 측정
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const syncHeight = () => {
      const h = el.clientHeight || 0;
      setViewportHeight((prev) => (prev === h ? prev : h));
    };
    syncHeight();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(syncHeight) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [session?.id]);

  // WebP 썸네일 캐시 구독
  useEffect(() => {
    if (!session) {
      setThumbnailUrls({});
      return;
    }
    setThumbnailUrls(thumbnailPipeline.getNoteCacheSnapshot(session.id));
    const unsub = thumbnailPipeline.subscribe((noteId) => {
      if (noteId === session.id) {
        setThumbnailUrls(thumbnailPipeline.getNoteCacheSnapshot(session.id));
      }
    });
    return unsub;
  }, [session?.id]);

  // 가시 페이지 변경 시 100ms 디바운스 후 썸네일 순차 큐 적재
  useEffect(() => {
    if (!session) return;
    scheduleVisibleThumbnails(false);
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
  }, [session?.id, scheduleVisibleThumbnails]);

  // 특정 페이지 필기 추가/수정/삭제 시 해당 페이지의 thumbnailCache[pageNumber]만 무효화하여 1장만 재굽기
  useEffect(() => {
    if (!session?.strokes?.subscribePageChanges) return;
    const unsub = session.strokes.subscribePageChanges((changedPages) => {
      for (const pageNum of changedPages) {
        thumbnailPipeline.invalidatePage(session.id, pageNum);
      }
      scheduleVisibleThumbnails(false);
    });
    return unsub;
  }, [session, scheduleVisibleThumbnails]);

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop);
  }, []);

  if (!session) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center p-6 text-center text-xs text-slate-400">
        <FileText size={32} className="mb-2 text-slate-300 stroke-[1.5]" />
        <p className="font-medium text-slate-600">열린 노트가 없습니다</p>
        <p className="mt-1 text-[11px] text-slate-400">노트를 열면 페이지 미리보기 목록이 표시됩니다.</p>
      </div>
    );
  }

  return (
    <div data-testid="page-thumbnail-list" className="flex h-full min-h-0 flex-1 flex-col bg-slate-50">
      {/* 헤더: 문서 제목 및 전체 페이지 카운터 & 퀵 내비게이션 & 페이지 추가 버튼 */}
      <div className="border-b border-slate-200 bg-white px-3 py-2">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1.5 text-xs font-semibold text-slate-800">
            <Layers size={13} className="text-indigo-600" />
            <span>페이지 목록</span>
          </span>
          <div className="flex items-center gap-1.5">
            <span className="rounded bg-indigo-50 px-1.5 py-0.5 font-mono text-[11px] font-bold text-indigo-700">
              총 {totalPages}페이지
            </span>
            <button
              type="button"
              data-testid="add-page-header-btn"
              onClick={() => {
                const created = session.addPageBelow(currentIdx);
                toast.success(`새 페이지(${created.size})를 추가했습니다.`);
              }}
              className="flex items-center gap-1 rounded bg-indigo-600 px-2 py-0.5 text-[11px] font-medium text-white shadow-xs transition hover:bg-indigo-700 active:scale-95"
              title="현재 페이지 아래에 새 페이지 추가"
            >
              <Plus size={12} />
              <span>추가</span>
            </button>
          </div>
        </div>

        {totalPages > 1 && (
          <div className="mt-1.5 flex items-center justify-between rounded-lg bg-slate-100/80 p-1 text-xs">
            <button
              type="button"
              disabled={currentIdx === 0}
              onClick={() => session.scrollToPage(currentIdx - 1)}
              className="rounded p-1 text-slate-600 hover:bg-white hover:text-indigo-600 disabled:opacity-30"
              title="이전 페이지로 이동"
            >
              <ChevronLeft size={14} />
            </button>
            <span className="font-mono text-[11px] font-semibold text-slate-700">
              {currentIdx + 1} / {totalPages}
            </span>
            <button
              type="button"
              disabled={currentIdx >= totalPages - 1}
              onClick={() => session.scrollToPage(currentIdx + 1)}
              className="rounded p-1 text-slate-600 hover:bg-white hover:text-indigo-600 disabled:opacity-30"
              title="다음 페이지로 이동"
            >
              <ChevronRight size={14} />
            </button>
          </div>
        )}
      </div>

      {/* 가상 스크롤 2열 썸네일 그리드: 사이드바 가시 범위(8~10개)만 마운트 */}
      <div
        ref={scrollContainerRef}
        data-testid="thumbnail-scroll-container"
        onScroll={handleScroll}
        className="min-h-0 flex-1 overflow-y-auto p-2"
      >
        {virtualRange.topSpacerHeight > 0 && (
          <div style={{ height: `${virtualRange.topSpacerHeight}px` }} aria-hidden />
        )}
        <div className="grid grid-cols-2 gap-2">
          {visibleItems.map((it) => {
            const isCurrent = it.pageNumber - 1 === currentIdx;
            const thumbUrl = thumbnailUrls[it.pageNumber];

            return (
              <div
                key={it.pageNumber}
                data-testid={`page-thumbnail-${it.pageNumber}`}
                data-active={isCurrent ? 'true' : 'false'}
                onClick={() => {
                  if (typeof session.navigateToPage === 'function') {
                    session.navigateToPage(it.pageNumber - 1);
                  } else if (typeof session.scrollToPage === 'function') {
                    session.scrollToPage(it.pageNumber - 1);
                  }
                }}
                className={`group relative flex cursor-pointer select-none flex-col overflow-hidden rounded-xl border transition-all ${
                  isCurrent
                    ? 'border-indigo-500 bg-indigo-50/70 shadow-sm ring-2 ring-indigo-400'
                    : 'border-slate-200 bg-white hover:border-indigo-300 hover:shadow-xs'
                }`}
                title={`클릭하여 ${it.pageNumber}페이지로 바로 이동`}
              >
                {/* 초경량 WebP <img> 썸네일 프리뷰 영역 (고해상도 캔버스 미사용) */}
                <div className={`relative aspect-[1/1.414] w-full overflow-hidden page-style-${it.style || 'plain'} bg-slate-100`}>
                  {thumbUrl ? (
                    <img
                      src={thumbUrl}
                      alt={`페이지 ${it.pageNumber}`}
                      data-testid={`page-thumbnail-img-${it.pageNumber}`}
                      className="h-full w-full object-contain transition-transform group-hover:scale-[1.02]"
                    />
                  ) : totalPages <= 10 && !it.templateSrc && !it.pdfSrc ? (
                    <PagePreviewCanvas
                      session={session}
                      pageIndex={it.pageNumber - 1}
                      item={it}
                    />
                  ) : (
                    <div
                      data-testid={`page-thumbnail-placeholder-${it.pageNumber}`}
                      className="flex h-full w-full items-center justify-center text-[11px] font-medium text-slate-400"
                    >
                      {it.pageNumber}
                    </div>
                  )}

                  {/* 활성 페이지 표시 뱃지 */}
                  {isCurrent && (
                    <span className="absolute left-1.5 top-1.5 flex h-2 w-2 items-center justify-center rounded-full bg-indigo-600 ring-2 ring-white" />
                  )}

                  {/* 페이지 관리 퀵 액션 */}
                  <div
                    className="absolute right-1 top-1 z-20 flex items-center gap-1 opacity-90 transition-opacity hover:opacity-100"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      type="button"
                      data-testid={`add-page-below-thumb-${it.pageNumber}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        const created = session.addPageBelow(it.pageNumber - 1);
                        toast.success(`${it.pageNumber}쪽 아래에 새 페이지(${created.size})를 추가했습니다.`);
                      }}
                      className="rounded bg-white/90 p-1 text-slate-600 shadow-xs backdrop-blur-xs hover:bg-indigo-50 hover:text-indigo-600"
                      title="이 페이지 아래에 새 페이지 추가"
                    >
                      <Plus size={11} />
                    </button>
                    <button
                      type="button"
                      disabled={totalPages <= 1}
                      data-testid={`delete-page-${it.pageNumber}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (totalPages <= 1) {
                          toast.error('문서에는 최소 1개의 페이지가 있어야 합니다.');
                          return;
                        }
                        setConfirmDeletePageNumber(it.pageNumber);
                      }}
                      className="rounded bg-white/90 p-1 text-slate-600 shadow-xs backdrop-blur-xs hover:bg-rose-50 hover:text-rose-600 disabled:opacity-30 disabled:hover:bg-white/90 disabled:hover:text-slate-600"
                      title={totalPages <= 1 ? '최소 1개 페이지는 유지되어야 합니다' : '이 페이지 삭제'}
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>

                  {/* 페이지 삭제 확인 인라인 오버레이 */}
                  {confirmDeletePageNumber === it.pageNumber && (
                    <div
                      data-testid={`delete-confirm-overlay-${it.pageNumber}`}
                      onClick={(e) => e.stopPropagation()}
                      className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-white/95 p-2 text-center backdrop-blur-xs"
                    >
                      <span className="text-[11px] font-semibold text-rose-600">
                        {it.pageNumber}쪽을 삭제할까요?
                      </span>
                      <p className="mt-0.5 text-[9px] text-slate-500">필기 및 텍스트도 함께 삭제됩니다.</p>
                      <div className="mt-2 flex items-center gap-1.5">
                        <button
                          type="button"
                          data-testid={`confirm-delete-page-${it.pageNumber}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            const success = session.deletePage(it.pageNumber - 1);
                            setConfirmDeletePageNumber(null);
                            if (success) {
                              toast.success(`페이지 ${it.pageNumber}을(를) 삭제했습니다.`);
                            }
                          }}
                          className="rounded bg-rose-600 px-2 py-0.5 text-[10px] font-bold text-white shadow-xs hover:bg-rose-700 active:scale-95"
                        >
                          삭제
                        </button>
                        <button
                          type="button"
                          data-testid={`cancel-delete-page-${it.pageNumber}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            setConfirmDeletePageNumber(null);
                          }}
                          className="rounded border border-slate-200 bg-white px-2 py-0.5 text-[10px] font-medium text-slate-600 hover:bg-slate-50"
                        >
                          취소
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                {/* 하단 페이지 번호 바 */}
                <div
                  className={`flex items-center justify-between border-t px-2 py-1 text-[11px] ${
                    isCurrent
                      ? 'border-indigo-200 bg-indigo-100/60 font-bold text-indigo-900'
                      : 'border-slate-100 bg-slate-50 text-slate-600 group-hover:text-indigo-600'
                  }`}
                >
                  <div className="flex items-center gap-1 truncate">
                    <span>{it.pageNumber}쪽</span>
                    {it.size && <span className="font-mono text-[9px] text-slate-400">· {it.size}</span>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        {virtualRange.bottomSpacerHeight > 0 && (
          <div style={{ height: `${virtualRange.bottomSpacerHeight}px` }} aria-hidden />
        )}
      </div>
    </div>
  );
}
