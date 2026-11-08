import { create } from 'zustand';
import type { Stroke } from '../core/strokes/StrokeStore';

interface ContextMenuState {
  open: boolean;
  x: number;
  y: number;
  noteId: string | null;
  pagePoint: { x: number; y: number } | null;
  lastOpenedAt: number;
  show: (p: { x: number; y: number; noteId: string; pagePoint: { x: number; y: number } }) => void;
  hide: () => void;
}

export const useContextMenu = create<ContextMenuState>((set, get) => ({
  open: false,
  x: 0,
  y: 0,
  noteId: null,
  pagePoint: null,
  lastOpenedAt: 0,
  show: (p) => {
    if (Date.now() - get().lastOpenedAt < 700 && get().open) return; // 롱프레스+네이티브 contextmenu 중복 방지
    set({ ...p, open: true, lastOpenedAt: Date.now() });
  },
  hide: () => set({ open: false }),
}));

/** 필기(스트로크) 내부 클립보드: active가 true일 때 최근 복사 항목이 손글씨임을 나타냄 */
export const strokeClipboard: { strokes: Stroke[]; active: boolean } = { strokes: [], active: false };
