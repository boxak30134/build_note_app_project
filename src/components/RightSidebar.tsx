import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type MouseEvent } from 'react';
import { motion } from 'framer-motion';
import { KeyRound, Send, Loader2, Settings, MessageCircle, Trash2, Sparkles, ShieldCheck, ArrowLeft, ExternalLink, Square, Link2 } from 'lucide-react';
import type { ModelMessage } from 'ai';
import { useSettings, DEFAULT_MODELS, type AiProviderId } from '../store/settingsStore';
import { useSessionUI } from '../store/sessionStore';
import { useTabs } from '../store/tabsStore';
import { saveApiKey, removeApiKey, loadTranslateApiKey, saveTranslateApiKey, removeTranslateApiKey } from '../storage/secureStore';
import { useConnectedProviders, useProvidersLoaded, refreshProviders } from '../ai/useConnectedProviders';
import { streamAi, PROVIDER_LABEL, PROVIDER_KEY_URL } from '../ai/aiClient';
import {
  clearGeminiClientCache,
  GEMINI_FALLBACK_MODEL,
  GEMINI_PRIMARY_MODEL,
  parseMathSegments,
  SIDEBAR_MAX_OUTPUT_TOKENS,
  streamGeminiTutor,
} from '../modules/ai';
import { getSession } from '../session/NoteSession';
import { openWikiTarget } from './WikiPreview';
import { toast } from '../store/uiStore';
import { useAiChatStore, aiChatAbortManager, type ChatMsg } from '../store/aiChatStore';

const PROVIDERS: Array<{ id: AiProviderId; emoji: string; desc: string; color: string }> = [
  { id: 'google', emoji: '🔷', desc: `Google Gemini 학술 튜터 (${GEMINI_PRIMARY_MODEL} / ${GEMINI_FALLBACK_MODEL})`, color: 'border-blue-200 hover:bg-blue-50' },
  { id: 'openai', emoji: '🟢', desc: 'OpenAI GPT 모델', color: 'border-emerald-200 hover:bg-emerald-50' },
  { id: 'anthropic', emoji: '🟠', desc: 'Anthropic Claude 모델', color: 'border-orange-200 hover:bg-orange-50' },
];

/** 오른쪽 사이드바: 생성형 AI 허브 & BYOK 온보딩 */
export function RightSidebar() {
  const connected = useConnectedProviders();
  const loaded = useProvidersLoaded();
  const [view, setView] = useState<'chat' | 'settings'>('chat');
  const [connecting, setConnecting] = useState<AiProviderId | null>(null);

  if (!loaded) return <aside className="h-full bg-white" />;

  return (
    <aside className="flex h-full min-w-0 flex-col bg-white">
      <div className="flex items-center gap-1 border-b border-slate-200 px-2 py-1.5">
        <span className="flex-1 text-sm font-semibold text-slate-700">🤖 AI 허브</span>
        <button type="button" className={`icon-btn ${view === 'chat' ? 'text-indigo-600' : ''}`} onClick={() => setView('chat')} title="채팅">
          <MessageCircle size={16} />
        </button>
        <button type="button" className={`icon-btn ${view === 'settings' ? 'text-indigo-600' : ''}`} onClick={() => setView('settings')} title="설정">
          <Settings size={16} />
        </button>
      </div>
      {connecting ? (
        <ConnectForm provider={connecting} onDone={() => setConnecting(null)} />
      ) : view === 'settings' ? (
        <SettingsPanel connected={connected} onConnect={setConnecting} />
      ) : connected.length === 0 ? (
        <Onboarding onPick={setConnecting} />
      ) : (
        <Chat connected={connected} />
      )}
      <RelatedNotesPanel />
    </aside>
  );
}

