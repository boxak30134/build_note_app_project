import type { AnyExtension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown, MarkdownManager } from '@tiptap/markdown';
import { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table';
import { InlineMath, BlockMath } from './math';
import { WikiLink } from './wikiLink';
import { AnnotationMark } from './annotationMark';
import { FontFamilyMark } from './fontFamily';
import { BlockId } from './blockId';
import { NoteImage, PdfEmbed, InkTemplate } from './media';
import { RubyText } from './rubyText';
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
    InlineMath,
    BlockMath,
    RubyText,
    AnnotationMark,
    FontFamilyMark,
    BlockId,
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

/** 에디터 인스턴스 없이 마크다운 → TipTap JSON */
export function markdownToJson(md: string): unknown {
  return manager().parse(md);
}

export function jsonToMarkdown(json: unknown): string {
  return manager().serialize(json as never);
}
