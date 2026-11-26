import { PDFDocument } from 'pdf-lib';
import type { JSONContent } from '@tiptap/core';
import { encodeText } from '../../core/codec/textCodec';
import { getPageDimensions, type NotePage } from '../../core/page/pageTypes';
import { drawStroke } from '../../canvas/render';
import { readAttachmentBlob } from '../../storage/opfs';
import { downloadBytes } from '../../storage/localFiles';
import type { NoteSession } from '../../session/NoteSession';
import { toast } from '../../store/uiStore';

/** 파일명 금지 문자 제거 및 안전한 내보내기 파일명 생성 */
export function safeExportFileName(title: string | null | undefined, fallback = '제목 없는 노트'): string {
  const cleaned = (title ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 120);
  return cleaned || fallback;
}

type SavePickerWindow = Window & {
  showSaveFilePicker?: (options?: {
    suggestedName?: string;
    types?: Array<{ description?: string; accept: Record<string, string[]> }>;
  }) => Promise<{
    createWritable: () => Promise<{
      write: (data: BufferSource | Blob | string) => Promise<void>;
      close: () => Promise<void>;
    }>;
  }>;
};

/**
 * 사용자가 원하는 경로에 파일을 저장한다.
 * - `showSaveFilePicker` 지원 환경: 파일 저장 다이얼로그로 경로·파일명 직접 선택
 * - 사용자 취소(`AbortError`): false 반환
 * - 미지원 환경(태블릿/모바일 등): 브라우저 다운로드(`downloadBytes`) 폴백
 */
export async function saveBytesWithPicker(
  bytes: Uint8Array,
  suggestedName: string,
  mimeType: string,
  extensions: string[],
): Promise<boolean> {
  const win = typeof window !== 'undefined' ? (window as SavePickerWindow) : undefined;
  if (win?.showSaveFilePicker) {
    try {
      const handle = await win.showSaveFilePicker({
        suggestedName,
        types: [
          {
            description: mimeType === 'application/pdf' ? 'PDF 문서' : 'Markdown 문서',
            accept: { [mimeType]: extensions },
          },
        ],
      });
      const writable = await handle.createWritable();
      await writable.write(bytes as unknown as BufferSource);
      await writable.close();
      return true;
    } catch (err) {
      const name = (err as Error)?.name;
      if (name === 'AbortError') return false;
      // SecurityError 등 파일 피커 호출 제한 시 다운로드 폴백
    }
  }

  downloadBytes(bytes, suggestedName, mimeType);
  return true;
}

/** 활성 노트를 Markdown(.md) 파일로 원하는 경로에 내보낸다 */
export async function exportNoteToMarkdown(session: NoteSession): Promise<boolean> {
  const markdown = session.editor.getMarkdown();
  const encoding = session.record.encoding ?? 'utf-8';
  const eol = session.record.eol ?? 'lf';

  let bytes: Uint8Array;
  try {
    bytes = encodeText(markdown, encoding, eol);
  } catch {
    bytes = encodeText(markdown, 'utf-8', eol);
    toast.info('CP949에 없는 문자가 포함되어 UTF-8로 내보냅니다.');
  }

  const fileName = `${safeExportFileName(session.record.title)}.md`;
  return saveBytesWithPicker(bytes, fileName, 'text/markdown', ['.md']);
}

type ExportSegment =
  | { type: 'text'; text: string }
  | { type: 'math'; latex: string };

interface ExportLine {
  runs: ExportSegment[];
  size: number;
  bold?: boolean;
  isBlockMath?: boolean;
}

const CALLOUT_LABELS: Record<string, string> = {
  theorem: 'Theorem (정리)',
  lemma: 'Lemma (보조정리)',
  proposition: 'Proposition (명제)',
  corollary: 'Corollary (따름정리)',
  definition: 'Definition (정의)',
  proof: 'Proof (증명)',
  example: 'Example (예제)',
  remark: 'Remark (주해)',
  warning: 'Warning (주의)',
  note: 'Note (노트)',
};

