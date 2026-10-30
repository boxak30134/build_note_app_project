/**
 * textCodec — UTF-8 / UTF-8 BOM / CP949(MS-949) 자동 감지 및 원본 인코딩·줄바꿈 보존 저장.
 * CP949 변환은 iconv-lite (브라우저에서는 buffer 폴리필) 를 사용한다.
 */
import iconv from 'iconv-lite';
import { Buffer } from 'buffer';

export type TextEncodingKind = 'utf-8' | 'utf-8-bom' | 'cp949';
export type EolKind = 'lf' | 'crlf';

export interface DecodedText {
  text: string; // 항상 LF 로 정규화된 텍스트
  encoding: TextEncodingKind;
  eol: EolKind;
}

export interface UnencodableChar {
  char: string;
  codePoint: number;
  index: number; // 문자열(LF 정규화) 기준 UTF-16 인덱스
  line: number; // 1-based
  column: number; // 1-based
}

export class UnencodableCharError extends Error {
  readonly chars: UnencodableChar[];
  constructor(chars: UnencodableChar[]) {
    const preview = chars
      .slice(0, 5)
      .map((c) => `'${c.char}'(U+${c.codePoint.toString(16).toUpperCase().padStart(4, '0')}) ${c.line}행 ${c.column}열`)
      .join(', ');
    super(`CP949로 표현할 수 없는 문자 ${chars.length}개가 있어 저장을 거부했습니다: ${preview}${chars.length > 5 ? ' …' : ''}`);
    this.name = 'UnencodableCharError';
    this.chars = chars;
  }
}

const BOM = [0xef, 0xbb, 0xbf];

export function hasUtf8Bom(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === BOM[0] && bytes[1] === BOM[1] && bytes[2] === BOM[2];
}

export function detectEol(text: string): EolKind {
  return text.includes('\r\n') ? 'crlf' : 'lf';
}

export function normalizeEol(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

export function applyEol(text: string, eol: EolKind): string {
  const lf = normalizeEol(text);
  return eol === 'crlf' ? lf.replace(/\n/g, '\r\n') : lf;
}

export function detectEncoding(bytes: Uint8Array): TextEncodingKind {
  if (hasUtf8Bom(bytes)) return 'utf-8-bom';
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return 'utf-8';
  } catch {
    return 'cp949';
  }
}

export function decodeText(bytes: Uint8Array): DecodedText {
  const encoding = detectEncoding(bytes);
  let raw: string;
  if (encoding === 'utf-8-bom') raw = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes.subarray(3));
  else if (encoding === 'utf-8') raw = new TextDecoder('utf-8').decode(bytes);
  else raw = iconv.decode(Buffer.from(bytes), 'cp949');
  return { text: normalizeEol(raw), encoding, eol: detectEol(raw) };
}

let cp949Cache: Map<number, boolean> | null = null;

/** 문자 하나가 CP949 로 왕복 표현 가능한지 (iconv-lite 는 비표현 문자를 '?' 로 치환하므로 왕복 비교) */
function cp949Encodable(ch: string): boolean {
  const cp = ch.codePointAt(0)!;
  if (cp < 0x80) return true;
  cp949Cache ??= new Map();
  const hit = cp949Cache.get(cp);
  if (hit !== undefined) return hit;
  const ok = iconv.decode(iconv.encode(ch, 'cp949'), 'cp949') === ch;
  cp949Cache.set(cp, ok);
  return ok;
}

/** CP949 로 표현할 수 없는 문자 목록 (LF 정규화 텍스트 기준 위치) */
export function findUnencodableCp949(text: string): UnencodableChar[] {
  const result: UnencodableChar[] = [];
  let line = 1;
  let column = 1;
  let index = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0x80 && !cp949Encodable(ch)) {
      result.push({ char: ch, codePoint: cp, index, line, column });
    }
    if (ch === '\n') {
      line++;
      column = 1;
    } else {
      column++;
    }
    index += ch.length;
  }
  return result;
}

function encodeCp949(text: string): Uint8Array {
  const bad = findUnencodableCp949(normalizeEol(text));
  if (bad.length > 0) throw new UnencodableCharError(bad);
  return new Uint8Array(iconv.encode(text, 'cp949'));
}

/** 원래의 인코딩·줄바꿈으로 인코딩. CP949 비표현 문자가 있으면 UnencodableCharError 를 던진다. */
export function encodeText(text: string, encoding: TextEncodingKind, eol: EolKind): Uint8Array {
  const withEol = applyEol(text, eol);
  if (encoding === 'cp949') return encodeCp949(withEol);
  const body = new TextEncoder().encode(withEol);
  if (encoding === 'utf-8-bom') {
    const out = new Uint8Array(body.length + 3);
    out.set(BOM, 0);
    out.set(body, 3);
    return out;
  }
  return body;
}

/** 새로 생성하는 파일의 기본값: BOM 없는 UTF-8, LF */
export const DEFAULT_TEXT_FORMAT: { encoding: TextEncodingKind; eol: EolKind } = { encoding: 'utf-8', eol: 'lf' };
