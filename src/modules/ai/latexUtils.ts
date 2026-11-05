import katex from 'katex';

/**
 * KaTeX 렌더링 호환성을 보장하기 위해 \begin{align*} 등을 \begin{aligned}로 정규화한다.
 */
export function normalizeAcademicLatex(text: string): string {
  return text
    .replace(/\\begin\{align\*?\}/g, '\\begin{aligned}')
    .replace(/\\end\{align\*?\}/g, '\\end{aligned}');
}

export type MathSegment =
  | { type: 'text'; content: string }
  | { type: 'inline-math'; latex: string; html: string }
  | { type: 'block-math'; latex: string; html: string };

function safeKatexToString(latex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(normalizeAcademicLatex(latex.trim()), {
      throwOnError: false,
      displayMode,
    });
  } catch {
    return latex;
  }
}

/**
 * 마크다운/텍스트 내의 독립 블록 수식($$...$$)과 인라인 수식($...$)을 분리하여 KaTeX HTML 세그먼트로 변환한다.
 */
export function parseMathSegments(rawText: string): MathSegment[] {
  const normalized = normalizeAcademicLatex(rawText);
  const segments: MathSegment[] = [];
  const pattern = /\$\$([\s\S]+?)\$\$|\$(?!\$)([^$\n]+?)\$/g;
  let lastIndex = 0;

  for (const match of normalized.matchAll(pattern)) {
    const idx = match.index ?? 0;
    if (idx > lastIndex) {
      segments.push({ type: 'text', content: normalized.slice(lastIndex, idx) });
    }
    if (match[1] !== undefined) {
      const latex = match[1].trim();
      segments.push({
        type: 'block-math',
        latex,
        html: safeKatexToString(latex, true),
      });
    } else if (match[2] !== undefined) {
      const latex = match[2].trim();
      segments.push({
        type: 'inline-math',
        latex,
        html: safeKatexToString(latex, false),
      });
    }
    lastIndex = idx + match[0].length;
  }

  if (lastIndex < normalized.length) {
    segments.push({ type: 'text', content: normalized.slice(lastIndex) });
  }

  return segments;
}