const LATEX_SYMBOLS: Record<string, string> = {
  alpha: 'α',
  beta: 'β',
  gamma: 'γ',
  delta: 'δ',
  epsilon: 'ε',
  varepsilon: 'ε',
  zeta: 'ζ',
  eta: 'η',
  theta: 'θ',
  vartheta: 'ϑ',
  iota: 'ι',
  kappa: 'κ',
  lambda: 'λ',
  mu: 'μ',
  nu: 'ν',
  xi: 'ξ',
  pi: 'π',
  rho: 'ρ',
  sigma: 'σ',
  tau: 'τ',
  upsilon: 'υ',
  phi: 'φ',
  varphi: 'φ',
  chi: 'χ',
  psi: 'ψ',
  omega: 'ω',
  Gamma: 'Γ',
  Delta: 'Δ',
  Theta: 'Θ',
  Lambda: 'Λ',
  Xi: 'Ξ',
  Pi: 'Π',
  Sigma: 'Σ',
  Phi: 'Φ',
  Psi: 'Ψ',
  Omega: 'Ω',
  le: '≤',
  leq: '≤',
  ge: '≥',
  geq: '≥',
  ne: '≠',
  neq: '≠',
  approx: '≈',
  equiv: '≡',
  sim: '∼',
  simeq: '≃',
  cong: '≅',
  propto: '∝',
  pm: '±',
  mp: '∓',
  times: '×',
  div: '÷',
  cdot: '·',
  ast: '∗',
  circ: '∘',
  bullet: '•',
  to: '→',
  rightarrow: '→',
  leftarrow: '←',
  leftrightarrow: '↔',
  Rightarrow: '⇒',
  Leftarrow: '⇐',
  Leftrightarrow: '⇔',
  mapsto: '↦',
  infty: '∞',
  partial: '∂',
  nabla: '∇',
  forall: '∀',
  exists: '∃',
  nexists: '∄',
  in: '∈',
  notin: '∉',
  ni: '∋',
  subset: '⊂',
  subseteq: '⊆',
  supset: '⊃',
  supseteq: '⊇',
  cup: '∪',
  cap: '∩',
  emptyset: '∅',
  varnothing: '∅',
  sum: '∑',
  prod: '∏',
  int: '∫',
  iint: '∬',
  oint: '∮',
  degree: '°',
  prime: '′',
  angle: '∠',
  perp: '⊥',
  parallel: '∥',
  therefore: '∴',
  because: '∵',
  square: '□',
  quad: '  ',
  qquad: '    ',
  ',': ' ',
  ';': ' ',
  ' ': ' ',
  '%': '%',
  _: '_',
  '{': '{',
  '}': '}',
  '&': '&',
};

const BLACKBOARD_MAP: Record<string, string> = {
  R: 'ℝ',
  N: 'ℕ',
  Z: 'ℤ',
  Q: 'ℚ',
  C: 'ℂ',
  P: 'ℙ',
  E: '𝔼',
};

const TEXT_WRAPPER_CMDS = new Set([
  'text',
  'textrm',
  'textsf',
  'texttt',
  'mathrm',
  'mathbf',
  'mathit',
  'mathsf',
  'mathcal',
  'operatorname',
  'boldsymbol',
  'hat',
  'bar',
  'vec',
  'tilde',
  'overline',
]);

function splitInlineRawMath(text: string): ExportSegment[] {
  if (!text.includes('$')) return text ? [{ type: 'text', text }] : [];
  const out: ExportSegment[] = [];
  const re = /\$(?!\$)(?!\s)([^$\n]+?)(?<!\s)\$/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      out.push({ type: 'text', text: text.slice(last, m.index) });
    }
    out.push({ type: 'math', latex: m[1].trim() });
    last = re.lastIndex;
  }
  if (last < text.length) {
    out.push({ type: 'text', text: text.slice(last) });
  }
  return out;
}

