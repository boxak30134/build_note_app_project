/** 외부 문서 가져오기 파이프라인: PDF → 새 노트 */
import type { JSONContent } from '@tiptap/core';
import { db, emptyNote, uid, type NoteRecord } from '../../storage/db';
import { createPage, type NotePage } from '../../core/page/pageTypes';
import { saveAttachmentExclusive } from '../../storage/opfs';
import { plainTextOf } from '../../core/doc/blocks';
import { jsonToMarkdown } from '../../editor/extensions';
import { validateFileName } from '../../core/files/validation';
import type { PdfImportResult } from './pdfImport';

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
  const normalizedName = file.name.trim().toLowerCase();
  if (file.type === 'application/pdf' || normalizedName.endsWith('.pdf')) return 'pdf';
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

export interface PdfAttachmentSaver {
  (blob: Blob, fileName: string): Promise<string>;
}

/**
 * PDF 분석 결과를 에디터 문서(Layer 1 inkTemplate 전용)와 검색 색인용 plainText로 변환한다.
 * - 순수 캔버스 템플릿 마운트 원칙: page.template이 존재하는 페이지는 단일 `inkTemplate` 노드만 생성하며,
 *   page.blocks(OCR 텍스트)나 page.images(삼성 노트 손글씨 XObject 등)를 에디터 본문에 중복 삽입하지 않는다.
 * - 추출된 OCR 텍스트는 오직 `plainText` 검색 색인으로만 병합한다.
 */
export async function assemblePdfImportResult(
  result: PdfImportResult,
  fileName: string,
  saveAttachment: PdfAttachmentSaver,
) {
  const content: JSONContent[] = [];
  let media = 0;
  let handwriting = 0;
  let textBlocks = 0;
  const stem = safeTitle(baseName(fileName), 'import');
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
      const rel = await saveAttachment(page.template.blob, `${stem}-p${page.index}.jpg`);
      content.push({
        type: 'inkTemplate',
        attrs: {
          src: rel,
          width: page.template.width,
          height: page.template.height,
          page: page.index,
        },
      });
      handwriting++;
    } else {
      // 템플릿이 없는 예외 폴백 시에만 개별 이미지를 마운트
      for (let k = 0; k < page.images.length; k++) {
        const rel = await saveAttachment(page.images[k], `${stem}-p${page.index}-img${k + 1}.png`);
        content.push({ type: 'image', attrs: { src: rel, alt: '' } });
        media++;
      }
    }

    textBlocks += page.blocks.length;
    for (const b of page.blocks) {
      if (b.content) {
        for (const c of b.content) {
          if (c.text) textLines.push(c.text);
        }
      }
    }
  }

  if (content.length === 0) content.push({ type: 'paragraph' });
  return {
    title: safeTitle(result.title, safeTitle(baseName(fileName), '가져온 PDF')),
    doc: { type: 'doc', content },
    pages,
    pageCount: result.pages.length,
    handwritingPages: handwriting,
    textBlocks,
    media,
    plainText: textLines.join('\n'),
  };
}

async function importPdfFile(file: File, noteId: string, onProgress?: (msg: string) => void) {
  const { importPdf } = await import('./pdfImport');
  const result = await importPdf(await file.arrayBuffer(), (p, t) => onProgress?.(`PDF 변환 중 (${p} / ${t} 페이지)...`));
  return assemblePdfImportResult(result, file.name, (blob, name) => saveAttachmentExclusive(noteId, blob, name));
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
      markdown: jsonToMarkdown(r.doc),
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
