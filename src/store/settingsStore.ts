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

export type PenType = 'fountain-sharp' | 'fountain-flat' | 'ballpoint' | 'pencil' | 'brush';

export interface PenTypeDef {
  id: PenType;
  name: string;
  description: string;
}

export const PEN_TYPES: PenTypeDef[] = [
  { id: 'fountain-sharp', name: '끝이 뾰족한 만년필', description: '필압에 민감하게 반응하는 섬세하고 뾰족한 만년필 닙' },
  { id: 'fountain-flat', name: '끝이 뭉툭한 만년필', description: '일정한 굵기와 납작한 끝단의 캘리그래피 만년필 닙' },
  { id: 'ballpoint', name: '볼펜', description: '균일하고 부드러운 굵기의 기본 볼펜' },
  { id: 'pencil', name: '연필', description: '자연스러운 필기감의 스케치 연필' },
  { id: 'brush', name: '붓', description: '다양한 필압 표현이 가능한 부드러운 서예 붓' },
];

/** 기본 8색 팔레트 (왼쪽부터 빨주노초파남보 검정) */
export const DEFAULT_PALETTE_COLORS = [
  '#EF4444', // 빨강
  '#F97316', // 주황
  '#FACC15', // 노랑
  '#22C55E', // 초록
  '#3B82F6', // 파랑
  '#1E3A8A', // 남색
  '#8B5CF6', // 보라
  '#000000', // 검정
];

export const PALETTE_COLOR_NAMES = ['빨강', '주황', '노랑', '초록', '파랑', '남색', '보라', '검정'];
export const DEFAULT_COLORS = DEFAULT_PALETTE_COLORS;

export type TranslationInsertMode = 'parentheses' | 'ruby' | 'replace';

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
  /** 펜 종류: 끝이 뾰족한 만년필, 끝이 뭉툭한 만년필, 볼펜, 연필, 붓 */
  penType: PenType;
  /** 직선 자동 보정 */
  autoStraighten: boolean;
  /** 사용자 지정 RGB 색상 (HEX) */
  customColor: string;
  /** 사용자 지정 RGB 색상 활성화 여부 */
  isCustomColorActive: boolean;
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

  /** 번역 결과 삽입 형식: 'parentheses'(원문 뒤 괄호) | 'ruby'(루비 주석) | 'replace'(원문 대체) */
  translationInsertMode: TranslationInsertMode;

  /** 기본 글자 크기 (px, 기본값: 16) */
  fontSize: number;

  toggleLeft: () => void;
  toggleRight: () => void;
  setPaneWidth: (side: 'left' | 'right', w: number) => void;
  setSlotColor: (i: number, color: string) => void;
  selectSlot: (i: number) => void;
  setCustomColor: (color: string) => void;
  selectCustomColor: () => void;
  setPenType: (type: PenType) => void;
  setAutoStraighten: (enabled: boolean) => void;
  setTool: (t: Tool) => void;
  setDocFormat: (mode: DocFormatMode) => void;
  setDefaultPaperSize: (size: PaperSizeId) => void;
  setDefaultPageStyle: (style: PageStyleId) => void;
  setDefaultOrientation: (orientation: PageOrientation) => void;
  selectFont: (fontId: string) => void;
  addCustomFont: (font: FontItem) => void;
  removeCustomFont: (fontId: string) => void;
  setTranslationInsertMode: (mode: TranslationInsertMode) => void;
  setFontSize: (size: number) => void;
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
      colorSlots: DEFAULT_PALETTE_COLORS,
      activeSlot: 7, // 검정 (#000000)
      tool: 'none',
      penType: 'fountain-sharp',
      autoStraighten: false,
      customColor: '#E11D48',
      isCustomColorActive: false,
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

      translationInsertMode: 'parentheses',
      fontSize: 16,

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
      selectSlot: (i) =>
        set((s) => ({
          activeSlot: i,
          isCustomColorActive: false,
          tool: s.tool === 'eraser' || s.tool === 'lasso' ? 'pencil' : s.tool,
        })),
      setCustomColor: (color) =>
        set((s) => ({
          customColor: color,
          isCustomColorActive: true,
          tool: s.tool === 'eraser' || s.tool === 'lasso' ? 'pencil' : s.tool,
        })),
      selectCustomColor: () =>
        set((s) => ({
          isCustomColorActive: true,
          tool: s.tool === 'eraser' || s.tool === 'lasso' ? 'pencil' : s.tool,
        })),
      setPenType: (penType) => set({ penType }),
      setAutoStraighten: (autoStraighten) => set({ autoStraighten }),
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
      setTranslationInsertMode: (translationInsertMode) => set({ translationInsertMode }),
      setFontSize: (fontSize) => set({ fontSize: Math.max(8, Math.min(72, Math.round(fontSize))) }),
      set: (p) => set(p),
    }),
    {
      name: 'eduink-settings',
      version: 6,
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
        if (version < 4) {
          state.penType = state.penType ?? 'fountain-sharp';
          state.autoStraighten = state.autoStraighten ?? false;
          state.customColor = state.customColor ?? '#E11D48';
          state.isCustomColorActive = state.isCustomColorActive ?? false;
          if (!state.colorSlots || state.colorSlots.length < 8) {
            state.colorSlots = DEFAULT_PALETTE_COLORS;
            state.activeSlot = 7;
          }
        }
        if (version < 5) {
          state.translationInsertMode = state.translationInsertMode ?? 'parentheses';
        }
        if (version < 6) {
          state.fontSize = state.fontSize ?? 16;
        }
        return state as SettingsState;
      },
    },
  ),
);

export function activeColor(): string {
  const s = useSettings.getState();
  if (s.isCustomColorActive && s.customColor) {
    return s.customColor;
  }
  return s.colorSlots[s.activeSlot] ?? '#000000';
}
