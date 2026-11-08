import { useEffect, useRef, useState } from 'react';
import type { NoteSession } from '../session/NoteSession';
import type { NoteTextObject } from '../core/text/textObjects';
import { useSessionUI } from '../store/sessionStore';
import type { Tool } from '../store/settingsStore';

interface Props {
  session: NoteSession;
  activeTool: Tool;
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
 * pageIndex에 해당하는 DOM 요소를 찾는다 (PDF 템플릿 또는 일반 분리형 페이지 시트)
 */
export function findPageElement(notePageEl: HTMLElement, pageIndex: number): HTMLElement | null {
  return (
    (notePageEl.querySelector(
      `[data-ink-template][data-page="${pageIndex + 1}"], #pdf-page-${pageIndex + 1}`
    ) as HTMLElement | null) ??
    (notePageEl.querySelector(`[data-page-index="${pageIndex}"]`) as HTMLElement | null)
  );
}

/**
 * note-page 내에서 해당 페이지의 상대적 (x, y) 오프셋을 계산한다
 */
function getPageOffset(notePageEl: HTMLElement, pageIndex: number): { x: number; y: number } {
  const target = findPageElement(notePageEl, pageIndex);
  if (!target) return { x: 0, y: 0 };
  const nr = notePageEl.getBoundingClientRect();
  const tr = target.getBoundingClientRect();
  const zoom = Number(notePageEl.dataset.zoom) || 1;
  return {
    x: (tr.left - nr.left) / zoom,
    y: (tr.top - nr.top) / zoom,
  };
}

/**
 * [Layer 2.5] 페이지 앵커 기반 독립형 텍스트 객체 렌더링 레이어
 * - PDF 페이지나 일반 멀티페이지의 고유 pageId 로컬 (x, y) 좌표계에 종속되어 정확한 위치에 렌더링된다.
 * - S-Pen 필기 모드(pencil, highlighter, eraser, lasso)일 때는 pointer-events-none 으로 통과되어 필기를 방해하지 않는다.
 * - 텍스트 도구(activeTool === 'none')일 때 탭하여 선택 및 인라인 편집을 수행한다.
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

  const isTextToolActive = activeTool === 'none';

  // pageId -> pageIndex 맵 구축
  const pageIdToIndex = new Map<string, number>();
  pages.forEach((p, idx) => {
    pageIdToIndex.set(p.id, idx);
  });

  // 편집 시작 시 draftText 동기화 및 textarea 자동 포커스
  const startEditing = (obj: NoteTextObject) => {
    setEditingId(obj.id);
    setDraftText(obj.text);
    setTimeout(() => {
      textareaRef.current?.focus();
      textareaRef.current?.select();
    }, 20);
  };

  const commitEditing = (obj: NoteTextObject) => {
    const trimmed = draftText.trim();
    if (!trimmed) {
      session.deleteTextObject(obj.id);
    } else {
      session.updateTextObject(obj.id, { text: draftText });
    }
    setEditingId(null);
  };

  // 텍스트 도구 활성 상태에서 페이지 빈 공간 탭 시 신규 텍스트 객체 생성 및 인라인 편집 진입
  useEffect(() => {
    const notePage = session.pageEl;
    if (!notePage) return;

    const handlePageClick = (e: MouseEvent) => {
      if (activeTool !== 'none') return;
      const target = e.target as HTMLElement;

      // 이미 텍스트 객체 위를 눌렀거나 버튼/링크 등을 누른 경우는 무시
      if (target.closest('[data-testid^="text-object-"]') || target.closest('button, a, input, textarea')) {
        return;
      }

      const pageTarget = target.closest('[data-ink-template], .ink-template, [data-page-index], .page-sheet') as HTMLElement | null;
      if (!pageTarget) return;

      let pageIdx = 0;
      if (pageTarget.dataset.page) {
        pageIdx = Math.max(0, Number(pageTarget.dataset.page) - 1);
      } else if (pageTarget.dataset.pageIndex) {
        pageIdx = Number(pageTarget.dataset.pageIndex);
      } else {
        pageIdx = session.ui.currentPageIndex;
      }

      const targetPage = session.ui.pages[pageIdx] ?? session.ui.pages[0];
      if (!targetPage) return;

      const targetRect = pageTarget.getBoundingClientRect();
      const zoom = Number(notePage.dataset.zoom) || session.ui.zoom || 1;
      const localX = Math.max(10, Math.round((e.clientX - targetRect.left) / zoom));
      const localY = Math.max(10, Math.round((e.clientY - targetRect.top) / zoom));

      const newObj = session.addTextObject({
        pageId: targetPage.id,
        x: localX,
        y: localY,
        text: '',
        fontSize: 16,
        color: '#1e293b',
      });

      setEditingId(newObj.id);
      setDraftText('');
      setTimeout(() => {
        textareaRef.current?.focus();
      }, 30);
    };

    notePage.addEventListener('click', handlePageClick);
    return () => {
      notePage.removeEventListener('click', handlePageClick);
    };
  }, [session, activeTool, session.pageEl, session.ui.pages]);

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
              minWidth: obj.width ? `${obj.width}px` : '120px',
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
              startEditing(obj);
            }}
          >
            {isEditing ? (
              <textarea
                ref={textareaRef}
                data-testid={`text-object-input-${obj.id}`}
                value={draftText}
                onChange={(e) => setDraftText(e.target.value)}
                onBlur={() => commitEditing(obj)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    commitEditing(obj);
                  }
                }}
                className="w-full min-h-[40px] resize rounded border border-indigo-400 bg-white/95 p-1.5 shadow-md outline-none focus:ring-2 focus:ring-indigo-300"
                style={{
                  fontSize: `${obj.fontSize}px`,
                  color: obj.color || '#1e293b',
                }}
              />
            ) : (
              <div
                className="group relative rounded border border-transparent p-1 transition hover:border-indigo-200 hover:bg-indigo-50/20 whitespace-pre-wrap break-words"
              >
                {obj.text || '텍스트 입력'}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
