/** 외부 문서 가져오기 파이프라인: 삼성 노트 PDF / .sdocx → 새 노트 */
import type { JSONContent } from '@tiptap/core';
import { db, emptyNote, uid, type NoteRecord } from '../../storage/db';
import { saveAttachmentExclusive } from '../../storage/opfs';
import { markdownToJson } from '../../editor/extensions';
import { plainTextOf } from '../../core/doc/blocks';
import { validateFileName } from '../../core/files/validation';

export type ImportKind = 'pdf' | 'sdocx';

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
  if (ext === 'sdocx') return 'sdocx';
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
  for (const page of result.pages) {
    if (result.pages.length > 1) content.push({ type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: `📄 ${page.index}쪽` }] });
    if (page.template) {
      const rel = await saveAttachmentExclusive(noteId, page.template.blob, `${stem}-p${page.index}-handwriting.png`);
      content.push({ type: 'inkTemplate', attrs: { src: rel, width: page.template.width, height: page.template.height, page: page.index } });
      handwriting++;
    }
    content.push(...page.blocks);
    textBlocks += page.blocks.length;
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
    pages: result.pages.length,
    handwritingPages: handwriting,
    textBlocks,
    media,
  };
}

async function importSdocxFile(file: File, noteId: string, onProgress?: (msg: string) => void) {
  const { parseSdocx, sdocxToMarkdown } = await import('./sdocx');
  onProgress?.('삼성 노트 패키지 압축 해제 중…');
  const parsed = await parseSdocx(await file.arrayBuffer());
  if (parsed.paragraphs.length === 0 && parsed.media.length === 0) {
    throw new Error('삼성 노트 파일에서 텍스트(document.xml / text.json)나 미디어를 찾지 못했습니다.');
  }
  // 미디어 리소스 → attachments/ 자동 복사 후 인라인 링크
  const links: string[] = [];
  for (const m of parsed.media) {
    links.push(await saveAttachmentExclusive(noteId, new Blob([m.data as BlobPart], { type: m.mime }), m.name));
  }
  const markdown = sdocxToMarkdown(parsed, links);
  return {
    title: safeTitle(parsed.title, safeTitle(baseName(file.name), '가져온 삼성 노트')),
    doc: markdownToJson(markdown) as JSONContent,
    textBlocks: parsed.paragraphs.length,
    media: links.length,
  };
}

/** 외부 문서를 새 노트로 가져온다 */
export async function importExternalFile(file: File, folderId: string | null, onProgress?: (msg: string) => void): Promise<ImportSummary> {
  const kind = detectImportKind(file);
  if (!kind) throw new Error(`지원하지 않는 형식입니다: ${file.name} (삼성 노트 PDF 내보내기, .sdocx 지원)`);
  if (file.size > IMPORT_MAX_BYTES) throw new Error('가져오기 파일은 200MB 이하만 지원합니다.');
  const noteId = uid('note');
  try {
    const r = kind === 'pdf' ? await importPdfFile(file, noteId, onProgress) : await importSdocxFile(file, noteId, onProgress);
    const note = emptyNote({ id: noteId, title: r.title, folderId, content: r.doc, plainText: plainTextOf(r.doc) });
    await db.notes.add(note);
    return {
      note,
      kind,
      pages: 'pages' in r ? r.pages : undefined,
      handwritingPages: 'handwritingPages' in r ? r.handwritingPages : undefined,
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
