import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type SplitPaneId = 'primary' | 'secondary';

interface TabsState {
  /** 열린 문서 탭 목록 (재시작 시 복원) */
  openDocTabs: string[];
  activeTabId: string | null;
  /** 좌우 화면 분할(Dual Split Pane) 활성화 여부 */
  splitOpen: boolean;
  /** 우측(Secondary) 패널에 표시할 문서 ID */
  secondaryTabId: string | null;
  /** 현재 포커스된 패널 (툴바/단축키/펜 입력 대상) */
  focusedPane: SplitPaneId;
  /** 좌측 패널 너비 비율 (0.25 ~ 0.75) */
  splitRatio: number;
  /** 탭 열기 후 스크롤할 블록 (휘발성) */
  pendingScroll: Record<string, string | undefined>;
  openTab: (id: string, blockId?: string) => void;
  closeTab: (id: string) => void;
  activate: (id: string) => void;
  toggleSplit: (targetId?: string) => void;
  openInSecondary: (id: string, blockId?: string) => void;
  closeSplit: () => void;
  setFocusedPane: (pane: SplitPaneId) => void;
  setSplitRatio: (ratio: number) => void;
  consumeScroll: (id: string) => string | undefined;
}

export const useTabs = create<TabsState>()(
  persist(
    (set, get) => ({
      openDocTabs: [],
      activeTabId: null,
      splitOpen: false,
      secondaryTabId: null,
      focusedPane: 'primary',
      splitRatio: 0.5,
      pendingScroll: {},
      openTab: (id, blockId) =>
        set((s) => {
          const openDocTabs = s.openDocTabs.includes(id) ? s.openDocTabs : [...s.openDocTabs, id];
          const pendingScroll = blockId ? { ...s.pendingScroll, [id]: blockId } : s.pendingScroll;
          if (s.splitOpen && s.focusedPane === 'secondary') {
            return { openDocTabs, secondaryTabId: id, pendingScroll };
          }
          return { openDocTabs, activeTabId: id, pendingScroll };
        }),
      closeTab: (id) =>
        set((s) => {
          const idx = s.openDocTabs.indexOf(id);
          const openDocTabs = s.openDocTabs.filter((t) => t !== id);
          let activeTabId = s.activeTabId;
          if (activeTabId === id) activeTabId = openDocTabs[Math.min(idx, openDocTabs.length - 1)] ?? null;
          let secondaryTabId = s.secondaryTabId;
          let splitOpen = s.splitOpen;
          let focusedPane = s.focusedPane;
          if (secondaryTabId === id) {
            const fallback = openDocTabs.find((t) => t !== activeTabId) ?? openDocTabs[0] ?? null;
            secondaryTabId = fallback;
            if (!secondaryTabId) {
              splitOpen = false;
              focusedPane = 'primary';
            }
          }
          return { openDocTabs, activeTabId, secondaryTabId, splitOpen, focusedPane };
        }),
      activate: (id) =>
        set((s) => {
          if (s.splitOpen && s.focusedPane === 'secondary') {
            return { secondaryTabId: id };
          }
          return { activeTabId: id };
        }),
      toggleSplit: (targetId) =>
        set((s) => {
          if (s.splitOpen && !targetId) {
            return { splitOpen: false, focusedPane: 'primary' };
          }
          const candidate =
            targetId ??
            s.secondaryTabId ??
            s.openDocTabs.find((t) => t !== s.activeTabId) ??
            s.activeTabId;
          const openDocTabs =
            candidate && !s.openDocTabs.includes(candidate) ? [...s.openDocTabs, candidate] : s.openDocTabs;
          return {
            openDocTabs,
            splitOpen: Boolean(candidate),
            secondaryTabId: candidate ?? null,
            focusedPane: candidate ? 'secondary' : 'primary',
          };
        }),
      openInSecondary: (id, blockId) =>
        set((s) => ({
          openDocTabs: s.openDocTabs.includes(id) ? s.openDocTabs : [...s.openDocTabs, id],
          splitOpen: true,
          secondaryTabId: id,
          focusedPane: 'secondary',
          pendingScroll: blockId ? { ...s.pendingScroll, [id]: blockId } : s.pendingScroll,
        })),
      closeSplit: () => set({ splitOpen: false, focusedPane: 'primary' }),
      setFocusedPane: (pane) => set({ focusedPane: pane }),
      setSplitRatio: (ratio) => set({ splitRatio: Math.max(0.25, Math.min(0.75, ratio)) }),
      consumeScroll: (id) => {
        const b = get().pendingScroll[id];
        if (b) set((s) => ({ pendingScroll: { ...s.pendingScroll, [id]: undefined } }));
        return b;
      },
    }),
    {
      name: 'eduink-tabs',
      partialize: (s) => ({
        openDocTabs: s.openDocTabs,
        activeTabId: s.activeTabId,
        splitOpen: s.splitOpen,
        secondaryTabId: s.secondaryTabId,
        splitRatio: s.splitRatio,
      }),
    },
  ),
);
