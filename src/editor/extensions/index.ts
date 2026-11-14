import type { AnyExtension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown, MarkdownManager } from '@tiptap/markdown';
import { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table';
import { InlineMath, BlockMath } from './math';
import { WikiLink } from './wikiLink';
import { Callout } from './callout';
import { BlockEmbed } from './blockEmbed';
import { AnnotationMark } from './annotationMark';
import { FontFamilyMark } from './fontFamily';
import { FontSizeMark } from './fontSize';
import { TextColorMark } from './textColor';
import { BlockId } from './blockId';
import { NoteImage, PdfEmbed, InkTemplate } from './media';
import { RubyText } from './rubyText';
import { TabletMarkdownImeFix } from './tabletMarkdownImeFix';
import { HistoryBridge } from './historyBridge';
import type { CompositeHistoryManager } from '../../core/history/CompositeHistoryManager';

export interface BuildOptions {
  noteId: string;
  getHistory?: () => CompositeHistoryManager | null;
}

/** 스키마 확장 (에디터 / 헤드리스 마크다운 변환 공용) */
export function schemaExtensions(noteId: string): AnyExtension[] {
  return [
    StarterKit.configure({
      undoRedo: false, // 통합 히스토리(CompositeHistoryManager)로 대체
      link: { openOnClick: false, autolink: true },
    }),
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    NoteImage.configure({ noteId }),
    PdfEmbed.configure({ noteId }),
    InkTemplate.configure({ noteId }),
    Callout,
    BlockEmbed.configure({ noteId }),
    InlineMath,
    BlockMath,
    RubyText,
    AnnotationMark,
    FontFamilyMark,
    FontSizeMark,
    TextColorMark,
    BlockId,
    TabletMarkdownImeFix,
  ];
}

export function buildExtensions(opts: BuildOptions): AnyExtension[] {
  return [
    ...schemaExtensions(opts.noteId),
    WikiLink,
    Markdown,
    HistoryBridge.configure({ getHistory: opts.getHistory ?? (() => null), editorKey: opts.noteId }),
  ];
}

let headless: MarkdownManager | null = null;

function manager(): MarkdownManager {
  if (!headless) headless = new MarkdownManager({ extensions: [...schemaExtensions(''), WikiLink] });
  return headless;
}

const FENCED_CODE_RE = /(^|\n)(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\2[ \t]*(?=\n|$)/g;
const INLINE_CODE_RE = /(`+)([^`\n]*?)\1/g;

function transformNonCodeMarkdown(segment: string): string {
  // 1. 이중 이스케이프된 엔티티 복원 (&amp;nbsp;, &amp;lt;, &amp;gt;)
  const unescaped = segment.replace(/&amp;(nbsp|lt|gt);/g, '&$1;');
  // 2. 단일 줄바꿈으로 인접한 단독 &nbsp; 줄을 빈 단락 경계로 분리해 @tiptap/markdown이 빈 단락으로 파싱하도록 보장
  const lines = unescaped.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^[ \t]*&nbsp;[ \t]*$/.test(line)) {
      if (out.length > 0 && out[out.length - 1] !== '') {
        out.push('');
      }
      out.push('&nbsp;');
      const next = lines[i + 1];
      if (next !== undefined && next !== '') {
        out.push('');
      }
    } else {
      out.push(line);
    }
  }
  return out.join('\n');
}

/** 코드 블록/인라인 코드를 보호하면서 마크다운 파싱 전 엔티티를 정규화한다. */
export function preprocessMarkdownEntities(md: string): string {
  const normalized = md.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const fencedParts: string[] = [];
  let lastIdx = 0;

  for (const m of normalized.matchAll(FENCED_CODE_RE)) {
    const start = m.index ?? 0;
    const prefixEnd = start + (m[1]?.length ?? 0);
    if (prefixEnd > lastIdx) {
      fencedParts.push(transformInlineSafeSegment(normalized.slice(lastIdx, prefixEnd)));
    }
    fencedParts.push(m[0].slice(m[1]?.length ?? 0));
    lastIdx = start + m[0].length;
  }
  if (lastIdx < normalized.length) {
    fencedParts.push(transformInlineSafeSegment(normalized.slice(lastIdx)));
  }
  return fencedParts.join('');
}

function transformInlineSafeSegment(chunk: string): string {
  const parts: string[] = [];
  let lastIdx = 0;
  for (const m of chunk.matchAll(INLINE_CODE_RE)) {
    const start = m.index ?? 0;
    if (start > lastIdx) {
      parts.push(transformNonCodeMarkdown(chunk.slice(lastIdx, start)));
    }
    parts.push(m[0]);
    lastIdx = start + m[0].length;
  }
  if (lastIdx < chunk.length) {
    parts.push(transformNonCodeMarkdown(chunk.slice(lastIdx)));
  }
  return parts.join('');
}

