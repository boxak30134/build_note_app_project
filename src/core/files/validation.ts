/** 파일/폴더 이름 유효성 검사. 오류 메시지(한국어) 또는 null 반환 */
const FORBIDDEN = /[\\/<>:"|?*]/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

export function validateFileName(name: string): string | null {
  if (name.length === 0 || name.trim().length === 0) return '이름을 입력하세요.';
  if (/^\.+$/.test(name)) return "'.' 또는 '..' 같은 점만 있는 이름은 사용할 수 없습니다.";
  if (FORBIDDEN.test(name)) return '다음 문자는 사용할 수 없습니다: \\ / < > : " | ? *';
  if (CONTROL.test(name)) return '제어 문자는 사용할 수 없습니다.';
  if (/[. ]$/.test(name)) return '이름 끝에 점(.)이나 공백을 둘 수 없습니다.';
  if (name.length > 200) return '이름이 너무 깁니다(최대 200자).';
  return null;
}

/** 문서의 맨 위 헤더 텍스트를 안전한 문서 제목으로 변환 */
export function sanitizeDocumentTitle(raw: string): string | null {
  if (!raw) return null;
  let cleaned = raw.replace(/[\\/<>:"|?*\u0000-\u001f\u007f#]/g, ' ').trim();
  cleaned = cleaned.replace(/[. ]+$/, '').trim();
  if (cleaned.length > 100) cleaned = cleaned.slice(0, 100).trim();
  if (!cleaned) return null;
  return cleaned;
}

/** chokidar/폴더 스캔 시 완전히 제외할 폴더 */
export const IGNORED_DIRS = new Set([
  'node_modules',
  'target',
  '.git',
  'dist',
  'build',
  '.gradle',
  '.idea',
  'out',
  '.next',
  '.venv',
  '__pycache__',
]);

export function isIgnoredDir(name: string): boolean {
  return IGNORED_DIRS.has(name);
}

/** 첨부 이미지 규칙 */
export const IMAGE_MAX_BYTES = 20 * 1024 * 1024;
export const IMAGE_MAX_COUNT = 10;
export const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp'];

export function validateImageFiles(files: Array<{ name: string; size: number }>): string | null {
  if (files.length > IMAGE_MAX_COUNT) return `이미지는 1회 최대 ${IMAGE_MAX_COUNT}장까지 업로드할 수 있습니다.`;
  for (const f of files) {
    const ext = f.name.split('.').pop()?.toLowerCase() ?? '';
    if (!IMAGE_EXTS.includes(ext)) return `허용되지 않는 형식입니다: ${f.name} (png, jpg, jpeg, gif, webp)`;
    if (f.size > IMAGE_MAX_BYTES) return `20MB를 초과하는 이미지입니다: ${f.name}`;
  }
  return null;
}

/** images/YYYYMMDD-HHmmss-n.png */
export function imageFileName(date: Date, n: number, ext = 'png'): string {
  const p = (v: number) => String(v).padStart(2, '0');
  const stamp = `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
  return `images/${stamp}-${n}.${ext}`;
}