function collectSegments(n: JSONContent): ExportSegment[] {
  if (n.type === 'text') {
    return splitInlineRawMath(n.text ?? '');
  }
  if (n.type === 'hardBreak') {
    return [{ type: 'text', text: '\n' }];
  }
  if (n.type === 'inlineMath') {
    const latex = String(n.attrs?.latex ?? '').trim();
    return [{ type: 'math', latex: latex || '□' }];
  }
  if (n.type === 'rubyText') {
    const base = String(n.attrs?.base ?? '');
    const rt = String(n.attrs?.rt ?? '').trim();
    return [{ type: 'text', text: rt ? `${base}(${rt})` : base }];
  }
  if (n.type === 'wikiLink') {
    const label = String(n.attrs?.label ?? '링크');
    return [{ type: 'text', text: label }];
  }
  if (!n.content) return [];
  return n.content.flatMap(collectSegments);
}

function splitSegmentsByNewline(segments: ExportSegment[]): ExportSegment[][] {
  const lines: ExportSegment[][] = [[]];
  for (const seg of segments) {
    if (seg.type === 'math') {
      lines[lines.length - 1].push(seg);
      continue;
    }
    const parts = seg.text.split('\n');
    parts.forEach((part, idx) => {
      if (idx > 0) lines.push([]);
      if (part.length > 0) {
        lines[lines.length - 1].push({ type: 'text', text: part });
      }
    });
  }
  return lines;
}

function extractNodeLines(node: JSONContent, depth = 0): ExportLine[] {
  const lines: ExportLine[] = [];

  if (node.type === 'doc') {
    for (const child of node.content ?? []) {
      lines.push(...extractNodeLines(child, depth));
    }
    return lines;
  }

  if (node.type === 'inkTemplate' || node.type === 'pdfEmbed') {
    return lines;
  }

  if (node.type === 'blockMath') {
    const latex = String(node.attrs?.latex ?? '').trim();
    lines.push({
      runs: [{ type: 'math', latex: latex || '□' }],
      size: 15,
      isBlockMath: true,
    });
    return lines;
  }

  if (node.type === 'heading') {
    const level = Number(node.attrs?.level ?? 1);
    const size = level === 1 ? 22 : level === 2 ? 18 : 15;
    for (const segLine of splitSegmentsByNewline(collectSegments(node))) {
      lines.push({ runs: segLine, size, bold: true });
    }
    return lines;
  }

  if (node.type === 'bulletList' || node.type === 'orderedList') {
    (node.content ?? []).forEach((item, idx) => {
      const prefix = node.type === 'orderedList' ? `${idx + 1}. ` : '• ';
      const itemLines = extractNodeLines(item, depth + 1);
      if (itemLines.length > 0) {
        itemLines[0] = {
          ...itemLines[0],
          runs: [{ type: 'text', text: `${'  '.repeat(depth)}${prefix}` }, ...itemLines[0].runs],
        };
        lines.push(...itemLines);
      }
    });
    return lines;
  }

  if (node.type === 'blockquote') {
    for (const child of node.content ?? []) {
      const sub = extractNodeLines(child, depth);
      sub.forEach((l) =>
        lines.push({ ...l, runs: [{ type: 'text', text: '│ ' }, ...l.runs] }),
      );
    }
    return lines;
  }

  if (node.type === 'callout') {
    const kind = String(node.attrs?.kind ?? 'note');
    const title = String(node.attrs?.title ?? '').trim();
    const header = title || CALLOUT_LABELS[kind] || kind;
    lines.push({ runs: [{ type: 'text', text: `[${header}]` }], size: 13, bold: true });
    for (const child of node.content ?? []) {
      const sub = extractNodeLines(child, depth);
      sub.forEach((l) =>
        lines.push({ ...l, runs: [{ type: 'text', text: '│ ' }, ...l.runs] }),
      );
    }
    return lines;
  }

  if (node.type === 'table') {
    for (const row of node.content ?? []) {
      if (row.type !== 'tableRow') continue;
      const rowRuns: ExportSegment[] = [];
      (row.content ?? []).forEach((cell, idx) => {
        if (idx > 0) rowRuns.push({ type: 'text', text: '  |  ' });
        rowRuns.push(...collectSegments(cell));
      });
      if (rowRuns.length > 0) {
        lines.push({ runs: rowRuns, size: 12 });
      }
    }
    return lines;
  }

  if (node.type === 'codeBlock') {
    for (const segLine of splitSegmentsByNewline(collectSegments(node))) {
      lines.push({ runs: segLine, size: 11 });
    }
    return lines;
  }

  const segments = collectSegments(node);
  const split = splitSegmentsByNewline(segments);
  const hasContent = segments.some((s) => (s.type === 'math' ? s.latex.length > 0 : s.text.trim().length > 0));
  if (hasContent || node.type === 'paragraph') {
    for (const segLine of split) {
      lines.push({ runs: segLine, size: 13 });
    }
  }
  return lines;
}

