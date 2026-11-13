// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { assemblePdfImportResult, detectImportKind } from '../src/features/import/importer';
import type { PdfImportResult } from '../src/features/import/pdfImport';

describe('태블릿 PDF 가져오기 보완 (REQ_tablet_pdf_import)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('1. 안드로이드 파일 피커처럼 file.type이 빈 문자열("")이어도 .pdf 확장자로 PDF를 정상 인식한다', () => {
    expect(detectImportKind({ name: 'lecture.pdf', type: '' })).toBe('pdf');
    expect(detectImportKind({ name: 'LECTURE_NOTE.PDF ', type: '' })).toBe('pdf');
    expect(detectImportKind({ name: 'document', type: 'application/pdf' })).toBe('pdf');
    expect(detectImportKind({ name: 'readme.txt', type: '' })).toBeNull();
  });

  it('2. PDF 페이지 템플릿을 경량 JPEG(.jpg) 확장자로 저장한다', async () => {
    const fakeBlob = new Blob(['jpeg-bytes'], { type: 'image/jpeg' });
    const mockResult: PdfImportResult = {
      title: '태블릿 강의안',
      pages: [
        {
          index: 1,
          width: 595,
          height: 842,
          blocks: [],
          images: [],
          template: { blob: fakeBlob, width: 595, height: 842 },
          stats: { textCount: 0, pathCount: 0, imageCount: 0, hasHandwriting: false },
        },
      ],
    };

    const savedNames: string[] = [];
    const assembled = await assemblePdfImportResult(mockResult, 'sample.pdf', async (_blob, fileName) => {
      savedNames.push(fileName);
      return `attachments/${fileName}`;
    });

    expect(savedNames).toEqual(['sample-p1.jpg']);
    expect(assembled.handwritingPages).toBe(1);
    expect(assembled.doc.content?.[0]).toMatchObject({
      type: 'inkTemplate',
      attrs: { src: 'attachments/sample-p1.jpg', page: 1 },
    });
  });
});

