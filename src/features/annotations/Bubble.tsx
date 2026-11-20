import { useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type MouseEvent } from 'react';
import { useFloating, autoUpdate, offset, flip, shift, useDismiss, useInteractions, FloatingPortal } from '@floating-ui/react';
import { motion } from 'framer-motion';
import { Bot, Eye, Paperclip, Pencil, Send, Trash2, X, Loader2, Image as ImageIcon, FileText } from 'lucide-react';
import type { NoteSession } from '../../session/NoteSession';
import type { Annotation } from './types';
import {
  AI_TURN_LIMIT_MESSAGE,
  canAskAi,
  MAX_AI_TURNS_PER_BUBBLE,
  MAX_BUBBLE_CHAR_LENGTH,
} from '../../core/bubble/limits';
import { bubbleDrafts } from '../../storage/drafts';
import { PROVIDER_LABEL } from '../../ai/aiClient';
import { parseBubbleBlocks } from './bubbleMarkdownParser';
import { BubbleMarkdown } from './BubbleMarkdown';
import { useSessions } from '../../store/sessionStore';
import { useSettings, type AiProviderId } from '../../store/settingsStore';
import { useConnectedProviders } from '../../ai/useConnectedProviders';
import { pickFiles } from '../../storage/localFiles';
import { toast } from '../../store/uiStore';

type Attachment = { kind: 'image'; name: string; dataUrl: string } | { kind: 'text'; name: string; text: string };

interface Props {
  session: NoteSession;
  annotation: Annotation;
  reference: HTMLElement | null;
  onClose: () => void;
}

function readAsDataUrl(f: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(r.error);
    r.readAsDataURL(f);
  });
}

/**
 * 말풍선 주석 팝오버. 닫혀 있을 때는 언마운트되어 렌더링 부하 0.
 * 내장 AI 질의(최대 5회), 미니 첨부, 편집 가능한 마크다운 본문(최대 2,500자).
 */
