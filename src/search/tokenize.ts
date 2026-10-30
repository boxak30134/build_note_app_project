/** 한국어 친화 토크나이저: 단어 + 한글 2-gram (조사 부착형 어절 매칭 보완) */
const HANGUL = /[\uac00-\ud7a3]/;

export function tokenizeKo(text: string): string[] {
  const words = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((w) => w.length > 0);
  const out: string[] = [];
  for (const w of words) {
    out.push(w);
    if (HANGUL.test(w) && w.length > 2) {
      for (let i = 0; i < w.length - 1; i++) out.push(w.slice(i, i + 2));
    }
  }
  return out;
}
