import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { GEMINI_FALLBACK_MODEL, GEMINI_PRIMARY_MODEL } from '../modules/ai/constants';
import {
  DEFAULT_DOC_FORMAT,
  DEFAULT_PAGE_ORIENTATION,
  DEFAULT_PAGE_STYLE,
  DEFAULT_PAPER_SIZE,
  type DocFormatMode,
  type PageOrientation,
  type PageStyleId,
  type PaperSizeId,
} from '../core/page/pageTypes';
import {
  DEFAULT_FONT_ID,
  recordRecentFont,
  type FontItem,
} from '../core/font/fontManager';

export type Tool = 'pencil' | 'highlighter' | 'eraser' | 'lasso' | 'none';
export type AiProviderId = 'openai' | 'google' | 'anthropic';

export const DEFAULT_COLORS = ['#EF4444', '#FACC15', '#000000'];
export const DEFAULT_MODELS: Record<AiProviderId, string> = {
  openai: 'gpt-4.1-mini',
  google: GEMINI_PRIMARY_MODEL,
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

  /** 문서 포맷: 'paginated'(페이지 분리형) | 'continuous'(페이지 분리 없는 연속형) */
  docFormat: DocFormatMode;
  /** 기본 용지 규격 (기본값: 'A4') */
  defaultPaperSize: PaperSizeId;
  /** 기본 용지 스타일 (기본값: 'plain') */
  defaultPageStyle: PageStyleId;
  /** 기본 용지 방향 (기본값: 'portrait') */
  defaultOrientation: PageOrientation;

  /** 현재 선택된 폰트 ID */
  selectedFontId: string;
  /** 최근 선택한 폰트 ID 목록 (맨 위에 따로 구분·추천 표시) */
  recentFontIds: string[];
  /** 사용자가 로컬 디렉토리(.ttf, .otf 등)에서 추가한 폰트 목록 */
  customFonts: FontItem[];

  toggleLeft: () => void;
  toggleRight: () => void;
  setPaneWidth: (side: 'left' | 'right', w: number) => void;
  setSlotColor: (i: number, color: string) => void;
  selectSlot: (i: number) => void;
  setTool: (t: Tool) => void;
  setDocFormat: (mode: DocFormatMode) => void;
  setDefaultPaperSize: (size: PaperSizeId) => void;
  setDefaultPageStyle: (style: PageStyleId) => void;
  setDefaultOrientation: (orientation: PageOrientation) => void;
  selectFont: (fontId: string) => void;
  addCustomFont: (font: FontItem) => void;
  removeCustomFont: (fontId: string) => void;
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

      docFormat: DEFAULT_DOC_FORMAT,
      defaultPaperSize: DEFAULT_PAPER_SIZE,
      defaultPageStyle: DEFAULT_PAGE_STYLE,
      defaultOrientation: DEFAULT_PAGE_ORIENTATION,

      selectedFontId: DEFAULT_FONT_ID,
      recentFontIds: [DEFAULT_FONT_ID],
      customFonts: [],

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
      setDocFormat: (docFormat) => set({ docFormat }),
      setDefaultPaperSize: (defaultPaperSize) => set({ defaultPaperSize }),
      setDefaultPageStyle: (defaultPageStyle) => set({ defaultPageStyle }),
      setDefaultOrientation: (defaultOrientation) => set({ defaultOrientation }),
      selectFont: (fontId) =>
        set((s) => ({
          selectedFontId: fontId,
          recentFontIds: recordRecentFont(s.recentFontIds, fontId),
        })),
      addCustomFont: (font) =>
        set((s) => {
          const filtered = s.customFonts.filter((f) => f.id !== font.id);
          return {
            customFonts: [...filtered, { ...font, isCustom: true }],
            selectedFontId: font.id,
            recentFontIds: recordRecentFont(s.recentFontIds, font.id),
          };
        }),
      removeCustomFont: (fontId) =>
        set((s) => {
          const customFonts = s.customFonts.filter((f) => f.id !== fontId);
          const recentFontIds = s.recentFontIds.filter((id) => id !== fontId);
          const selectedFontId = s.selectedFontId === fontId ? DEFAULT_FONT_ID : s.selectedFontId;
          return {
            customFonts,
            recentFontIds: recentFontIds.length > 0 ? recentFontIds : [DEFAULT_FONT_ID],
            selectedFontId,
          };
        }),
      set: (p) => set(p),
    }),
    {
      name: 'eduink-settings',
      version: 3,
      migrate: (persistedState: unknown, version: number) => {
        const state = (persistedState ?? {}) as Partial<SettingsState>;
        if (version < 2 && state.aiModels) {
          const currentGoogle = state.aiModels.google;
          if (!currentGoogle || currentGoogle === GEMINI_FALLBACK_MODEL) {
            state.aiModels = { ...state.aiModels, google: GEMINI_PRIMARY_MODEL };
          }
        }
        if (version < 3) {
          state.docFormat = state.docFormat ?? DEFAULT_DOC_FORMAT;
          state.defaultPaperSize = state.defaultPaperSize ?? DEFAULT_PAPER_SIZE;
          state.defaultPageStyle = state.defaultPageStyle ?? DEFAULT_PAGE_STYLE;
          state.defaultOrientation = state.defaultOrientation ?? DEFAULT_PAGE_ORIENTATION;
          state.selectedFontId = state.selectedFontId ?? DEFAULT_FONT_ID;
          state.recentFontIds = state.recentFontIds?.length ? state.recentFontIds : [DEFAULT_FONT_ID];
          state.customFonts = state.customFonts ?? [];
        }
        return state as SettingsState;
      },
    },
  ),
);

export function activeColor(): string {
  const s = useSettings.getState();
  return s.colorSlots[s.activeSlot] ?? '#000000';
}
