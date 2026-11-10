// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import {
  computePdfPageLayout,
  createPage,
  extractInkTemplateDimensions,
  normalizePdfNoteContent,
  PDF_PAGE_GAP_PX,
} from '../src/core/page/pageTypes';
import { getMeasuredPageLayout } from '../src/core/layout/pageLayout';
import { NoteSession } from '../src/session/NoteSession';
import { emptyNote } from '../src/storage/db';

function createMixed20PagePdfSession(): NoteSession {
  // 홀수 페이지: 세로(595x842), 짝수 페이지: 가로(842x595) 혼합 20페이지
  const pages = Array.from({ length: 20 }, (_, i) =>
    createPage({
      size: 'A4',
      orientation: i % 2 === 0 ? 'portrait' : 'landscape',
    }),
  );

  const content = {
    type: 'doc',
    content: pages.map((p, i) => ({
      type: 'inkTemplate',
      attrs: {
        src: `attachments/page_${i + 1}.png`,
        width: i % 2 === 0 ? 595 : 842,
        height: i % 2 === 0 ? 842 : 595,
        page: i + 1,
        pageId: p.id,
        style: 'plain',
      },
    })),
  };

  const note = emptyNote({
    id: `pdf-mixed-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    title: '혼합 20페이지 PDF 테스트',
    content,
    pages,
  });

  return new NoteSession(note);
}

describe('REQ_PDF_PAGE_DATA_AND_LAYOUT_STABILITY: PDF 페이지 데이터 및 레이아웃 안정성 검증', () => {
  it('1. 20페이지 PDF에서 페이지 수와 inkTemplate 수 및 pageId가 1:1로 일치한다', () => {
    const session = createMixed20PagePdfSession();
    expect(session.ui.pages).toHaveLength(20);

    const templates: Array<{ page: number; pageId: string }> = [];
    session.editor.state.doc.descendants((node) => {
      if (node.type.name === 'inkTemplate') {
        templates.push({
          page: Number(node.attrs.page),
          pageId: String(node.attrs.pageId),
        });
        return false;
      }
      return true;
    });

    expect(templates).toHaveLength(20);
    for (let i = 0; i < 20; i++) {
      expect(templates[i].page).toBe(i + 1);
      expect(templates[i].pageId).toBe(session.ui.pages[i].id);
    }
    expect(session.assertPageInvariant()).toBe(true);
  });

  it('2. ui.pages가 실제 노드보다 많을 때 extractInkTemplateDimensions는 가상 치수를 덧붙이지 않고 [PDF_PAGE_COUNT_MISMATCH]를 출력한다', () => {
    const docContent = {
      type: 'doc',
      content: [
        { type: 'inkTemplate', attrs: { width: 595, height: 842, page: 1 } },
        { type: 'inkTemplate', attrs: { width: 595, height: 842, page: 2 } },
      ],
    };

    // fallbackPages에는 5개의 페이지가 존재하지만, 실제 inkTemplate은 2개뿐인 상태
    const fallbackPages = Array.from({ length: 5 }, () => createPage({ size: 'A4' }));

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const dims = extractInkTemplateDimensions(docContent, fallbackPages);

    // 실제 노드 수인 2개만 반환되어야 함 (가상 3개 페이지 덧붙임 방지)
    expect(dims).toHaveLength(2);
    expect(errorSpy).toHaveBeenCalledWith(
      '[PDF_PAGE_COUNT_MISMATCH]',
      expect.objectContaining({
        templateCount: 2,
        fallbackCount: 5,
      }),
    );

    errorSpy.mockRestore();
  });

  it('3. 세로/가로가 혼합된 20페이지 PDF에서 고정 컨테이너 너비 기준 레이아웃 안정성 검증', () => {
    const session = createMixed20PagePdfSession();
    const dims = extractInkTemplateDimensions(session.editor.getJSON(), session.ui.pages);
    const containerWidth = dims[0].width; // 첫 페이지 기준 고정 너비 (595)

    const layout1 = computePdfPageLayout(dims, containerWidth);

    // 0페이지(세로) -> 1페이지(가로) -> 19페이지(가로)로 이동 시뮬레이션
    session.setCurrentPageIndex(1);
    const layout2 = computePdfPageLayout(dims, containerWidth);

    session.setCurrentPageIndex(19);
    const layout3 = computePdfPageLayout(dims, containerWidth);

    // 활성 페이지가 바뀌어도 고정 너비 컨테이너 기반이므로 전체 높이 및 오프셋 불변
    expect(layout1.totalHeight).toBe(layout2.totalHeight);
    expect(layout2.totalHeight).toBe(layout3.totalHeight);
    expect(layout1.yOffsets).toEqual(layout3.yOffsets);
  });

  it('4. 중간 페이지 추가/삭제 시 pageId가 보존되고 page 번호만 1..N으로 연속 재정렬된다', () => {
    const session = createMixed20PagePdfSession();
    const originalPage5Id = session.ui.pages[4].id;
    const originalPage6Id = session.ui.pages[5].id;

    // 5번째 페이지(인덱스 4) 아래에 새 페이지 추가
    const inserted = session.addPageBelow(4);
    expect(session.ui.pages).toHaveLength(21);

    const docAfterAdd = session.editor.getJSON();
    const templatesAfterAdd = (docAfterAdd.content ?? []).filter((n) => n.type === 'inkTemplate');
    expect(templatesAfterAdd).toHaveLength(21);

    // 5번째 페이지(기존) id 보존
    expect(templatesAfterAdd[4].attrs?.pageId).toBe(originalPage5Id);
    expect(templatesAfterAdd[4].attrs?.page).toBe(5);

    // 6번째 페이지(신규 삽입) id 및 번호 확인
    expect(templatesAfterAdd[5].attrs?.pageId).toBe(inserted.id);
    expect(templatesAfterAdd[5].attrs?.page).toBe(6);

    // 7번째 페이지(기존 6번째) id 보존 및 번호 7로 시프트
    expect(templatesAfterAdd[6].attrs?.pageId).toBe(originalPage6Id);
    expect(templatesAfterAdd[6].attrs?.page).toBe(7);

    // 추가했던 6번째 페이지 삭제
    session.deletePage(5);
    expect(session.ui.pages).toHaveLength(20);

    const docAfterDel = session.editor.getJSON();
    const templatesAfterDel = (docAfterDel.content ?? []).filter((n) => n.type === 'inkTemplate');
    expect(templatesAfterDel).toHaveLength(20);
    expect(templatesAfterDel[5].attrs?.pageId).toBe(originalPage6Id);
    expect(templatesAfterDel[5].attrs?.page).toBe(6);
    expect(session.assertPageInvariant()).toBe(true);
  });

  it('5. normalizePdfNoteContent는 순서대로 1..N 재정렬하고 기존 pageId를 재발급 없이 유지한다', () => {
    // page 번호가 1, 3, 5 로 구멍 나 있고, pageId는 존재하는 비정규화 문서
    const dirtyDoc = {
      type: 'doc',
      content: [
        { type: 'inkTemplate', attrs: { width: 595, height: 842, page: 1, pageId: 'id-alpha' } },
        { type: 'paragraph', content: [{ type: 'text', text: '중복 OCR 텍스트' }] },
        { type: 'inkTemplate', attrs: { width: 595, height: 842, page: 3, pageId: 'id-beta' } },
        { type: 'inkTemplate', attrs: { width: 595, height: 842, page: 5 } }, // pageId 누락
      ],
    };

    const fallbackPages = [
      createPage({ size: 'A4' }),
      createPage({ size: 'A4' }),
      createPage({ size: 'A4' }),
    ];

    const normalized = normalizePdfNoteContent(dirtyDoc, fallbackPages);
    expect(normalized.content).toHaveLength(3);

    // 1..N 순차 재정렬 검증
    expect(normalized.content?.[0].attrs?.page).toBe(1);
    expect(normalized.content?.[1].attrs?.page).toBe(2);
    expect(normalized.content?.[2].attrs?.page).toBe(3);

    // 기존 pageId 보존 및 누락분 마이그레이션 검증
    expect(normalized.content?.[0].attrs?.pageId).toBe('id-alpha');
    expect(normalized.content?.[1].attrs?.pageId).toBe('id-beta');
    expect(normalized.content?.[2].attrs?.pageId).toBe(fallbackPages[2].id);
  });

  it('6. PDF_PAGE_GAP_PX(24px) 간격 및 1, 10, 18, 19, 20쪽 예상/실측 offset 비교', () => {
    expect(PDF_PAGE_GAP_PX).toBe(24);

    const container = document.createElement('div');
    const pageH = 842;
    const pageW = 595;

    // 20개 페이지 모의 DOM 생성
    for (let i = 0; i < 20; i++) {
      const el = document.createElement('div');
      el.className = 'ink-template';
      el.setAttribute('data-page', String(i + 1));
      el.setAttribute('data-page-id', `page-${i + 1}`);
      const offsetTop = i * (pageH + PDF_PAGE_GAP_PX);
      Object.defineProperty(el, 'offsetTop', { value: offsetTop, configurable: true });
      Object.defineProperty(el, 'offsetHeight', { value: pageH, configurable: true });
      container.appendChild(el);
    }

    const measured = getMeasuredPageLayout(container);
    const estimated = computePdfPageLayout(
      Array(20).fill({ width: pageW, height: pageH }),
      pageW,
      PDF_PAGE_GAP_PX,
    );

    const targetIndices = [0, 9, 17, 18, 19]; // 1, 10, 18, 19, 20쪽
    const diffs: Record<number, number> = {};

    for (const idx of targetIndices) {
      const estY = estimated.yOffsets[idx];
      const domY = measured.offsets[idx];
      diffs[idx + 1] = Math.abs(domY - estY);
      // CSS margin-bottom: 24px와 gap 공식이 정확히 일치하므로 차이가 0px
      expect(domY).toBe(estY);
    }

    // 검증 결과 차이(diff) 출력
    expect(diffs[1]).toBe(0);
    expect(diffs[10]).toBe(0);
    expect(diffs[18]).toBe(0);
    expect(diffs[19]).toBe(0);
    expect(diffs[20]).toBe(0);
  });

  it('7. 기존 텍스트 객체와 pageId 연결 유지 검증', () => {
    const session = createMixed20PagePdfSession();
    const targetPage = session.ui.pages[2];

    session.patch({
      textObjects: [
        {
          id: 'text-mixed-1',
          pageId: targetPage.id,
          content: '3번째 페이지 연동 텍스트',
          xRatio: 0.2,
          yRatio: 0.3,
          widthPx: 120,
          heightPx: 40,
          style: { fontSize: 14, color: '#000' },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    });

    // 0번째 페이지 아래에 새 페이지 삽입 (targetPage는 3번째 -> 4번째로 밀림)
    session.addPageBelow(0);

    // pageNumber는 바뀌었지만 targetPage.id와 textObject.pageId 연결은 100% 동일하게 유지됨
    const textObj = session.ui.textObjects?.[0];
    expect(textObj).toBeDefined();
    expect(textObj?.pageId).toBe(targetPage.id);

    const currentDoc = session.editor.getJSON();
    const matchedNode = (currentDoc.content ?? []).find(
      (n) => n.type === 'inkTemplate' && n.attrs?.pageId === targetPage.id,
    );
    expect(matchedNode).toBeDefined();
    expect(matchedNode?.attrs?.page).toBe(4); // 3쪽에서 4쪽으로 갱신됨
    expect(matchedNode?.attrs?.pageId).toBe(textObj?.pageId);
  });
});

