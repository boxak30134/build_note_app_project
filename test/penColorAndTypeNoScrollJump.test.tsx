// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { NoteSession } from '../src/session/NoteSession';
import * as noteSessionMod from '../src/session/NoteSession';
import { Toolbar } from '../src/components/Toolbar';
import { PenSettingsPopup } from '../src/components/PenSettingsPopup';
import { InkTemplate } from '../src/editor/extensions/media';
import { useSettings } from '../src/store/settingsStore';
import { useTabs } from '../src/store/tabsStore';
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

describe('펜 색깔/종류 변경 시 에디터 포커스 유입 및 맨 밑 강제 스크롤 차단', () => {
  let session: NoteSession | null = null;

  beforeEach(() => {
    cleanup();
    useSettings.setState({
      tool: 'pencil',
      penType: 'ballpoint',
      fontSize: 16,
      colorSlots: ['#EF4444', '#F97316', '#FACC15', '#22C55E', '#3B82F6', '#1E3A8A', '#8B5CF6', '#000000'],
      activeSlot: 7,
      customColor: '#E11D48',
      isCustomColorActive: false,
    });
    useTabs.setState({ activeTabId: 'tab-pen-1', openDocTabs: ['tab-pen-1'] });
  });

  afterEach(() => {
    session?.destroy();
    session = null;
    vi.restoreAllMocks();
    cleanup();
  });

  it('필기 모드(pencil)에서는 텍스트 선택이 남아 있어도 applyTextColor가 focus()나 마크 적용을 수행하지 않는다', () => {
    session = new NoteSession(createMockRecord('note-pen-1', '노트', '<p>Keep ink mode scroll intact</p>'));
    session.editor.commands.setTextSelection({ from: 1, to: 10 });
    const focusSpy = vi.spyOn(session.editor.commands, 'focus');

    session.applyTextColor('#EF4444');

    expect(focusSpy).not.toHaveBeenCalled();
    expect(session.editor.getHTML()).not.toContain('data-text-color');
  });

  it('필기 모드(pencil)에서 Toolbar 색상 슬롯 클릭 시 applyTextColor를 부르지 않고 blurEditor로 잔존 포커스를 해제한다', () => {
    const mockApplyTextColor = vi.fn();
    const mockBlurEditor = vi.fn();
    vi.spyOn(noteSessionMod, 'getSession').mockReturnValue({
      applyFontSize: vi.fn(),
      applyTextColor: mockApplyTextColor,
      blurEditor: mockBlurEditor,
      undo: vi.fn(),
      redo: vi.fn(),
      applyFontFamily: vi.fn(),
    } as unknown as noteSessionMod.NoteSession);

    render(<Toolbar />);
    fireEvent.click(screen.getByTestId('color-slot-0'));

    expect(useSettings.getState().activeSlot).toBe(0);
    expect(mockApplyTextColor).not.toHaveBeenCalled();
    expect(mockBlurEditor).toHaveBeenCalledTimes(1);
  });

  it('텍스트 모드(none)에서는 Toolbar 색상 슬롯 클릭 시 applyTextColor가 정상 호출된다', () => {
    useSettings.setState({ tool: 'none' });
    const mockApplyTextColor = vi.fn();
    const mockBlurEditor = vi.fn();
    vi.spyOn(noteSessionMod, 'getSession').mockReturnValue({
      applyFontSize: vi.fn(),
      applyTextColor: mockApplyTextColor,
      blurEditor: mockBlurEditor,
      undo: vi.fn(),
      redo: vi.fn(),
      applyFontFamily: vi.fn(),
    } as unknown as noteSessionMod.NoteSession);

    render(<Toolbar />);
    fireEvent.click(screen.getByTestId('color-slot-4'));

    expect(mockApplyTextColor).toHaveBeenCalledWith('#3B82F6');
    expect(mockBlurEditor).not.toHaveBeenCalled();
  });

  it('PenSettingsPopup에서 펜 종류·색상 변경 및 팝업 닫기 시 에디터 잔존 포커스를 blurEditor로 해제한다', () => {
    const mockBlurEditor = vi.fn();
    vi.spyOn(noteSessionMod, 'getSession').mockReturnValue({
      blurEditor: mockBlurEditor,
    } as unknown as noteSessionMod.NoteSession);

    const onClose = vi.fn();
    render(<PenSettingsPopup open={true} onClose={onClose} />);

    fireEvent.click(screen.getByTestId('pen-type-fountain-sharp'));
    expect(useSettings.getState().penType).toBe('fountain-sharp');

    fireEvent.click(screen.getByTestId('palette-color-2'));
    expect(useSettings.getState().activeSlot).toBe(2);

    fireEvent.click(screen.getByTestId('pen-settings-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockBlurEditor).toHaveBeenCalledTimes(3);
  });

  it('InkTemplate NodeView의 stopEvent는 펜 모드에서도 mousedown/click/touchstart를 차단하고 pointerdown S-Pen 경로는 보존한다', () => {
    const addNodeViewFn = (InkTemplate.config as unknown as {
      addNodeView: (this: { options: { noteId: string } }) => (props: {
        node: { attrs: Record<string, unknown> };
      }) => { stopEvent: (e: { type: string }) => boolean };
    }).addNodeView.call({ options: { noteId: 'test' } });
    const nodeView = addNodeViewFn({
      node: { attrs: { page: 1, width: 595, height: 842 } },
    });

    useSettings.setState({ tool: 'pencil' });
    expect(nodeView.stopEvent({ type: 'pointerdown' })).toBe(false);
    expect(nodeView.stopEvent({ type: 'mousedown' })).toBe(true);
    expect(nodeView.stopEvent({ type: 'click' })).toBe(true);
    expect(nodeView.stopEvent({ type: 'touchstart' })).toBe(true);

    useSettings.setState({ tool: 'none' });
    expect(nodeView.stopEvent({ type: 'pointerdown' })).toBe(true);
  });
});
