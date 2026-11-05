export type FontFormat = 'ttf' | 'otf' | 'woff' | 'woff2';

export type FontItem = {
  id: string;
  name: string;
  family: string;
  isCustom?: boolean;
  fileName?: string;
  format?: FontFormat;
};

export type CustomFontRecord = FontItem & {
  isCustom: true;
  fileName: string;
  format: FontFormat;
  dataBase64: string;
  createdAt: number;
};

export const ALLOWED_FONT_EXTENSIONS: readonly FontFormat[] = ['ttf', 'otf', 'woff', 'woff2'];
export const MAX_FONT_FILE_BYTES = 30 * 1024 * 1024; // 30MB
export const MAX_RECENT_FONTS = 5;
export const DEFAULT_FONT_ID = 'pretendard';

export const BUILTIN_FONTS: readonly FontItem[] = [
  {
    id: 'pretendard',
    name: 'Pretendard (기본)',
    family: "'Pretendard', 'Apple SD Gothic Neo', 'Malgun Gothic', system-ui, sans-serif",
  },
  {
    id: 'noto-sans-kr',
    name: 'Noto Sans KR (본고딕)',
    family: "'Noto Sans KR', 'Apple SD Gothic Neo', sans-serif",
  },
  {
    id: 'noto-serif-kr',
    name: 'Noto Serif KR (본명조)',
    family: "'Noto Serif KR', 'Batang', Georgia, serif",
  },
  {
    id: 'nanum-gothic',
    name: '나눔고딕 (Nanum Gothic)',
    family: "'Nanum Gothic', 'Malgun Gothic', sans-serif",
  },
  {
    id: 'nanum-myeongjo',
    name: '나눔명조 (Nanum Myeongjo)',
    family: "'Nanum Myeongjo', 'Batang', serif",
  },
  {
    id: 'malgun-gothic',
    name: '맑은 고딕 (Malgun Gothic)',
    family: "'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif",
  },
  {
    id: 'd2coding',
    name: 'D2Coding (고정폭 코딩)',
    family: "'D2Coding', 'JetBrains Mono', 'Consolas', monospace",
  },
];

/** 파일명에서 확장자(.ttf, .otf 등) 추출 및 검증 */
export function getFontExtension(fileName: string): FontFormat | null {
  const idx = fileName.lastIndexOf('.');
  if (idx < 0) return null;
  const ext = fileName.slice(idx + 1).toLowerCase();
  if ((ALLOWED_FONT_EXTENSIONS as readonly string[]).includes(ext)) {
    return ext as FontFormat;
  }
  return null;
}

/** 로컬 폰트 파일(.ttf, .otf 등) 유효성 검사 */
export function validateFontFile(file: { name: string; size: number }): string | null {
  const ext = getFontExtension(file.name);
  if (!ext) {
    return '지원하지 않는 폰트 파일 형식입니다. (.ttf, .otf, .woff, .woff2 파일만 추가 가능)';
  }
  if (file.size <= 0) {
    return '빈 폰트 파일은 추가할 수 없습니다.';
  }
  if (file.size > MAX_FONT_FILE_BYTES) {
    return '폰트 파일 크기는 30MB 이하여야 합니다.';
  }
  return null;
}

/** 파일명으로부터 표시용 폰트 이름 추출 */
export function extractFontNameFromFile(fileName: string): string {
  const stripped = fileName.replace(/\.(ttf|otf|woff2?)$/i, '').trim();
  return stripped || 'CustomFont';
}

/** ArrayBuffer -> Base64 인코딩 */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/** 로컬 File 객체(.ttf/.otf)를 읽어 CustomFontRecord 로 변환 */
export async function parseCustomFontFile(file: File): Promise<CustomFontRecord> {
  const error = validateFontFile(file);
  if (error) throw new Error(error);
  const format = getFontExtension(file.name)!;
  const name = extractFontNameFromFile(file.name);
  const safeSlug = name.replace(/[^a-zA-Z0-9가-힣_-]/g, '_') || 'custom';
  const id = `custom-font-${safeSlug.toLowerCase()}-${Date.now().toString(36)}`;
  const familyName = `EduInk_${safeSlug}_${id.slice(-4)}`;
  const buffer = await file.arrayBuffer();
  const dataBase64 = arrayBufferToBase64(buffer);

  return {
    id,
    name,
    family: `'${familyName}', sans-serif`,
    isCustom: true,
    fileName: file.name,
    format,
    dataBase64,
    createdAt: Date.now(),
  };
}

