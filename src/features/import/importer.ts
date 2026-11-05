/** 외부 문서 가져오기 파이프라인: PDF → 새 노트 */
import type { JSONContent } from '@tiptap/core';
import { db, emptyNote, uid, type NoteRecord } from '../../storage/db';
import { createPage, type NotePage } from '../../core/page/pageTypes';
import { saveAttachmentExclusive } from '../../storage/opfs';
import { plainTextOf } from '../../core/doc/blocks';
import { validateFileName } from '../../core/files/validation';

export type ImportKind = 'pdf';

export interface ImportSummary {
  note: NoteRecord;
  kind: ImportKind;
  pages?: number;
  handwritingPages?: number;
  textBlocks: number;
  media: number;
}

export const IMPORT_MAX_BYTES = 200 * 1024 * 1024;

export function detectImportKind(file: { name: string; type: string }): ImportKind | null {
  const ext = file.name.split('.').pop()?.toLowerCase();
  if (ext === 'pdf' || file.type === 'application/pdf') return 'pdf';
  return null;
}

/** 파일명 규칙을 만족하는 노트 제목으로 정리 */
export function safeTitle(raw: string | null | undefined, fallback: string): string {
  const cleaned = (raw ?? '')
    .replace(/[\\/<>:"|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 120);
  return cleaned && !validateFileName(cleaned) ? cleaned : fallback;
}

function baseName(name: string) {
  return name.replace(/\.[^.]+$/, '');
}

async function importPdfFile(file: File, noteId: string, onProgress?: (msg: string) => void) {
  const { importPdf } = await import('./pdfImport');
  const result = await importPdf(await file.arrayBuffer(), (p, t) => onProgress?.(`PDF 페이지 분석 중… ${p}/${t}`));
  const content: JSONContent[] = [];
  let media = 0;
  let handwriting = 0;
  let textBlocks = 0;
  const stem = safeTitle(baseName(file.name), 'import');
  const pages: NotePage[] = [];
  const textLines: string[] = [];

  for (const page of result.pages) {
    const isLandscape = page.width > page.height;
    pages.push(
      createPage({
        size: 'A4',
        style: 'plain',
        orientation: isLandscape ? 'landscape' : 'portrait',
      }),
    );

    if (page.template) {
      const rel = await saveAttachmentExclusive(noteId, page.template.blob, `${stem}-p${page.index}.png`);
      content.push({ type: 'inkTemplate', attrs: { src: rel, width: page.template.width, height: page.template.height, page: page.index } });
      handwriting++;
    }

    textBlocks += page.blocks.length;
    for (const b of page.blocks) {
      if (b.content) {
        for (const c of b.content) {
          if (c.text) textLines.push(c.text);
        }
      }
    }

    for (let k = 0; k < page.images.length; k++) {
      const rel = await saveAttachmentExclusive(noteId, page.images[k], `${stem}-p${page.index}-img${k + 1}.png`);
      content.push({ type: 'image', attrs: { src: rel, alt: '' } });
      media++;
    }
  }

  if (content.length === 0) content.push({ type: 'paragraph' });
  return {
    title: safeTitle(result.title, safeTitle(baseName(file.name), '가져온 PDF')),
    doc: { type: 'doc', content },
    pages,
    pageCount: result.pages.length,
    handwritingPages: handwriting,
    textBlocks,
    media,
    plainText: textLines.join('\n'),
  };
}

/** 외부 PDF 문서를 새 노트로 가져온다 */
export async function importExternalFile(file: File, folderId: string | null, onProgress?: (msg: string) => void): Promise<ImportSummary> {
  const kind = detectImportKind(file);
  if (!kind) throw new Error(`지원하지 않는 형식입니다: ${file.name} (PDF 문서만 지원)`);
  if (file.size > IMPORT_MAX_BYTES) throw new Error('가져오기 파일은 200MB 이하만 지원합니다.');
  const noteId = uid('note');
  try {
    const r = await importPdfFile(file, noteId, onProgress);
    const note = emptyNote({
      id: noteId,
      title: r.title,
      folderId,
      content: r.doc,
      plainText: r.plainText || plainTextOf(r.doc),
      pages: r.pages,
    });
    await db.notes.add(note);
    return {
      note,
      kind: 'pdf',
      pages: r.pageCount,
      handwritingPages: r.handwritingPages,
      textBlocks: r.textBlocks,
      media: r.media,
    };
  } catch (e) {
    // 실패 시 잔여 첨부 정리
    const { deleteAttachmentsOf } = await import('../../storage/attachmentsCleanup');
    await deleteAttachmentsOf(noteId);
    throw e;
  }
}
