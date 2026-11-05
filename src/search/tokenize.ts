import { stripKoreanJosa } from '../services/offlineDocumentLinker';

/** 한국어·수식 친화 하이브리드 토크나이저: LaTeX 수식 명령어 + 한국어 조사 제거 어간 + 한글 2-gram */
const HANGUL = /[\uac00-\ud7a3]/;

export function tokenizeKo(text: string): string[] {
  const out: string[] = [];

  // Step A: LaTeX 핵심 명령어 추출 (\frac, \int, \sum, \sqrt 등)
  const latexCommands = text.match(/\\[a-zA-Z]{2,}/g);
  if (latexCommands) {
    for (const cmd of latexCommands) {
      out.push(`math:${cmd}`);
    }
  }

  // Step B: 일반 텍스트 정제 및 한국어 조사 제거 + 2-gram
  const words = text
    .toLowerCase()
    .replace(/\$+/g, ' ')
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((w) => w.length > 0);

  for (const w of words) {
    const stem = stripKoreanJosa(w);
    out.push(stem);
    if (stem !== w) out.push(w);
    if (HANGUL.test(stem) && stem.length > 2) {
      for (let i = 0; i < stem.length - 1; i++) out.push(stem.slice(i, i + 2));
    }
  }
  return out;
}