function decodeTextNodeEntities(text: string): string {
  return text
    .replace(/&amp;(nbsp|lt|gt);/g, '&$1;')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/^[ \t]*&nbsp;[ \t]*\n/gm, '')
    .replace(/\n[ \t]*&nbsp;[ \t]*$/g, '')
    .replace(/&nbsp;/g, ' ');
}

function isStandaloneNbspText(text: string): boolean {
  return /^[\s\u00A0]*(?:&(?:amp;)?nbsp;|[\r\n]+)+[\s\u00A0]*$/.test(text) && /&(?:amp;)?nbsp;/.test(text);
}

function hasCodeMark(node: Record<string, unknown>): boolean {
  const marks = Array.isArray(node.marks) ? node.marks : [];
  return marks.some((m) => m && typeof m === 'object' && (m as { type?: unknown }).type === 'code');
}

/**
 * TipTap JSON AST에서 codeBlock 및 code 마크를 제외한 텍스트 노드·콜아웃 제목의
 * 잔존 HTML 엔티티(&nbsp;, &lt;, &gt;, 이중 이스케이프)를 안전하게 디코딩/정리한다.
 */
export function sanitizeMarkdownDocEntities(doc: unknown): unknown {
  if (!doc || typeof doc !== 'object') return doc;
  const node = doc as Record<string, unknown>;
  const nodeType = node.type;

  if (nodeType === 'codeBlock') {
    return doc;
  }

  if (nodeType === 'text') {
    if (hasCodeMark(node)) {
      return doc;
    }
    if (typeof node.text !== 'string') return doc;
    const cleaned = decodeTextNodeEntities(node.text);
    if (cleaned === node.text) return doc;
    return { ...node, text: cleaned };
  }

  let nextAttrs = node.attrs;
  if (nodeType === 'callout' && node.attrs && typeof node.attrs === 'object') {
    const attrsObj = node.attrs as Record<string, unknown>;
    if (typeof attrsObj.title === 'string') {
      const cleanedTitle = decodeTextNodeEntities(attrsObj.title).trim();
      if (cleanedTitle !== attrsObj.title) {
        nextAttrs = { ...attrsObj, title: cleanedTitle };
      }
    }
  }

  if (!Array.isArray(node.content)) {
    return nextAttrs !== node.attrs ? { ...node, attrs: nextAttrs } : doc;
  }

  // 단락 전체가 단독 &nbsp;(또는 줄바꿈 포함)로만 이루어진 경우 빈 단락으로 정규화 (code 마크 제외)
  if (nodeType === 'paragraph' && node.content.length > 0) {
    const allNonCodeText = node.content.every(
      (c) =>
        c &&
        typeof c === 'object' &&
        (c as { type?: unknown }).type === 'text' &&
        typeof (c as { text?: unknown }).text === 'string' &&
        !hasCodeMark(c as Record<string, unknown>),
    );
    if (allNonCodeText) {
      const combined = node.content.map((c) => (c as { text: string }).text).join('');
      if (isStandaloneNbspText(combined)) {
        const { content: _removed, ...rest } = node;
        return rest;
      }
    }
  }

  const nextContent: unknown[] = [];
  let changed = nextAttrs !== node.attrs;
  for (const child of node.content) {
    const sanitized = sanitizeMarkdownDocEntities(child);
    if (sanitized !== child) changed = true;
    if (
      sanitized &&
      typeof sanitized === 'object' &&
      (sanitized as { type?: unknown }).type === 'text' &&
      (sanitized as { text?: unknown }).text === ''
    ) {
      changed = true;
      continue;
    }
    nextContent.push(sanitized);
  }

  if (!changed) return doc;
  if (nextContent.length === 0 && nodeType === 'paragraph') {
    const { content: _removed, ...rest } = node;
    return {
      ...rest,
      ...(nextAttrs !== node.attrs ? { attrs: nextAttrs } : {}),
    };
  }
  return {
    ...node,
    ...(nextAttrs !== node.attrs ? { attrs: nextAttrs } : {}),
    content: nextContent,
  };
}

/** 에디터 인스턴스 없이 마크다운 → TipTap JSON */
export function markdownToJson(md: string): unknown {
  const preprocessed = preprocessMarkdownEntities(md);
  return sanitizeMarkdownDocEntities(manager().parse(preprocessed));
}

export function jsonToMarkdown(json: unknown): string {
  return manager().serialize(json as never);
}
