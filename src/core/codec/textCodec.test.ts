import { describe, expect, it } from 'vitest';
import {
  decodeText,
  detectEncoding,
  encodeText,
  findUnencodableCp949,
  UnencodableCharError,
} from './textCodec';

// '안녕' CP949 바이트: BE C8 B3 E7
const CP949_ANNYEONG = [0xbe, 0xc8, 0xb3, 0xe7];

describe('textCodec 인코딩 감지', () => {
  it('UTF-8 / UTF-8 BOM / CP949 를 구분한다', () => {
    expect(detectEncoding(new TextEncoder().encode('안녕 hello'))).toBe('utf-8');
    expect(detectEncoding(Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('a')]))).toBe('utf-8-bom');
    expect(detectEncoding(Uint8Array.from(CP949_ANNYEONG))).toBe('cp949');
  });

  it('CP949 바이트를 올바르게 디코딩한다', () => {
    const d = decodeText(Uint8Array.from([...CP949_ANNYEONG, 0x0d, 0x0a, 0x41]));
    expect(d.encoding).toBe('cp949');
    expect(d.eol).toBe('crlf');
    expect(d.text).toBe('안녕\nA');
  });
});

describe('textCodec 왕복 변환', () => {
  const samples = ['# 제목\n\n본문 텍스트입니다. 똠방각하 뷁\n- 항목 1\n- 항목 2\n', 'plain ascii\n', '한자 漢字 및 기호 ①②③\n'];

  for (const enc of ['utf-8', 'utf-8-bom', 'cp949'] as const) {
    for (const eol of ['lf', 'crlf'] as const) {
      it(`${enc} / ${eol} 바이트 단위 동일 왕복`, () => {
        for (const s of samples) {
          const bytes = encodeText(s, enc, eol);
          const decoded = decodeText(bytes);
          expect(decoded.encoding).toBe(enc === 'cp949' && /^[\x00-\x7f]*$/.test(s) ? 'utf-8' : enc);
          expect(decoded.text).toBe(s);
          if (s.includes('\n')) expect(decoded.eol).toBe(eol);
          // 재인코딩 시 원래 바이트와 100% 동일
          const again = encodeText(decoded.text, enc, decoded.eol);
          expect(Array.from(again)).toEqual(Array.from(bytes));
        }
      });
    }
  }

  it('CP949 원본 바이트를 열고 그대로 저장하면 동일한 바이트', () => {
    const original = Uint8Array.from([...CP949_ANNYEONG, 0x0d, 0x0a, 0x41, 0x0d, 0x0a]);
    const d = decodeText(original);
    expect(Array.from(encodeText(d.text, d.encoding, d.eol))).toEqual(Array.from(original));
  });
});

describe('CP949 비표현 문자 저장 거부', () => {
  it('이모지 등 표현 불가 문자가 있으면 위치와 함께 예외', () => {
    const text = '첫 줄\n둘째 😀 줄';
    expect(() => encodeText(text, 'cp949', 'lf')).toThrow(UnencodableCharError);
    try {
      encodeText(text, 'cp949', 'lf');
    } catch (e) {
      const err = e as UnencodableCharError;
      expect(err.chars).toHaveLength(1);
      expect(err.chars[0].char).toBe('😀');
      expect(err.chars[0].line).toBe(2);
      expect(err.chars[0].column).toBe(4);
      expect(err.message).toContain('2행 4열');
    }
  });

  it('UTF-8 로는 같은 문자도 저장 가능', () => {
    expect(() => encodeText('😀', 'utf-8', 'lf')).not.toThrow();
    expect(findUnencodableCp949('가나다')).toEqual([]);
  });
});
