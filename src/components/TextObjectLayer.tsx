import { useEffect, useRef, useState } from 'react';
import type { NoteSession } from '../session/NoteSession';
import type { NoteTextObject } from '../core/text/textObjects';
import type { NotePage } from '../core/page/pageTypes';
import { useSessionUI } from '../store/sessionStore';
import type { Tool } from '../store/settingsStore';

interface Props {
  session: NoteSession;
  activeTool: Tool;
}

export interface ResolvedPageCoordinates {
  page: NotePage;
  pageEl: HTMLElement;
  pageRect: DOMRect;
  pageIndex: number;
  pageOffsetTop: number;
  pageOffsetLeft: number;
  localX: number;
  localY: number;
}

/**
 * 레이아웃 변경(스크롤, 리사이즈, DOM 변경) 감지 훅
 */
function useLayoutTick(session: NoteSession): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let raf = 0;
    const bump = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setTick((t) => t + 1));
    };
    session.editor?.on('transaction', bump);
    const scroller = session.scrollEl;
    scroller?.addEventListener('scroll', bump, { passive: true });
    window.addEventListener('resize', bump);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(bump) : null;
    if (session.pageEl) ro?.observe(session.pageEl);
    return () => {
      cancelAnimationFrame(raf);
      session.editor?.off('transaction', bump);
      scroller?.removeEventListener('scroll', bump);
      window.removeEventListener('resize', bump);
      ro?.disconnect();
    };
  }, [session]);
  return tick;
}

/**
 * pageIndex에 해당하는 DOM 요소를 찾는다 (PDF 템플릿, 일반 페이지 시트, 또는 기본 본문)
 */
export function findPageElement(notePageEl: HTMLElement, pageIndex: number): HTMLElement | null {
  // 1. PDF 템플릿 또는 data-page / data-page-index 가 명시된 요소 직접 쿼리
  const direct = notePageEl.querySelector(
    `[data-ink-template][data-page="${pageIndex + 1}"], #pdf-page-${pageIndex + 1}, [data-page="${pageIndex + 1}"], [data-page-index="${pageIndex}"]`
  ) as HTMLElement | null;
  if (direct) return direct;

  // 2. .page-sheet 또는 .ink-template 목록 순서 매칭
  const sheets = notePageEl.querySelectorAll('[data-ink-template], .ink-template, [data-page-index], .page-sheet');
  if (sheets && sheets[pageIndex]) {
    return sheets[pageIndex] as HTMLElement;
  }

  // 3. 1페이지 (index === 0)이고 일반 연속형 노트인 경우
  if (pageIndex === 0) {
    const prose = notePageEl.querySelector('.ProseMirror, .note-page-content') as HTMLElement | null;
    if (prose) return prose;
  }
  return null;
}

/**
 * note-page 내에서 해당 페이지의 상대적 (x, y) 오프셋을 계산한다
 */
export function getPageOffset(notePageEl: HTMLElement, pageIndex: number): { x: number; y: number } {
  const target = findPageElement(notePageEl, pageIndex);
  if (!target || target === notePageEl) return { x: 0, y: 0 };
  const nr = notePageEl.getBoundingClientRect();
  const tr = target.getBoundingClientRect();
  const zoom = Number(notePageEl.dataset.zoom) || 1;
  return {
    x: Math.round((tr.left - nr.left) / zoom),
    y: Math.round((tr.top - nr.top) / zoom),
  };
}

/**
 * 터치/클릭한 clientX, clientY로부터 대상 페이지 및 페이지 로컬 (localX, localY) 좌표를 정확히 역산한다
 * - 1순위: e.target의 closest를 통한 브라우저 네이티브 Hit-Test 판별
 * - 2순위: 여백 터치 시 각 페이지 DOM의 boundingClientRect 수직 범위 및 최근접 거리 비교
 * - 3순위: 식별 실패 시 명시적 경고 출력 ([PDF_PAGE_RESOLUTION_FAILED]) 및 null 반환
 */
