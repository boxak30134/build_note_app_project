import { create } from 'zustand';

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'error';
  message: string;
  title?: string;
}

interface ConfirmRequest {
  id: number;
  title: string;
  message: string;
  buttons: Array<{ label: string; value: string; variant?: 'primary' | 'danger' | 'default' }>;
  resolve: (v: string) => void;
}

interface PromptRequest {
  id: number;
  title: string;
  initial: string;
  validate?: (v: string) => string | null;
  resolve: (v: string | null) => void;
}

interface UiState {
  toasts: Toast[];
  confirm: ConfirmRequest | null;
  prompt: PromptRequest | null;
  cameraOpen: boolean;
  pushToast: (t: Omit<Toast, 'id'>, ms?: number) => void;
  dismissToast: (id: number) => void;
  set: (p: Partial<UiState>) => void;
}

let seq = 0;

export const useUi = create<UiState>((set, get) => ({
  toasts: [],
  confirm: null,
  prompt: null,
  cameraOpen: false,
  pushToast: (t, ms = 4000) => {
    const id = ++seq;
    set((s) => ({ toasts: [...s.toasts, { ...t, id }] }));
    if (ms > 0) setTimeout(() => get().dismissToast(id), ms);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  set: (p) => set(p),
}));

export const toast = {
  info: (message: string) => useUi.getState().pushToast({ kind: 'info', message }),
  success: (message: string) => useUi.getState().pushToast({ kind: 'success', message }),
  error: (message: string, title?: string) => useUi.getState().pushToast({ kind: 'error', message, title }, 9000),
};

export function confirmDialog(
  title: string,
  message: string,
  buttons: ConfirmRequest['buttons'] = [
    { label: '취소', value: 'cancel' },
    { label: '확인', value: 'ok', variant: 'primary' },
  ],
): Promise<string> {
  return new Promise((resolve) => {
    useUi.setState({
      confirm: {
        id: ++seq,
        title,
        message,
        buttons,
        resolve: (v) => {
          useUi.setState({ confirm: null });
          resolve(v);
        },
      },
    });
  });
}

export function promptDialog(title: string, initial = '', validate?: (v: string) => string | null): Promise<string | null> {
  return new Promise((resolve) => {
    useUi.setState({
      prompt: {
        id: ++seq,
        title,
        initial,
        validate,
        resolve: (v) => {
          useUi.setState({ prompt: null });
          resolve(v);
        },
      },
    });
  });
}