/** 우측 하단 '연관 노트(Related Notes)' 오프라인 자동 추천 패널 (저장 시 또는 1000ms 편집 멈춤 시 자동 갱신) */
export function RelatedNotesPanel() {
  const activeId = useTabs((s) => s.activeTabId);
  const ui = useSessionUI(activeId);

  if (!activeId) return null;

  return (
    <section
      data-testid="related-notes-panel"
      className="max-h-56 shrink-0 overflow-y-auto border-t border-slate-200 bg-slate-50/70 p-2.5"
    >
      <div className="mb-1.5 flex items-center justify-between">
        <span className="flex items-center gap-1 text-xs font-semibold text-slate-700">
          <Link2 size={13} className="text-indigo-600" /> 연관 노트 (Related Notes)
        </span>
        <span className="text-[10px] text-slate-400">오프라인 TF-IDF · 수식</span>
      </div>
      {ui.relatedNotes.length === 0 ? (
        <p className="py-2 text-center text-[11px] text-slate-400">
          현재 노트와 유사한 수학 개념·키워드를 가진 노트가 없습니다.
        </p>
      ) : (
        <div className="space-y-1.5">
          {ui.relatedNotes.map((rec) => (
            <div
              key={rec.docId}
              data-testid={`related-note-card-${rec.docId}`}
              className=" cursor-pointer rounded-xl border border-slate-200 bg-white p-2 shadow-xs transition hover:border-indigo-300 hover:bg-indigo-50/40"
              onClick={() => void openWikiTarget(rec.docId, null)}
            >
              <div className="flex items-center justify-between gap-1">
                <span className="truncate text-xs font-semibold text-slate-800">📄 {rec.title}</span>
                <span className="shrink-0 rounded bg-indigo-50 px-1.5 py-0.5 font-mono text-[10px] font-medium text-indigo-700">
                  {Math.round(rec.score * 100)}%
                </span>
              </div>
              {rec.matchedKeywords.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {rec.matchedKeywords.map((kw) => (
                    <span key={kw} className="rounded bg-slate-100 px-1 py-0.2 text-[10px] text-slate-600">
                      #{kw}
                    </span>
                  ))}
                </div>
              )}
              {rec.snippet && <p className="mt-1 line-clamp-2 text-[11px] text-slate-500">{rec.snippet}</p>}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function Onboarding({ onPick }: { onPick: (p: AiProviderId) => void }) {
  return (
    <div className="flex-1 overflow-y-auto p-4">
      <div className="mb-4 text-center">
        <Sparkles className="mx-auto mb-2 text-indigo-500" />
        <h3 className="text-sm font-semibold text-slate-800">AI 에이전트를 연결하세요</h3>
        <p className="mt-1 text-xs text-slate-500">사용자 본인의 계정/토큰(BYOK)으로 동작합니다. 모든 호출 비용은 연결한 계정의 쿼터로 처리됩니다.</p>
      </div>
      <div className="space-y-2">
        {PROVIDERS.map((p, i) => (
          <motion.button
            type="button"
            key={p.id}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.06 }}
            className={`flex w-full items-center gap-3 rounded-xl border bg-white p-3 text-left ${p.color}`}
            onClick={() => onPick(p.id)}
          >
            <span className="text-2xl">{p.emoji}</span>
            <span>
              <span className="block text-sm font-semibold">{PROVIDER_LABEL[p.id]}</span>
              <span className="block text-xs text-slate-500">{p.desc}</span>
            </span>
          </motion.button>
        ))}
      </div>
    </div>
  );
}

function ConnectForm({ provider, onDone }: { provider: AiProviderId; onDone: () => void }) {
  const { aiModels, set } = useSettings();
  const [key, setKey] = useState('');
  const [model, setModel] = useState(aiModels[provider]);
  const [busy, setBusy] = useState(false);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!key.trim()) return;
    setBusy(true);
    try {
      await saveApiKey(provider, key.trim());
      if (provider === 'google') clearGeminiClientCache();
      set({ aiModels: { ...aiModels, [provider]: model.trim() || DEFAULT_MODELS[provider] }, aiProvider: provider });
      await refreshProviders();
      toast.success(`${PROVIDER_LABEL[provider]} 연결 완료 (키는 이 기기에 AES-GCM 으로 암호화 저장됨)`);
      onDone();
    } catch (err) {
      toast.error(`저장 실패: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="flex-1 overflow-y-auto p-4" onSubmit={(e) => void submit(e)}>
      <button type="button" className="btn-ghost mb-3" onClick={onDone}>
        <ArrowLeft size={14} /> 뒤로
      </button>
      <h3 className="mb-1 text-sm font-semibold">{PROVIDER_LABEL[provider]} 연결</h3>
      <button type="button" className="mb-3 w-full cursor-not-allowed rounded-lg border border-dashed border-slate-300 py-2 text-xs text-slate-400" disabled title="OAuth 앱 등록이 필요하여 현재 빌드에서는 비활성화되어 있습니다">
        계정으로 로그인 (OAuth) — 준비 중
      </button>
      <label className="mb-1 block text-xs font-medium text-slate-600">개인 API Key (BYOK)</label>
      <input
        type="password"
        className="mb-2 w-full rounded-lg border px-2 py-1.5 font-mono text-xs outline-none focus:border-indigo-400"
        placeholder="sk-… / AIza… / sk-ant-…"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        autoFocus
      />
      <a className="mb-3 flex items-center gap-1 text-[11px] text-indigo-600 hover:underline" href={PROVIDER_KEY_URL[provider]} target="_blank" rel="noreferrer">
        API Key 발급 페이지 <ExternalLink size={10} />
      </a>
      <label className="mb-1 block text-xs font-medium text-slate-600">모델 ID</label>
      <input className="mb-3 w-full rounded-lg border px-2 py-1.5 font-mono text-xs outline-none focus:border-indigo-400" value={model} onChange={(e) => setModel(e.target.value)} />
      <div className="mb-3 flex items-start gap-2 rounded-lg bg-slate-50 p-2 text-[11px] text-slate-500">
        <ShieldCheck size={14} className="mt-0.5 shrink-0 text-emerald-600" />
        키는 서버로 전송되지 않으며, 브라우저의 추출 불가능한 AES-GCM 키로 암호화되어 IndexedDB 에만 저장됩니다. AI 호출은 이 기기에서 해당 서비스로 직접 이루어집니다.
      </div>
      <button type="submit" className="btn-primary w-full justify-center" disabled={!key.trim() || busy}>
        {busy ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />} 연결
      </button>
    </form>
  );
}

function SettingsPanel({ connected, onConnect }: { connected: AiProviderId[]; onConnect: (p: AiProviderId) => void }) {
  const { aiModels, set, esUrl, esIndex, aiProvider, translationInsertMode, setTranslationInsertMode } = useSettings();
  const [translateKey, setTranslateKey] = useState<string | null>(null);
  const [editingTranslate, setEditingTranslate] = useState(false);
  const [newTranslateKey, setNewTranslateKey] = useState('');

  useEffect(() => {
    void loadTranslateApiKey().then(setTranslateKey);
  }, []);

  return (
    <div className="flex-1 space-y-4 overflow-y-auto p-3 text-xs">
      <section>
        <h4 className="mb-2 font-semibold text-slate-700">AI 서비스</h4>
        {PROVIDERS.map((p) => {
          const on = connected.includes(p.id);
          return (
            <div key={p.id} className="mb-2 rounded-lg border p-2">
              <div className="flex items-center gap-2">
                <span>{p.emoji}</span>
                <span className="flex-1 font-medium">{PROVIDER_LABEL[p.id]}</span>
                {on ? (
                  <>
                    <label className="flex items-center gap-1">
                      <input type="radio" checked={aiProvider === p.id} onChange={() => set({ aiProvider: p.id })} /> 기본
                    </label>
                    <button
                      type="button"
                      className="icon-btn text-red-500"
                      title="연결 해제"
                      onClick={async () => {
                        await removeApiKey(p.id);
                        if (p.id === 'google') clearGeminiClientCache();
                        await refreshProviders();
                        if (aiProvider === p.id) set({ aiProvider: null });
                      }}
                    >
                      <Trash2 size={12} />
                    </button>
                  </>
                ) : (
                  <button type="button" className="btn-ghost text-[11px]" onClick={() => onConnect(p.id)}>
                    연결
                  </button>
                )}
              </div>
              {on && (
                <input
                  className="mt-1 w-full rounded border px-1.5 py-1 font-mono"
                  value={aiModels[p.id]}
                  onChange={(e) => set({ aiModels: { ...aiModels, [p.id]: e.target.value } })}
                  title="모델 ID"
                />
              )}
            </div>
          );
        })}
      </section>

      <section>
        <h4 className="mb-2 font-semibold text-slate-700">번역 서비스 (Google Cloud Translation API)</h4>
        <div className="mb-2 rounded-lg border p-2">
          <div className="flex items-center gap-2">
            <span>🌐</span>
            <span className="flex-1 font-medium">Google Cloud Translation</span>
            {translateKey ? (
              <>
                <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">연결됨</span>
                <button
                  type="button"
                  className="icon-btn text-red-500"
                  title="번역 키 삭제"
                  onClick={async () => {
                    await removeTranslateApiKey();
                    setTranslateKey(null);
                    toast.info('Google Translate API 키가 삭제되었습니다.');
                  }}
                >
                  <Trash2 size={12} />
                </button>
              </>
            ) : (
              <button
                type="button"
                className="btn-ghost text-[11px]"
                onClick={() => setEditingTranslate(true)}
              >
                키 등록
              </button>
            )}
          </div>
          <p className="mt-1 text-[11px] text-slate-400">
            Google Gemini 학술 튜터 키와는 별개로 관리되는 전용 번역 API 키입니다.
          </p>
          {editingTranslate && (
            <div className="mt-2 space-y-1.5 border-t border-slate-100 pt-2">
              <input
                type="password"
                className="w-full rounded border px-2 py-1 font-mono text-xs outline-none focus:border-indigo-400"
                placeholder="AIzaSy... (Translation API Key)"
                value={newTranslateKey}
                onChange={(e) => setNewTranslateKey(e.target.value)}
                autoFocus
              />
              <div className="flex justify-end gap-1.5">
                <button
                  type="button"
                  className="rounded px-2 py-0.5 text-[11px] text-slate-500 hover:bg-slate-100"
                  onClick={() => {
                    setEditingTranslate(false);
                    setNewTranslateKey('');
                  }}
                >
                  취소
                </button>
                <button
                  type="button"
                  className="btn-primary px-2.5 py-0.5 text-[11px]"
                  onClick={async () => {
                    if (!newTranslateKey.trim()) return;
                    await saveTranslateApiKey(newTranslateKey.trim());
                    setTranslateKey(newTranslateKey.trim());
                    setEditingTranslate(false);
                    setNewTranslateKey('');
                    toast.success('Google Translate API 키가 등록되었습니다.');
                  }}
                >
                  저장
                </button>
              </div>
            </div>
          )}
        </div>
      </section>

      <section>
        <h4 className="mb-2 font-semibold text-slate-700">번역 결과 삽입 방식 설정</h4>
        <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50/70 p-2.5">
          <label className="flex items-start gap-2 cursor-pointer hover:text-slate-900">
            <input
              type="radio"
              name="sidebarTranslationMode"
              value="parentheses"
              checked={translationInsertMode === 'parentheses'}
              onChange={() => setTranslationInsertMode('parentheses')}
              data-testid="sidebar-mode-parentheses"
              className="mt-0.5 accent-indigo-600"
            />
            <div>
              <span className="font-medium text-slate-800">1. 원문 뒤 괄호 삽입 (기본)</span>
              <p className="text-[11px] text-slate-500">원래 문장 뒤에 괄호치고 번역 문장을 삽입합니다. 뒤에 다른 문장이 있어도 그 사이에 괄호로 삽입됩니다 (예: apple (사과)).</p>
            </div>
          </label>
          <label className="flex items-start gap-2 cursor-pointer hover:text-slate-900">
            <input
              type="radio"
              name="sidebarTranslationMode"
              value="ruby"
              checked={translationInsertMode === 'ruby'}
              onChange={() => setTranslationInsertMode('ruby')}
              data-testid="sidebar-mode-ruby"
              className="mt-0.5 accent-indigo-600"
            />
            <div>
              <span className="font-medium text-slate-800">2. 루비 주석 표시</span>
              <p className="text-[11px] text-slate-500">원래 문장 위에 보라색 작은 글씨로 표시합니다.</p>
            </div>
          </label>
          <label className="flex items-start gap-2 cursor-pointer hover:text-slate-900">
            <input
              type="radio"
              name="sidebarTranslationMode"
              value="replace"
              checked={translationInsertMode === 'replace'}
              onChange={() => setTranslationInsertMode('replace')}
              data-testid="sidebar-mode-replace"
              className="mt-0.5 accent-indigo-600"
            />
            <div>
              <span className="font-medium text-slate-800">3. 원문 대체 (덮어쓰기)</span>
              <p className="text-[11px] text-slate-500">원래 문장을 번역 문장으로 대체/덮어씌웁니다.</p>
            </div>
          </label>
        </div>
      </section>
      <section>
        <h4 className="mb-1 font-semibold text-slate-700">Elasticsearch (선택)</h4>
        <p className="mb-2 text-[11px] text-slate-500">설정 시 링크 생성 검색에 Elasticsearch REST API를 사용하고, 미설정·오프라인 시 내장 MiniSearch(BM25)로 자동 폴백합니다.</p>
        <input className="mb-1 w-full rounded border px-1.5 py-1 font-mono" placeholder="http://localhost:9200" value={esUrl} onChange={(e) => set({ esUrl: e.target.value })} />
        <input className="w-full rounded border px-1.5 py-1 font-mono" placeholder="인덱스 이름" value={esIndex} onChange={(e) => set({ esIndex: e.target.value })} />
      </section>
    </div>
  );
}

function Chat({ connected }: { connected: AiProviderId[] }) {
  const { aiProvider, set } = useSettings();
  const provider =
    aiProvider && connected.includes(aiProvider)
      ? aiProvider
      : connected.includes('google')
        ? 'google'
        : connected[0];
  const activeId = useTabs((s) => s.activeTabId);
  const msgs = useAiChatStore((s) => s.messages);
  const setMsgs = useAiChatStore((s) => s.setMessages);
  const input = useAiChatStore((s) => s.inputDraft);
  const setInput = useAiChatStore((s) => s.setInputDraft);
  const busy = useAiChatStore((s) => s.busy);
  const setBusy = useAiChatStore((s) => s.setBusy);
  const statusInfo = useAiChatStore((s) => s.statusInfo);
  const setStatusInfo = useAiChatStore((s) => s.setStatusInfo);
  const clearMessages = useAiChatStore((s) => s.clearMessages);
  const endRef = useRef<HTMLDivElement>(null);
  const lastQuestionRef = useRef<string>('');

  // 주의: 최신 Chrome 에서 scrollIntoView() 는 Promise 를 반환한다.
  // 화살표 함수 축약형으로 쓰면 effect 가 Promise 를 반환해 React 가 cleanup 으로 호출하다 오류가 나므로 블록으로 감싼다.
  useEffect(() => {
    void endRef.current?.scrollIntoView({ block: 'end' });
  }, [msgs]);

  const handleSendMessage = async (
    e?: FormEvent<HTMLFormElement> | KeyboardEvent<HTMLTextAreaElement> | MouseEvent<HTMLButtonElement>,
    overrideText?: string,
  ) => {
    e?.preventDefault();
    e?.stopPropagation();

    const q = (overrideText ?? input).trim();
    if (!q || busy) return;
    lastQuestionRef.current = q;

    const s = getSession(activeId);
    // 토큰 최적화(token_optimization_guide.md §2.1~2.2): 전체 문서 통째 주입 대신 핵심 청크(최대 2,000자) 및 최근 4턴 슬라이딩 윈도우 전송
    const context = s ? s.editor.getMarkdown().slice(0, 2000) : '';
    const title = s?.record.title ?? '';
    const systemContext = context ? `[현재 노트: ${title}]\n${context}` : '(현재 열린 노트 없음)';
    const history: ChatMsg[] = [...msgs, { role: 'user', content: q }];

    setMsgs([...history, { role: 'assistant', content: '' }]);
    if (overrideText === undefined) {
      setInput('');
    }
    setBusy(true);

    const controller = aiChatAbortManager.create();

    let resolvedModelName = provider === 'google' ? GEMINI_PRIMARY_MODEL : PROVIDER_LABEL[provider];
    setStatusInfo({
      status: 'connecting',
      message: `연결 중… (${resolvedModelName})`,
      model: resolvedModelName,
    });

    try {
      const prunedHistory = history.slice(-8);
      const messages: ModelMessage[] = prunedHistory.map((m) => ({ role: m.role, content: m.content }));
      let acc = '';
      if (provider === 'google') {
        const modelId = useSettings.getState().aiModels.google || GEMINI_PRIMARY_MODEL;
        for await (const delta of streamGeminiTutor({
          messages,
          systemContext,
          target: 'sidebar',
          maxOutputTokens: SIDEBAR_MAX_OUTPUT_TOKENS,
          model: modelId,
          signal: controller.signal,
          onModelResolved: (model) => {
            resolvedModelName = model;
            setStatusInfo({
              status: 'streaming',
              message: `${model} 응답 중`,
              model,
            });
          },
          onRetry: (model, attempt, delayMs) => {
            setStatusInfo({
              status: 'retrying',
              message: `서버 혼잡(503). ${Math.max(1, Math.round(delayMs / 1000))}초 후 재시도 (${attempt}/3)`,
              model,
            });
          },
          onFallback: (fromModel, toModel) => {
            setStatusInfo({
              status: 'fallback',
              message: `${fromModel} 응답 없음. ${toModel}로 전환 중…`,
              model: toModel,
            });
          },
        })) {
          acc += delta;
          setMsgs([...history, { role: 'assistant', content: acc, model: resolvedModelName }]);
        }
        setStatusInfo({ status: 'done', model: resolvedModelName });
      } else {
        for await (const delta of streamAi({
          provider,
          target: 'sidebar',
          system: systemContext,
          messages,
          maxOutputTokens: SIDEBAR_MAX_OUTPUT_TOKENS,
          signal: controller.signal,
        })) {
          acc += delta;
          setMsgs([...history, { role: 'assistant', content: acc, model: resolvedModelName }]);
        }
        setStatusInfo({ status: 'done', model: resolvedModelName });
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        const errMsg = (err as Error)?.message || 'AI 호출 중 알 수 없는 오류가 발생했습니다.';
        toast.error(errMsg, 'AI 호출 실패');
        setStatusInfo({ status: 'error', message: errMsg });
        setMsgs([...history, { role: 'assistant', content: `⚠️ 오류로 답변을 받지 못했습니다.\n${errMsg}` }]);
      } else {
        setStatusInfo({ status: 'cancelled', message: '취소됨' });
      }
    } finally {
      setBusy(false);
      aiChatAbortManager.clear();
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 border-b px-2 py-1.5">
        <select className="rounded border bg-white px-1 py-0.5 text-xs" value={provider} onChange={(e) => set({ aiProvider: e.target.value as AiProviderId })}>
          {connected.map((p) => (
            <option key={p} value={p}>
              {PROVIDER_LABEL[p]}
            </option>
          ))}
        </select>
        <div className="flex-1" />
        <button
          type="button"
          className="btn-ghost text-[11px]"
          disabled={busy || !activeId}
          onClick={(e) => void handleSendMessage(e, '이 노트의 핵심 내용을 학술적으로 엄밀하게 요약하고, 학습자가 점검할 핵심 질문 3개를 제시해줘.')}
        >
          <Sparkles size={12} /> 노트 요약
        </button>
        <button
          type="button"
          className="icon-btn"
          title="대화 지우기"
          onClick={() => {
            clearMessages();
            toast.info('대화 내역을 초기화했습니다.');
          }}
        >
          <Trash2 size={13} />
        </button>
      </div>
      {statusInfo.status !== 'idle' && statusInfo.status !== 'done' && (
        <div className="flex items-center justify-between border-b border-indigo-100 bg-indigo-50/90 px-2.5 py-1 text-[11px] text-indigo-800">
          <div className="flex items-center gap-1.5 truncate">
            {statusInfo.status === 'connecting' || statusInfo.status === 'retrying' || statusInfo.status === 'fallback' ? (
              <Loader2 size={11} className="animate-spin text-indigo-600 shrink-0" />
            ) : null}
            <span className="truncate">{statusInfo.message}</span>
          </div>
          {statusInfo.status === 'error' ? (
            <button
              type="button"
              className="ml-2 font-semibold text-indigo-700 underline hover:text-indigo-900 shrink-0"
              onClick={(e) => void handleSendMessage(e, lastQuestionRef.current)}
            >
              다시 시도
            </button>
          ) : busy ? (
            <button
              type="button"
              className="ml-2 font-medium text-red-600 hover:text-red-800 shrink-0"
              onClick={() => {
                aiChatAbortManager.abort();
                setStatusInfo({ status: 'cancelled', message: '취소됨' });
              }}
            >
              취소
            </button>
          ) : null}
        </div>
      )}
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
        {msgs.length === 0 && <p className="mt-6 text-center text-xs text-slate-400">현재 노트 전체 문맥을 바탕으로 학술 정의·정리·증명·수식에 대해 질문하세요.</p>}
        {msgs.map((m, i) => (
          <div key={i} className={`whitespace-pre-wrap break-words rounded-xl px-3 py-2 text-xs leading-relaxed ${m.role === 'user' ? 'ml-6 bg-indigo-600 text-white' : 'mr-4 bg-slate-100 text-slate-800'}`}>
            {m.content ? (
              m.role === 'assistant' && m.content.includes('$') ? (
                parseMathSegments(m.content).map((seg, idx) =>
                  seg.type === 'text' ? (
                    <span key={idx}>{seg.content}</span>
                  ) : seg.type === 'block-math' ? (
                    <div key={idx} className="my-1.5 overflow-x-auto" dangerouslySetInnerHTML={{ __html: seg.html }} />
                  ) : (
                    <span key={idx} dangerouslySetInnerHTML={{ __html: seg.html }} />
                  ),
                )
              ) : (
                m.content
              )
            ) : busy && i === msgs.length - 1 ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              ''
            )}
            {m.role === 'assistant' && m.model && m.content && (
              <div className="mt-1 text-[10px] text-slate-400 font-mono">{m.model}</div>
            )}
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <form className="flex items-end gap-1 border-t p-2" onSubmit={(e) => void handleSendMessage(e)}>
        <textarea
          className="max-h-32 min-h-[38px] flex-1 resize-none rounded-lg border px-2 py-1.5 text-xs outline-none focus:border-indigo-400"
          placeholder="노트에 대해 질문… (Enter 전송, Shift+Enter 줄바꿈)"
          value={input}
          rows={2}
          onChange={(e) => {
            setInput(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void handleSendMessage(e);
            }
          }}
        />
        {busy ? (
          <button
            type="button"
            className="btn-primary !px-2"
            onClick={(e) => {
              e.preventDefault();
              aiChatAbortManager.abort();
            }}
            title="중지"
          >
            <Square size={14} />
          </button>
        ) : (
          <button type="submit" className="btn-primary !px-2" disabled={!input.trim()} title="전송">
            <Send size={14} />
          </button>
        )}
      </form>
    </div>
  );
}
