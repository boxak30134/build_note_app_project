// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { NoteWorkspace } from './NoteWorkspace';
import * as noteSessionMod from '../session/NoteSession';
import { useSessions } from '../store/sessionStore';
import { useSettings } from '../store/settingsStore';
import type { NoteRecord } from '../storage/db';
import { resetGlobalPalmState } from '../core/android/androidDeployment';

vi.mock('../search/searchClient', () => ({
  indexNote: vi.fn(),
  unindexNote: vi.fn(),
  searchRelated: vi.fn().mockResolvedValue([]),
}));

type PointerInit = { pointerId: number; pointerType: string; clientX: number; clientY: number; timeStamp?: number };

function firePointer(target: Element, type: string, init: PointerInit) {
  const ev = new Event(type, { bubbles: true, cancelable: true }) as PointerEvent;
  Object.defineProperties(ev, {
    pointerId: { value: init.pointerId },
    pointerType: { value: init.pointerType },
    clientX: { value: init.clientX },
    clientY: { value: init.clientY },
    pressure: { value: 0.5 },
    button: { value: 0 },
    buttons: { value: 1 },
    timeStamp: { value: init.timeStamp ?? 0 },
  });
  act(() => {
    target.dispatchEvent(ev);
  });
  return ev;
}

function createMockRecord(id: string): NoteRecord {
  return {
    id,
    title: 'Isolation',
    folderId: null,
    content: '<p>Isolation test</p>',
    markdown: 'Isolation test',
    plainText: 'Isolation test',
    strokes: [],
    annotations: [],
    encoding: 'utf-8',
    eol: 'lf',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

describe('S-Pen 필기 ↔ 손가락 제스처 격리', () => {
  const noteId = 'test-spen-isolation';
  let session: noteSessionMod.NoteSession;

  beforeEach(() => {
    cleanup();
    resetGlobalPalmState();
    useSettings.setState({ docFormat: 'continuous', fontSize: 16, tool: 'pencil', mouseDraw: false });
    useSessions.getState().patch(noteId, {
      loaded: true,
      readOnly: false,
      zoom: 1.0,
      pages: [{ id: 'p1', size: 'A4', style: 'plain', orientation: 'portrait' }],
      currentPageIndex: 0,
      lassoIds: [],
      moveMode: false,
    });
    session = new noteSessionMod.NoteSession(createMockRecord(noteId));
    vi.spyOn(noteSessionMod, 'openSession').mockResolvedValue(session);
  });

  afterEach(() => {
    resetGlobalPalmState();
    cleanup();
    session?.destroy();
    vi.restoreAllMocks();
  });

  it('S-Pen 으로 상하좌우 획을 그어도 뷰포트 스크롤·줌이 전혀 변하지 않는다', async () => {
    render(<NoteWorkspace noteId={noteId} active={true} />);
    const viewport = await screen.findByTestId('note-viewport');
    const pageEl = viewport.querySelector<HTMLElement>('.page-canvas-surface') ?? viewport;
    viewport.scrollTop = 300;
    viewport.scrollLeft = 20;

    firePointer(pageEl, 'pointerdown', { pointerId: 7, pointerType: 'pen', clientX: 100, clientY: 100 });
    const move = firePointer(pageEl, 'pointermove', { pointerId: 7, pointerType: 'pen', clientX: 300, clientY: 400 });
    firePointer(pageEl, 'pointermove', { pointerId: 7, pointerType: 'pen', clientX: 10, clientY: 5 });
    firePointer(pageEl, 'pointerup', { pointerId: 7, pointerType: 'pen', clientX: 10, clientY: 5 });

    expect(move.defaultPrevented).toBe(true);
    expect(viewport.scrollTop).toBe(300);
    expect(viewport.scrollLeft).toBe(20);
    expect(useSessions.getState().sessions[noteId]?.zoom).toBe(1);
  });

  it('손가락 1개 드래그는 이동량만큼 뷰포트를 패닝한다', async () => {
    render(<NoteWorkspace noteId={noteId} active={true} />);
    const viewport = await screen.findByTestId('note-viewport');
    viewport.scrollTop = 300;
    viewport.scrollLeft = 0;

    firePointer(viewport, 'pointerdown', { pointerId: 1, pointerType: 'touch', clientX: 200, clientY: 500, timeStamp: 0 });
    firePointer(viewport, 'pointermove', { pointerId: 1, pointerType: 'touch', clientX: 200, clientY: 420, timeStamp: 500 });
    firePointer(viewport, 'pointerup', { pointerId: 1, pointerType: 'touch', clientX: 200, clientY: 420, timeStamp: 1000 });

    expect(viewport.scrollTop).toBe(380);
  });

  it('필기 중 손바닥(touch)이 닿아도 핀치 줌·패닝으로 오인되지 않는다 (Palm Rejection)', async () => {
    render(<NoteWorkspace noteId={noteId} active={true} />);
    const viewport = await screen.findByTestId('note-viewport');
    const pageEl = viewport.querySelector<HTMLElement>('.page-canvas-surface') ?? viewport;
    viewport.scrollTop = 300;

    firePointer(pageEl, 'pointerdown', { pointerId: 7, pointerType: 'pen', clientX: 100, clientY: 100 });
    firePointer(viewport, 'pointerdown', { pointerId: 2, pointerType: 'touch', clientX: 400, clientY: 600 });
    firePointer(viewport, 'pointerdown', { pointerId: 3, pointerType: 'touch', clientX: 500, clientY: 600 });
    firePointer(viewport, 'pointermove', { pointerId: 3, pointerType: 'touch', clientX: 700, clientY: 300 });
    firePointer(pageEl, 'pointermove', { pointerId: 7, pointerType: 'pen', clientX: 150, clientY: 130 });
    firePointer(pageEl, 'pointerup', { pointerId: 7, pointerType: 'pen', clientX: 150, clientY: 130 });

    expect(viewport.scrollTop).toBe(300);
    expect(useSessions.getState().sessions[noteId]?.zoom).toBe(1);
  });
});
