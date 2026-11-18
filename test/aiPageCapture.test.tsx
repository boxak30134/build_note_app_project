// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { renderPageStrokesToDataUrl } from '../src/canvas/render';
import { NoteSession } from '../src/session/NoteSession';
import * as noteSessionMod from '../src/session/NoteSession';
import { RightSidebar } from '../src/components/RightSidebar';
import * as aiModule from '../src/modules/ai';
import { useAiChatStore } from '../src/store/aiChatStore';
import { useSettings } from '../src/store/settingsStore';
import { useTabs } from '../src/store/tabsStore';
import { emptyNote } from '../src/storage/db';
import type { Stroke } from '../src/core/strokes/StrokeStore';

vi.mock('../src/ai/useConnectedProviders', () => ({
  useConnectedProviders: () => ['google'],
  useProvidersLoaded: () => true,
  refreshProviders: vi.fn().mockResolvedValue(['google']),
}));

vi.mock('../src/search/searchClient', () => ({
  indexNote: vi.fn(),
  unindexNote: vi.fn(),
  searchRelated: vi.fn().mockResolvedValue([]),
}));

function mockCanvas2d() {
  const ctx = {
    imageSmoothingEnabled: true,
    imageSmoothingQuality: 'high',
    fillStyle: '#ffffff',
    strokeStyle: '#000000',
    lineWidth: 1,
    lineCap: 'round',
    lineJoin: 'round',
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    fillRect: vi.fn(),
    scale: vi.fn(),
    translate: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    quadraticCurveTo: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    closePath: vi.fn(),
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/webp;base64,QUJDREVGRw==');
}

describe('REQ_issues_13: 노트 페이지 손글씨 캡처 및 AI 허브 멀티모달 질의', () => {
  beforeEach(() => {
    cleanup();
    vi.restoreAllMocks();
    mockCanvas2d();
    useSettings.setState({ aiProvider: 'google' });
    useTabs.setState({ activeTabId: null, openDocTabs: [] });
    useAiChatStore.setState({
      messages: [],
      inputDraft: '',
      busy: false,
      statusInfo: { status: 'idle', message: '' },
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('1. renderPageStrokesToDataUrl이 빈 스트로크는 null, 유효 스트로크는 DataURL을 반환한다', () => {
    expect(renderPageStrokesToDataUrl([])).toBeNull();

    const stroke: Stroke = {
      id: 'st-1',
      tool: 'pencil',
      color: '#111827',
      size: 2,
      points: [
        [10, 10, 0.5],
        [40, 25, 0.6],
        [80, 40, 0.5],
      ],
    };
    const url = renderPageStrokesToDataUrl([stroke], { mimeType: 'image/webp' });
    expect(url).toBe('data:image/webp;base64,QUJDREVGRw==');
  });

  it('2. NoteSession.captureCurrentPageImage가 현재 페이지의 스트로크만 캡처한다', async () => {
    const note = emptyNote({
      id: 'note-cap-1',
      title: '미적분 풀이',
      pages: [
        { id: 'page-0', size: 'A4', style: 'blank', orientation: 'portrait' },
        { id: 'page-1', size: 'A4', style: 'blank', orientation: 'portrait' },
      ],
      strokes: [
        { id: 's0', tool: 'pencil', color: '#000', size: 2, points: [[10, 10, 0.5], [20, 20, 0.5]] },
      ],
    });
    const session = new NoteSession(note);

    // 페이지 0에는 손글씨 있음
    const cap0 = await session.captureCurrentPageImage();
    expect(cap0).not.toBeNull();
    expect(cap0?.pageIndex).toBe(0);
    expect(cap0?.dataUrl).toContain('data:image/');

    // 페이지 1로 전환 -> 손글씨 없으므로 null 반환
    session.patch({ currentPageIndex: 1 });
    const cap1 = await session.captureCurrentPageImage();
    expect(cap1).toBeNull();

    session.destroy();
  });

  it('3. RightSidebar [페이지 캡처] 클릭 후 전송 시 멀티모달 파일 파트가 AI로 전달되고 채팅에 표시된다', async () => {
    const note = emptyNote({
      id: 'note-cap-ui-1',
      title: '물리 풀이',
      strokes: [
        { id: 's-ui-1', tool: 'pencil', color: '#000', size: 2, points: [[15, 15, 0.5], [60, 45, 0.7]] },
      ],
    });
    const session = new NoteSession(note);
    useTabs.setState({ activeTabId: note.id, openDocTabs: [note.id] });
    vi.spyOn(noteSessionMod, 'getSession').mockReturnValue(session);

    let capturedMessages: unknown[] = [];
    vi.spyOn(aiModule, 'streamGeminiTutor').mockImplementation((opts) => {
      capturedMessages = opts.messages as unknown[];
      return (async function* () {
        yield '풀이 과정이 **정확합니다**.';
      })();
    });

    render(<RightSidebar />);

    const captureBtn = screen.getByTestId('ai-capture-page-btn');
    fireEvent.click(captureBtn);

    const attachedBox = await screen.findByTestId('ai-attached-page-image');
    expect(attachedBox.textContent).toContain('페이지 1 캡처 첨부됨');

    const submitBtn = screen.getByTitle('전송');
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(screen.queryByTestId('ai-attached-page-image')).toBeNull();
      expect(screen.getByTestId('ai-chat-assistant-markdown').textContent).toContain('정확합니다');
    });

    const lastMsg = capturedMessages[capturedMessages.length - 1] as {
      role: string;
      content: Array<{ type: string; text?: string; mediaType?: string; data?: string }>;
    };
    expect(lastMsg.role).toBe('user');
    expect(Array.isArray(lastMsg.content)).toBe(true);
    expect(lastMsg.content.some((p) => p.type === 'text')).toBe(true);
    expect(lastMsg.content.some((p) => p.type === 'file' && p.mediaType === 'image/webp' && p.data === 'QUJDREVGRw==')).toBe(true);

    session.destroy();
  });
});
