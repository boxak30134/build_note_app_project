// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NoteSession } from './NoteSession';
import { useSettings } from '../store/settingsStore';
import { db, type NoteRecord } from '../storage/db';
import { sanitizeDocumentTitle } from '../core/files/validation';

vi.mock('../search/searchClient', () => ({
  indexNote: vi.fn(),
  unindexNote: vi.fn(),
  searchRelated: vi.fn().mockResolvedValue([]),
}));

function createMockRecord(id: string, title: string, content: string): NoteRecord {
  return {
    id,
    title,
    folderId: null,
    content,
    markdown: content,
    plainText: content,
    strokes: [],
    annotations: [],
    encoding: 'utf-8',
    eol: 'lf',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

describe('Font Size, Text Color & Header Title Auto-Sync', () => {
  let session: NoteSession;

  beforeEach(() => {
    useSettings.setState({
      fontSize: 16,
      tool: 'none',
      colorSlots: ['#EF4444', '#F97316', '#FACC15', '#22C55E', '#3B82F6', '#1E3A8A', '#8B5CF6', '#000000'],
      activeSlot: 7,
      customColor: '#E11D48',
      isCustomColorActive: false,
    });
  });

  afterEach(() => {
    session?.destroy();
    vi.clearAllMocks();
  });

  describe('1. 폰트 크기 조절 (FontSizeMark & settingsStore)', () => {
    it('선택한 텍스트에 FontSizeMark(24px)를 적용한다', () => {
      const record = createMockRecord('note-font-1', '제목 없는 노트', '<p>Hello font size test</p>');
      session = new NoteSession(record);

      // "font size" 부분 선택 (from: 7, to: 16)
      session.editor.commands.setTextSelection({ from: 7, to: 16 });
      session.applyFontSize(24);

      const html = session.editor.getHTML();
      expect(html).toContain('data-font-size="24px"');
      expect(html).toContain('font-size: 24px');
    });

    it('settingsStore에서 fontSize 변경 시 상태가 갱신되고 8~72px로 클램핑된다', () => {
      const { setFontSize } = useSettings.getState();
      setFontSize(28);
      expect(useSettings.getState().fontSize).toBe(28);

      setFontSize(4); // min 8
      expect(useSettings.getState().fontSize).toBe(8);

      setFontSize(100); // max 72
      expect(useSettings.getState().fontSize).toBe(72);
    });
  });

  describe('2. 펜 색상 버튼의 텍스트 적용 (TextColorMark & text mode 보존)', () => {
    it('선택한 텍스트에 TextColorMark(#EF4444)를 적용한다', () => {
      const record = createMockRecord('note-color-1', '제목 없는 노트', '<p>Colorized text sample</p>');
      session = new NoteSession(record);

      session.editor.commands.setTextSelection({ from: 1, to: 10 });
      session.applyTextColor('#EF4444');

      const html = session.editor.getHTML();
      expect(html).toContain('data-text-color="#EF4444"');
      expect(html).toMatch(/color: (rgb\(239, 68, 68\)|#EF4444)/i);
    });

    it('텍스트 모드(tool: "none")에서 색상 슬롯을 선택해도 펜으로 강제 전환되지 않고 tool: "none"을 유지한다', () => {
      useSettings.setState({ tool: 'none' });
      const { selectSlot, setCustomColor } = useSettings.getState();

      selectSlot(0); // 빨강
      expect(useSettings.getState().tool).toBe('none');
      expect(useSettings.getState().activeSlot).toBe(0);

      setCustomColor('#123456');
      expect(useSettings.getState().tool).toBe('none');
      expect(useSettings.getState().customColor).toBe('#123456');
    });

    it('지우개/올가미 모드에서 색상 슬롯을 선택하면 펜 모드로 전환된다', () => {
      useSettings.setState({ tool: 'eraser' });
      useSettings.getState().selectSlot(2);
      expect(useSettings.getState().tool).toBe('pencil');

      useSettings.setState({ tool: 'lasso' });
      useSettings.getState().selectSlot(3);
      expect(useSettings.getState().tool).toBe('pencil');
    });
  });

  describe('3. 문서의 맨 위 header 텍스트의 문서 제목 기본 동기화', () => {
    it('sanitizeDocumentTitle이 특수기호(#, :, /, \\ 등)를 정리하여 안전한 제목을 생성한다', () => {
      expect(sanitizeDocumentTitle('# 2026/11/06: 머신러닝 연구! ')).toBe('2026 11 06  머신러닝 연구!');
      expect(sanitizeDocumentTitle('   ')).toBeNull();
    });

    it('제목 없는 노트에 맨 위 heading(# 헤더)이 작성되면 문서 제목이 자동 동기화된다', async () => {
      const record = createMockRecord('note-title-1', '제목 없는 노트', '<h1>선형대수학 기초</h1><p>본문 내용입니다.</p>');
      vi.spyOn(db.notes, 'update').mockResolvedValue(1);
      vi.spyOn(db.notes, 'get').mockResolvedValue(record);

      session = new NoteSession(record);
      await session.syncTitleFromHeader();

      expect(session.record.title).toBe('선형대수학 기초');
      expect(db.notes.update).toHaveBeenCalledWith('note-title-1', expect.objectContaining({ title: '선형대수학 기초' }));
    });

    it('heading이 없어도 첫 번째 텍스트 단락이 제목 없는 노트의 제목으로 자동 반영된다', async () => {
      const record = createMockRecord('note-title-2', '제목 없는 노트', '<p>인공지능 에이전트 설계 원칙</p><p>두 번째 줄</p>');
      vi.spyOn(db.notes, 'update').mockResolvedValue(1);
      vi.spyOn(db.notes, 'get').mockResolvedValue(record);

      session = new NoteSession(record);
      await session.syncTitleFromHeader();

      expect(session.record.title).toBe('인공지능 에이전트 설계 원칙');
      expect(db.notes.update).toHaveBeenCalledWith('note-title-2', expect.objectContaining({ title: '인공지능 에이전트 설계 원칙' }));
    });

    it('사용자가 수동으로 지정한 제목이 있는 경우(isManualTitle: true) 본문 헤더 변경으로 덮어쓰지 않는다', async () => {
      const record = createMockRecord('note-title-3', '사용자 정의 제목', '<h1>새로운 헤더 텍스트</h1>');
      const updateSpy = vi.spyOn(db.notes, 'update').mockResolvedValue(1);
      vi.spyOn(db.notes, 'get').mockResolvedValue(record);

      session = new NoteSession(record);
      // isManualTitle 이 true 로 설정되어 있음을 확인
      expect(session.isManualTitle).toBe(true);

      await session.syncTitleFromHeader();
      expect(session.record.title).toBe('사용자 정의 제목');
      expect(updateSpy).not.toHaveBeenCalled();
    });
  });
});
