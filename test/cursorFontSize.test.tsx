// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { NoteSession } from '../src/session/NoteSession';
import * as noteSessionMod from '../src/session/NoteSession';
import { Toolbar } from '../src/components/Toolbar';
import { useSettings } from '../src/store/settingsStore';
import { useTabs } from '../src/store/tabsStore';
import { markdownToJson, jsonToMarkdown } from '../src/editor/extensions';
import type { NoteRecord } from '../src/storage/db';

vi.mock('../src/search/searchClient', () => ({
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

/** ProseMirror/TipTap 환경에서 현재 커서 storedMarks를 반영해 텍스트를 입력하는 헬퍼 */
function typeAtCursor(session: NoteSession, text: string) {
  const { state, dispatch } = session.editor.view;
  const { from, to } = state.selection;
  const marks = state.storedMarks ?? state.selection.$from.marks();
  const tr = state.tr.replaceWith(from, to, state.schema.text(text, marks));
  tr.setStoredMarks(marks);
  dispatch(tr);
}

describe('커서 위치 인라인 글자 크기 적용 · 툴바 동기화 · IME/Enter 안전성', () => {
  let session: NoteSession | null = null;

  beforeEach(() => {
    cleanup();
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
    session = null;
    vi.restoreAllMocks();
    cleanup();
  });

  it('Case 1: 선택 영역 없이 커서 위치에서 20px 적용 시 storedMarks에 등록되고 직후 입력 텍스트 및 마크다운에 반영된다', () => {
    const record = createMockRecord('cursor-fs-1', '테스트', '<p>일반</p>');
    session = new NoteSession(record);

    // "일반" 뒤 커서 배치
    const endPos = session.editor.state.doc.content.size - 1;
    session.editor.commands.setTextSelection(endPos);
    expect(session.editor.state.selection.empty).toBe(true);

    session.applyFontSize(20);

    expect(session.getCursorFontSize()).toBe(20);
    typeAtCursor(session, '크게');

    const html = session.editor.getHTML();
    expect(html).toContain('일반');
    expect(html).toContain('data-font-size="20px"');
    expect(html).toMatch(/font-size:\s*20px/);
    expect(html).toContain('>크게</span>');

    const md = session.editor.getMarkdown();
    expect(md).toContain('일반<span style="font-size: 20px;">크게</span>');
  });

  it('Case 2: 도구 모드가 펜(pencil)이어도 커서 위치 fontSize storedMarks 적용 및 보통(초기화) 해제가 동작한다', () => {
    useSettings.setState({ tool: 'pencil' });
    const record = createMockRecord('cursor-fs-2', '테스트', '<p></p>');
    session = new NoteSession(record);
    session.editor.commands.setTextSelection(1);

    session.applyFontSize(26);
    expect(session.getCursorFontSize()).toBe(26);
    typeAtCursor(session, '특대');

    // 보통(초기화) 실행 시 이후 입력부터 기본 크기로 분리됨
    session.resetFontSize();
    expect(session.getCursorFontSize()).toBeNull();
    typeAtCursor(session, '보통');

    const md = session.editor.getMarkdown();
    expect(md).toContain('<span style="font-size: 26px;">특대</span>보통');
  });

  it('Case 3: FontSizeMark 내부에서 다른 크기(13px) 선택 시 이후 입력 텍스트가 새 크기로 전환된다', () => {
    const record = createMockRecord('cursor-fs-3', '테스트', '<p><span data-font-size="20px" style="font-size: 20px">크게</span></p>');
    session = new NoteSession(record);

    const endPos = session.editor.state.doc.content.size - 1;
    session.editor.commands.setTextSelection(endPos);
    expect(session.getCursorFontSize()).toBe(20);

    session.applyFontSize(13);
    expect(session.getCursorFontSize()).toBe(13);
    typeAtCursor(session, '작게');

    const md = session.editor.getMarkdown();
    expect(md).toContain('<span style="font-size: 20px;">크게</span>');
    expect(md).toContain('<span style="font-size: 13px;">작게</span>');
  });

  it('Case 4: markdownToJson ↔ jsonToMarkdown 왕복 시 <span style="font-size: ...">이 보존된다', () => {
    const rawMd = '일반 <span style="font-size: 20px;">큰 글자</span> 와 <span style="font-size: 13px;">**작은 굵은 글자**</span>';
    const json = markdownToJson(rawMd);
    const out = jsonToMarkdown(json);

    expect(out).toContain('<span style="font-size: 20px;">큰 글자</span>');
    expect(out).toContain('<span style="font-size: 13px;">작은 굵은 글자</span>');
    expect(out).toContain('**');
  });

  it('Case 5: Toolbar가 커서 이동에 따라 현재 글자 크기와 퀵 프리셋/보통 버튼을 실시간 동기화한다', () => {
    const record = createMockRecord(
      'cursor-fs-5',
      '테스트',
      '<p>일반<span data-font-size="20px" style="font-size: 20px">큰글자</span></p>',
    );
    session = new NoteSession(record);
    useTabs.setState({ activeTabId: 'cursor-fs-5', openDocTabs: ['cursor-fs-5'] });
    vi.spyOn(noteSessionMod, 'getSession').mockReturnValue(session);

    render(<Toolbar />);

    const dropdownBtn = screen.getByTestId('font-size-dropdown-btn');
    expect(dropdownBtn.textContent).toContain('16px');
    expect(dropdownBtn.getAttribute('data-active-cursor-size')).toBe('default');

    // 커서를 "큰글자"(20px) 내부로 이동
    act(() => {
      session!.editor.commands.setTextSelection(5);
    });
    expect(dropdownBtn.textContent).toContain('20px');
    expect(dropdownBtn.getAttribute('data-active-cursor-size')).toBe('20');

    // 드롭다운 열면 '크게(20px)' 프리셋이 하이라이트되어 있어야 함
    fireEvent.click(dropdownBtn);
    const largeQuick = screen.getByTestId('font-size-quick-large');
    const resetBtn = screen.getByTestId('font-size-reset-btn');
    expect(largeQuick.className).toContain('bg-indigo-600');
    expect(resetBtn.className).not.toContain('bg-indigo-600');

    // '보통' 클릭 시 커서 마크가 초기화되고 기본 16px로 복귀
    fireEvent.click(resetBtn);
    expect(session.getCursorFontSize()).toBeNull();
    expect(dropdownBtn.textContent).toContain('16px');
  });

  it('Case 6: 한글 IME 조합 중(compositionstart) 크기 변경 시 조합을 깨뜨리지 않고 compositionend 직후 적용된다', () => {
    const record = createMockRecord('cursor-fs-6', '테스트', '<p>안녕</p>');
    session = new NoteSession(record);
    const endPos = session.editor.state.doc.content.size - 1;
    session.editor.commands.setTextSelection(endPos);

    // IME 조합 시작
    fireEvent.compositionStart(session.editor.view.dom);

    // 조합 중 크기 변경 요청 -> storedMarks 즉시 변경하지 않고 대기열에 보관
    session.applyFontSize(20);
    expect(session.getCursorFontSize()).toBeNull();

    // 조합 완료(compositionend) -> 대기 중이던 20px storedMarks가 안전하게 적용됨
    fireEvent.compositionEnd(session.editor.view.dom);
    expect(session.getCursorFontSize()).toBe(20);
  });

  it('Case 7: <span> 내부에서 Enter 및 Shift+Enter 입력 시 블록 구조가 깨지지 않고 빈 <span></span>이 남지 않는다', () => {
    const record = createMockRecord(
      'cursor-fs-7',
      '테스트',
      '<p><span data-font-size="20px" style="font-size: 20px">첫줄둘째줄</span></p>',
    );
    session = new NoteSession(record);

    // "첫줄|둘째줄" 위치(pos 3)에서 Enter (splitBlock)
    session.editor.commands.setTextSelection(3);
    act(() => {
      session!.editor.commands.splitBlock();
    });

    const splitMd = session.editor.getMarkdown();
    expect(splitMd).toContain('<span style="font-size: 20px;">첫줄</span>');
    expect(splitMd).toContain('<span style="font-size: 20px;">둘째줄</span>');
    expect(splitMd).not.toContain('<span style="font-size: 20px;"></span>');

    // Shift+Enter (HardBreak) 테스트
    session.editor.commands.setContent('<p><span data-font-size="26px" style="font-size: 26px">윗줄아랫줄</span></p>');
    session.editor.commands.setTextSelection(3);
    act(() => {
      session!.editor.commands.setHardBreak();
    });

    const hardBreakMd = session.editor.getMarkdown();
    const lines = hardBreakMd.split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const line of lines) {
      // 각 줄이 열린 <span> 없이 스스로 닫혀 있어야 함
      const opens = (line.match(/<span\b/g) ?? []).length;
      const closes = (line.match(/<\/span>/g) ?? []).length;
      expect(opens).toBe(closes);
    }
  });
});