function formatToCssDescriptor(format: FontFormat): { mime: string; cssFormat: string } {
  switch (format) {
    case 'otf':
      return { mime: 'font/otf', cssFormat: 'opentype' };
    case 'woff':
      return { mime: 'font/woff', cssFormat: 'woff' };
    case 'woff2':
      return { mime: 'font/woff2', cssFormat: 'woff2' };
    case 'ttf':
    default:
      return { mime: 'font/ttf', cssFormat: 'truetype' };
  }
}

/**
 * 사용자 정의 폰트를 브라우저 DOM(@font-face 및 FontFace API)에 등록한다.
 */
export function registerCustomFontInDOM(font: CustomFontRecord): void {
  if (typeof document === 'undefined') return;
  const existing = document.head.querySelector(`style[data-custom-font="${font.id}"]`);
  if (existing) return;

  const rawFamily = font.family.split(',')[0].replace(/^['"]|['"]$/g, '').trim();
  const { mime, cssFormat } = formatToCssDescriptor(font.format);
  const dataUrl = `data:${mime};base64,${font.dataBase64}`;

  const style = document.createElement('style');
  style.setAttribute('data-custom-font', font.id);
  style.textContent = `@font-face { font-family: '${rawFamily}'; src: url('${dataUrl}') format('${cssFormat}'); font-display: swap; }`;
  document.head.appendChild(style);

  if (typeof FontFace !== 'undefined' && document.fonts && typeof document.fonts.add === 'function') {
    try {
      const face = new FontFace(rawFamily, `url(${dataUrl})`);
      void face
        .load()
        .then((loaded) => {
          document.fonts.add(loaded);
        })
        .catch(() => {
          // @font-face style 태그가 폴백으로 동작
        });
    } catch {
      // jsdom 또는 미지원 환경에서는 style 태그로 충분
    }
  }
}

/**
 * 사용자가 선택한 폰트 ID를 최근 선택 목록의 맨 위에 배치한다 (중복 제거, 최대 max개 유지).
 */
export function recordRecentFont(
  recentIds: readonly string[],
  selectedId: string,
  max: number = MAX_RECENT_FONTS,
): string[] {
  const trimmed = selectedId.trim();
  if (!trimmed) return [...recentIds].slice(0, max);
  const next = [trimmed, ...recentIds.filter((id) => id !== trimmed)];
  return next.slice(0, Math.max(1, max));
}

/** 기본 폰트와 사용자가 추가한 로컬 커스텀 폰트를 합친 전체 폰트 리스트 반환 */
export function getAllFonts(customFonts: readonly FontItem[] = []): FontItem[] {
  return [...BUILTIN_FONTS, ...customFonts];
}

/** ID 로 폰트 메타데이터 조회 (없으면 기본 폰트 반환) */
export function resolveFontById(fontId: string, customFonts: readonly FontItem[] = []): FontItem {
  const all = getAllFonts(customFonts);
  return all.find((f) => f.id === fontId) ?? BUILTIN_FONTS[0];
}

/**
 * 폰트 리스트를:
 * 1) 맨 위에 따로 구분하여 표시·추천하는 '최근 선택 폰트 (recentFonts)'
 * 2) 전체 폰트 목록 ('allFonts')
 * 으로 분류하여 반환한다.
 */
export function getCategorizedFontList(
  customFonts: readonly FontItem[],
  recentIds: readonly string[],
): {
  recentFonts: FontItem[];
  allFonts: FontItem[];
} {
  const allFonts = getAllFonts(customFonts);
  const byId = new Map<string, FontItem>(allFonts.map((f) => [f.id, f]));
  const recentFonts: FontItem[] = [];
  for (const id of recentIds) {
    const found = byId.get(id);
    if (found && !recentFonts.some((r) => r.id === found.id)) {
      recentFonts.push(found);
    }
  }
  return { recentFonts, allFonts };
}
