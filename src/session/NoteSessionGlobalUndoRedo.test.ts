// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NoteSession } from './NoteSession';
import type { NoteRecord } from '../storage/db';
import { createPage } from '../core/page/pageTypes';
import { newStrokeId, type Stroke } from '../core/strokes/StrokeStore';

vi.mock('../storage/db', () => ({
  uid: (prefix = 'id') => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
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
    id: 'mock-global-undo-note',
    title: '글로벌 Undo/Redo 통합 테스트 노트',
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

describe('Unified Global Undo/Redo System', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('1. 기본 편집 작업 (Stroke, Text, Annotation)', () => {
    it('손글씨 Stroke 생성 -> Undo -> Redo 가 완벽히 동작한다', () => {
      const session = new NoteSession(createMockRecord());
      expect(session.canUndo).toBe(false);

      const stroke: Stroke = {
        id: newStrokeId(),
        tool: 'pencil',
        color: '#000000',
        size: 2,
        points: [[10, 10, 0.5], [20, 20, 0.5], [30, 30, 0.5]],
      };

      session.strokes.addStroke(stroke);
      expect(session.canUndo).toBe(true);
      expect(session.strokes.getAll().length).toBe(1);

      session.undo();
      expect(session.strokes.getAll().length).toBe(0);
      expect(session.canRedo).toBe(true);

      session.redo();
      expect(session.strokes.getAll().length).toBe(1);
      expect(session.strokes.getAll()[0].id).toBe(stroke.id);
      session.destroy();
    });

    it('텍스트 상자 생성 -> 수정 -> 삭제가 Undo/Redo 와 완벽히 연동된다', () => {
      const page1 = createPage({ size: 'A4' });
      const session = new NoteSession(createMockRecord({ pages: [page1] }));

      // 1. 생성
      const txt = session.addTextObject({
        pageId: page1.id,
        x: 50,
        y: 100,
        text: '첫 번째 텍스트',
        fontSize: 16,
        color: '#1e293b',
      });
      expect(session.ui.textObjects?.length).toBe(1);

      // 2. 수정
      session.updateTextObject(txt.id, { text: '수정된 텍스트' });
      expect(session.ui.textObjects?.[0].text).toBe('수정된 텍스트');

      // 3. 삭제
      session.deleteTextObject(txt.id);
      expect(session.ui.textObjects?.length).toBe(0);

      // Undo 삭제 -> 텍스트 복구
      session.undo();
      expect(session.ui.textObjects?.length).toBe(1);
      expect(session.ui.textObjects?.[0].text).toBe('수정된 텍스트');

      // Undo 수정 -> 이전 텍스트 복구
      session.undo();
      expect(session.ui.textObjects?.[0].text).toBe('첫 번째 텍스트');

      // Undo 생성 -> 텍스트 완전히 없음
      session.undo();
      expect(session.ui.textObjects?.length).toBe(0);

      // Redo 생성 -> 텍스트 재생성
      session.redo();
      expect(session.ui.textObjects?.length).toBe(1);
      expect(session.ui.textObjects?.[0].text).toBe('첫 번째 텍스트');

      session.destroy();
    });

    it('말풍선 주석(Annotation) 생성 및 삭제가 Undo/Redo 와 완벽히 연동된다', () => {
      const session = new NoteSession(createMockRecord());
      expect(session.ui.annotations.length).toBe(0);

      const annId = session.createAnnotation({ x: 100, y: 150 });
      expect(session.ui.annotations.length).toBe(1);
      expect(session.ui.annotations[0].id).toBe(annId);

      // Undo 생성 -> 주석 제거
      session.undo();
      expect(session.ui.annotations.length).toBe(0);

      // Redo 생성 -> 주석 복구
      session.redo();
      expect(session.ui.annotations.length).toBe(1);

      // 삭제
      session.deleteAnnotation(annId);
      expect(session.ui.annotations.length).toBe(0);

      // Undo 삭제 -> 주석 복구
      session.undo();
      expect(session.ui.annotations.length).toBe(1);
      expect(session.ui.annotations[0].id).toBe(annId);

      session.destroy();
    });
  });

  describe('2. 페이지 관리 (생성, 복제, 삭제, 순서변경) 원자적 Undo/Redo', () => {
    it('페이지 생성 -> Undo -> Redo 가 완벽히 동작한다', () => {
      const page1 = createPage({ size: 'A4' });
      const session = new NoteSession(createMockRecord({ pages: [page1] }));
      expect(session.ui.pages.length).toBe(1);

      const created = session.addPageBelow(0);
      expect(session.ui.pages.length).toBe(2);
      expect(session.ui.pages[1].id).toBe(created.id);

      // Undo -> 생성된 페이지 제거
      session.undo();
      expect(session.ui.pages.length).toBe(1);
      expect(session.ui.pages[0].id).toBe(page1.id);

      // Redo -> 페이지 복원
      session.redo();
      expect(session.ui.pages.length).toBe(2);
      expect(session.ui.pages[1].id).toBe(created.id);

      session.destroy();
    });

    it('콘텐츠(스트로크+텍스트)가 있는 페이지 삭제 시, Undo 1회로 페이지와 모든 소속 콘텐츠가 100% 완전 복구된다 (Atomic Transaction)', () => {
      const page1 = createPage({ size: 'A4' });
      const page2 = createPage({ size: 'A4' });

      const strokeOnPage2: Stroke = {
        id: 'stroke-p2',
        tool: 'pencil',
        color: '#ff0000',
        size: 3,
        // page2 영역: A4 세로(1188px) + gap(16px) 이상 -> 1204px ~ 2392px
        points: [[100, 1400, 0.5], [150, 1450, 0.5]],
      };

      const session = new NoteSession(createMockRecord({
        pages: [page1, page2],
        strokes: [strokeOnPage2],
        textObjects: [
          {
            id: 'txt-p2',
            pageId: page2.id,
            x: 80,
            y: 120,
            text: '2페이지에 소속된 중요 메모',
            fontSize: 16,
            color: '#000000',
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        ],
      }));

      expect(session.ui.pages.length).toBe(2);
      expect(session.strokes.getAll().length).toBe(1);
      expect(session.ui.textObjects?.length).toBe(1);

      // 2페이지 삭제 실행
      const deleted = session.deletePage(1);
      expect(deleted).toBe(true);
      expect(session.ui.pages.length).toBe(1);
      expect(session.strokes.getAll().length).toBe(0); // 2페이지 스트로크 삭제됨
      expect(session.ui.textObjects?.length).toBe(0); // 2페이지 텍스트 삭제됨

      // Undo 1회 실행 -> 원자적 완전 복구 검증
      session.undo();

      expect(session.ui.pages.length).toBe(2);
      expect(session.ui.pages[1].id).toBe(page2.id); // 원래 페이지 ID 그대로 복원
      expect(session.strokes.getAll().length).toBe(1);
      expect(session.strokes.getAll()[0].id).toBe('stroke-p2'); // 스트로크 복원
      expect(session.ui.textObjects?.length).toBe(1);
      expect(session.ui.textObjects?.[0].id).toBe('txt-p2'); // 텍스트 객체 복원
      expect(session.ui.textObjects?.[0].text).toBe('2페이지에 소속된 중요 메모');

      // Redo 1회 실행 -> 다시 원자적 일괄 삭제
      session.redo();
      expect(session.ui.pages.length).toBe(1);
      expect(session.strokes.getAll().length).toBe(0);
      expect(session.ui.textObjects?.length).toBe(0);

      session.destroy();
    });

    it('페이지 복제(duplicatePage) 및 순서 변경(reorderPages)이 Undo/Redo 와 완벽히 연동된다', () => {
      const page1 = createPage({ size: 'A4' });
      const session = new NoteSession(createMockRecord({ pages: [page1] }));

      // 1. 복제
      const dup = session.duplicatePage(0);
      expect(dup).toBeDefined();
      expect(session.ui.pages.length).toBe(2);

      // Undo 복제
      session.undo();
      expect(session.ui.pages.length).toBe(1);

      // Redo 복제
      session.redo();
      expect(session.ui.pages.length).toBe(2);

      // 2. 순서 변경 (0 -> 1)
      const firstId = session.ui.pages[0].id;
      const secondId = session.ui.pages[1].id;
      session.reorderPages(0, 1);
      expect(session.ui.pages[0].id).toBe(secondId);
      expect(session.ui.pages[1].id).toBe(firstId);

      // Undo 순서 변경
      session.undo();
      expect(session.ui.pages[0].id).toBe(firstId);
      expect(session.ui.pages[1].id).toBe(secondId);

      session.destroy();
    });
  });

  describe('3. 복합 다단계 트랜잭션 및 Redo Stack 수명 주기', () => {
    it('5단계 연속 작업 (필기 -> 텍스트 -> 페이지생성 -> 주석 -> 페이지삭제) 후 5회 Undo / 5회 Redo가 완벽한 일관성을 유지한다', () => {
      const initialPage = createPage({ size: 'A4' });
      const session = new NoteSession(createMockRecord({ pages: [initialPage] }));

      // 1. 필기 생성
      const s1: Stroke = { id: 's-complex-1', tool: 'pencil', color: '#000', size: 2, points: [[5, 5, 0.5]] };
      session.strokes.addStroke(s1);

      // 2. 텍스트 입력
      session.addTextObject({ pageId: initialPage.id, x: 20, y: 30, text: '복합 텍스트', fontSize: 16, color: '#000' });

      // 3. 페이지 생성
      session.addPageBelow(0);

      // 4. 주석 생성
      session.createAnnotation({ x: 50, y: 50 });

      // 5. 페이지 삭제 (p2 삭제)
      session.deletePage(1);

      expect(session.ui.pages.length).toBe(1);
      expect(session.ui.annotations.length).toBe(1);
      expect(session.ui.textObjects?.length).toBe(1);
      expect(session.strokes.getAll().length).toBe(1);

      // --- 5회 연속 Undo ---
      session.undo(); // 5 취소: p2 복원
      expect(session.ui.pages.length).toBe(2);

      session.undo(); // 4 취소: a1 삭제
      expect(session.ui.annotations.length).toBe(0);

      session.undo(); // 3 취소: p2 제거
      expect(session.ui.pages.length).toBe(1);

      session.undo(); // 2 취소: t1 제거
      expect(session.ui.textObjects?.length).toBe(0);

      session.undo(); // 1 취소: s1 제거
      expect(session.strokes.getAll().length).toBe(0);
      expect(session.canUndo).toBe(false);

      // --- 5회 연속 Redo ---
      session.redo(); // 1 재실행: s1 복원
      expect(session.strokes.getAll().length).toBe(1);

      session.redo(); // 2 재실행: t1 복원
      expect(session.ui.textObjects?.length).toBe(1);

      session.redo(); // 3 재실행: p2 복원
      expect(session.ui.pages.length).toBe(2);

      session.redo(); // 4 재실행: a1 복원
      expect(session.ui.annotations.length).toBe(1);

      session.redo(); // 5 재실행: p2 다시 삭제
      expect(session.ui.pages.length).toBe(1);
      expect(session.canRedo).toBe(false);

      session.destroy();
    });

    it('Undo 후 새로운 작업을 실행하면 이전 Redo Stack이 즉시 초기화(비워짐)된다', () => {
      const page1 = createPage({ size: 'A4' });
      const session = new NoteSession(createMockRecord({ pages: [page1] }));

      // 1. 필기 생성
      session.strokes.addStroke({ id: 'stroke-1', tool: 'pencil', color: '#000', size: 2, points: [[1, 1, 0.5]] });

      // 2. 텍스트 생성
      session.addTextObject({ pageId: page1.id, x: 10, y: 10, text: '텍스트 1', fontSize: 16, color: '#000' });

      // 3. 페이지 생성
      session.addPageBelow(0);

      expect(session.ui.pages.length).toBe(2);

      // Undo 1회 -> 페이지 생성 취소
      session.undo();
      expect(session.ui.pages.length).toBe(1);
      expect(session.canRedo).toBe(true);

      // 새 작업 실행 (새로운 Stroke 추가)
      session.strokes.addStroke({ id: 'stroke-new', tool: 'pencil', color: '#000', size: 2, points: [[5, 5, 0.5]] });

      // Redo 스택이 폐기되어 더 이상 페이지 생성을 Redo할 수 없음
      expect(session.canRedo).toBe(false);

      session.destroy();
    });
  });
});
