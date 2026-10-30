import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface TabsState {
  /** 열린 문서 탭 목록 (재시작 시 복원) */
  openDocTabs: string[];
  activeTabId: string | null;
  /** 탭 열기 후 스크롤할 블록 (휘발성) */
  pendingScroll: Record<string, string | undefined>;
  openTab: (id: string, blockId?: string) => void;
  closeTab: (id: string) => void;
  activate: (id: string) => void;
  consumeScroll: (id: string) => string | undefined;
}

export const useTabs = create<TabsState>()(
  persist(
    (set, get) => ({
      openDocTabs: [],
      activeTabId: null,
      pendingScroll: {},
      openTab: (id, blockId) =>
        set((s) => ({
          openDocTabs: s.openDocTabs.includes(id) ? s.openDocTabs : [...s.openDocTabs, id],
          activeTabId: id,
          pendingScroll: blockId ? { ...s.pendingScroll, [id]: blockId } : s.pendingScroll,
        })),
      closeTab: (id) =>
        set((s) => {
          const idx = s.openDocTabs.indexOf(id);
          const openDocTabs = s.openDocTabs.filter((t) => t !== id);
          let activeTabId = s.activeTabId;
          if (activeTabId === id) activeTabId = openDocTabs[Math.min(idx, openDocTabs.length - 1)] ?? null;
          return { openDocTabs, activeTabId };
        }),
      activate: (id) => set({ activeTabId: id }),
      consumeScroll: (id) => {
        const b = get().pendingScroll[id];
        if (b) set((s) => ({ pendingScroll: { ...s.pendingScroll, [id]: undefined } }));
        return b;
      },
    }),
    {
      name: 'eduink-tabs',
      partialize: (s) => ({ openDocTabs: s.openDocTabs, activeTabId: s.activeTabId }),
    },
  ),
);