export function Bubble({ session, annotation, reference, onClose }: Props) {
  const [question, setQuestion] = useState(() => bubbleDrafts.get(annotation.id));
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [mode, setMode] = useState<'preview' | 'edit'>(() => (annotation.body.trim().length > 0 ? 'preview' : 'edit'));
  const questionRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const busy = useSessions((s) => Boolean(s.sessions[session.id]?.streamingAnnotationIds?.[annotation.id]));
  const aiStatus = useSessions((s) => s.sessions[session.id]?.annotationAiStatus?.[annotation.id]);
  const blocks = useMemo(() => parseBubbleBlocks(annotation.body), [annotation.body]);
  const questionBlocks = useMemo(
    () => blocks.filter((b): b is Extract<typeof b, { kind: 'question' }> => b.kind === 'question'),
    [blocks],
  );
  const connected = useConnectedProviders();
  const preferred = useSettings((s) => s.aiProvider);
  const [provider, setProvider] = useState<AiProviderId | null>(null);
  const activeProvider =
    provider ??
    (preferred && connected.includes(preferred)
      ? preferred
      : connected.includes('google')
        ? 'google'
        : connected[0] ?? null);

  const { refs, floatingStyles, context } = useFloating({
    open: true,
    onOpenChange: (o) => {
      if (!o) onClose();
    },
    placement: 'right-start',
    middleware: [offset(10), flip({ fallbackPlacements: ['left-start', 'bottom', 'top'] }), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
    transform: false, // framer-motion 이 transform 을 제어하므로 top/left 위치 지정
    elements: { reference },
  });
  const dismiss = useDismiss(context, {
    outsidePress: (e) => !(e.target as HTMLElement).closest('[data-pin]'),
  });
  const { getFloatingProps } = useInteractions([dismiss]);

  const turns = annotation.turns.length;
  const limitReached = !canAskAi(turns);

  const setBody = (body: string) => session.updateAnnotation(annotation.id, { body });

  const handleSendMessage = async (
    e?: FormEvent<HTMLFormElement> | KeyboardEvent<HTMLInputElement> | MouseEvent<HTMLButtonElement>,
  ) => {
    e?.preventDefault();
    e?.stopPropagation();

    const q = question.trim();
    if (!q || busy) return;
    if (!activeProvider) {
      toast.error('연결된 AI 서비스가 없습니다. 우측 사이드바에서 API Key를 등록하세요.');
      return;
    }

    const pendingAttachments = attachments;
    setQuestion('');
    bubbleDrafts.set(annotation.id, '');
    setAttachments([]);
    setMode('preview');

    await session.askAnnotationAi({
      annotationId: annotation.id,
      question: q,
      provider: activeProvider,
      attachments: pendingAttachments,
    });
  };

  const scrollToQuestion = (index: number) => {
    const focusEl = () => {
      questionRefs.current.get(index)?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    };
    if (mode !== 'preview') {
      setMode('preview');
      requestAnimationFrame(focusEl);
    } else {
      focusEl();
    }
  };

  const attach = async (kind: 'image' | 'text') => {
    const files = await pickFiles(kind === 'image' ? 'image/png,image/jpeg,image/gif,image/webp' : '.txt,.md,.csv,.json', false);
    const f = files[0];
    if (!f) return;
    if (f.size > 20 * 1024 * 1024) return toast.error('첨부 파일은 20MB 이하만 가능합니다.');
    if (kind === 'image') {
      const dataUrl = await readAsDataUrl(f);
      setAttachments((a) => [...a, { kind: 'image', name: f.name, dataUrl }]);
    } else {
      const text = await f.text();
      setAttachments((a) => [...a, { kind: 'text', name: f.name, text }]);
    }
  };

  const anchorLabel =
    annotation.anchor.type === 'text'
      ? `“${session.annotationQuote(annotation).slice(0, 60)}”`
      : annotation.anchor.type === 'strokes'
        ? `손글씨 ${annotation.anchor.strokeIds.length}획`
        : '지점 메모';

  return (
    <FloatingPortal>
      <motion.div
        ref={refs.setFloating}
        style={floatingStyles}
        {...getFloatingProps()}
        data-overlay
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ type: 'spring', stiffness: 420, damping: 30 }}
        className="z-50 w-[360px] max-w-[calc(100vw-24px)] rounded-2xl border border-amber-200 bg-white shadow-2xl"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-amber-100 bg-amber-50 px-3 py-2 rounded-t-2xl">
          <span className="text-sm">💬</span>
          <span className="flex-1 truncate text-xs text-amber-900" title={anchorLabel}>
            {anchorLabel}
          </span>
          <button type="button" className="icon-btn" title="주석 삭제" onClick={() => session.deleteAnnotation(annotation.id)}>
            <Trash2 size={14} />
          </button>
          <button type="button" className="icon-btn" title="닫기(최소화)" onClick={onClose}>
            <X size={14} />
          </button>
        </div>

        <div className="flex items-center justify-between gap-2 border-b border-slate-100 bg-slate-50/80 px-3 py-1.5">
          {questionBlocks.length >= 2 ? (
            <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" data-testid="bubble-question-nav">
              <span className="shrink-0 text-[10px] font-medium text-slate-500">질문 {questionBlocks.length}개</span>
              {questionBlocks.map((qb) => (
                <button
                  key={qb.index}
                  type="button"
                  title={qb.content}
                  onClick={() => scrollToQuestion(qb.index)}
                  className="shrink-0 rounded-full bg-indigo-100 px-2 py-0.5 text-[10px] font-bold text-indigo-700 transition-colors hover:bg-indigo-200"
                >
                  Q{qb.index}
                </button>
              ))}
            </div>
          ) : (
            <span className="text-[10px] font-medium text-slate-400">
              {mode === 'edit' ? '마크다운 편집 모드' : '마크다운 보기 모드'}
            </span>
          )}
          <button
            type="button"
            data-bubble-mode-toggle="true"
            onClick={() => setMode((m) => (m === 'preview' ? 'edit' : 'preview'))}
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-0.5 text-[10px] font-medium text-slate-600 transition-colors hover:bg-slate-100"
            title={mode === 'preview' ? '원문 마크다운 편집' : '마크다운 렌더링 보기'}
          >
            {mode === 'preview' ? (
              <>
                <Pencil size={10} />
                편집
              </>
            ) : (
              <>
                <Eye size={10} />
                보기
              </>
            )}
          </button>
        </div>

        <div className="max-h-[340px] overflow-y-auto px-3 py-2.5">
          {mode === 'edit' ? (
            <>
              <textarea
                className="min-h-[100px] w-full resize-none bg-transparent text-sm leading-relaxed outline-none"
                placeholder="메모를 입력하거나 아래에서 AI에게 질문하세요. (마크다운 편집 가능)"
                value={annotation.body}
                maxLength={MAX_BUBBLE_CHAR_LENGTH}
                onChange={(e) => setBody(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !e.nativeEvent.isComposing && annotation.body.trim()) {
                    e.preventDefault();
                    setMode('preview');
                  }
                }}
                onBlur={(e) => {
                  const nextTarget = e.relatedTarget as HTMLElement | null;
                  if (nextTarget?.closest('[data-bubble-mode-toggle]')) return;
                  if (annotation.body.trim().length > 0) {
                    setMode('preview');
                  }
                }}
                rows={Math.min(14, Math.max(4, annotation.body.split('\n').length + 1))}
              />
              {blocks.length > 0 && (
                <div
                  data-testid="bubble-live-preview"
                  className="mt-1.5 border-t border-amber-100 pt-2 pb-1 text-xs leading-relaxed text-slate-700"
                >
                  <div className="mb-1 text-[10px] font-medium text-amber-700">마크다운 실시간 미리보기</div>
                  <div className="space-y-2">
                    {blocks.map((block, idx) =>
                      block.kind === 'memo' ? (
                        <div key={`live-memo-${idx}`} className="rounded-lg bg-amber-50/40 px-2 py-1.5 text-[12.5px] text-slate-800">
                          <BubbleMarkdown text={block.content} />
                        </div>
                      ) : block.kind === 'question' ? (
                        <div key={`live-q-${idx}`} className="rounded-lg border border-indigo-200 bg-indigo-50/80 px-2 py-1.5">
                          <span className="mr-1.5 rounded bg-indigo-600 px-1 py-0.5 text-[9px] font-bold text-white">Q{block.index}</span>
                          <BubbleMarkdown text={block.content} className="mt-1 text-[12px] text-slate-900" />
                        </div>
                      ) : (
                        <div key={`live-a-${idx}`} className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5">
                          <BubbleMarkdown text={block.content} className="text-[12px] text-slate-800" />
                        </div>
                      ),
                    )}
                  </div>
                </div>
              )}
            </>
          ) : blocks.length === 0 ? (
            <button
              type="button"
              onClick={() => setMode('edit')}
              className="w-full rounded-xl border border-dashed border-slate-200 px-3 py-5 text-center text-xs text-slate-400 transition-colors hover:border-amber-300 hover:text-slate-600"
            >
              메모가 비어 있습니다. 눌러서 마크다운을 입력하거나 아래에서 AI에게 질문하세요.
            </button>
          ) : (
            <div className="space-y-2.5" data-testid="bubble-preview">
              {blocks.map((block, idx) => {
                if (block.kind === 'memo') {
                  return (
                    <div
                      key={`memo-${idx}`}
                      data-bubble-role="memo"
                      title="클릭하여 마크다운 편집"
                      onClick={(e) => {
                        if ((e.target as HTMLElement).closest('a')) return;
                        setMode('edit');
                      }}
                      className="cursor-text rounded-lg bg-amber-50/40 px-2 py-1.5 text-[13px] text-slate-800 transition-colors hover:bg-amber-50/80"
                    >
                      <BubbleMarkdown text={block.content} />
                    </div>
                  );
                }

                if (block.kind === 'question') {
                  return (
                    <div
                      key={`q-${block.index}-${idx}`}
                      ref={(el) => {
                        if (el) questionRefs.current.set(block.index, el);
                        else questionRefs.current.delete(block.index);
                      }}
                      data-bubble-role="question"
                      data-question-index={block.index}
                      className={block.index > 1 ? 'mt-3 border-t-2 border-dashed border-slate-200 pt-2.5' : undefined}
                    >
                      <div className="rounded-xl border border-indigo-200 border-l-4 border-l-indigo-500 bg-indigo-50/90 px-2.5 py-2 shadow-xs">
                        <div className="flex items-center gap-1.5">
                          <span className="inline-flex items-center rounded-md bg-indigo-600 px-1.5 py-0.5 text-[10px] font-bold tracking-tight text-white">
                            Q{block.index}
                          </span>
                          <span className="text-[10px] font-semibold text-indigo-800">질문</span>
                        </div>
                        <BubbleMarkdown text={block.content} className="mt-1 text-[13px] font-medium text-slate-900" />
                      </div>
                    </div>
                  );
                }

                return (
                  <div
                    key={`a-${block.index}-${idx}`}
                    data-bubble-role="answer"
                    data-answer-index={block.index}
                    className="rounded-xl border border-slate-200 bg-slate-50/95 px-2.5 py-2"
                  >
                    <div className="flex items-center gap-1.5">
                      <Bot size={12} className="shrink-0 text-emerald-600" />
                      <span className="text-[10px] font-semibold text-emerald-700">AI 답변</span>
                      <span className="rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] font-medium text-slate-500">
                        {block.providerLabel}
                      </span>
                      {idx === blocks.length - 1 && aiStatus?.usedFallback && aiStatus.model && (
                        <span
                          data-testid="bubble-fallback-badge"
                          className="rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[9px] font-medium text-amber-800"
                          title={`선택 모델(${aiStatus.requestedModel ?? '기본 모델'}) 혼잡으로 경량 모델(${aiStatus.model})로 응답했습니다.`}
                        >
                          폴백 · {aiStatus.model}
                        </span>
                      )}
                      {busy && idx === blocks.length - 1 && (
                        <Loader2 size={11} className="ml-auto animate-spin text-indigo-500" />
                      )}
                    </div>
                    {block.content.trim() ? (
                      <BubbleMarkdown text={block.content} className="mt-1.5 text-[12.5px] text-slate-800" />
                    ) : busy && idx === blocks.length - 1 ? (
                      <p data-testid="bubble-ai-status-text" className="mt-1.5 text-xs text-indigo-600">
                        {aiStatus?.message || '답변을 작성하고 있습니다…'}
                      </p>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <div className="flex justify-between px-3 pb-1 text-[10px] text-slate-400">
          <span>
            AI {turns}/{MAX_AI_TURNS_PER_BUBBLE}회
          </span>
          <span>
            {annotation.body.length.toLocaleString()}/{MAX_BUBBLE_CHAR_LENGTH.toLocaleString()}자
          </span>
        </div>

        <div className="border-t border-slate-100 p-2">
          {limitReached ? (
            <p className="rounded-lg bg-slate-100 px-2 py-2 text-center text-xs text-slate-500">{AI_TURN_LIMIT_MESSAGE}</p>
          ) : (
            <>
              {attachments.length > 0 && (
                <div className="mb-1 flex flex-wrap gap-1">
                  {attachments.map((a, i) => (
                    <span key={i} className="flex items-center gap-1 rounded bg-slate-100 px-1.5 py-0.5 text-[10px]">
                      {a.kind === 'image' ? <ImageIcon size={10} /> : <FileText size={10} />}
                      {a.name}
                      <button type="button" onClick={() => setAttachments((l) => l.filter((_, j) => j !== i))}>
                        <X size={10} />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <form className="flex items-center gap-1" onSubmit={(e) => void handleSendMessage(e)}>
                <select
                  className="rounded border border-slate-200 bg-white px-1 py-1 text-[11px]"
                  value={activeProvider ?? ''}
                  onChange={(e) => setProvider(e.target.value as AiProviderId)}
                  title="AI 에이전트"
                >
                  {connected.length === 0 && <option value="">AI 미연결</option>}
                  {connected.map((p) => (
                    <option key={p} value={p}>
                      {PROVIDER_LABEL[p]}
                    </option>
                  ))}
                </select>
                <AttachMenu onPick={attach} />
                <input
                  className="min-w-0 flex-1 rounded-lg border border-slate-200 px-2 py-1 text-xs outline-none focus:border-indigo-400"
                  placeholder="AI에게 질문…"
                  value={question}
                  disabled={busy}
                  onChange={(e) => {
                    setQuestion(e.target.value);
                    bubbleDrafts.set(annotation.id, e.target.value);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      void handleSendMessage(e);
                    }
                  }}
                />
                <button type="submit" className="btn-primary !px-2 !py-1 text-xs" disabled={busy || !question.trim()} title="AI에게 질문">
                  {busy ? <Loader2 size={14} className="animate-spin" /> : <Bot size={14} />}
                  <Send size={12} />
                </button>
              </form>
            </>
          )}
        </div>
      </motion.div>
    </FloatingPortal>
  );
}

function AttachMenu({ onPick }: { onPick: (k: 'image' | 'text') => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button type="button" className="icon-btn" title="미니 파일 첨부" onClick={() => setOpen((o) => !o)}>
        <Paperclip size={14} />
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-10 mb-1 w-28 rounded-lg border bg-white py-1 text-xs shadow-lg">
          <button type="button" className="menu-item" onClick={() => (setOpen(false), onPick('image'))}>
            <ImageIcon size={12} /> 이미지
          </button>
          <button type="button" className="menu-item" onClick={() => (setOpen(false), onPick('text'))}>
            <FileText size={12} /> 문서 조각
          </button>
        </div>
      )}
    </div>
  );
}
