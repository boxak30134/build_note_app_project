import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface ChatMsg {
  role: 'user' | 'assistant';
  content: string;
  model?: string;
}

export type ChatStatus =
  | 'idle'
  | 'connecting'
  | 'retrying'
  | 'fallback'
  | 'streaming'
  | 'done'
  | 'error'
  | 'cancelled';

export interface StatusInfo {
  status: ChatStatus;
  message?: string;
  model?: string;
}

export interface AiChatState {
  messages: ChatMsg[];
  inputDraft: string;
  busy: boolean;
  statusInfo: StatusInfo;
  setMessages: (msgs: ChatMsg[] | ((prev: ChatMsg[]) => ChatMsg[])) => void;
  appendMessage: (msg: ChatMsg) => void;
  updateLastAssistantMessage: (updater: (prev: ChatMsg) => ChatMsg) => void;
  setInputDraft: (text: string) => void;
  setBusy: (busy: boolean) => void;
  setStatusInfo: (info: StatusInfo) => void;
  clearMessages: () => void;
}

const MAX_STORED_MESSAGES = 200;

// 백그라운드 스트리밍을 위한 전역 싱글톤 AbortController
let globalAbortController: AbortController | null = null;

export const aiChatAbortManager = {
  create(): AbortController {
    if (globalAbortController) {
      try {
        globalAbortController.abort();
      } catch {}
    }
    globalAbortController = new AbortController();
    return globalAbortController;
  },
  get(): AbortController | null {
    return globalAbortController;
  },
  abort(): void {
    if (globalAbortController) {
      try {
        globalAbortController.abort();
      } catch {}
      globalAbortController = null;
    }
  },
  clear(): void {
    globalAbortController = null;
  },
};

export const useAiChatStore = create<AiChatState>()(
  persist(
    (set) => ({
      messages: [],
      inputDraft: '',
      busy: false,
      statusInfo: { status: 'idle' },

      setMessages: (msgs) =>
        set((state) => {
          const resolved = typeof msgs === 'function' ? msgs(state.messages) : msgs;
          const trimmed = resolved.length > MAX_STORED_MESSAGES
            ? resolved.slice(-MAX_STORED_MESSAGES)
            : resolved;
          return { messages: trimmed };
        }),

      appendMessage: (msg) =>
        set((state) => {
          const next = [...state.messages, msg];
          const trimmed = next.length > MAX_STORED_MESSAGES ? next.slice(-MAX_STORED_MESSAGES) : next;
          return { messages: trimmed };
        }),

      updateLastAssistantMessage: (updater) =>
        set((state) => {
          if (state.messages.length === 0) return state;
          const lastIdx = state.messages.length - 1;
          const last = state.messages[lastIdx];
          const updated = updater(last);
          const next = [...state.messages];
          next[lastIdx] = updated;
          return { messages: next };
        }),

      setInputDraft: (text) => set({ inputDraft: text }),

      setBusy: (busy) => set({ busy }),

      setStatusInfo: (info) => set({ statusInfo: info }),

      clearMessages: () => {
        aiChatAbortManager.abort();
        set({
          messages: [],
          busy: false,
          statusInfo: { status: 'idle' },
        });
      },
    }),
    {
      name: 'eduink-ai-chat-history',
      partialize: (state) => ({
        messages: state.messages,
        inputDraft: state.inputDraft,
      }),
    },
  ),
);

