// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { assemblePdfImportResult, detectImportKind, safeTitle, IMPORT_MAX_BYTES } from './importer';
import {
  computePdfPageLayout,
  createPage,
  extractInkTemplateDimensions,
  insertBlankInkTemplateBelow,
  PDF_PAGE_GAP_PX,
} from '../../core/page/pageTypes';
import { NoteSession } from '../../session/NoteSession';
import { emptyNote } from '../../storage/db';
import type { PdfImportResult } from './pdfImport';

describe('PDF 가져오기 유틸 및 형식 감지', () => {
  it('PDF 파일만 감지하고 .sdocx 는 지원하지 않는다', () => {
    expect(detectImportKind({ name: 'document.pdf', type: 'application/pdf' })).toBe('pdf');
    expect(detectImportKind({ name: 'lecture.PDF', type: '' })).toBe('pdf');
    expect(detectImportKind({ name: 'note.sdocx', type: '' })).toBeNull();
    expect(detectImportKind({ name: 'image.png', type: 'image/png' })).toBeNull();
  });

  it('안전한 노트 제목으로 정리', () => {
    expect(safeTitle('수학 / 1. 군의 정의: (기초)*?', 'fallback')).toBe('수학 1. 군의 정의 (기초)');
    expect(safeTitle('', '기본제목')).toBe('기본제목');
    expect(safeTitle(null, '기본제목')).toBe('기본제목');
  });

  it('가져오기 최대 바이트는 200MB', () => {
    expect(IMPORT_MAX_BYTES).toBe(200 * 1024 * 1024);
  });
});