function drawPageGridStyle(ctx: CanvasRenderingContext2D, width: number, height: number, style: NotePage['style']) {
  if (style === 'plain') return;
  ctx.save();
  if (style === 'lined') {
    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = 1;
    for (let y = 48; y < height; y += 32) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
  } else if (style === 'grid') {
    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = 0.8;
    for (let x = 24; x < width; x += 24) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
    for (let y = 24; y < height; y += 24) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
  } else if (style === 'dotted') {
    ctx.fillStyle = '#cbd5e1';
    for (let y = 24; y < height; y += 24) {
      for (let x = 24; x < width; x += 24) {
        ctx.fillRect(x - 0.8, y - 0.8, 1.6, 1.6);
      }
    }
  }
  ctx.restore();
}

type MathAstNode =
  | { kind: 'text'; text: string }
  | { kind: 'script'; base: MathAstNode; sub?: MathAstNode[]; sup?: MathAstNode[] }
  | { kind: 'frac'; num: MathAstNode[]; den: MathAstNode[] }
  | { kind: 'sqrt'; inner: MathAstNode[] }
  | { kind: 'group'; items: MathAstNode[] };

function parseLatexAst(input: string): MathAstNode[] {
  let pos = 0;

  const skipSpaces = () => {
    while (pos < input.length && /\s/.test(input[pos])) pos++;
  };

  const readArg = (): MathAstNode[] => {
    skipSpaces();
    if (pos >= input.length) return [];
    if (input[pos] === '{') {
      pos++;
      const inner = parseSequence('}');
      if (pos < input.length && input[pos] === '}') pos++;
      return inner;
    }
    const atom = readAtom();
    return atom ? [atom] : [];
  };

  const readCommandName = (): string => {
    pos++; // skip '\'
    if (pos >= input.length) return '';
    if (!/[a-zA-Z]/.test(input[pos])) {
      return input[pos++];
    }
    const start = pos;
    while (pos < input.length && /[a-zA-Z]/.test(input[pos])) pos++;
    return input.slice(start, pos);
  };

  const readAtom = (): MathAstNode | null => {
    if (pos >= input.length) return null;
    const ch = input[pos];
    if (ch === '{') {
      pos++;
      const items = parseSequence('}');
      if (pos < input.length && input[pos] === '}') pos++;
      return { kind: 'group', items };
    }
    if (ch === '\\') {
      const cmd = readCommandName();
      if (cmd === 'left' || cmd === 'right' || cmd === 'displaystyle' || cmd === 'limits') {
        return null;
      }
      if (cmd === 'frac' || cmd === 'dfrac' || cmd === 'tfrac') {
        const num = readArg();
        const den = readArg();
        return { kind: 'frac', num, den };
      }
      if (cmd === 'sqrt') {
        skipSpaces();
        if (input[pos] === '[') {
          while (pos < input.length && input[pos] !== ']') pos++;
          if (input[pos] === ']') pos++;
        }
        return { kind: 'sqrt', inner: readArg() };
      }
      if (cmd === 'mathbb') {
        const inner = readArg();
        const raw = inner.map((n) => (n.kind === 'text' ? n.text : '')).join('');
        return { kind: 'text', text: BLACKBOARD_MAP[raw] ?? raw };
      }
      if (TEXT_WRAPPER_CMDS.has(cmd)) {
        return { kind: 'group', items: readArg() };
      }
      if (cmd in LATEX_SYMBOLS) {
        return { kind: 'text', text: LATEX_SYMBOLS[cmd] };
      }
      return { kind: 'text', text: cmd };
    }
    pos++;
    return { kind: 'text', text: ch };
  };

  const parseSequence = (stopChar?: string): MathAstNode[] => {
    const nodes: MathAstNode[] = [];
    while (pos < input.length) {
      const ch = input[pos];
      if (stopChar && ch === stopChar) break;
      if (ch === '^' || ch === '_') {
        const isSup = ch === '^';
        pos++;
        const arg = readArg();
        const prev = nodes.pop() ?? { kind: 'text', text: '' };
        if (prev.kind === 'script') {
          if (isSup) prev.sup = arg;
          else prev.sub = arg;
          nodes.push(prev);
        } else {
          nodes.push({
            kind: 'script',
            base: prev,
            ...(isSup ? { sup: arg } : { sub: arg }),
          });
        }
        continue;
      }
      if (/\s/.test(ch)) {
        pos++;
        if (nodes.length > 0) {
          const last = nodes[nodes.length - 1];
          if (!(last.kind === 'text' && last.text.endsWith(' '))) {
            nodes.push({ kind: 'text', text: ' ' });
          }
        }
        continue;
      }
      const atom = readAtom();
      if (atom) nodes.push(atom);
    }
    return nodes;
  };

  return parseSequence();
}

