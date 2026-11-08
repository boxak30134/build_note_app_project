// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { Toolbar } from './Toolbar';
import { useSettings } from '../store/settingsStore';
import { useTabs } from '../store/tabsStore';
import * as noteSessionMod from '../session/NoteSession';

vi.mock('../search/searchClient', () => ({
  indexNote: vi.fn(),
  unindexNote: vi.fn(),
  searchRelated: vi.fn().mockResolvedValue([]),
}));

describe('Toolbar Font Size & Text Color Controls UI', () => {
  const mockApplyFontSize = vi.fn();
  const mockApplyTextColor = vi.fn();

  beforeEach(() => {
    cleanup();
    useSettings.setState({
      fontSize: 16,
      tool: 'none',
      colorSlots: ['#EF4444', '#F97316', '#FACC15', '#22C55E', '#3B82F6', '#1E3A8A', '#8B5CF6', '#000000'],
      activeSlot: 7,
      isCustomColorActive: false,
    });
    useTabs.setState({ activeTabId: 'tab-test-1', openDocTabs: ['tab-test-1'] });

    vi.spyOn(noteSessionMod, 'getSession').mockReturnValue({
      applyFontSize: mockApplyFontSize,
      applyTextColor: mockApplyTextColor,
      undo: vi.fn(),
      redo: vi.fn(),
      applyFontFamily: vi.fn(),
    } as unknown as noteSessionMod.NoteSession);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('글자 크기 스텝퍼 (+, -) 클릭 시 폰트 크기가 조정되고 session.applyFontSize가 호출된다', () => {
    render(<Toolbar />);

    const incBtn = screen.getByTestId('font-size-inc-btn');
    const decBtn = screen.getByTestId('font-size-dec-btn');
    const dropdownBtn = screen.getByTestId('font-size-dropdown-btn');

    expect(dropdownBtn.textContent).toContain('16px');

    // + 클릭 -> 16에서 다음 프리셋인 18로 증가
    fireEvent.click(incBtn);
    expect(useSettings.getState().fontSize).toBe(18);
    expect(mockApplyFontSize).toHaveBeenCalledWith(18);

    // - 클릭 -> 18에서 이전 프리셋인 16으로 감소
    fireEvent.click(decBtn);
    expect(useSettings.getState().fontSize).toBe(16);
    expect(mockApplyFontSize).toHaveBeenCalledWith(16);
  });

  it('글자 크기 드롭다운을 열고 프리셋(24px)을 선택하면 24px로 변경된다', () => {
    render(<Toolbar />);

    const dropdownBtn = screen.getByTestId('font-size-dropdown-btn');
    fireEvent.click(dropdownBtn);

    const preset24 = screen.getByTestId('font-size-preset-24');
    fireEvent.click(preset24);

    expect(useSettings.getState().fontSize).toBe(24);
    expect(mockApplyFontSize).toHaveBeenCalledWith(24);
  });

  it('팔레트 색상 슬롯 클릭 시 session.applyTextColor가 해당 색상으로 호출된다', () => {
    render(<Toolbar />);

    const slot0 = screen.getByTestId('color-slot-0'); // #EF4444 (빨강)
    fireEvent.click(slot0);

    expect(mockApplyTextColor).toHaveBeenCalledWith('#EF4444');
    expect(useSettings.getState().activeSlot).toBe(0);
  });
});