describe('BUGFIX_PDF_IMPORT_DUPLICATION: 삼성 노트 PDF 손글씨 중복 렌더링 및 빈 공간 방지', () => {
  it('페이지 템플릿이 존재하면 XObject 손글씨 이미지(page.images)나 OCR 단락(page.blocks)을 본문에 중복 삽입하지 않고 단일 inkTemplate만 생성한다', async () => {
    const savedFiles: string[] = [];
    const mockResult: PdfImportResult = {
      title: '삼성노트_심폐소생술_필기',
      pages: [
        {
          index: 1,
          width: 595,
          height: 842,
          blocks: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: '전기충격할 때 붙어있으면 안된다. 119가 올 때까지 반복.' }],
            },
          ],
          // 삼성 노트 PDF 내부의 손글씨 비트맵 XObject가 포함되어 있더라도 템플릿과 중복 삽입되면 안 됨
          images: [new Blob(['duplicate-handwriting-bitmap'], { type: 'image/png' })],
          template: {
            blob: new Blob(['rendered-full-page-1'], { type: 'image/png' }),
            width: 595,
            height: 842,
          },
          stats: { textOps: 2, pathOps: 48, imageOps: 1, imageIds: ['img_handwriting_1'] },
        },
        {
          index: 2,
          width: 595,
          height: 842,
          blocks: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: '2페이지 필기 내용' }],
            },
          ],
          images: [new Blob(['duplicate-handwriting-bitmap-2'], { type: 'image/png' })],
          template: {
            blob: new Blob(['rendered-full-page-2'], { type: 'image/png' }),
            width: 595,
            height: 842,
          },
          stats: { textOps: 1, pathOps: 35, imageOps: 1, imageIds: ['img_handwriting_2'] },
        },
      ],
    };

    const assembled = await assemblePdfImportResult(mockResult, '삼성노트_필기.pdf', async (_blob, fileName) => {
      savedFiles.push(fileName);
      return `attachments/${fileName}`;
    });

    // 1. 에디터 본문(doc.content)에는 페이지당 정확히 1개의 inkTemplate만 존재해야 함 (image 노드 0개, paragraph 노드 0개)
    expect(assembled.doc.content).toHaveLength(2);
    expect(assembled.doc.content?.every((n) => n.type === 'inkTemplate')).toBe(true);
    expect(assembled.doc.content?.some((n) => n.type === 'image')).toBe(false);
    expect(assembled.media).toBe(0);
    expect(assembled.handwritingPages).toBe(2);
    expect(savedFiles).toEqual(['삼성노트_필기-p1.png', '삼성노트_필기-p2.png']);

    // 2. 추출된 OCR 텍스트는 화면 이중 렌더링 없이 검색 색인용 plainText에만 보존되어야 함
    expect(assembled.plainText).toContain('전기충격할 때 붙어있으면 안된다.');
    expect(assembled.plainText).toContain('2페이지 필기 내용');
  });

  it('computePdfPageLayout: 페이지별 yOffset 공식(sum(H_i + G))과 총 높이가 하단 유령 빈 공간 없이 1:1로 계산된다', () => {
    const containerWidth = 840;
    // 1페이지 단독 PDF: 하단 여백(gap)이 추가되지 않아야 함
    const single = computePdfPageLayout([{ width: 595, height: 842 }], containerWidth);
    const expectedH1 = Math.round(840 * (842 / 595)); // 1189px
    expect(single.pageHeights).toEqual([expectedH1]);
    expect(single.yOffsets).toEqual([0]);
    expect(single.totalHeight).toBe(expectedH1);

    // 2페이지 혼합(1쪽 세로 A4 595x842, 2쪽 가로 A4 842x595)
    const multi = computePdfPageLayout(
      [
        { width: 595, height: 842 },
        { width: 842, height: 595 },
      ],
      containerWidth,
      PDF_PAGE_GAP_PX,
    );
    const expectedH2 = Math.round(840 * (595 / 842)); // 594px
    expect(multi.pageHeights).toEqual([expectedH1, expectedH2]);
    expect(multi.yOffsets).toEqual([0, expectedH1 + PDF_PAGE_GAP_PX]);
    expect(multi.totalHeight).toBe(expectedH1 + PDF_PAGE_GAP_PX + expectedH2);

    // extractInkTemplateDimensions: TipTap doc JSON에서 inkTemplate 치수를 정확히 추출
    const dims = extractInkTemplateDimensions({
      type: 'doc',
      content: [
        { type: 'inkTemplate', attrs: { src: 'a.png', width: 595, height: 842, page: 1 } },
        { type: 'inkTemplate', attrs: { src: 'b.png', width: 842, height: 595, page: 2 } },
      ],
    });
    expect(dims).toEqual([
      { width: 595, height: 842 },
      { width: 842, height: 595 },
    ]);
  });

  it('BUGFIX_PDF_ADD_PAGE: PDF 문서에서 addPageBelow 호출 시 에디터에 빈 inkTemplate 노드가 삽입되고 쪽수와 전체 높이가 즉시 갱신된다', () => {
    const initialDoc = {
      type: 'doc',
      content: [
        { type: 'inkTemplate', attrs: { src: 'attachments/p1.png', width: 595, height: 842, page: 1, style: 'plain' } },
        { type: 'inkTemplate', attrs: { src: 'attachments/p2.png', width: 595, height: 842, page: 2, style: 'plain' } },
      ],
    };

    // 1. 순수 JSON 변환 함수 검증
    const pureInserted = insertBlankInkTemplateBelow(
      initialDoc,
      0,
      createPage({ size: 'A4', style: 'grid', orientation: 'portrait' }),
    );
    expect(pureInserted.content).toHaveLength(3);
    expect(pureInserted.content?.[1]).toMatchObject({
      type: 'inkTemplate',
      attrs: { src: '', width: 595, height: 842, page: 2, style: 'grid' },
    });
    expect(pureInserted.content?.[2]?.attrs?.page).toBe(3);

    // 2. 실제 NoteSession.addPageBelow 연동 및 DOM/높이 확장 검증
    const note = emptyNote({
      id: 'pdf-add-page-test',
      title: 'PDF 페이지 추가 테스트',
      content: initialDoc,
      pages: [
        createPage({ size: 'A4', style: 'plain', orientation: 'portrait' }),
        createPage({ size: 'A4', style: 'plain', orientation: 'portrait' }),
      ],
    });
    const session = new NoteSession(note);
    try {
      const beforeLayout = computePdfPageLayout(
        extractInkTemplateDimensions(session.editor.getJSON(), session.ui.pages),
        840,
      );
      expect(beforeLayout.pageHeights).toHaveLength(2);

      // 1페이지(index 0) 바로 아래에 새 페이지 추가
      session.addPageBelow(0, { style: 'lined' });

      expect(session.ui.pages).toHaveLength(3);
      expect(session.ui.currentPageIndex).toBe(1);

      const afterJson = session.editor.getJSON();
      const templates = (afterJson.content ?? []).filter((n) => n.type === 'inkTemplate');
      expect(templates).toHaveLength(3);
      expect(templates[0].attrs).toMatchObject({ src: 'attachments/p1.png', page: 1 });
      expect(templates[1].attrs).toMatchObject({ src: '', width: 595, height: 842, page: 2, style: 'lined' });
      expect(templates[2].attrs).toMatchObject({ src: 'attachments/p2.png', page: 3 });

      // DOM NodeView 확인: 새로 삽입된 2쪽은 빈 템플릿이므로 깨진 img 태그가 없어야 하며 page-style-lined 클래스를 가짐
      const domTemplates = session.host.querySelectorAll('[data-ink-template]');
      expect(domTemplates).toHaveLength(3);
      expect(domTemplates[1].getAttribute('data-page')).toBe('2');
      expect(domTemplates[1].className).toContain('page-style-lined');
      expect(domTemplates[1].querySelector('img')).toBeNull();
      expect(domTemplates[2].getAttribute('data-page')).toBe('3');

      // 레이아웃 총 높이가 3페이지 분량으로 확장되었는지 확인
      const afterLayout = computePdfPageLayout(
        extractInkTemplateDimensions(afterJson, session.ui.pages),
        840,
      );
      expect(afterLayout.pageHeights).toHaveLength(3);
      expect(afterLayout.totalHeight).toBeGreaterThan(beforeLayout.totalHeight);
    } finally {
      session.destroy();
    }
  });
});
