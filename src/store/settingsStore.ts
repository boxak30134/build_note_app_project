import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Tool = 'pencil' | 'highlighter' | 'eraser' | 'lasso' | 'none';
export type AiProviderId = 'openai' | 'google' | 'anthropic';

export const DEFAULT_COLORS = ['#EF4444', '#FACC15', '#000000'];
export const DEFAULT_MODELS: Record<AiProviderId, string> = {
  openai: 'gpt-4.1-mini',
  google: 'gemini-2.5-flash',
  anthropic: 'claude-sonnet-4-5',
};

export interface SettingsState {
  theme: 'light';
  leftOpen: boolean;
  rightOpen: boolean;
  paneWidths: { left: number; right: number };
  colorSlots: string[];
  activeSlot: number;
  tool: Tool;
  /** 데스크톱 테스트용: 마우스로도 필기 */
  mouseDraw: boolean;
  penSize: number;
  highlighterSize: number;
  eraserSize: number;
  aiProvider: AiProviderId | null;
  aiModels: Record<AiProviderId, string>;
  esUrl: string;
  esIndex: string;

  toggleLeft: () => void;
  toggleRight: () => void;
  setPaneWidth: (side: 'left' | 'right', w: number) => void;
  setSlotColor: (i: number, color: string) => void;
  selectSlot: (i: number) => void;
  setTool: (t: Tool) => void;
  set: (p: Partial<SettingsState>) => void;
}

/** 모든 사용자 설정은 변경 즉시 localStorage 에 영속화된다 */
export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      theme: 'light',
      leftOpen: true,
      rightOpen: true,
      paneWidths: { left: 260, right: 340 },
      colorSlots: DEFAULT_COLORS,
      activeSlot: 2,
      tool: 'none',
      mouseDraw: false,
      penSize: 4,
      highlighterSize: 18,
      eraserSize: 12,
      aiProvider: null,
      aiModels: DEFAULT_MODELS,
      esUrl: '',
      esIndex: 'eduink',

      toggleLeft: () => set((s) => ({ leftOpen: !s.leftOpen })),
      toggleRight: () => set((s) => ({ rightOpen: !s.rightOpen })),
      setPaneWidth: (side, w) =>
        set((s) => ({ paneWidths: { ...s.paneWidths, [side]: Math.max(180, Math.min(560, Math.round(w))) } })),
      setSlotColor: (i, color) =>
        set((s) => {
          const colorSlots = s.colorSlots.slice();
          colorSlots[i] = color;
          return { colorSlots };
        }),
      selectSlot: (i) => set((s) => ({ activeSlot: i, tool: s.tool === 'eraser' || s.tool === 'lasso' || s.tool === 'none' ? 'pencil' : s.tool })),
      setTool: (t) => set({ tool: t }),
      set: (p) => set(p),
    }),
    { name: 'eduink-settings', version: 1 },
  ),
);

export function activeColor(): string {
  const s = useSettings.getState();
  return s.colorSlots[s.activeSlot] ?? '#000000';
}
