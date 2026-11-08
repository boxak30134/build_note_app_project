// @vitest-environment jsdom
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OverlayLayer } from './OverlayLayer';
import { ContextMenu } from './ContextMenu';
import { CompositeHistoryManager } from '../core/history/CompositeHistoryManager';
import { StrokeStore, type Stroke } from '../core/strokes/StrokeStore';
import { useSessions } from '../store/sessionStore';
import { useContextMenu, strokeClipboard } from '../store/contextMenuStore';
import * as NoteSessionModule from '../session/NoteSession';
import type { NoteSession } from '../session/NoteSession';

function createSampleStroke(id: string, y: number, xStart = 10, xEnd = 100): Stroke {
  return {
    id,
    tool: 'pencil',
    color: '#000000',
    size: 4,
    points: [
      [xStart, y, 0.5],
      [(xStart + xEnd) / 2, y, 0.5],
      [xEnd, y, 0.5],
    ],
  };
}

describe('LassoActionBar & ContextMenu (선택 영역 직상단 z-50 배치 및 손글씨·텍스트 클립보드 통합)', () => {
  const noteId = 'test-note-lasso-menu';
  let history: CompositeHistoryManager;
  let strokes: StrokeStore;
  let mockSession: NoteSession;
  let pageEl: HTMLElement;
  let editorSelectionEmpty: boolean;
  let selectedText: string;
  let insertedTexts: string[];

  beforeEach(() => {
    editorSelectionEmpty = true;
    selectedText = '';
    insertedTexts = [];
    strokeClipboard.strokes = [];
    strokeClipboard.active = false;

    history = new CompositeHistoryManager();
    strokes = new StrokeStore(history, [
      createSampleStroke('s-top', 150, 10, 150),
      createSampleStroke('s-target', 200, 10, 150),
    ]);

    useSessions.getState().patch(noteId, {
      loaded: true,
      readOnly: false,
      lassoIds: [],
      moveMode: false,
      zoom: 1,
      annotations: [],
      citations: [],
    });

    pageEl = document.createElement('div');
    document.body.appendChild(pageEl);

    vi.spyOn(pageEl, 'getBoundingClientRect').mockReturnValue({
      left: 100,
      top: 100,
      right: 900,
      bottom: 1200,
      width: 800,
      height: 1100,
      x: 100,
      y: 100,
      toJSON: () => {},
    });

    mockSession = {
      id: noteId,
      strokes,
      pageEl,
      scrollEl: null,
      host: document.createElement('div'),
      editor: {
        isDestroyed: false,
        on: vi.fn(),
        off: vi.fn(),
        view: { coordsAtPos: vi.fn() },
        state: {
          get selection() {
            return { empty: editorSelectionEmpty, from: 0, to: selectedText.length };
          },
          doc: {
            content: { size: 100 },
            textBetween: () => selectedText,
          },
        },
        chain: () => ({
          focus: () => ({
            insertContent: (txt: string) => ({
              run: () => {
                insertedTexts.push(txt);
                return true;
              },
            }),
          }),
        }),
      } as unknown as NoteSession['editor'],
      ui: {
        get lassoIds() {
          return useSessions.getState().sessions[noteId]?.lassoIds ?? [];
        },
        get moveMode() {
          return useSessions.getState().sessions[noteId]?.moveMode ?? false;
        },
        get zoom() {
          return useSessions.getState().sessions[noteId]?.zoom ?? 1;
        },
        get annotations() {
          return useSessions.getState().sessions[noteId]?.annotations ?? [];
        },
        get citations() {
          return useSessions.getState().sessions[noteId]?.citations ?? [];
        },
      } as unknown as NoteSession['ui'],
      patch: (patch: Parameters<NoteSession['patch']>[0]) => {
        useSessions.getState().patch(noteId, patch);
      },
      createAnnotation: vi.fn(),
    } as unknown as NoteSession;

    vi.spyOn(NoteSessionModule, 'getSession').mockReturnValue(mockSession);
  });

  afterEach(() => {
    cleanup();
    useContextMenu.getState().hide();
    if (pageEl.parentElement) {
      pageEl.parentElement.removeChild(pageEl);
    }
    vi.restoreAllMocks();
  });

  it('1. 올가미 선택 시 메뉴가 화면 맨 위(0,0)로 튀지 않고 선택 영역 바로 위 좌표에 z-50으로 표시된다', () => {
    act(() => {
      mockSession.patch({ lassoIds: ['s-target'] });
    });

    render(<OverlayLayer session={mockSession} />);

    const actionBar = screen.getByTestId('lasso-action-bar');
    expect(actionBar).toBeTruthy();
    expect(actionBar.className).toContain('z-50');
    expect(actionBar.className).toContain('bg-white');

    // 화면 좌상단(0,0)이 아니라 선택 영역(page.top=100, s-target.minY=198 -> top = 100 + 198 - 52 = 246px) 바로 위에 위치해야 함
    const leftPx = parseInt(actionBar.style.left, 10);
    const topPx = parseInt(actionBar.style.top, 10);
    expect(leftPx).toBeGreaterThan(90);
    expect(topPx).toBe(246);
  });

  it('2. 컨텍스트 메뉴에서 별도의 필기 전용 버튼이 제거되고 단일 [복사]/[붙여넣기] 버튼으로 손글씨와 키보드 텍스트가 간섭 없이 동작한다', async () => {
    let clipboardText = '';
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn(async (t: string) => {
          clipboardText = t;
        }),
        readText: vi.fn(async () => clipboardText),
      },
    });

    // (A) 올가미로 손글씨 선택 후 컨텍스트 메뉴 오픈
    act(() => {
      mockSession.patch({ lassoIds: ['s-target'] });
      useContextMenu.getState().show({ x: 200, y: 200, noteId, pagePoint: { x: 300, y: 300 } });
    });

    const { rerender } = render(<ContextMenu />);

    // 별도의 '필기 붙여넣기'나 '필기복사' 버튼이 없어야 함
    expect(screen.queryByText(/필기/)).toBeNull();

    // 단일 '복사' 버튼 클릭 -> 손글씨가 복사되고 active=true
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '복사' }));
    });
    expect(strokeClipboard.strokes).toHaveLength(1);
    expect(strokeClipboard.active).toBe(true);

    // 컨텍스트 메뉴 다시 열고 단일 '붙여넣기' 클릭 -> 손글씨 스트로크가 추가됨
    act(() => {
      useContextMenu.getState().show({ x: 250, y: 250, noteId, pagePoint: { x: 320, y: 320 } });
    });
    rerender(<ContextMenu />);

    const beforeCount = strokes.getAll().length;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '붙여넣기' }));
    });
    expect(strokes.getAll().length).toBe(beforeCount + 1);

    // (B) 키보드로 입력한 텍스트 선택 후 '복사' -> '붙여넣기' 시 텍스트가 정상 복사/붙여넣기되고 손글씨는 중복 붙여넣기되지 않음
    editorSelectionEmpty = false;
    selectedText = '키보드 입력 텍스트';
    act(() => {
      mockSession.patch({ lassoIds: [] });
      useContextMenu.getState().show({ x: 260, y: 260, noteId, pagePoint: { x: 350, y: 350 } });
    });
    rerender(<ContextMenu />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '복사' }));
    });
    expect(strokeClipboard.active).toBe(false);
    expect(clipboardText).toBe('키보드 입력 텍스트');

    editorSelectionEmpty = true;
    act(() => {
      useContextMenu.getState().show({ x: 260, y: 260, noteId, pagePoint: { x: 350, y: 350 } });
    });
    rerender(<ContextMenu />);

    const strokeCountBeforeTextPaste = strokes.getAll().length;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '붙여넣기' }));
    });
    expect(insertedTexts).toEqual(['키보드 입력 텍스트']);
    expect(strokes.getAll().length).toBe(strokeCountBeforeTextPaste);
  });

  it('3. 올가미 액션바의 이동(moveMode), 삭제(lassoDelete), 말풍선(createAnnotation) 버튼이 정상 동작한다', () => {
    act(() => {
      mockSession.patch({ lassoIds: ['s-target'] });
    });

    render(<OverlayLayer session={mockSession} />);

    fireEvent.click(screen.getByRole('button', { name: /이동/ }));
    expect(mockSession.ui.moveMode).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: /말풍선/ }));
    expect(mockSession.createAnnotation).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: /삭제/ }));
    expect(strokes.getAll().map((s) => s.id)).not.toContain('s-target');
    expect(mockSession.ui.lassoIds).toHaveLength(0);
  });
});
