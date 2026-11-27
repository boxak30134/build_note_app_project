// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { NoteWorkspace } from '../src/components/NoteWorkspace';
import * as noteSessionMod from '../src/session/NoteSession';
import { emptyNote } from '../src/storage/db';
import { createPage } from '../src/core/page/pageTypes';
import { useTabs } from '../src/store/tabsStore';

vi.mock('../src/search/searchClient', () => ({
  indexNote: vi.fn(),
  unindexNote: vi.fn(),
  searchRelated: vi.fn().mockResolvedValue([]),
}));

describe('REQ_restore_last_view_position: 마지막 열람 문서·페이지·스크롤 위치 저장 및 복원', () => {
  beforeEach(() => {
    localStorage.clear();
    useTabs.setState({
      openDocTabs: [],
      activeTabId: null,
      splitOpen: false,
      secondaryTabId: null,
      focusedPane: 'primary',
      noteViewPositions: {},
      pendingScroll: {},
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('1. tabsStore에 저장된 마지막 열람 위치가 NoteSession 재시작 시 currentPageIndex·zoom에 복원되고 페이지 축소 시 안전 클램핑된다', () => {
    const noteId = 'note-restore-session';
    useTabs.getState().saveNoteViewPosition(noteId, {
      pageIndex: 3,
      scrollTop: 2400,
      scrollLeft: 40,
      zoom: 1.75,
    });

    const pages = Array.from({ length: 5 }, () => createPage({ size: 'A4', orientation: 'portrait' }));
    const note = emptyNote({ id: noteId, title: '긴 PDF 노트', pages });

    const session = new noteSessionMod.NoteSession(note);
    try {
      expect(session.ui.currentPageIndex).toBe(3);
      expect(session.ui.zoom).toBe(1.75);
    } finally {
      session.destroy();
    }

    // 페이지 수가 2개로 줄어든 경우 [0, 1] 범위로 클램핑
    const shrunkNote = emptyNote({
      id: noteId,
      title: '축소된 노트',
      pages: [createPage(), createPage()],
    });
    const shrunkSession = new noteSessionMod.NoteSession(shrunkNote);
    try {
      expect(shrunkSession.ui.currentPageIndex).toBe(1);
    } finally {
      shrunkSession.destroy();
    }
  });

  it('2. NoteWorkspace 마운트 시 마지막 스크롤 위치(scrollTop/scrollLeft)를 즉시 복원하고, 스크롤 시 새 위치를 저장한다', async () => {
    vi.useFakeTimers();
    const noteId = 'note-restore-workspace';
    useTabs.getState().saveNoteViewPosition(noteId, {
      pageIndex: 2,
      scrollTop: 1850,
      scrollLeft: 120,
      zoom: 1.5,
    });

    const pages = Array.from({ length: 4 }, () => createPage({ size: 'A4', orientation: 'portrait' }));
    const note = emptyNote({ id: noteId, title: '재오픈 테스트 노트', pages });
    const session = new noteSessionMod.NoteSession(note);
    vi.spyOn(noteSessionMod, 'openSession').mockResolvedValue(session);

    try {
      const { container } = render(<NoteWorkspace noteId={noteId} active={true} />);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      const viewport = container.querySelector('.note-viewport') as HTMLDivElement;
      expect(viewport).toBeTruthy();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(220);
      });

      expect(viewport.scrollTop).toBe(1850);
      expect(viewport.scrollLeft).toBe(120);
      expect(session.ui.currentPageIndex).toBe(2);

      // 복원 완료 후 사용자가 새로 스크롤하면 150ms 디바운스 후 갱신 저장됨
      viewport.scrollTop = 2600;
      viewport.scrollLeft = 80;
      viewport.dispatchEvent(new Event('scroll'));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(180);
      });
      const savedAfterScroll = useTabs.getState().noteViewPositions[noteId];
      expect(savedAfterScroll.scrollTop).toBe(2600);
      expect(savedAfterScroll.scrollLeft).toBe(80);
    } finally {
      session.destroy();
    }
  });

  it('3. 위키링크 블록 이동(pendingScroll)이 설정된 경우 저장된 이전 위치로 덮어쓰지 않는다', async () => {
    vi.useFakeTimers();
    const noteId = 'note-wikilink-priority';
    useTabs.getState().saveNoteViewPosition(noteId, {
      pageIndex: 2,
      scrollTop: 1500,
      scrollLeft: 0,
    });
    useTabs.getState().openTab(noteId, 'target-block-1');

    const pages = Array.from({ length: 3 }, () => createPage({ size: 'A4', orientation: 'portrait' }));
    const note = emptyNote({ id: noteId, title: '위키링크 타깃', pages });
    const session = new noteSessionMod.NoteSession(note);
    vi.spyOn(noteSessionMod, 'openSession').mockResolvedValue(session);

    try {
      const { container } = render(<NoteWorkspace noteId={noteId} active={true} />);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      const viewport = container.querySelector('.note-viewport') as HTMLDivElement;
      expect(viewport).toBeTruthy();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      expect(viewport.scrollTop).toBe(0);
    } finally {
      session.destroy();
    }
  });
});
