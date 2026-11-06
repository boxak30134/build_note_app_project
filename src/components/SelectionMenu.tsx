import { useEffect, useState, useRef } from 'react';
import { useFloating, autoUpdate, offset, flip, shift, FloatingPortal } from '@floating-ui/react';
import { Languages, Link2, MessageSquare, Sparkles, X, Check } from 'lucide-react';
import type { NoteSession } from '../session/NoteSession';
import type { LinkRecommendation } from '../services/offlineDocumentLinker';
import type { TranslationResolution } from '../types/adaptiveGlossary';
import { UnifiedTranslationButton } from './UnifiedTranslationButton';
import { loadApiKey } from '../storage/secureStore';
import { useSettings } from '../store/settingsStore';

interface TranslationContextState {
  from: number;
  to: number;
  targetWord: string;
  surroundingSentence: string;
  activeTag: string;
  resolution: TranslationResolution;
}

interface SelectionRangeState {
  from: number;
  to: number;
  selectedText: string;
  surroundingSentence: string;
  documentTags: string[];
}

/** 텍스트 드래그 시 플로팅 메뉴: [적응형 문맥 번역] [🔗 문서 연결] [링크 생성] [💬 말풍선] */
export function SelectionMenu({ session }: { session: NoteSession }) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [docLinkState, setDocLinkState] = useState<{
    text: string;
    from: number;
    to: number;
    recommendations: LinkRecommendation[];
  } | null>(null);
  const [translationCtx, setTranslationCtx] = useState<TranslationContextState | null>(null);
  const [selectionRange, setSelectionRange] = useState<SelectionRangeState | null>(null);
  const [geminiApiKey, setGeminiApiKey] = useState<string | null>(null);
  const [editTranslationOpen, setEditTranslationOpen] = useState(false);
  const [customMeaning, setCustomMeaning] = useState('');
  const isModalOpenRef = useRef(false);
  const translationInsertMode = useSettings((s) => s.translationInsertMode);

  useEffect(() => {
    let active = true;
    void loadApiKey('google').then((k) => {
      if (active) setGeminiApiKey(k);
    });
    return () => {
      active = false;
    };
  }, []);

  const { refs, floatingStyles, update } = useFloating({
    placement: 'top',
    middleware: [offset(8), flip(), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });

  useEffect(() => {
    const ed = session.editor;
    if (ed.isDestroyed) return;
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
      // 키 등록 모달 등 전용 팝업이 떠 있는 경우 blur로 인해 선택 메뉴가 닫히지 않도록 보호
      if (isModalOpenRef.current || document.querySelector('[data-testid="unified-translate-key-dialog"]')) {
        return;
      }
      const { selection } = ed.state;
      if (selection.empty || !ed.isFocused || pointerDown || !ed.isEditable) {
        setRect(null);
        setDocLinkState(null);
        setTranslationCtx(null);
        setSelectionRange(null);
        setEditTranslationOpen(false);
        return;
      }
      try {
        const a = ed.view.coordsAtPos(selection.from);
        const b = ed.view.coordsAtPos(selection.to);
        const left = Math.min(a.left, b.left);
        const right = Math.max(a.right, b.right);
        setRect(
          new DOMRect(
            left,
            Math.min(a.top, b.top),
            Math.max(1, right - left),
            Math.max(a.bottom, b.bottom) - Math.min(a.top, b.top),
          ),
        );

        const selectedText = ed.state.doc.textBetween(selection.from, selection.to, ' ').trim();
        const docSize = ed.state.doc.content.size;
        const ctxStart = Math.max(0, selection.from - 250);
        const ctxEnd = Math.min(docSize, selection.to + 250);
        const contextSnippet = ed.state.doc.textBetween(ctxStart, ctxEnd, ' ');
        const fullText = ed.state.doc.textBetween(0, Math.min(docSize, 2000), ' ');
        const tagMatches = fullText.match(/#[a-zA-Z0-9가-힣_-]+/g) || [];
        const documentTags = [...tagMatches.map((t) => t.slice(1)), session.record.title];
        const surroundingSentence = `${session.record.title} ${contextSnippet}`.trim();

        if (selectedText) {
          setSelectionRange({
            from: selection.from,
            to: selection.to,
            selectedText,
            surroundingSentence,
            documentTags,
          });
        } else {
          setSelectionRange(null);
        }

        const tr = session.resolveSelectionTranslation();
        setTranslationCtx(tr);
        if (tr) {
          setCustomMeaning(tr.resolution.selectedMeaning);
        }
      } catch {
        setRect(null);
        setSelectionRange(null);
      }
    };
    const down = (e: PointerEvent) => {
      if (isModalOpenRef.current || (e.target as HTMLElement)?.closest?.('[data-testid="unified-translate-key-dialog"]')) {
        return;
      }
      pointerDown = true;
      setRect(null);
      setDocLinkState(null);
      setTranslationCtx(null);
      setSelectionRange(null);
      setEditTranslationOpen(false);
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

  const applyMeaning = (meaning: string) => {
    if (!translationCtx || !meaning.trim()) return;
    session.applyTranslation(meaning.trim(), translationCtx, true);
    setEditTranslationOpen(false);
    setTranslationCtx(null);
    setSelectionRange(null);
    setRect(null);
  };

  const handleApplyRuby = (original: string, translated: string) => {
    if (!selectionRange) return;
    session.applyTranslation(
      translated,
      {
        from: selectionRange.from,
        to: selectionRange.to,
        targetWord: original,
        surroundingSentence: selectionRange.surroundingSentence,
        activeTag: selectionRange.documentTags[0] || 'default',
      },
      true,
    );
    isModalOpenRef.current = false;
    setEditTranslationOpen(false);
    setTranslationCtx(null);
    setSelectionRange(null);
    setRect(null);
  };

  return (
    <FloatingPortal>
      <div
        ref={refs.setFloating}
        style={floatingStyles}
        data-overlay
        className="z-40 flex flex-col gap-1"
        onMouseDown={(e) => {
          // 입력창 포커스는 허용하고 버튼 클릭 시 에디터 포커스 손실 방지
          if ((e.target as HTMLElement).tagName !== 'INPUT') {
            e.preventDefault();
          }
        }}
      >
        <div className="flex flex-wrap items-center gap-0.5 rounded-xl border border-slate-200 bg-white p-1 shadow-lg">
          {selectionRange && (
            <div className="flex items-center gap-0.5 border-r border-slate-200 pr-1 mr-0.5">
              <UnifiedTranslationButton
                selectedText={selectionRange.selectedText}
                surroundingSentence={selectionRange.surroundingSentence}
                documentTags={selectionRange.documentTags}
                apiKey={geminiApiKey}
                onApiKeySaved={(k) => setGeminiApiKey(k)}
                onModalToggle={(open) => {
                  isModalOpenRef.current = open;
                }}
                onOpenSettings={() => useSettings.getState().set({ rightOpen: true })}
                onApplyRuby={handleApplyRuby}
              />
            </div>
          )}

          {translationCtx && (
            <div className="flex items-center gap-0.5 border-r border-slate-200 pr-1 mr-0.5">
              <button
                type="button"
                data-testid="instant-translate-apply-btn"
                className="flex items-center gap-1.5 rounded-lg bg-violet-50 px-2 py-1 text-xs font-semibold text-violet-800 hover:bg-violet-100"
                title={
                  translationInsertMode === 'parentheses'
                    ? `클릭 시 "${translationCtx.targetWord} (${translationCtx.resolution.selectedMeaning})" 괄호 형식으로 본문에 삽입합니다`
                    : translationInsertMode === 'replace'
                      ? `클릭 시 "${translationCtx.resolution.selectedMeaning}" 번역문으로 원문을 대체합니다`
                      : `클릭 시 <ruby>${translationCtx.targetWord}<rt>${translationCtx.resolution.selectedMeaning}</rt></ruby> 루비 주석으로 삽입합니다`
                }
                onClick={() => applyMeaning(translationCtx.resolution.selectedMeaning)}
              >
                <Languages size={13} className="text-violet-600" />
                <span>{translationCtx.resolution.selectedMeaning}</span>
                <span className="rounded bg-violet-200/80 px-1 py-0.2 font-mono text-[10px] text-violet-900">
                  {translationCtx.resolution.confidence}%
                </span>
              </button>
              <button
                type="button"
                data-testid="instant-translate-edit-btn"
                className="rounded-lg px-1.5 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-100"
                title="다른 뜻 선택 또는 사용자 번역어 직접 입력(학습)"
                onClick={() => {
                  setEditTranslationOpen((o) => !o);
                  setDocLinkState(null);
                }}
              >
                ▾ (수정)
              </button>
            </div>
          )}

          <button
            type="button"
            data-testid="instant-doc-link-btn"
            className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-50"
            title="오프라인 초저지연(BM25+TF-IDF)으로 상위 5개 연관 문서를 즉시 찾아 위키링크로 연결합니다"
            onClick={() => {
              const res = session.recommendByCurrentSelection(5);
              setDocLinkState(res);
              setEditTranslationOpen(false);
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
          <button
            type="button"
            className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs hover:bg-amber-50"
            onClick={() => session.createAnnotation()}
          >
            <MessageSquare size={13} /> 💬 말풍선
          </button>
        </div>

        {editTranslationOpen && translationCtx && (
          <div
            data-testid="instant-translate-dropdown"
            className="w-72 rounded-xl border border-violet-200 bg-white p-2.5 shadow-xl"
          >
            <div className="mb-1.5 flex items-center justify-between border-b border-slate-100 pb-1 text-[11px] font-semibold text-violet-900">
              <span className="flex items-center gap-1 truncate">
                <Languages size={12} /> 문맥 적응형 번역 · "{translationCtx.targetWord}"
              </span>
              <button
                type="button"
                className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                onClick={() => setEditTranslationOpen(false)}
              >
                <X size={12} />
              </button>
            </div>

            <div className="mb-2 flex items-center justify-between text-[10px] text-slate-500">
              <span>
                판별 출처:{' '}
                <strong className="text-violet-700">
                  {translationCtx.resolution.source === 'user_learned'
                    ? '개인화 학습 사전'
                    : translationCtx.resolution.source === 'seed_context'
                      ? '학술 문맥 시드'
                      : '기본 사전'}
                </strong>
              </span>
              {translationCtx.resolution.matchedTrigger && (
                <span className="rounded bg-violet-50 px-1.5 py-0.5 font-mono text-[10px] text-violet-700">
                  트리거: {translationCtx.resolution.matchedTrigger}
                </span>
              )}
            </div>

            {translationCtx.resolution.alternatives.length > 0 && (
              <div className="mb-2 space-y-1">
                <div className="text-[10px] font-medium text-slate-400">대안 번역어 선택</div>
                {translationCtx.resolution.alternatives.map((alt, idx) => (
                  <button
                    type="button"
                    key={`${alt.meaning}-${idx}`}
                    data-testid={`instant-translate-alt-${idx}`}
                    className="flex w-full items-center justify-between rounded-lg border border-slate-100 px-2 py-1 text-left text-xs text-slate-700 hover:border-violet-200 hover:bg-violet-50/60"
                    onClick={() => applyMeaning(alt.meaning)}
                  >
                    <span>{alt.meaning}</span>
                    <span className="font-mono text-[10px] text-slate-400">{alt.confidence}%</span>
                  </button>
                ))}
              </div>
            )}

            <div className="space-y-1 border-t border-slate-100 pt-2">
              <label className="block text-[10px] font-medium text-slate-500">
                직접 수정 및 문맥 학습 (다음번 최우선 추천)
              </label>
              <div className="flex gap-1">
                <input
                  type="text"
                  data-testid="instant-translate-custom-input"
                  value={customMeaning}
                  onChange={(e) => setCustomMeaning(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      applyMeaning(customMeaning);
                    }
                  }}
                  placeholder="번역어 직접 입력 (예: 체)"
                  className="min-w-0 flex-1 rounded-lg border border-slate-200 px-2 py-1 text-xs outline-none focus:border-violet-400"
                />
                <button
                  type="button"
                  data-testid="instant-translate-custom-submit"
                  className="flex shrink-0 items-center gap-1 rounded-lg bg-violet-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-violet-700"
                  onClick={() => applyMeaning(customMeaning)}
                >
                  <Check size={12} /> 학습·삽입
                </button>
              </div>
            </div>
          </div>
        )}

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
