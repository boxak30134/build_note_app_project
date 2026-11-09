import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, FileText, Layers, Plus, Trash2 } from 'lucide-react';
import type { NoteSession } from '../session/NoteSession';
import { useSessionUI } from '../store/sessionStore';
import { toast } from '../store/uiStore';
import { attachmentUrl } from '../storage/opfs';
import { createPage, PAGE_STYLE_LABELS, type PageStyleId, type PaperSizeId } from '../core/page/pageTypes';

export interface PageItem {
  pageNumber: number; // 1-based (1, 2, ... N)
  templateSrc?: string;
  width?: number;
  height?: number;
  size?: PaperSizeId;
  style?: PageStyleId;
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
        templates.push({
          pageNumber: Number(node.attrs.page) || templates.length + 1,
          templateSrc: typeof node.attrs.src === 'string' ? node.attrs.src : undefined,
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
  }));
}

/** 좌측 사이드바: 현재 문서의 페이지 미리보기 썸네일 그리드 및 원클릭 즉시 이동 */
export function PageThumbnailList({ session }: { session: NoteSession | null }) {
  const storeUI = useSessionUI(session?.id ?? null);
  const ui = session?.ui ?? storeUI;
  const [thumbnailUrls, setThumbnailUrls] = useState<Record<number, string>>({});
  const [confirmDeletePageNumber, setConfirmDeletePageNumber] = useState<number | null>(null);

  const items = extractPageItems(session);
  const totalPages = items.length;
  const currentIdx = Math.max(0, Math.min(totalPages - 1, ui.currentPageIndex));

  // PDF 페이지 템플릿 썸네일 이미지 비동기 로드
  useEffect(() => {
    let alive = true;
    if (!session) {
      setThumbnailUrls({});
      return;
    }

    for (const it of items) {
      if (it.templateSrc) {
        const pageNum = it.pageNumber;
        void attachmentUrl(session.id, it.templateSrc).then((url) => {
          if (alive && url) {
            setThumbnailUrls((prev) => (prev[pageNum] === url ? prev : { ...prev, [pageNum]: url }));
          }
        });
      }
    }

    return () => {
      alive = false;
    };
  }, [session, session?.id, items.length]);

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

      {/* 2열 썸네일 그리드: 스크롤 없이 클릭 즉시 해당 페이지로 이동 */}
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <div className="grid grid-cols-2 gap-2">
          {items.map((it) => {
            const isCurrent = it.pageNumber - 1 === currentIdx;
            const thumbUrl = thumbnailUrls[it.pageNumber];

            return (
              <div
                key={it.pageNumber}
                data-testid={`page-thumbnail-${it.pageNumber}`}
                data-active={isCurrent ? 'true' : 'false'}
                onClick={() => session.scrollToPage(it.pageNumber - 1)}
                className={`group relative flex cursor-pointer select-none flex-col overflow-hidden rounded-xl border transition-all ${isCurrent
                  ? 'border-indigo-500 bg-indigo-50/70 shadow-sm ring-2 ring-indigo-400'
                  : 'border-slate-200 bg-white hover:border-indigo-300 hover:shadow-xs'
                  }`}
                title={`클릭하여 ${it.pageNumber}페이지로 바로 이동`}
              >
                {/* 썸네일 프리뷰 영역 */}
                <div className="relative aspect-[1/1.414] w-full overflow-hidden bg-slate-100">
                  {thumbUrl ? (
                    <img
                      src={thumbUrl}
                      alt={`페이지 ${it.pageNumber}`}
                      loading="lazy"
                      className="h-full w-full object-contain transition-transform group-hover:scale-[1.02]"
                    />
                  ) : (
                    <div
                      className={`flex h-full w-full flex-col items-center justify-center p-2 text-slate-400 page-style-${it.style || 'plain'}`}
                    >
                      <FileText size={24} className="stroke-[1.2] text-slate-300" />
                      {it.style && (
                        <span className="mt-1 text-[9px] font-medium text-slate-400">
                          {PAGE_STYLE_LABELS[it.style]}
                        </span>
                      )}
                    </div>
                  )}

                  {/* 활성 페이지 표시 뱃지 */}
                  {isCurrent && (
                    <span className="absolute left-1.5 top-1.5 flex h-2 w-2 items-center justify-center rounded-full bg-indigo-600 ring-2 ring-white" />
                  )}

                  {/* 페이지 관리 퀵 액션 (추가 / 삭제 - 모바일/터치/데스크톱 상시 노출) */}
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

                {/* 하단 페이지 번호 바 & 상시 삭제 버튼 */}
                <div
                  className={`flex items-center justify-between border-t px-2 py-1 text-[11px] ${isCurrent
                      ? 'border-indigo-200 bg-indigo-100/60 font-bold text-indigo-900'
                      : 'border-slate-100 bg-slate-50 text-slate-600 group-hover:text-indigo-600'
                    }`}
                >
                  <div className="flex items-center gap-1 truncate">
                    <span>{it.pageNumber}쪽</span>
                    {it.size && <span className="font-mono text-[9px] text-slate-400">· {it.size}</span>}
                  </div>
                  <button
                    type="button"
                    data-testid={`delete-page-bar-${it.pageNumber}`}
                    disabled={totalPages <= 1}
                    title={totalPages <= 1 ? '최소 1페이지가 필요합니다' : `${it.pageNumber}쪽 삭제`}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (totalPages <= 1) return;
                      setConfirmDeletePageNumber(it.pageNumber);
                    }}
                    className="ml-auto rounded p-0.5 text-slate-400 transition hover:bg-red-50 hover:text-red-600 disabled:opacity-20 disabled:hover:bg-transparent disabled:hover:text-slate-400"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
