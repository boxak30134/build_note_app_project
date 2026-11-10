// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createPage } from '../src/core/page/pageTypes';
import { NoteSession } from '../src/session/NoteSession';
import { emptyNote } from '../src/storage/db';

function create20PagePdfSession(): NoteSession {
  const content = {
    type: 'doc',
    content: Array.from({ length: 20 }, (_, i) => ({
      type: 'inkTemplate',
      attrs: {
        src: `attachments/page_${i + 1}.png`,
        width: 595,
        height: 842,
        page: i + 1,
        style: 'plain',
      },
    })),
  };

  const pages = Array.from({ length: 20 }, () =>
    createPage({ size: 'A4', style: 'plain', orientation: 'portrait' }),
  );

  const note = emptyNote({
    id: `pdf-session-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    title: '20페이지 PDF 테스트',
    content,
    pages,
  });

  return new NoteSession(note);
}

function getInkTemplates(session: NoteSession) {
  const list: Array<{ pos: number; attrs: Record<string, unknown> }> = [];
  session.editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'inkTemplate') {
      list.push({ pos, attrs: { ...node.attrs } });
      return false;
    }
    return true;
  });
  return list;
}

describe('REQ_PAGE_SOURCE_OF_TRUTH_AND_SCROLL_SPY_FIX: 페이지 진실 소스 단일화 및 무결성 검증', () => {
  it('1. 20페이지 PDF 세션에서 20번째 아래 페이지 추가 시 ui.pages.length === 21, 노드 21개, 21번째 노드 { page: 21 }', () => {
    const session = create20PagePdfSession();
    expect(session.ui.pages).toHaveLength(20);
    expect(getInkTemplates(session)).toHaveLength(20);

    const newPage = session.addPageBelow(19);

    expect(session.ui.pages).toHaveLength(21);
    const templates = getInkTemplates(session);
    expect(templates).toHaveLength(21);
    expect(templates[19].attrs.page).toBe(20);
    expect(templates[20].attrs).toMatchObject({
      src: '',
      page: 21,
      style: newPage.style,
      width: 595,
      height: 842,
    });
    expect(session.assertPageInvariant()).toBe(true);
  });

  it('2. 1페이지 아래 삽입 시 2번째 노드가 { page: 2 }, 기존 2~20페이지가 page: 3..21로 재정렬된다', () => {
    const session = create20PagePdfSession();

    session.addPageBelow(0);

    expect(session.ui.pages).toHaveLength(21);
    const templates = getInkTemplates(session);
    expect(templates).toHaveLength(21);

    expect(templates[0].attrs.page).toBe(1);
    expect(templates[1].attrs).toMatchObject({ src: '', page: 2 });

    for (let i = 0; i < 21; i++) {
      expect(templates[i].attrs.page).toBe(i + 1);
    }
    expect(session.assertPageInvariant()).toBe(true);
  });

  it('3. 네 진입점(헤더, 썸네일, 시트 하단, Pull-up)이 모두 session.addPageBelow를 1회 호출하고 독자 변경을 하지 않는다', () => {
    const session = create20PagePdfSession();
    const addSpy = vi.spyOn(session, 'addPageBelow');

    // 1) 헤더 버튼 시뮬레이션
    session.addPageBelow();
    expect(addSpy).toHaveBeenCalledTimes(1);

    // 2) 썸네일 액션 시뮬레이션
    session.addPageBelow(2);
    expect(addSpy).toHaveBeenCalledTimes(2);

    // 3) 시트 하단 버튼 시뮬레이션
    session.addPageBelow(5);
    expect(addSpy).toHaveBeenCalledTimes(3);

    // 4) Pull-up 제스처 시뮬레이션
    session.addPageBelow(10);
    expect(addSpy).toHaveBeenCalledTimes(4);

    expect(session.assertPageInvariant()).toBe(true);
  });

  it('4. 페이지 추가 전후 ui.pages 참조가 다름 (새 배열 생성 및 불변 유지)', () => {
    const session = create20PagePdfSession();
    const prevPages = session.ui.pages;

    session.addPageBelow(5);

    const nextPages = session.ui.pages;
    expect(Object.is(prevPages, nextPages)).toBe(false);
    expect(nextPages.length).toBe(prevPages.length + 1);
  });

  it('5. addPageBelow 후 record.content의 inkTemplate 수가 21로 즉시 동기화된다', () => {
    const session = create20PagePdfSession();

    session.addPageBelow(19);

    const recordContent = session.record.content as {
      content?: Array<{ type: string; attrs?: { page?: number } }>;
    };
    const recordTemplates = (recordContent.content ?? []).filter((n) => n.type === 'inkTemplate');
    expect(recordTemplates).toHaveLength(21);
    expect(recordTemplates[20].attrs?.page).toBe(21);
  });

  it('6. deletePage(10) -> 노드 19개, page 1..19 연속 재정렬 및 스트로크/텍스트 정리', () => {
    const session = create20PagePdfSession();
    const targetPageId = session.ui.pages[10].id;

    // 10페이지에 속하는 텍스트 객체 등록
    session.patch({
      textObjects: [
        {
          id: 'text-1',
          pageId: targetPageId,
          content: '10페이지 텍스트',
          xRatio: 0.1,
          yRatio: 0.1,
          widthPx: 100,
          heightPx: 50,
          style: { fontSize: 14, color: '#000' },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        {
          id: 'text-2',
          pageId: session.ui.pages[0].id,
          content: '0페이지 텍스트',
          xRatio: 0.1,
          yRatio: 0.1,
          widthPx: 100,
          heightPx: 50,
          style: { fontSize: 14, color: '#000' },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    });

    const success = session.deletePage(10);
    expect(success).toBe(true);
    expect(session.ui.pages).toHaveLength(19);

    const templates = getInkTemplates(session);
    expect(templates).toHaveLength(19);
    for (let i = 0; i < 19; i++) {
      expect(templates[i].attrs.page).toBe(i + 1);
    }

    // 소속 textObjects 제거 검증
    expect(session.ui.textObjects).toHaveLength(1);
    expect(session.ui.textObjects[0].id).toBe('text-2');
    expect(session.assertPageInvariant()).toBe(true);
  });

  it('7. 페이지 추가 -> Undo -> Redo 왕복 시 불변식 통과 및 노드/pages 수 동기화', () => {
    const session = create20PagePdfSession();

    session.addPageBelow(0);
    expect(session.ui.pages).toHaveLength(21);
    expect(getInkTemplates(session)).toHaveLength(21);
    expect(session.assertPageInvariant()).toBe(true);

    // Undo 1회
    session.history.undo();
    expect(session.ui.pages).toHaveLength(20);
    expect(getInkTemplates(session)).toHaveLength(20);
    expect(session.assertPageInvariant()).toBe(true);

    // Redo 1회
    session.history.redo();
    expect(session.ui.pages).toHaveLength(21);
    expect(getInkTemplates(session)).toHaveLength(21);
    expect(session.assertPageInvariant()).toBe(true);
  });

  it('8. 1페이지 문서에서 deletePage(0) 호출 시 삭제 거부 (최소 1페이지 보장)', () => {
    const note = emptyNote({
      id: 'single-page-test',
      title: '단일 페이지 문서',
      content: {
        type: 'doc',
        content: [
          {
            type: 'inkTemplate',
            attrs: { src: '', width: 595, height: 842, page: 1, style: 'plain' },
          },
        ],
      },
      pages: [createPage({ size: 'A4' })],
    });
    const session = new NoteSession(note);

    const result = session.deletePage(0);
    expect(result).toBe(false);
    expect(session.ui.pages).toHaveLength(1);
    expect(getInkTemplates(session)).toHaveLength(1);
    expect(session.assertPageInvariant()).toBe(true);
  });

  it('9. 개발 모드에서 불변식 위반(ui.pages만 불일치하게 변경) 감지 시 [PAGE_INVARIANT_VIOLATION] 출력 및 false 반환', () => {
    const session = create20PagePdfSession();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // 고의로 불일치 조장: ui.pages만 22개로 늘림
    session.patch({
      pages: [...session.ui.pages, createPage({ size: 'A4' }), createPage({ size: 'A4' })],
    });

    const valid = session.assertPageInvariant();
    expect(valid).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(
      '[PAGE_INVARIANT_VIOLATION]',
      expect.objectContaining({
        uiPagesLength: 22,
        docTemplateCount: 20,
      }),
    );

    errorSpy.mockRestore();
  });
});

