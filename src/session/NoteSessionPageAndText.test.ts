// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NoteSession } from './NoteSession';
import type { NoteRecord } from '../storage/db';
import { createPage } from '../core/page/pageTypes';
import { InkTemplate } from '../editor/extensions/media';

vi.mock('../storage/db', () => ({
  db: {
    notes: {
      put: vi.fn().mockResolvedValue('test-note-id'),
      get: vi.fn().mockResolvedValue(null),
    },
  },
}));

vi.mock('../storage/opfs', () => ({
  attachmentUrl: vi.fn().mockResolvedValue('blob:test'),
  writeAttachment: vi.fn().mockResolvedValue(undefined),
  deleteAttachment: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../features/search/documentLinker', () => ({
  searchRelatedDocuments: vi.fn().mockResolvedValue([]),
}));

function createMockRecord(partial: Partial<NoteRecord> = {}): NoteRecord {
  const now = Date.now();
  return {
    id: 'mock-note',
    title: '테스트 노트',
    folderId: null,
    content: { type: 'doc', content: [] },
    markdown: '',
    plainText: '',
    strokes: [],
    annotations: [],
    textObjects: [],
    pages: [createPage()],
    encoding: 'utf-8',
    eol: 'lf',
    fileHandle: null,
    fileLastModified: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    ...partial,
  };
}

describe('NoteSession Page Management & Text Object System', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('InkTemplate 확장의 selectable 속성이 false로 설정되어 있어 S-Pen 터치 시 NodeSelection을 유발하지 않는다', () => {
    expect(InkTemplate.config.selectable).toBe(false);
  });

  it('단 1개의 페이지만 존재하는 경우 deletePage는 false를 반환하고 페이지를 삭제하지 않는다 (최소 1페이지 보장)', () => {
    const singlePage = createPage({ size: 'A4' });
    const record = createMockRecord({
      id: 'note-1',
      title: '단일 페이지',
      pages: [singlePage],
      textObjects: [],
    });

    const session = new NoteSession(record);
    expect(session.ui.pages.length).toBe(1);

    const deleted = session.deletePage(0);
    expect(deleted).toBe(false);
    expect(session.ui.pages.length).toBe(1);
    session.destroy();
  });

  it('다중 페이지 문서에서 deletePage 호출 시 해당 페이지 및 소속된 textObjects를 정확히 정리한다', () => {
    const page1 = createPage({ size: 'A4' });
    const page2 = createPage({ size: 'A4' });
    const page3 = createPage({ size: 'A4' });

    const record = createMockRecord({
      id: 'note-multi',
      title: '다중 페이지 문서',
      pages: [page1, page2, page3],
      textObjects: [
        {
          id: 'txt-1',
          pageId: page1.id,
          x: 50,
          y: 100,
          text: '1페이지 메모',
          fontSize: 16,
          color: '#000000',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        {
          id: 'txt-2',
          pageId: page2.id,
          x: 100,
          y: 200,
          text: '2페이지 삭제될 메모',
          fontSize: 16,
          color: '#000000',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        {
          id: 'txt-3',
          pageId: page3.id,
          x: 80,
          y: 150,
          text: '3페이지 유지될 메모',
          fontSize: 16,
          color: '#000000',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    });

    const session = new NoteSession(record);
    expect(session.ui.pages.length).toBe(3);
    expect(session.ui.textObjects?.length).toBe(3);

    // 2번째 페이지(page2, index 1) 삭제
    const success = session.deletePage(1);
    expect(success).toBe(true);
    expect(session.ui.pages.length).toBe(2);
    expect(session.ui.pages.map((p) => p.id)).toEqual([page1.id, page3.id]);

    // page2에 속했던 txt-2는 제거되고 txt-1, txt-3만 남아야 함
    const remainingTextIds = (session.ui.textObjects ?? []).map((t) => t.id);
    expect(remainingTextIds).toContain('txt-1');
    expect(remainingTextIds).toContain('txt-3');
    expect(remainingTextIds).not.toContain('txt-2');

    session.destroy();
  });

  it('addTextObject, updateTextObject, deleteTextObject 가 정상 동작하고 통합 Undo/Redo 와 완벽히 연동된다', () => {
    const page1 = createPage({ size: 'A4' });
    const record = createMockRecord({
      id: 'note-text-test',
      title: '텍스트 객체 Undo/Redo 테스트',
      pages: [page1],
      textObjects: [],
    });

    const session = new NoteSession(record);

    // 1. addTextObject
    const newText = session.addTextObject({
      pageId: page1.id,
      x: 120,
      y: 240,
      text: '수학 공식: E = mc^2',
      fontSize: 18,
      color: '#4338ca',
    });

    expect(newText.id).toBeDefined();
    expect(session.ui.textObjects?.length).toBe(1);
    expect(session.ui.textObjects?.[0].text).toBe('수학 공식: E = mc^2');

    // 2. Undo -> 객체 제거 확인
    session.undo();
    expect(session.ui.textObjects?.length).toBe(0);

    // 3. Redo -> 객체 복원 확인
    session.redo();
    expect(session.ui.textObjects?.length).toBe(1);
    expect(session.ui.textObjects?.[0].text).toBe('수학 공식: E = mc^2');

    // 4. updateTextObject
    session.updateTextObject(newText.id, { text: '수학 공식: E = mc^2 (수정됨)' });
    expect(session.ui.textObjects?.[0].text).toBe('수학 공식: E = mc^2 (수정됨)');

    // 5. Undo update -> 이전 텍스트 복원
    session.undo();
    expect(session.ui.textObjects?.[0].text).toBe('수학 공식: E = mc^2');

    // 6. Redo update -> 수정된 텍스트 재반영
    session.redo();
    expect(session.ui.textObjects?.[0].text).toBe('수학 공식: E = mc^2 (수정됨)');

    // 7. deleteTextObject
    session.deleteTextObject(newText.id);
    expect(session.ui.textObjects?.length).toBe(0);

    // 8. Undo delete -> 삭제된 객체 복원
    session.undo();
    expect(session.ui.textObjects?.length).toBe(1);
    expect(session.ui.textObjects?.[0].id).toBe(newText.id);

    // 9. Redo delete -> 다시 삭제
    session.redo();
    expect(session.ui.textObjects?.length).toBe(0);

    session.destroy();
  });
});