const makeTextFont = (size: number, bold?: boolean) =>
  `${bold ? 'bold ' : ''}${size}px "Malgun Gothic", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif`;

const makeMathFont = (size: number, bold?: boolean) =>
  `${bold ? 'bold ' : ''}italic ${size}px "Cambria Math", "Times New Roman", "Malgun Gothic", serif`;

function measureMathAst(ctx: CanvasRenderingContext2D, nodes: MathAstNode[], size: number, bold?: boolean): number {
  let width = 0;
  const scriptSize = Math.max(8, Math.round(size * 0.72));
  const fracSize = Math.max(8, Math.round(size * 0.82));

  for (const node of nodes) {
    if (node.kind === 'text') {
      ctx.font = makeMathFont(size, bold);
      width += ctx.measureText(node.text).width;
    } else if (node.kind === 'group') {
      width += measureMathAst(ctx, node.items, size, bold);
    } else if (node.kind === 'script') {
      const baseW = measureMathAst(ctx, [node.base], size, bold);
      const subW = node.sub ? measureMathAst(ctx, node.sub, scriptSize, bold) : 0;
      const supW = node.sup ? measureMathAst(ctx, node.sup, scriptSize, bold) : 0;
      width += baseW + Math.max(subW, supW);
    } else if (node.kind === 'frac') {
      const numW = measureMathAst(ctx, node.num, fracSize, bold);
      const denW = measureMathAst(ctx, node.den, fracSize, bold);
      width += Math.max(numW, denW) + 8;
    } else if (node.kind === 'sqrt') {
      ctx.font = makeMathFont(size, bold);
      width += ctx.measureText('√').width + measureMathAst(ctx, node.inner, size, bold) + 2;
    }
  }
  return width;
}

