import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { KeyRound, Send, Loader2, Settings, MessageCircle, Trash2, Sparkles, ShieldCheck, ArrowLeft, ExternalLink, Square } from 'lucide-react';
import type { ModelMessage } from 'ai';
import { useSettings, DEFAULT_MODELS, type AiProviderId } from '../store/settingsStore';
import { useTabs } from '../store/tabsStore';
import { saveApiKey, removeApiKey } from '../storage/secureStore';
import { useConnectedProviders, useProvidersLoaded, refreshProviders } from '../ai/useConnectedProviders';
import { streamAi, PROVIDER_LABEL, PROVIDER_KEY_URL } from '../ai/aiClient';
import { getSession } from '../session/NoteSession';
import { toast } from '../store/uiStore';

const PROVIDERS: Array<{ id: AiProviderId; emoji: string; desc: string; color: string }> = [
  { id: 'openai', emoji: '🟢', desc: 'OpenAI GPT 모델', color: 'border-emerald-200 hover:bg-emerald-50' },
  { id: 'google', emoji: '🔷', desc: 'Google Gemini 모델', color: 'border-blue-200 hover:bg-blue-50' },
  { id: 'anthropic', emoji: '🟠', desc: 'Anthropic Claude 모델', color: 'border-orange-200 hover:bg-orange-50' },
];

interface ChatMsg {
  role: 'user' | 'assistant';
  content: string;
}

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
        <button className={`icon-btn ${view === 'chat' ? 'text-indigo-600' : ''}`} onClick={() => setView('chat')} title="채팅">
          <MessageCircle size={16} />
        </button>
        <button className={`icon-btn ${view === 'settings' ? 'text-indigo-600' : ''}`} onClick={() => setView('settings')} title="설정">
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
    </aside>
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

  const submit = async () => {
    if (!key.trim()) return;
    setBusy(true);
    try {
      await saveApiKey(provider, key.trim());
      set({ aiModels: { ...aiModels, [provider]: model.trim() || DEFAULT_MODELS[provider] }, aiProvider: provider });
      await refreshProviders();
      toast.success(`${PROVIDER_LABEL[provider]} 연결 완료 (키는 이 기기에 AES-GCM 으로 암호화 저장됨)`);
      onDone();
    } catch (e) {
      toast.error(`저장 실패: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto p-4">
      <button className="btn-ghost mb-3" onClick={onDone}>
        <ArrowLeft size={14} /> 뒤로
      </button>
      <h3 className="mb-1 text-sm font-semibold">{PROVIDER_LABEL[provider]} 연결</h3>
      <button className="mb-3 w-full cursor-not-allowed rounded-lg border border-dashed border-slate-300 py-2 text-xs text-slate-400" disabled title="OAuth 앱 등록이 필요하여 현재 빌드에서는 비활성화되어 있습니다">
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
      <button className="btn-primary w-full justify-center" disabled={!key.trim() || busy} onClick={() => void submit()}>
        {busy ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />} 연결
      </button>
    </div>
  );
}

function SettingsPanel({ connected, onConnect }: { connected: AiProviderId[]; onConnect: (p: AiProviderId) => void }) {
  const { aiModels, set, esUrl, esIndex, aiProvider } = useSettings();
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
                      className="icon-btn text-red-500"
                      title="연결 해제"
                      onClick={async () => {
                        await removeApiKey(p.id);
                        await refreshProviders();
                        if (aiProvider === p.id) set({ aiProvider: null });
                      }}
                    >
                      <Trash2 size={12} />
                    </button>
                  </>
                ) : (
                  <button className="btn-ghost text-[11px]" onClick={() => onConnect(p.id)}>
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
  const provider = aiProvider && connected.includes(aiProvider) ? aiProvider : connected[0];
  const activeId = useTabs((s) => s.activeTabId);
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState(() => localStorage.getItem('eduink-chat-draft') ?? '');
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => endRef.current?.scrollIntoView({ block: 'end' }), [msgs]);

  const send = async (text: string) => {
    const q = text.trim();
    if (!q || busy) return;
    const s = getSession(activeId);
    // 노트 전체 문맥: 에디터에서 최신 마크다운을 직접 획득
    const context = s ? s.editor.getMarkdown().slice(0, 30000) : '';
    const title = s?.record.title ?? '';
    const history: ChatMsg[] = [...msgs, { role: 'user', content: q }];
    setMsgs([...history, { role: 'assistant', content: '' }]);
    setInput('');
    localStorage.removeItem('eduink-chat-draft');
    setBusy(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const messages: ModelMessage[] = history.map((m) => ({ role: m.role, content: m.content }));
      let acc = '';
      for await (const d of streamAi({
        provider,
        system: `당신은 교육자·학습자를 돕는 노트 어시스턴트입니다. 한국어 마크다운으로 답하세요.${context ? `\n\n[현재 노트: ${title}]\n${context}` : '\n\n(현재 열린 노트 없음)'}`,
        messages,
        maxOutputTokens: 2000,
        signal: ctrl.signal,
      })) {
        acc += d;
        setMsgs([...history, { role: 'assistant', content: acc }]);
      }
    } catch (e) {
      if (!ctrl.signal.aborted) {
        toast.error((e as Error).message, 'AI 호출 실패');
        setMsgs([...history, { role: 'assistant', content: '⚠️ 오류로 답변을 받지 못했습니다.' }]);
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
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
        <button className="btn-ghost text-[11px]" disabled={busy || !activeId} onClick={() => void send('이 노트의 핵심 내용을 5줄 이내로 요약하고, 학습자가 확인할 질문 3개를 만들어줘.')}>
          <Sparkles size={12} /> 노트 요약
        </button>
        <button className="icon-btn" title="대화 지우기" onClick={() => setMsgs([])}>
          <Trash2 size={13} />
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
        {msgs.length === 0 && <p className="mt-6 text-center text-xs text-slate-400">현재 노트 전체 문맥을 바탕으로 자유롭게 질문하세요.</p>}
        {msgs.map((m, i) => (
          <div key={i} className={`whitespace-pre-wrap rounded-xl px-3 py-2 text-xs leading-relaxed ${m.role === 'user' ? 'ml-6 bg-indigo-600 text-white' : 'mr-4 bg-slate-100 text-slate-800'}`}>
            {m.content || (busy && i === msgs.length - 1 ? <Loader2 size={12} className="animate-spin" /> : '')}
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <div className="flex items-end gap-1 border-t p-2">
        <textarea
          className="max-h-32 min-h-[38px] flex-1 resize-none rounded-lg border px-2 py-1.5 text-xs outline-none focus:border-indigo-400"
          placeholder="노트에 대해 질문… (Enter 전송, Shift+Enter 줄바꿈)"
          value={input}
          rows={2}
          onChange={(e) => {
            setInput(e.target.value);
            localStorage.setItem('eduink-chat-draft', e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send(input);
            }
          }}
        />
        {busy ? (
          <button className="btn-primary !px-2" onClick={() => abortRef.current?.abort()} title="중지">
            <Square size={14} />
          </button>
        ) : (
          <button className="btn-primary !px-2" disabled={!input.trim()} onClick={() => void send(input)} title="전송">
            <Send size={14} />
          </button>
        )}
      </div>
    </div>
  );
}
