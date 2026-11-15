export type BubbleBlock =
  | { kind: 'memo'; content: string }
  | { kind: 'question'; index: number; content: string }
  | { kind: 'answer'; index: number; providerLabel: string; content: string };

export type MarkdownBlock =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'code'; lang: string; code: string }
  | { kind: 'block-math'; latex: string }
  | { kind: 'blockquote'; lines: string[] }
  | { kind: 'list'; ordered: boolean; items: string[]; checks?: Array<boolean | null> }
  | { kind: 'table'; headers: string[]; rows: string[][] }
  | { kind: 'hr' };

export type InlineNode =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'math'; latex: string; displayMode: boolean }
  | { type: 'strong'; children: InlineNode[] }
  | { type: 'em'; children: InlineNode[] }
  | { type: 'del'; children: InlineNode[] }
  | { type: 'link'; label: string; href: string }
  | { type: 'break' };

const QUESTION_LINE_RE = /^\*\*Q(?:\d+)?\.\*\*\s*(.*)$/;
const ANSWER_PROVIDER_LINE_RE = /^\*\*A\(([^)]+)\)\.\*\*\s*(.*)$/;
const ANSWER_PLAIN_LINE_RE = /^\*\*A\.\*\*\s*(.*)$/;
const HR_LINE_RE = /^\s*(?:-{3,}|_{3,}|\*{3,})\s*$/;
const HEADING_RE = /^(#{1,6})\s+(.+)$/;
const TASK_ITEM_RE = /^\s*[-*+]\s+\[([ xX])\]\s+(.+)$/;
const UL_ITEM_RE = /^\s*[-*+]\s+(.+)$/;
const OL_ITEM_RE = /^\s*\d+\.\s+(.+)$/;
const TABLE_SEP_RE = /^\s*\|?(?:\s*:?-{2,}:?\s*\|)+(?:\s*:?-{2,}:?\s*)?\|?\s*$/;
const FENCE_START_RE = /^(`{3,}|~{3,})(.*)$/;

function stripTrailingSeparator(text: string): string {
  const lines = text.split('\n');
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }
  if (lines.length > 0 && HR_LINE_RE.test(lines[lines.length - 1])) {
    lines.pop();
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
      lines.pop();
    }
  }
  return lines.join('\n').trim();
}

/**
 * 말풍선 본문(`**Q.** ... / **A(Provider).** ...`)을 질문·답변·메모 블록 배열로 파싱한다.
 * 기존 저장 노트와 새 구분선(`---`) 포맷 모두 호환된다.
 */
export function parseBubbleBlocks(body: string): BubbleBlock[] {
  if (!body) return [];

  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const blocks: BubbleBlock[] = [];
  let current: BubbleBlock | null = null;
  let questionCount = 0;
  let inFence = false;

  const pushCurrent = (beforeQuestion: boolean) => {
    if (!current) return;
    const cleaned = beforeQuestion ? stripTrailingSeparator(current.content) : current.content.trim();
    if (current.kind === 'memo') {
      if (cleaned) blocks.push({ ...current, content: cleaned });
    } else {
      blocks.push({ ...current, content: cleaned });
    }
    current = null;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!inFence) {
      const qMatch = QUESTION_LINE_RE.exec(trimmed);
      if (qMatch) {
        pushCurrent(true);
        questionCount += 1;
        current = { kind: 'question', index: questionCount, content: qMatch[1] };
        continue;
      }

      const aProvMatch = ANSWER_PROVIDER_LINE_RE.exec(trimmed);
      if (aProvMatch) {
        pushCurrent(false);
        current = {
          kind: 'answer',
          index: Math.max(1, questionCount),
          providerLabel: aProvMatch[1].trim() || 'AI',
          content: aProvMatch[2],
        };
        continue;
      }

      const aPlainMatch = ANSWER_PLAIN_LINE_RE.exec(trimmed);
      if (aPlainMatch) {
        pushCurrent(false);
        current = {
          kind: 'answer',
          index: Math.max(1, questionCount),
          providerLabel: 'AI',
          content: aPlainMatch[1],
        };
        continue;
      }
    }

    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inFence = !inFence;
    }

    if (!current) {
      if (trimmed === '') continue;
      current = { kind: 'memo', content: line };
    } else {
      current.content = current.content ? `${current.content}\n${line}` : line;
    }
  }

  pushCurrent(false);
  return blocks;
}

function splitTableCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((cell) => cell.trim());
}

function isBlockStarter(lines: string[], idx: number): boolean {
  const line = lines[idx];
  const trimmed = line.trim();
  if (!trimmed) return true;
  if (trimmed.startsWith('```') || trimmed.startsWith('~~~') || trimmed.startsWith('$$')) return true;
  if (HR_LINE_RE.test(trimmed) || HEADING_RE.test(trimmed)) return true;
  if (/^\s*>/.test(line)) return true;
  if (UL_ITEM_RE.test(line) || OL_ITEM_RE.test(line)) return true;
  if (line.includes('|') && idx + 1 < lines.length && TABLE_SEP_RE.test(lines[idx + 1])) return true;
  return false;
}

/**
 * 마크다운 문자열을 블록 단위 AST로 파싱한다.
 * 스트리밍 도중 닫히지 않은 코드 블록이나 수식 블록도 예외 없이 처리한다.
 */
export function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
  if (!markdown.trim()) return [];
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      i += 1;
      continue;
    }

    // Fenced code block (``` or ~~~)
    const fenceMatch = FENCE_START_RE.exec(trimmed);
    if (fenceMatch) {
      const fenceChar = fenceMatch[1][0];
      const fenceLen = fenceMatch[1].length;
      const lang = fenceMatch[2].trim();
      const closeRe = new RegExp(`^${fenceChar}{${fenceLen},}\\s*$`);
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !closeRe.test(lines[i].trim())) {
        codeLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length && closeRe.test(lines[i].trim())) {
        i += 1;
      }
      blocks.push({ kind: 'code', lang, code: codeLines.join('\n') });
      continue;
    }

    // Multi-line or standalone block math $$...$$
    if (trimmed.startsWith('$$')) {
      if (trimmed.length > 4 && trimmed.endsWith('$$')) {
        blocks.push({ kind: 'block-math', latex: trimmed.slice(2, -2).trim() });
        i += 1;
        continue;
      }
      const mathLines: string[] = [];
      const firstRest = trimmed.slice(2).trim();
      if (firstRest) mathLines.push(firstRest);
      i += 1;
      while (i < lines.length && !lines[i].trim().endsWith('$$')) {
        mathLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) {
        const endLine = lines[i].trim();
        const beforeClose = endLine.slice(0, -2).trim();
        if (beforeClose) mathLines.push(beforeClose);
        i += 1;
      }
      blocks.push({ kind: 'block-math', latex: mathLines.join('\n').trim() });
      continue;
    }

    // Horizontal rule
    if (HR_LINE_RE.test(trimmed)) {
      blocks.push({ kind: 'hr' });
      i += 1;
      continue;
    }

    // Heading
    const headingMatch = HEADING_RE.exec(trimmed);
    if (headingMatch) {
      const level = Math.min(6, Math.max(1, headingMatch[1].length)) as 1 | 2 | 3 | 4 | 5 | 6;
      blocks.push({ kind: 'heading', level, text: headingMatch[2].trim() });
      i += 1;
      continue;
    }

    // Markdown table
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])) {
      const headers = splitTableCells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        rows.push(splitTableCells(lines[i]));
        i += 1;
      }
      blocks.push({ kind: 'table', headers, rows });
      continue;
    }

    // Blockquote
    if (/^\s*>/.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }
      blocks.push({ kind: 'blockquote', lines: quoteLines });
      continue;
    }

    // Unordered, task-checkbox, or ordered list
    const isUl = UL_ITEM_RE.test(line);
    const isOl = OL_ITEM_RE.test(line);
    if (isUl || isOl) {
      const ordered = isOl;
      const itemRe = ordered ? OL_ITEM_RE : UL_ITEM_RE;
      const items: string[] = [];
      const checks: Array<boolean | null> = [];
      let hasTask = false;
      while (i < lines.length) {
        if (!ordered) {
          const taskMatch = TASK_ITEM_RE.exec(lines[i]);
          if (taskMatch) {
            hasTask = true;
            checks.push(taskMatch[1].toLowerCase() === 'x');
            items.push(taskMatch[2].trim());
            i += 1;
            continue;
          }
        }
        const match = itemRe.exec(lines[i]);
        if (match) {
          checks.push(null);
          items.push(match[1].trim());
          i += 1;
          continue;
        }
        // Indented continuation line inside same list item
        if (/^\s{2,}\S/.test(lines[i]) && items.length > 0) {
          items[items.length - 1] += ` ${lines[i].trim()}`;
          i += 1;
          continue;
        }
        break;
      }
      blocks.push(hasTask ? { kind: 'list', ordered, items, checks } : { kind: 'list', ordered, items });
      continue;
    }

    // Paragraph
    const paraLines: string[] = [line];
    i += 1;
    while (i < lines.length && !isBlockStarter(lines, i)) {
      paraLines.push(lines[i]);
      i += 1;
    }
    blocks.push({ kind: 'paragraph', text: paraLines.join('\n') });
  }

  return blocks;
}

function isSafeHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url.trim());
}

/**
 * 한 단락/항목 내부의 인라인 마크다운(`**`, `*`, `~~`, `` ` ``, link)과 LaTeX 수식(`$...$`, `$$...$$`)을 파싱한다.
 */
export function parseInlineMarkdown(input: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  let pos = 0;

  const pushText = (chunk: string) => {
    if (!chunk) return;
    const prev = nodes[nodes.length - 1];
    if (prev && prev.type === 'text') {
      prev.text += chunk;
    } else {
      nodes.push({ type: 'text', text: chunk });
    }
  };

  while (pos < input.length) {
    const ch = input[pos];

    // Escaped character
    if (ch === '\\' && pos + 1 < input.length && /[$*`~\[\]\\_]/.test(input[pos + 1])) {
      pushText(input[pos + 1]);
      pos += 2;
      continue;
    }

    // Inline display math $$...$$
    if (input.startsWith('$$', pos)) {
      const closeIdx = input.indexOf('$$', pos + 2);
      if (closeIdx !== -1 && closeIdx > pos + 2) {
        nodes.push({ type: 'math', latex: input.slice(pos + 2, closeIdx), displayMode: true });
        pos = closeIdx + 2;
        continue;
      }
    }

    // Inline math $...$
    if (ch === '$' && input[pos + 1] !== '$') {
      const closeIdx = input.indexOf('$', pos + 1);
      if (closeIdx !== -1 && closeIdx > pos + 1 && !input.slice(pos + 1, closeIdx).includes('\n')) {
        nodes.push({ type: 'math', latex: input.slice(pos + 1, closeIdx), displayMode: false });
        pos = closeIdx + 1;
        continue;
      }
    }

    // Inline code `...`
    if (ch === '`') {
      const closeIdx = input.indexOf('`', pos + 1);
      if (closeIdx !== -1 && closeIdx > pos + 1 && !input.slice(pos + 1, closeIdx).includes('\n')) {
        nodes.push({ type: 'code', text: input.slice(pos + 1, closeIdx) });
        pos = closeIdx + 1;
        continue;
      }
    }

    // Link [label](url)
    if (ch === '[') {
      const rest = input.slice(pos);
      const linkMatch = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest);
      if (linkMatch) {
        const [, label, href] = linkMatch;
        if (isSafeHttpUrl(href)) {
          nodes.push({ type: 'link', label, href });
        } else {
          pushText(linkMatch[0]);
        }
        pos += linkMatch[0].length;
        continue;
      }
    }

    // Bold + Italic ***...***
    if (input.startsWith('***', pos)) {
      const closeIdx = input.indexOf('***', pos + 3);
      if (closeIdx !== -1 && closeIdx > pos + 3) {
        nodes.push({
          type: 'strong',
          children: [{ type: 'em', children: parseInlineMarkdown(input.slice(pos + 3, closeIdx)) }],
        });
        pos = closeIdx + 3;
        continue;
      }
    }

    // Bold **...**
    if (input.startsWith('**', pos)) {
      const closeIdx = input.indexOf('**', pos + 2);
      if (closeIdx !== -1 && closeIdx > pos + 2) {
        nodes.push({ type: 'strong', children: parseInlineMarkdown(input.slice(pos + 2, closeIdx)) });
        pos = closeIdx + 2;
        continue;
      }
    }

    // Bold __...__
    if (input.startsWith('__', pos)) {
      const closeIdx = input.indexOf('__', pos + 2);
      if (closeIdx !== -1 && closeIdx > pos + 2) {
        nodes.push({ type: 'strong', children: parseInlineMarkdown(input.slice(pos + 2, closeIdx)) });
        pos = closeIdx + 2;
        continue;
      }
    }

    // Safe inline line break <br> / <br />
    if (ch === '<') {
      const brMatch = /^<br\s*\/?>/i.exec(input.slice(pos));
      if (brMatch) {
        nodes.push({ type: 'break' });
        pos += brMatch[0].length;
        continue;
      }
    }

    // Strikethrough ~~...~~
    if (input.startsWith('~~', pos)) {
      const closeIdx = input.indexOf('~~', pos + 2);
      if (closeIdx !== -1 && closeIdx > pos + 2) {
        nodes.push({ type: 'del', children: parseInlineMarkdown(input.slice(pos + 2, closeIdx)) });
        pos = closeIdx + 2;
        continue;
      }
    }

    // Italic *...*
    if (ch === '*' && input[pos + 1] !== '*' && input[pos + 1] !== ' ') {
      const closeIdx = input.indexOf('*', pos + 1);
      if (closeIdx !== -1 && closeIdx > pos + 1 && input[closeIdx - 1] !== ' ' && !input.slice(pos + 1, closeIdx).includes('\n')) {
        nodes.push({ type: 'em', children: parseInlineMarkdown(input.slice(pos + 1, closeIdx)) });
        pos = closeIdx + 1;
        continue;
      }
    }

    // Italic _..._ (word-boundary guarded so snake_case_identifiers stay intact)
    if (ch === '_' && (pos === 0 || !/\w/.test(input[pos - 1])) && input[pos + 1] !== '_' && input[pos + 1] !== ' ') {
      const rest = input.slice(pos);
      const emMatch = /^_([^_\n]+)_(?!\w)/.exec(rest);
      if (emMatch && !emMatch[1].endsWith(' ')) {
        nodes.push({ type: 'em', children: parseInlineMarkdown(emMatch[1]) });
        pos += emMatch[0].length;
        continue;
      }
    }

    pushText(ch);
    pos += 1;
  }

  return nodes;
}