function drawMathAst(
  ctx: CanvasRenderingContext2D,
  nodes: MathAstNode[],
  x: number,
  y: number,
  size: number,
  bold?: boolean,
): number {
  let cursorX = x;
  const scriptSize = Math.max(8, Math.round(size * 0.72));
  const fracSize = Math.max(8, Math.round(size * 0.82));

  for (const node of nodes) {
    if (node.kind === 'text') {
      ctx.font = makeMathFont(size, bold);
      ctx.fillText(node.text, cursorX, y);
      cursorX += ctx.measureText(node.text).width;
    } else if (node.kind === 'group') {
      cursorX = drawMathAst(ctx, node.items, cursorX, y, size, bold);
    } else if (node.kind === 'script') {
      cursorX = drawMathAst(ctx, [node.base], cursorX, y, size, bold);
      const subW = node.sub ? measureMathAst(ctx, node.sub, scriptSize, bold) : 0;
      const supW = node.sup ? measureMathAst(ctx, node.sup, scriptSize, bold) : 0;
      if (node.sub) {
        drawMathAst(ctx, node.sub, cursorX, y + size * 0.28, scriptSize, bold);
      }
      if (node.sup) {
        drawMathAst(ctx, node.sup, cursorX, y - size * 0.36, scriptSize, bold);
      }
      cursorX += Math.max(subW, supW);
    } else if (node.kind === 'frac') {
      const numW = measureMathAst(ctx, node.num, fracSize, bold);
      const denW = measureMathAst(ctx, node.den, fracSize, bold);
      const barW = Math.max(numW, denW) + 6;
      const midX = cursorX + 1 + barW / 2;
      drawMathAst(ctx, node.num, midX - numW / 2, y - size * 0.44, fracSize, bold);
      ctx.save();
      ctx.strokeStyle = ctx.fillStyle as string;
      ctx.lineWidth = Math.max(0.8, size * 0.06);
      ctx.beginPath();
      ctx.moveTo(cursorX + 1, y - size * 0.3);
      ctx.lineTo(cursorX + 1 + barW, y - size * 0.3);
      ctx.stroke();
      ctx.restore();
      drawMathAst(ctx, node.den, midX - denW / 2, y + size * 0.48, fracSize, bold);
      cursorX += barW + 2;
    } else if (node.kind === 'sqrt') {
      ctx.font = makeMathFont(size, bold);
      const radW = ctx.measureText('√').width;
      ctx.fillText('√', cursorX, y);
      const innerStart = cursorX + radW;
      const innerEnd = drawMathAst(ctx, node.inner, innerStart, y, size, bold);
      ctx.save();
      ctx.strokeStyle = ctx.fillStyle as string;
      ctx.lineWidth = Math.max(0.8, size * 0.06);
      ctx.beginPath();
      ctx.moveTo(innerStart, y - size * 0.85);
      ctx.lineTo(innerEnd + 2, y - size * 0.85);
      ctx.stroke();
      ctx.restore();
      cursorX = innerEnd + 2;
    }
  }
  return cursorX;
}

function measureRunsWidth(
  ctx: CanvasRenderingContext2D,
  runs: ExportSegment[],
  size: number,
  bold?: boolean,
): number {
  let width = 0;
  for (const run of runs) {
    if (run.type === 'text') {
      ctx.font = makeTextFont(size, bold);
      width += ctx.measureText(run.text).width;
    } else {
      width += measureMathAst(ctx, parseLatexAst(run.latex), size, bold);
    }
  }
  return width;
}

