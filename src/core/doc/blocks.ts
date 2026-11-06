import type { JSONContent } from '@tiptap/core';

export interface BlockInfo {
  blockId: string | null;
  type: string;
  text: string;
}

function textOf(node: JSONContent): string {
  if (node.type === 'text') return node.text ?? '';
  if (node.type === 'inlineMath' || node.type === 'blockMath') return `$${node.attrs?.latex ?? ''}$`;
  if (node.type === 'wikiLink') return node.attrs?.label ?? '';
  if (node.type === 'rubyText') return node.attrs?.base ?? '';
  if (node.type === 'hardBreak') return '\n';
  return (node.content ?? []).map(textOf).join('');
}

/** TipTap JSON 에서 단락/제목 블록 목록 추출 (검색·위키링크용) */
export function extractBlocks(doc: unknown): BlockInfo[] {
  const out: BlockInfo[] = [];
  const walk = (n: JSONContent) => {
    if (n.type === 'paragraph' || n.type === 'heading') {
      const text = textOf(n).trim();
      if (text) out.push({ blockId: (n.attrs?.blockId as string) ?? null, type: n.type, text });
      return;
    }
    n.content?.forEach(walk);
  };
  if (doc && typeof doc === 'object') walk(doc as JSONContent);
  return out;
}

export function plainTextOf(doc: unknown): string {
  return extractBlocks(doc)
    .map((b) => b.text)
    .join('\n');
}

export function snippet(text: string, max = 300): string {
  return text.length > max ? text.slice(0, max) + '…' : text;
}