export function resolvePageAndLocalCoords(
  notePageEl: HTMLElement,
  pages: NotePage[],
  clientX: number,
  clientY: number,
  defaultPageIndex = 0,
  targetEl?: HTMLElement | null,
): ResolvedPageCoordinates | null {
  if (!pages || pages.length === 0) {
    console.warn('[PDF_PAGE_RESOLUTION_FAILED]', { reason: 'pages array is empty', clientX, clientY });
    return null;
  }

  const zoom = Number(notePageEl.dataset.zoom) || 1;

  // 1순위: 실제 클릭된 DOM 요소(targetEl)의 상위 트리에서 페이지 래퍼 직접 검출
  if (targetEl) {
    const hitPage = targetEl.closest(
      '[data-ink-template], .ink-template, [data-page-index], .page-sheet'
    ) as HTMLElement | null;

    if (hitPage) {
      let matchedIndex = -1;
      if (hitPage.dataset.page) {
        matchedIndex = Math.max(0, parseInt(hitPage.dataset.page, 10) - 1);
      } else if (hitPage.dataset.pageIndex) {
        matchedIndex = parseInt(hitPage.dataset.pageIndex, 10);
      } else if (hitPage.id && hitPage.id.startsWith('pdf-page-')) {
        matchedIndex = Math.max(0, parseInt(hitPage.id.replace('pdf-page-', ''), 10) - 1);
      } else {
        const allSheets = Array.from(
          notePageEl.querySelectorAll('[data-ink-template], .ink-template, [data-page-index], .page-sheet')
        );
        matchedIndex = allSheets.indexOf(hitPage);
      }

      if (matchedIndex >= 0 && matchedIndex < pages.length) {
        const p = pages[matchedIndex];
        const rect = hitPage.getBoundingClientRect();
        const localX = Math.max(10, Math.round((clientX - rect.left) / zoom));
        const localY = Math.max(10, Math.round((clientY - rect.top) / zoom));
        const pageOffset = getPageOffset(notePageEl, matchedIndex);

        return {
          page: p,
          pageEl: hitPage,
          pageRect: rect,
          pageIndex: matchedIndex,
          pageOffsetTop: pageOffset.y,
          pageOffsetLeft: pageOffset.x,
          localX,
          localY,
        };
      }
    }
  }

  // 2순위: 여백 터치 시 화면 상의 모든 페이지 DOM boundingClientRect를 순회하며 탐색
  let bestMatch: { page: NotePage; pageEl: HTMLElement; rect: DOMRect; pageIndex: number; distY: number } | null = null;

  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    const el = findPageElement(notePageEl, i);
    if (!el) continue;
    const rect = el.getBoundingClientRect();

    // 터치 Y가 페이지 수직 범위 안인 경우
    if (clientY >= rect.top && clientY <= rect.bottom) {
      bestMatch = { page: p, pageEl: el, rect, pageIndex: i, distY: 0 };
      break;
    }

    // 페이지 사이 여백 등 범위 바깥일 경우 가장 가까운 페이지 탐색
    const distY = clientY < rect.top ? rect.top - clientY : clientY - rect.bottom;
    if (!bestMatch || distY < bestMatch.distY) {
      bestMatch = { page: p, pageEl: el, rect, pageIndex: i, distY };
    }
  }

  if (bestMatch) {
    const localX = Math.max(10, Math.round((clientX - bestMatch.rect.left) / zoom));
    const localY = Math.max(10, Math.round((clientY - bestMatch.rect.top) / zoom));
    const pageOffset = getPageOffset(notePageEl, bestMatch.pageIndex);

    return {
      page: bestMatch.page,
      pageEl: bestMatch.pageEl,
      pageRect: bestMatch.rect,
      pageIndex: bestMatch.pageIndex,
      pageOffsetTop: pageOffset.y,
      pageOffsetLeft: pageOffset.x,
      localX,
      localY,
    };
  }

  // 3순위: 페이지 요소를 전혀 찾지 못했을 때 폴백 처리 (단일 일반 노트 본문 여부 검사)
  const singleFallbackIdx = Math.max(0, Math.min(pages.length - 1, defaultPageIndex));
  const fallbackPage = pages[singleFallbackIdx];
  const fallbackEl = findPageElement(notePageEl, singleFallbackIdx);

  if (fallbackEl) {
    const rect = fallbackEl.getBoundingClientRect();
    const localX = Math.max(10, Math.round((clientX - rect.left) / zoom));
    const localY = Math.max(10, Math.round((clientY - rect.top) / zoom));
    const pageOffset = getPageOffset(notePageEl, singleFallbackIdx);

    return {
      page: fallbackPage,
      pageEl: fallbackEl,
      pageRect: rect,
      pageIndex: singleFallbackIdx,
      pageOffsetTop: pageOffset.y,
      pageOffsetLeft: pageOffset.x,
      localX,
      localY,
    };
  }

  console.warn('[PDF_PAGE_RESOLUTION_FAILED]', {
    reason: 'Could not resolve any valid page DOM element for coordinates',
    clientX,
    clientY,
    defaultPageIndex,
    totalPages: pages.length,
  });
  return null;
}

