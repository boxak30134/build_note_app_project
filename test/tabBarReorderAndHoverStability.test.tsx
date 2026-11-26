// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TabBar } from '../src/components/TabBar';
import { useTabs } from '../src/store/tabsStore';
import { requestCloseTab } from '../src/features/tabActions';

vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: () =>
    useTabs.getState().openDocTabs.map((id) => ({
      id,
      title: `문서-${id}`,
    })),
}));

vi.mock('../src/features/tabActions', () => ({
  requestCloseTab: vi.fn().mockResolvedValue(undefined),
}));

function makeMockDataTransfer() {
  const store: Record<string, string> = {};
  return {
    effectAllowed: 'all',
    dropEffect: 'none',
    setData: (k: string, v: string) => {
      store[k] = v;
    },
    getData: (k: string) => store[k] ?? '',
  };
}

describe('REQ_issues_25: 탭 순서 이동(Drag/Keyboard) 및 Hover 너비 고정(X 버튼 오클릭 방지)', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    useTabs.setState({
      openDocTabs: ['t1', 't2', 't3'],
      activeTabId: 't1',
      splitOpen: false,
      secondaryTabId: null,
      focusedPane: 'primary',
      pendingScroll: {},
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('1. useTabs moveTab / reorderTabById가 탭 순서를 원자적으로 변경하고 경계값·활성 상태를 보존한다', () => {
    useTabs.setState({
      splitOpen: true,
      secondaryTabId: 't3',
      focusedPane: 'secondary',
    });

    useTabs.getState().moveTab(0, 2);
    expect(useTabs.getState().openDocTabs).toEqual(['t2', 't3', 't1']);
    expect(useTabs.getState().activeTabId).toBe('t1');
    expect(useTabs.getState().secondaryTabId).toBe('t3');
    expect(useTabs.getState().focusedPane).toBe('secondary');

    useTabs.getState().reorderTabById('t1', 't2');
    expect(useTabs.getState().openDocTabs).toEqual(['t1', 't2', 't3']);

    // 경계/무효 이동 무시
    useTabs.getState().moveTab(-1, 2);
    useTabs.getState().moveTab(0, 99);
    useTabs.getState().moveTab(1, 1);
    useTabs.getState().reorderTabById('missing', 't1');
    expect(useTabs.getState().openDocTabs).toEqual(['t1', 't2', 't3']);
  });

  it('2. TabBar에서 마우스 Drag & Drop으로 탭 위치를 이동할 수 있다', () => {
    render(<TabBar />);
    const dt = makeMockDataTransfer();

    const tab1 = screen.getByTestId('tab-item-t1');
    const tab3 = screen.getByTestId('tab-item-t3');

    fireEvent.dragStart(tab1, { dataTransfer: dt });
    fireEvent.dragOver(tab3, { dataTransfer: dt });
    fireEvent.drop(tab3, { dataTransfer: dt });
    fireEvent.dragEnd(tab1, { dataTransfer: dt });

    expect(useTabs.getState().openDocTabs).toEqual(['t2', 't3', 't1']);
    const renderedIds = screen
      .getAllByRole('tab')
      .map((el) => el.getAttribute('data-testid'));
    expect(renderedIds).toEqual(['tab-item-t2', 'tab-item-t3', 'tab-item-t1']);
  });

  it('3. Alt + ArrowRight / ArrowLeft 키보드 단축키로도 포커스된 탭 위치를 이동할 수 있다', () => {
    render(<TabBar />);
    const tab1 = screen.getByTestId('tab-item-t1');

    fireEvent.keyDown(tab1, { key: 'ArrowRight', altKey: true });
    expect(useTabs.getState().openDocTabs).toEqual(['t2', 't1', 't3']);

    const movedTab1 = screen.getByTestId('tab-item-t1');
    fireEvent.keyDown(movedTab1, { key: 'ArrowLeft', altKey: true });
    expect(useTabs.getState().openDocTabs).toEqual(['t1', 't2', 't3']);
  });

  it('4. Hover 시 분할 버튼이 display:none에서 토글되어 탭 너비가 변하지 않도록 고정 공간을 점유하며 X 닫기 오클릭을 차단한다', () => {
    render(<TabBar />);
    const splitBtn = screen.getByTestId('tab-split-t2');
    const closeBtn = screen.getByTestId('tab-close-t2');

    // hidden / group-hover:inline-flex 토글이 없어야 하며 고정 크기(h-5 w-5 shrink-0 inline-flex)와 pointer-events-none이어야 함
    expect(splitBtn.className).toContain('inline-flex');
    expect(splitBtn.className).toContain('shrink-0');
    expect(splitBtn.className).toContain('pointer-events-none');
    expect(splitBtn.className).toContain('opacity-0');
    expect(splitBtn.className).not.toContain('hidden');
    expect(splitBtn.className).not.toContain('group-hover:inline-flex');

    // 닫기 버튼 클릭 시 이벤트 버블링으로 다른 탭이 활성화되지 않아야 함
    fireEvent.click(closeBtn);
    expect(requestCloseTab).toHaveBeenCalledWith('t2');
    expect(useTabs.getState().activeTabId).toBe('t1');

    // 닫기 버튼 위에서의 드래그 시작은 탭 재정렬을 유발하지 않아야 함
    const dt = makeMockDataTransfer();
    fireEvent.dragStart(closeBtn, { dataTransfer: dt });
    fireEvent.drop(screen.getByTestId('tab-item-t3'), { dataTransfer: dt });
    expect(useTabs.getState().openDocTabs).toEqual(['t1', 't2', 't3']);
  });
});
