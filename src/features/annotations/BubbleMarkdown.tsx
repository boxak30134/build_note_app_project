import { Fragment } from 'react';
import { renderLatexHtml } from '../../modules/ai';
import { parseInlineMarkdown, parseMarkdownBlocks, type InlineNode, type MarkdownBlock } from './bubbleMarkdownParser';

interface Props {
  text: string;
  className?: string;
}

function renderInlineNodes(nodes: InlineNode[], keyPrefix: string) {
  return nodes.map((node, idx) => {
    const key = `${keyPrefix}-${idx}`;
    switch (node.type) {
      case 'text':
        return <Fragment key={key}>{node.text}</Fragment>;
      case 'code':
        return (
          <code key={key} className="rounded bg-slate-200/80 px-1 py-0.5 font-mono text-[11px] text-rose-700">
            {node.text}
          </code>
        );
      case 'math':
        return node.displayMode ? (
          <div
            key={key}
            className="my-1 overflow-x-auto"
            dangerouslySetInnerHTML={{ __html: renderLatexHtml(node.latex, true) }}
          />
        ) : (
          <span key={key} dangerouslySetInnerHTML={{ __html: renderLatexHtml(node.latex, false) }} />
        );
      case 'strong':
        return (
          <strong key={key} className="font-semibold text-slate-900">
            {renderInlineNodes(node.children, key)}
          </strong>
        );
      case 'em':
        return (
          <em key={key} className="italic">
            {renderInlineNodes(node.children, key)}
          </em>
        );
      case 'del':
        return (
          <del key={key} className="line-through text-slate-400">
            {renderInlineNodes(node.children, key)}
          </del>
        );
      case 'link':
        return (
          <a
            key={key}
            href={node.href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-indigo-600 underline decoration-indigo-300 hover:text-indigo-800"
          >
            {node.label}
          </a>
        );
    }
  });
}

function renderInlineWithLineBreaks(text: string, keyPrefix: string) {
  const lines = text.split('\n');
  return lines.map((line, lineIdx) => (
    <Fragment key={`${keyPrefix}-l${lineIdx}`}>
      {lineIdx > 0 && <br />}
      {renderInlineNodes(parseInlineMarkdown(line), `${keyPrefix}-l${lineIdx}`)}
    </Fragment>
  ));
}

const HEADING_STYLES: Record<1 | 2 | 3 | 4 | 5 | 6, string> = {
  1: 'text-sm font-bold text-slate-900 mt-1.5 mb-1',
  2: 'text-[13px] font-bold text-slate-900 mt-1.5 mb-0.5',
  3: 'text-xs font-bold text-slate-800 mt-1 mb-0.5',
  4: 'text-xs font-semibold text-slate-800 mt-1',
  5: 'text-[11px] font-semibold text-slate-700 mt-1',
  6: 'text-[11px] font-medium text-slate-600 mt-1',
};

function renderHeading(level: 1 | 2 | 3 | 4 | 5 | 6, text: string, key: string) {
  const Tag = `h${level}` as const;
  return <Tag key={key} className={HEADING_STYLES[level]}>{renderInlineNodes(parseInlineMarkdown(text), key)}</Tag>;
}

function renderBlock(block: MarkdownBlock, idx: number) {
  const key = `b-${idx}`;
  switch (block.kind) {
    case 'heading':
      return renderHeading(block.level, block.text, key);
    case 'paragraph':
      return (
        <p key={key} className="leading-relaxed break-words">
          {renderInlineWithLineBreaks(block.text, key)}
        </p>
      );
    case 'code':
      return (
        <pre key={key} className="overflow-x-auto rounded-lg bg-slate-900 px-2.5 py-2 font-mono text-[11px] leading-snug text-slate-100">
          {block.lang && <div className="mb-1 text-[9px] uppercase tracking-wider text-slate-400">{block.lang}</div>}
          <code>{block.code}</code>
        </pre>
      );
    case 'block-math':
      return (
        <div
          key={key}
          className="my-1 overflow-x-auto py-0.5"
          dangerouslySetInnerHTML={{ __html: renderLatexHtml(block.latex, true) }}
        />
      );
    case 'blockquote':
      return (
        <blockquote key={key} className="border-l-2 border-amber-400 bg-amber-50/60 pl-2.5 py-1 text-slate-700 italic">
          {renderInlineWithLineBreaks(block.lines.join('\n'), key)}
        </blockquote>
      );
    case 'list': {
      const ListTag = block.ordered ? 'ol' : 'ul';
      const listCls = block.ordered
        ? 'list-decimal pl-4 space-y-0.5 leading-relaxed'
        : 'list-disc pl-4 space-y-0.5 leading-relaxed';
      return (
        <ListTag key={key} className={listCls}>
          {block.items.map((item, itemIdx) => (
            <li key={`${key}-i${itemIdx}`} className="break-words">
              {renderInlineNodes(parseInlineMarkdown(item), `${key}-i${itemIdx}`)}
            </li>
          ))}
        </ListTag>
      );
    }
    case 'table':
      return (
        <div key={key} className="overflow-x-auto rounded border border-slate-200">
          <table className="w-full border-collapse text-left text-[11px]">
            <thead className="bg-slate-100 text-slate-700">
              <tr>
                {block.headers.map((h, hIdx) => (
                  <th key={`${key}-h${hIdx}`} className="border-b border-slate-200 px-2 py-1 font-semibold">
                    {renderInlineNodes(parseInlineMarkdown(h), `${key}-h${hIdx}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rIdx) => (
                <tr key={`${key}-r${rIdx}`} className="odd:bg-white even:bg-slate-50/50">
                  {row.map((cell, cIdx) => (
                    <td key={`${key}-r${rIdx}-c${cIdx}`} className="border-t border-slate-100 px-2 py-1">
                      {renderInlineNodes(parseInlineMarkdown(cell), `${key}-r${rIdx}-c${cIdx}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'hr':
      return <hr key={key} className="my-1.5 border-slate-200" />;
  }
}

/**
 * 말풍선 주석 내부용 경량 마크다운 + KaTeX 통합 렌더러.
 */
export function BubbleMarkdown({ text, className = '' }: Props) {
  const blocks = parseMarkdownBlocks(text);
  if (blocks.length === 0) return null;

  return <div className={`space-y-1.5 break-words ${className}`}>{blocks.map((block, idx) => renderBlock(block, idx))}</div>;
}
