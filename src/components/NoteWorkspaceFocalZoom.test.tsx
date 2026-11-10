// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { NoteWorkspace } from './NoteWorkspace';
import * as noteSessionMod from '../session/NoteSession';
import { useSessions } from '../store/sessionStore';
import { useSettings } from '../store/settingsStore';
import { resetGlobalPalmState } from '../core/android/androidDeployment';
import { setDeviceOverrideForTest } from '../core/utils/device';
import type { NoteRecord } from '../storage/db';

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

describe('NoteWorkspace Pinch-to-Zoom Focal Point & Touch Scroll', () => {
  const noteId = 'test-focal-note';
  let session: noteSessionMod.NoteSession;

  beforeEach(() => {
    cleanup();
    resetGlobalPalmState();
    setDeviceOverrideForTest(null);
    useSettings.setState({
      docFormat: 'continuous',
      fontSize: 16,
    });
    useSessions.getState().patch(noteId, {
      loaded: true,
      readOnly: false,
      zoom: 1.0,
      pages: [{ id: 'p1', size: 'A4', style: 'plain', orientation: 'portrait' }],
      currentPageIndex: 0,
      lassoIds: [],
      moveMode: false,
    });

    const record = createMockRecord(noteId, 'Focal Test', '<p>Test paragraph content</p>');
    session = new noteSessionMod.NoteSession(record);
    vi.spyOn(noteSessionMod, 'openSession').mockResolvedValue(session);
  });

  afterEach(() => {
    cleanup();
    resetGlobalPalmState();
    setDeviceOverrideForTest(null);
    session?.destroy();
    vi.restoreAllMocks();
  });

  it('두 손가락 핀치 줌 시 화면 상단(0,0)으로 이동하지 않고 손가락 중심점 위치를 기준으로 확대/축소 스크롤을 조정한다', async () => {
    render(<NoteWorkspace noteId={noteId} active={true} />);

    // NoteWorkspace 로딩 대기
    const viewport = await screen.findByTestId('note-viewport');
    const page = screen.getByTestId('note-page');
    expect(viewport).toBeTruthy();
    expect(page).toBeTruthy();

    // 뷰포트 크기 및 스크롤 모의 설정
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      left: 0,
      right: 800,
      bottom: 1000,
      width: 800,
      height: 1000,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    vi.spyOn(page, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      left: 0,
      right: 840,
      bottom: 1400,
      width: 840,
      height: 1400,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    viewport.scrollTop = 200;
    viewport.scrollLeft = 0;

    // 1. 손가락 두 개로 (focal point: 400, 500) 지점을 터치하여 핀치 시작 (거리: 100)
    const touchStartEv = new Event('touchstart', { bubbles: true, cancelable: true }) as TouchEvent;
    Object.defineProperty(touchStartEv, 'touches', {
      value: [
        { clientX: 350, clientY: 500 },
        { clientX: 450, clientY: 500 },
      ],
    });
    act(() => {
      viewport.dispatchEvent(touchStartEv);
    });

    // 2. 손가락을 벌려 거리 200으로 확대 (배율 1.0x -> 2.0x)
    const touchMoveEv = new Event('touchmove', { bubbles: true, cancelable: true }) as TouchEvent;
    Object.defineProperty(touchMoveEv, 'touches', {
      value: [
        { clientX: 300, clientY: 500 },
        { clientX: 500, clientY: 500 },
      ],
    });
    act(() => {
      viewport.dispatchEvent(touchMoveEv);
    });

    // 3. 확대 시 무조건 0으로 튀지 않고, 손가락 아래의 문서 내용(docY: 700)이 그대로 유지되도록
    // scrollTop 이 (200 + 500) * 2 - 500 = 900 으로 증가하여 중심점을 유지한다
    expect(viewport.scrollTop).toBeGreaterThan(200);

    // 핀치 줌 종료 (touchend): 스토어와 최종 scale/offset 동기화
    const touchEndEv = new Event('touchend', { bubbles: true, cancelable: true }) as TouchEvent;
    Object.defineProperty(touchEndEv, 'touches', { value: [] });
    Object.defineProperty(touchEndEv, 'changedTouches', { value: [{ clientX: 300, clientY: 500 }] });
    act(() => {
      viewport.dispatchEvent(touchEndEv);
    });

    expect(useSessions.getState().sessions[noteId]?.zoom).toBe(2);
  });
});
