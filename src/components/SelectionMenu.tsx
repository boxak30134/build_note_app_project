import { useEffect, useState } from 'react';
import { useFloating, autoUpdate, offset, flip, shift, FloatingPortal } from '@floating-ui/react';
import { Link2, MessageSquare, Sparkles, X } from 'lucide-react';
import type { NoteSession } from '../session/NoteSession';
import type { LinkRecommendation } from '../services/offlineDocumentLinker';

/** 텍스트 드래그 시 플로팅 메뉴: [🔗 문서 연결] [링크 생성] [💬 말풍선] */
export function SelectionMenu({ session }: { session: NoteSession }) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [docLinkState, setDocLinkState] = useState<{
    text: string;
    from: number;
    to: number;
    recommendations: LinkRecommendation[];
  } | null>(null);
  const { refs, floatingStyles, update } = useFloating({
    placement: 'top',
    middleware: [offset(8), flip(), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });

  useEffect(() => {
    const ed = session.editor;
    if (ed.isDestroyed) return;
    // 마운트 시점의 DOM 을 캡처: 정리(cleanup) 시점에는 에디터가 이미 destroy 되었을 수 있다
    const dom = ed.view.dom;
    let pointerDown = false;
    let disposed = false;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const later = (ms: number) => {
      const t = setTimeout(() => {
        timers.delete(t);
        compute();
      }, ms);
      timers.add(t);
    };
    const compute = () => {
      if (disposed || ed.isDestroyed) return;
      const { selection } = ed.state;
      if (selection.empty || !ed.isFocused || pointerDown || !ed.isEditable) {
        setRect(null);
        setDocLinkState(null);
        return;
      }
      try {
        const a = ed.view.coordsAtPos(selection.from);
        const b = ed.view.coordsAtPos(selection.to);
        const left = Math.min(a.left, b.left);
        const right = Math.max(a.right, b.right);
        setRect(new DOMRect(left, Math.min(a.top, b.top), Math.max(1, right - left), Math.max(a.bottom, b.bottom) - Math.min(a.top, b.top)));
      } catch {
        setRect(null);
      }
    };
    const down = () => {
      pointerDown = true;
      setRect(null);
      setDocLinkState(null);
    };
    const up = () => {
      pointerDown = false;
      later(0);
    };
    const blur = () => later(120);
    ed.on('selectionUpdate', compute);
    ed.on('focus', compute);
    ed.on('blur', blur);
    dom.addEventListener('pointerdown', down);
    window.addEventListener('pointerup', up);
    const scroller = session.scrollEl;
    scroller?.addEventListener('scroll', compute, { passive: true });
    return () => {
      disposed = true;
      timers.forEach(clearTimeout);
      ed.off('selectionUpdate', compute);
      ed.off('focus', compute);
      ed.off('blur', blur);
      dom.removeEventListener('pointerdown', down);
      window.removeEventListener('pointerup', up);
      scroller?.removeEventListener('scroll', compute);
    };
  }, [session]);

  useEffect(() => {
    if (rect) {
      refs.setPositionReference({ getBoundingClientRect: () => rect });
      update();
    }
  }, [rect, refs, update]);

  if (!rect) return null;
  return (
    <FloatingPortal>
      <div
        ref={refs.setFloating}
        style={floatingStyles}
        data-overlay
        className="z-40 flex flex-col gap-1"
        onMouseDown={(e) => e.preventDefault()}
      >
        <div className="flex gap-0.5 rounded-xl border border-slate-200 bg-white p-1 shadow-lg">
          <button
            type="button"
            data-testid="instant-doc-link-btn"
            className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-50"
            title="오프라인 초저지연(BM25+TF-IDF)으로 상위 5개 연관 문서를 즉시 찾아 위키링크로 연결합니다"
            onClick={() => {
              const res = session.recommendByCurrentSelection(5);
              setDocLinkState(res);
            }}
          >
            🔗 문서 연결
          </button>
          <button
            type="button"
            className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs hover:bg-emerald-50"
            title="선택한 텍스트와 연관된 문서 단락을 백그라운드에서 찾습니다"
            onClick={() => {
              session.requestLinkSuggestions();
              session.editor.commands.setTextSelection(session.editor.state.selection.to);
            }}
          >
            <Link2 size={13} /> 링크 생성
          </button>
          <button type="button" className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs hover:bg-amber-50" onClick={() => session.createAnnotation()}>
            <MessageSquare size={13} /> 💬 말풍선
          </button>
        </div>

        {docLinkState && (
          <div
            data-testid="instant-doc-link-dropdown"
            className="w-72 rounded-xl border border-indigo-200 bg-white p-2 shadow-xl"
          >
            <div className="mb-1.5 flex items-center justify-between border-b border-slate-100 pb-1 text-[11px] font-semibold text-indigo-800">
              <span className="flex items-center gap-1 truncate">
                <Sparkles size={12} /> 연관 문서 추천 (Top 5)
              </span>
              <button
                type="button"
                className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                onClick={() => setDocLinkState(null)}
              >
                <X size={12} />
              </button>
            </div>
            {docLinkState.recommendations.length === 0 ? (
              <p className="py-2 text-center text-xs text-slate-400">일치하는 연관 노트가 없습니다.</p>
            ) : (
              <div className="max-h-56 space-y-1 overflow-y-auto">
                {docLinkState.recommendations.map((rec) => (
                  <button
                    type="button"
                    key={rec.docId}
                    data-testid={`instant-doc-link-item-${rec.docId}`}
                    className="flex w-full flex-col items-start rounded-lg border border-transparent p-1.5 text-left hover:border-indigo-200 hover:bg-indigo-50/60"
                    onClick={() => {
                      session.applySelectionWikiLink(rec, {
                        from: docLinkState.from,
                        to: docLinkState.to,
                        text: docLinkState.text,
                      });
                      setDocLinkState(null);
                      setRect(null);
                    }}
                  >
                    <div className="flex w-full items-center justify-between gap-1">
                      <span className="truncate text-xs font-semibold text-slate-800">📄 {rec.title}</span>
                      <span className="shrink-0 rounded bg-indigo-100 px-1 py-0.5 font-mono text-[10px] text-indigo-700">
                        {rec.score.toFixed(2)}
                      </span>
                    </div>
                    {rec.matchedKeywords.length > 0 && (
                      <div className="mt-0.5 flex flex-wrap gap-1">
                        {rec.matchedKeywords.map((kw) => (
                          <span key={kw} className="rounded bg-slate-100 px-1 text-[10px] text-slate-600">
                            #{kw}
                          </span>
                        ))}
                      </div>
                    )}
                    {rec.snippet && <p className="mt-0.5 line-clamp-2 text-[11px] text-slate-500">{rec.snippet}</p>}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </FloatingPortal>
  );
}
