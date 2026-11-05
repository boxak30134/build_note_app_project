// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest';
import {
  BUILTIN_FONTS,
  DEFAULT_FONT_ID,
  getAllFonts,
  getCategorizedFontList,
  parseCustomFontFile,
  recordRecentFont,
  registerCustomFontInDOM,
  resolveFontById,
  validateFontFile,
} from './fontManager';
import { useSettings } from '../../store/settingsStore';

describe('Additional Features 2. Font (폰트 선택, 로컬 .ttf/.otf 추가, 최근 선택 폰트 상단 분리 및 추천)', () => {
  beforeEach(() => {
    useSettings.setState({
      selectedFontId: DEFAULT_FONT_ID,
      recentFontIds: [DEFAULT_FONT_ID],
      customFonts: [],
    });
  });

  it('사용자는 기본 폰트 목록에서 원하는 폰트를 선택할 수 있고, 최근 선택 폰트가 맨 위에 기록된다', () => {
    useSettings.getState().selectFont('nanum-gothic');
    expect(useSettings.getState().selectedFontId).toBe('nanum-gothic');
    expect(useSettings.getState().recentFontIds[0]).toBe('nanum-gothic');

    useSettings.getState().selectFont('d2coding');
    expect(useSettings.getState().selectedFontId).toBe('d2coding');
    expect(useSettings.getState().recentFontIds).toEqual(['d2coding', 'nanum-gothic', 'pretendard']);
  });

  it('로컬 디렉토리의 .ttf, .otf 폰트 파일을 추가하면 노트 앱 내 폰트 리스트에 추가되고 DOM에 등록된다', async () => {
    const dummyBytes = new Uint8Array([0, 1, 0, 0, 0, 10, 0, 128]);
    const ttfFile = new File([dummyBytes], 'MaruBuri-Regular.ttf', { type: 'font/ttf' });
    const otfFile = new File([dummyBytes], 'KoPubWorldBatang.otf', { type: 'font/otf' });

    const parsedTtf = await parseCustomFontFile(ttfFile);
    expect(parsedTtf.name).toBe('MaruBuri-Regular');
    expect(parsedTtf.format).toBe('ttf');
    expect(parsedTtf.isCustom).toBe(true);
    expect(parsedTtf.dataBase64.length).toBeGreaterThan(0);

    registerCustomFontInDOM(parsedTtf);
    const styleEl = document.head.querySelector(`style[data-custom-font="${parsedTtf.id}"]`);
    expect(styleEl).not.toBeNull();
    expect(styleEl?.textContent).toContain('@font-face');

    useSettings.getState().addCustomFont(parsedTtf);

    const parsedOtf = await parseCustomFontFile(otfFile);
    useSettings.getState().addCustomFont(parsedOtf);

    const state = useSettings.getState();
    const allFonts = getAllFonts(state.customFonts);
    expect(allFonts.length).toBe(BUILTIN_FONTS.length + 2);
    expect(resolveFontById(parsedTtf.id, state.customFonts).name).toBe('MaruBuri-Regular');
    expect(resolveFontById(parsedOtf.id, state.customFonts).name).toBe('KoPubWorldBatang');
  });

  it('지원하지 않는 확장자(.txt, .exe 등)는 폰트 파일 검증에서 거부된다', () => {
    expect(validateFontFile({ name: 'malicious.exe', size: 1024 })).not.toBeNull();
    expect(validateFontFile({ name: 'notes.txt', size: 512 })).not.toBeNull();
    expect(validateFontFile({ name: 'EmptyFont.ttf', size: 0 })).not.toBeNull();
    expect(validateFontFile({ name: 'ValidFont.ttf', size: 2048 })).toBeNull();
    expect(validateFontFile({ name: 'ValidFont.otf', size: 2048 })).toBeNull();
  });

  it('최근에 선택한 폰트들은 중복 없이 최신순으로 맨 위(recentFonts)에 따로 구분하여 표시·추천한다', () => {
    let recent: string[] = ['pretendard'];
    recent = recordRecentFont(recent, 'noto-serif-kr');
    recent = recordRecentFont(recent, 'nanum-myeongjo');
    recent = recordRecentFont(recent, 'noto-serif-kr'); // 재선택 시 맨 위로 이동 및 중복 제거

    expect(recent).toEqual(['noto-serif-kr', 'nanum-myeongjo', 'pretendard']);

    const { recentFonts, allFonts } = getCategorizedFontList(useSettings.getState().customFonts, recent);
    expect(recentFonts.map((f) => f.id)).toEqual(['noto-serif-kr', 'nanum-myeongjo', 'pretendard']);
    expect(allFonts.length).toBeGreaterThanOrEqual(BUILTIN_FONTS.length);
  });
});