function wrapSegmentRuns(
  ctx: CanvasRenderingContext2D,
  runs: ExportSegment[],
  size: number,
  maxWidth: number,
  bold?: boolean,
): ExportSegment[][] {
  if (runs.length === 0) return [[]];
  const wrapped: ExportSegment[][] = [[]];
  let currentWidth = 0;

  for (const run of runs) {
    if (run.type === 'math') {
      const mathW = measureMathAst(ctx, parseLatexAst(run.latex), size, bold);
      if (currentWidth > 0 && currentWidth + mathW > maxWidth) {
        wrapped.push([run]);
        currentWidth = mathW;
      } else {
        wrapped[wrapped.length - 1].push(run);
        currentWidth += mathW;
      }
      continue;
    }

    let buf = '';
    ctx.font = makeTextFont(size, bold);
    for (const ch of run.text) {
      const chW = ctx.measureText(buf + ch).width;
      if (currentWidth + chW > maxWidth && (buf.length > 0 || currentWidth > 0)) {
        if (buf.length > 0) {
          wrapped[wrapped.length - 1].push({ type: 'text', text: buf });
        }
        wrapped.push([]);
        buf = ch;
        currentWidth = 0;
      } else {
        buf += ch;
      }
    }
    if (buf.length > 0) {
      ctx.font = makeTextFont(size, bold);
      currentWidth += ctx.measureText(buf).width;
      wrapped[wrapped.length - 1].push({ type: 'text', text: buf });
    }
  }
  return wrapped;
}

function drawSegmentRuns(
  ctx: CanvasRenderingContext2D,
  runs: ExportSegment[],
  startX: number,
  y: number,
  size: number,
  bold?: boolean,
): void {
  let cursorX = startX;
  for (const run of runs) {
    if (run.type === 'text') {
      ctx.font = makeTextFont(size, bold);
      ctx.fillText(run.text, cursorX, y);
      cursorX += ctx.measureText(run.text).width;
    } else {
      cursorX = drawMathAst(ctx, parseLatexAst(run.latex), cursorX, y, size, bold);
    }
  }
}

function canvasToJpegUint8Array(canvas: HTMLCanvasElement, quality = 0.88): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) return reject(new Error('PDF 페이지 이미지 변환에 실패했습니다.'));
        blob
          .arrayBuffer()
          .then((buf) => resolve(new Uint8Array(buf)))
          .catch(reject);
      },
      'image/jpeg',
      quality,
    );
  });
}

function loadImageFromBlob(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('첨부 이미지 로드 실패'));
    };
    img.src = url;
  });
}

/**
 * 활성 노트의 페이지·템플릿·텍스트·S-Pen 스트로크를 합성해 표준 PDF Uint8Array를 생성한다.
 */