/**
 * [Layer 2.5] 전 페이지 Direct-to-Note 인라인 텍스트 입력 계층
 * - 별도 박스나 모달 없이, 텍스트 도구 상태에서 원하는 위치를 터치/클릭하면 즉시 인라인 커서가 깜빡이며 타이핑 가능.
 * - 1페이지, 2페이지, 3페이지 및 PDF 템플릿 문서 어디서든 일관된 페이지 로컬 (x, y) 좌표계에 종속되어 정확한 위치에 렌더링.
 * - S-Pen 필기 모드(pencil, highlighter, eraser, lasso)일 때는 pointer-events-none 으로 통과되어 240Hz 필기를 방해하지 않음.
 */
export function TextObjectLayer({ session, activeTool }: Props) {
  useLayoutTick(session);
  const storeUI = useSessionUI(session?.id ?? null);
  const ui = session?.ui ?? storeUI;
  const textObjects = ui?.textObjects ?? [];
  const pages = ui?.pages ?? [];
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftText, setDraftText] = useState<string>('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const newDraftIdRef = useRef<string | null>(null);
  const isComposingRef = useRef<boolean>(false);

  const isTextToolActive = activeTool === 'none';

  // pageId -> pageIndex 맵 구축
  const pageIdToIndex = new Map<string, number>();
  pages.forEach((p, idx) => {
    pageIdToIndex.set(p.id, idx);
  });

  // textarea 높이 자동 확장
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.max(24, textareaRef.current.scrollHeight)}px`;
    }
  }, [draftText, editingId]);

  // 편집 시작
  const startEditing = (obj: NoteTextObject, isNew = false) => {
    setEditingId(obj.id);
    setDraftText(obj.text);
    newDraftIdRef.current = isNew ? obj.id : null;
    setTimeout(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
        if (!isNew) {
          textareaRef.current.select();
        }
      }
    }, 20);
  };

  // 편집 완료 및 커밋
  const commitEditing = (obj: NoteTextObject) => {
    const isNew = newDraftIdRef.current === obj.id;
    newDraftIdRef.current = null;
    const trimmed = draftText.trim();

    if (!trimmed) {
      // 빈 텍스트인 경우: 신규 객체는 히스토리 없이 조용히 삭제, 기존 객체는 deleteTextObject 호출
      session.deleteTextObject(obj.id, !isNew);
    } else {
      if (isNew) {
        // 신규 객체에 텍스트가 입력되었을 때: 단일 text-add 히스토리 푸시
        session.updateTextObject(obj.id, { text: draftText }, false);
        session.recordTextAdd({ ...obj, text: draftText });
      } else if (obj.text !== draftText) {
        // 기존 객체 텍스트 변경: text-update 기록
        session.updateTextObject(obj.id, { text: draftText }, true);
      }
    }
    setEditingId(null);
  };

  // 텍스트 도구 활성 상태에서 노트 위 탭 시 즉시 해당 위치에 인라인 커서 활성화 (Direct-to-Note)
  useEffect(() => {
    const notePage = session.pageEl;
    if (!notePage) return;

    const handlePointerDown = (e: PointerEvent | MouseEvent) => {
      if (activeTool !== 'none') return;
      const target = e.target as HTMLElement;

      // 이미 텍스트 입력창이나 버튼, 툴바 등을 누른 경우는 통과
      if (target.closest('[data-testid^="text-object-"]') || target.closest('button, a, input, textarea, select')) {
        return;
      }

      // 다른 제스처(PDF 전체 선택, NodeSelection, 드래그 등) 방지
      e.stopPropagation();

      // 현재 편집 중인 텍스트가 있으면 먼저 커밋
      if (editingId) {
        const curObj = textObjects.find((t) => t.id === editingId);
        if (curObj) {
          commitEditing(curObj);
        }
      }

      // 정확한 페이지 및 로컬 (x, y) 좌표 계산 (1순위 targetEl 직계 Hit-Test 활용)
      const resolved = resolvePageAndLocalCoords(
        notePage,
        session.ui.pages,
        e.clientX,
        e.clientY,
        session.ui.currentPageIndex,
        target,
      );
      if (!resolved) return;

      const layerEl = notePage.querySelector('[data-testid="text-object-layer"]') as HTMLElement | null;
      const finalLeft = resolved.pageOffsetLeft + resolved.localX;
      const finalTop = resolved.pageOffsetTop + resolved.localY;

      // [PDF_TEXT_CLICK] 14대 필수 진단 로그 전수 출력
      console.log('[PDF_TEXT_CLICK]', {
        eventTarget: e.target,
        eventCurrentTarget: e.currentTarget,
        clientX: e.clientX,
        clientY: e.clientY,
        resolvedPageId: resolved.page.id,
        resolvedPageElement: resolved.pageEl,
        resolvedPageBoundingClientRect: resolved.pageRect,
        pageIndex: resolved.pageIndex,
        pageOffsetTop: resolved.pageOffsetTop,
        calculatedLocalX: resolved.localX,
        calculatedLocalY: resolved.localY,
        textLayerElement: layerEl,
        textInputElement: null,
        finalTextInputTop: finalTop,
        finalTextInputLeft: finalLeft,
      });

      // 신규 텍스트 객체 생성 (히스토리는 커밋 시점에만 기록)
      const newObj = session.addTextObject(
        {
          pageId: resolved.page.id,
          x: resolved.localX,
          y: resolved.localY,
          text: '',
          fontSize: 16,
          color: '#1e293b',
        },
        false,
      );

      startEditing(newObj, true);
    };

    notePage.addEventListener('pointerdown', handlePointerDown);
    return () => {
      notePage.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [session, activeTool, session.pageEl, session.ui.pages, session.ui.currentPageIndex, editingId, textObjects, draftText]);

  if (!session.pageEl) return null;
  const notePageEl = session.pageEl;

  return (
    <div
      data-testid="text-object-layer"
      className="pointer-events-none absolute inset-0 z-15 select-none"
    >
      {textObjects.map((obj) => {
        const pageIdx = pageIdToIndex.get(obj.pageId) ?? 0;
        const pageOffset = getPageOffset(notePageEl, pageIdx);
        const isEditing = editingId === obj.id;

        const left = pageOffset.x + obj.x;
        const top = pageOffset.y + obj.y;

        return (
          <div
            key={obj.id}
            data-testid={`text-object-${obj.id}`}
            style={{
              left: `${left}px`,
              top: `${top}px`,
              minWidth: isEditing ? '60px' : 'auto',
              maxWidth: '800px',
              fontFamily: obj.fontFamily || 'inherit',
              fontSize: `${obj.fontSize}px`,
              color: obj.color || '#1e293b',
            }}
            className={`absolute ${
              isTextToolActive ? 'pointer-events-auto cursor-text' : 'pointer-events-none'
            }`}
            onClick={(e) => {
              if (!isTextToolActive) return;
              e.stopPropagation();
              if (!isEditing) {
                startEditing(obj, false);
              }
            }}
          >
            {isEditing ? (
              <textarea
                ref={textareaRef}
                data-testid={`text-object-input-${obj.id}`}
                value={draftText}
                onChange={(e) => setDraftText(e.target.value)}
                onBlur={() => commitEditing(obj)}
                onCompositionStart={() => {
                  isComposingRef.current = true;
                }}
                onCompositionEnd={() => {
                  isComposingRef.current = false;
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    commitEditing(obj);
                  }
                }}
                className="w-full resize-none border-none bg-transparent p-0 outline-none shadow-none focus:ring-0 whitespace-pre-wrap break-words overflow-hidden"
                style={{
                  fontSize: `${obj.fontSize}px`,
                  color: obj.color || '#1e293b',
                  caretColor: obj.color || '#1e293b',
                  fontFamily: obj.fontFamily || 'inherit',
                  lineHeight: 1.4,
                }}
                rows={1}
                autoFocus
              />
            ) : (
              <div
                className="relative border-none bg-transparent p-0 whitespace-pre-wrap break-words"
                style={{
                  fontSize: `${obj.fontSize}px`,
                  color: obj.color || '#1e293b',
                  fontFamily: obj.fontFamily || 'inherit',
                  lineHeight: 1.4,
                }}
              >
                {obj.text}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