export async function buildPdfBytesFromSession(
  session: NoteSession,
  onProgress?: (page: number, total: number) => void,
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  const docJson = session.editor.getJSON();
  const strokes = session.strokes.getAll();
  const pages: NotePage[] =
    session.ui.pages.length > 0
      ? session.ui.pages
      : [{ id: 'p-1', size: 'A4', style: 'plain', orientation: 'portrait' }];

  // inkTemplate 노드가 있는 경우 페이지별 배경 이미지 소스 매핑
  const templateNodes = (docJson.content ?? []).filter((n) => n.type === 'inkTemplate');
  const textLines = extractNodeLines(docJson);
  const hasTemplates = templateNodes.length > 0;
  let pageCount = Math.max(pages.length, templateNodes.length);

  // 각 페이지의 세로 누적 오프셋 계산 (S-Pen 스트로크 Y좌표 매핑용)
  let currentYOffset = 0;
  let lineCursor = 0;

  for (let i = 0; i < pageCount || (!hasTemplates && lineCursor < textLines.length && i < 100); i++) {
    const effectiveTotal = hasTemplates ? pageCount : Math.max(pageCount, i + 1);
    onProgress?.(i + 1, effectiveTotal);
    const pageMeta = pages[i] ?? pages[pages.length - 1];
    const dims = getPageDimensions(pageMeta.size, pageMeta.orientation);
    const renderScale = 1.5; // 태블릿/데스크톱 균형 해상도
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(dims.width * renderScale);
    canvas.height = Math.ceil(dims.height * renderScale);

    try {
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('2D 캔버스 컨텍스트를 생성할 수 없습니다.');

      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.save();
      ctx.scale(renderScale, renderScale);

      // 1) 배경 그리드/줄 스타일
      drawPageGridStyle(ctx, dims.width, dims.height, pageMeta.style);

      // 2) PDF 템플릿 이미지가 있으면 배경에 삽입
      const tpl = templateNodes[i];
      if (tpl?.attrs?.src && typeof tpl.attrs.src === 'string') {
        try {
          const blob = await readAttachmentBlob(session.id, tpl.attrs.src);
          if (blob) {
            const img = await loadImageFromBlob(blob);
            ctx.drawImage(img, 0, 0, dims.width, dims.height);
          }
        } catch {
          /* 템플릿 로드 실패 시 빈 배경으로 진행 */
        }
      } else if (i === 0 || lineCursor < textLines.length) {
        // 3) 일반 에디터 텍스트 및 KaTeX/LaTeX 수식 렌더링
        const marginX = 48;
        let cursorY = 56;
        const maxWidth = dims.width - marginX * 2;
        ctx.fillStyle = '#0f172a';

        while (lineCursor < textLines.length) {
          const item = textLines[lineCursor];
          const wrapped = wrapSegmentRuns(ctx, item.runs, item.size, maxWidth, item.bold);
          const hasBlockMathOrFrac = item.isBlockMath || item.runs.some((r) => r.type === 'math' && /\\frac/.test(r.latex));
          const lineHeight = item.size * (hasBlockMathOrFrac ? 2.1 : 1.5);

          if (cursorY + wrapped.length * lineHeight > dims.height - 48 && cursorY > 56) {
            break;
          }
          if (item.isBlockMath) {
            cursorY += 4;
          }
          for (const wLine of wrapped) {
            let drawX = marginX;
            if (item.isBlockMath) {
              const lineW = measureRunsWidth(ctx, wLine, item.size, item.bold);
              drawX = marginX + Math.max(0, (maxWidth - lineW) / 2);
            }
            drawSegmentRuns(ctx, wLine, drawX, cursorY, item.size, item.bold);
            cursorY += lineHeight;
          }
          cursorY += item.isBlockMath ? 8 : 4;
          lineCursor++;
        }
      }

      // 4) 해당 페이지 영역의 S-Pen 스트로크 합성
      const pageTop = currentYOffset;
      const pageBottom = currentYOffset + dims.height;
      const pageStrokes = strokes.filter((s) =>
        s.points.some((pt) => pt[1] >= pageTop && pt[1] <= pageBottom),
      );
      if (pageStrokes.length > 0) {
        ctx.save();
        ctx.translate(0, -pageTop);
        for (const s of pageStrokes) {
          drawStroke(ctx, s);
        }
        ctx.restore();
      }
      ctx.restore();

      const jpgBytes = await canvasToJpegUint8Array(canvas, 0.88);
      const jpgImage = await pdfDoc.embedJpg(jpgBytes);
      // 72 DPI PDF 포인트 기준 (dims.width는 4px/mm 기준이므로 pt로 변환)
      const ptWidth = (dims.width / 4) * (72 / 25.4);
      const ptHeight = (dims.height / 4) * (72 / 25.4);
      const pdfPage = pdfDoc.addPage([ptWidth, ptHeight]);
      pdfPage.drawImage(jpgImage, { x: 0, y: 0, width: ptWidth, height: ptHeight });
    } finally {
      canvas.width = 0;
      canvas.height = 0;
    }

    currentYOffset += dims.height + 24;
  }

  return pdfDoc.save();
}

/** 활성 노트를 PDF(.pdf) 파일로 원하는 경로에 내보낸다 */
export async function exportNoteToPdf(
  session: NoteSession,
  onProgress?: (page: number, total: number) => void,
): Promise<boolean> {
  const pdfBytes = await buildPdfBytesFromSession(session, onProgress);
  const fileName = `${safeExportFileName(session.record.title)}.pdf`;
  return saveBytesWithPicker(pdfBytes, fileName, 'application/pdf', ['.pdf']);
}

