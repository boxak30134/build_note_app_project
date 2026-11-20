// @vitest-environment jsdom
import { createRef } from 'react';
import { render, cleanup, act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InkCanvas, CHUNK_HEIGHT, computeVisibleChunkRange } from '../src/canvas/InkCanvas';
import {
  computeCausalSmoothedPoints,
  computeCausalStrokeWidths,
  getIncrementalStrokeGeometry,
} from '../src/canvas/render';
import { CompositeHistoryManager } from '../src/core/history/CompositeHistoryManager';
import { StrokeStore, newStrokeId, type Stroke } from '../src/core/strokes/StrokeStore';
import { useSettings } from '../src/store/settingsStore';
import { useSessions } from '../src/store/sessionStore';
import { NoteSession } from '../src/session/NoteSession';
import type { NoteRecord } from '../src/storage/db';
import { createPage } from '../src/core/page/pageTypes';

vi.mock('../src/storage/db', () => ({
  uid: (prefix = 'id') => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
  db: {
    notes: {
      put: vi.fn().mockResolvedValue('test-note-id'),
      get: vi.fn().mockResolvedValue(null),
    },
  },
}));

vi.mock('../src/storage/opfs', () => ({
  attachmentUrl: vi.fn().mockResolvedValue('blob:test'),
  writeAttachment: vi.fn().mockResolvedValue(undefined),
  deleteAttachment: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/features/search/documentLinker', () => ({
  searchRelatedDocuments: vi.fn().mockResolvedValue([]),
}));

type Sample = { clientX: number; clientY: number; pressure?: number };

function dispatchPen(target: HTMLElement, type: string, s: Sample, coalesced?: Sample[]) {
  const ev = new Event(type, { bubbles: true, cancelable: true }) as PointerEvent;
  const mk = (c: Sample) =>
    ({ ...c, pressure: c.pressure ?? 0.6, pointerType: 'pen', pointerId: 11 }) as unknown as PointerEvent;
  Object.defineProperties(ev, {
    pointerId: { value: 11 },
    pointerType: { value: 'pen' },
    clientX: { value: s.clientX },
    clientY: { value: s.clientY },
    button: { value: 0 },
    buttons: { value: type === 'pointerup' ? 0 : 1 },
    pressure: { value: s.pressure ?? 0.6 },
    getCoalescedEvents: { value: () => (coalesced ?? [s]).map(mk) },
  });
  target.dispatchEvent(ev);
}

function makeMockCtx() {
  const ops: string[] = [];
  const ctx = {
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    lineCap: 'round',
    lineJoin: 'round',
    lineWidth: 1,
    strokeStyle: '#000',
    fillStyle: '#000',
    imageSmoothingEnabled: true,
    imageSmoothingQuality: 'high',
    save: vi.fn(() => {
      ops.push(`save:${ctx.globalCompositeOperation}`);
    }),
    restore: vi.fn(() => {
      ops.push('restore');
      ctx.globalCompositeOperation = 'source-over';
    }),
    setTransform: vi.fn(),
    translate: vi.fn(),
    scale: vi.fn(),
    clearRect: vi.fn(() => {
      ops.push('clearRect');
    }),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    quadraticCurveTo: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(() => {
      ops.push(`stroke:${ctx.globalCompositeOperation}`);
    }),
    drawImage: vi.fn(),
    setLineDash: vi.fn(),
    strokeRect: vi.fn(),
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, ops };
}

function createMockRecord(partial: Partial<NoteRecord> = {}): NoteRecord {
  const now = Date.now();
  return {
    id: 'mock-canvas-opt-note',
    title: '캔버스 최적화 테스트 노트',
    folderId: null,
    content: { type: 'doc', content: [] },
    markdown: '',
    plainText: '',
    strokes: [],
    annotations: [],
    textObjects: [],
    pages: [createPage()],
    encoding: 'utf-8',
    eol: 'lf',
    fileHandle: null,
    fileLastModified: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    ...partial,
  };
}

describe('REQ_canvas_rendering_optimization: 2-레이어 분리 · ±1 청크 가상화 · RAF 루프 검증', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('1. 다중 페이지(25,000px)에서 가시 영역 ±1 청크만 마운트하고 스크롤 이탈 청크는 width/height=0으로 컨텍스트를 해제한다', async () => {
    expect(computeVisibleChunkRange(25000, 0, 900, 1)).toEqual({ start: 0, end: 1, total: 16 });
    expect(computeVisibleChunkRange(25000, 9800, 900, 1)).toEqual({ start: 5, end: 7, total: 16 });

    useSettings.setState({ tool: 'pencil', penSize: 4, autoStraighten: false });
    const history = new CompositeHistoryManager();
    const strokeInChunk6: Stroke = {
      id: newStrokeId(),
      tool: 'pencil',
      penType: 'pencil',
      color: '#111827',
      size: 4,
      points: [
        [100, CHUNK_HEIGHT * 6 + 200, 0.6],
        [220, CHUNK_HEIGHT * 6 + 240, 0.6],
      ],
    };
    const strokes = new StrokeStore(history, [strokeInChunk6]);
    const noteId = 'note-virtualized-chunks';
    useSessions.getState().patch(noteId, { loaded: true, readOnly: false, lassoIds: [], moveMode: false, zoom: 1 });

    const viewport = document.createElement('div');
    const pageEl = document.createElement('div');
    viewport.appendChild(pageEl);
    document.body.appendChild(viewport);

    Object.defineProperty(pageEl, 'offsetWidth', { value: 840, configurable: true });
    Object.defineProperty(pageEl, 'offsetHeight', { value: 25000, configurable: true });
    Object.defineProperty(viewport, 'clientHeight', { value: 900, configurable: true });
    let scrollTop = 0;
    Object.defineProperty(viewport, 'scrollTop', {
      get: () => scrollTop,
      set: (v: number) => {
        scrollTop = v;
      },
      configurable: true,
    });
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, width: 840, height: 900, right: 840, bottom: 900, toJSON: () => ({}),
    });
    vi.spyOn(pageEl, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, width: 840, height: 25000, right: 840, bottom: 25000, toJSON: () => ({}),
    });

    const chunk6Mock = makeMockCtx();
    const defaultMock = makeMockCtx();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
      if (this.dataset.testid === 'ink-canvas-chunk-6') return chunk6Mock.ctx as never;
      return defaultMock.ctx as never;
    });

    const session = {
      id: noteId,
      history,
      strokes,
      pageEl,
      get ui() {
        return useSessions.getState().sessions[noteId]!;
      },
      patch(p: Parameters<ReturnType<typeof useSessions.getState>['patch']>[1]) {
        useSessions.getState().patch(noteId, p);
      },
    } as unknown as NoteSession;

    const ref = createRef<HTMLDivElement>();
    ref.current = viewport;
    const { container } = render(<InkCanvas session={session} viewportRef={ref} active />);

    // 초기 상단(scrollTop=0, viewportH=900)에서는 chunk 0, 1 (±1)만 마운트됨
    const initialChunks = Array.from(container.querySelectorAll<HTMLCanvasElement>('.ink-canvas-chunk'));
    expect(initialChunks.map((c) => c.dataset.testid)).toEqual(['ink-canvas-committed', 'ink-canvas-chunk-1']);
    const unmountedChunk0El = initialChunks[0];
    expect(unmountedChunk0El.width).toBeGreaterThan(0);

    // 6번 청크 영역(y=9800)으로 스크롤 후 RAF 반영
    scrollTop = 9800;
    await act(async () => {
      viewport.dispatchEvent(new Event('scroll'));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });

    const nextChunks = Array.from(container.querySelectorAll<HTMLCanvasElement>('.ink-canvas-chunk'));
    expect(nextChunks.map((c) => c.dataset.testid)).toEqual([
      'ink-canvas-chunk-5',
      'ink-canvas-chunk-6',
      'ink-canvas-chunk-7',
    ]);
    // 화면 밖으로 이탈한 0번 청크는 width/height=0으로 GPU 컨텍스트 메모리 해제
    expect(unmountedChunk0El.width).toBe(0);
    expect(unmountedChunk0El.height).toBe(0);
    // 새로 마운트된 6번 청크는 교차하는 기존 스트로크를 즉시 복원 렌더링함
    expect(chunk6Mock.ctx.stroke).toHaveBeenCalled();
  });

  it('2. pointermove 중에는 RAF로 배칭해 Active Layer(wet)에만 그리고 Static Layer와 React 리렌더를 차단한다', async () => {
    useSettings.setState({ tool: 'pencil', penSize: 4, autoStraighten: false, mouseDraw: false });
    const history = new CompositeHistoryManager();
    const strokes = new StrokeStore(history, []);
    const noteId = 'note-2layer-raf';
    useSessions.getState().patch(noteId, { loaded: true, readOnly: false, lassoIds: [], moveMode: false, zoom: 1 });

    const viewport = document.createElement('div');
    const pageEl = document.createElement('div');
    viewport.appendChild(pageEl);
    document.body.appendChild(viewport);
    const rect = { x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 1000, width: 800, height: 1000, toJSON: () => ({}) };
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(rect);
    vi.spyOn(pageEl, 'getBoundingClientRect').mockReturnValue(rect);

    const committed = makeMockCtx();
    const wet = makeMockCtx();
    const wetGetContextArgs: unknown[][] = [];
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
      this: HTMLCanvasElement,
      ...args: unknown[]
    ) {
      if (this.dataset.testid === 'ink-canvas-wet') {
        wetGetContextArgs.push(args);
        return wet.ctx as never;
      }
      return committed.ctx as never;
    });

    const session = {
      id: noteId,
      history,
      strokes,
      pageEl,
      get ui() {
        return useSessions.getState().sessions[noteId]!;
      },
      patch(p: Parameters<ReturnType<typeof useSessions.getState>['patch']>[1]) {
        useSessions.getState().patch(noteId, p);
      },
    } as unknown as NoteSession;

    const ref = createRef<HTMLDivElement>();
    ref.current = viewport;
    let renderCount = 0;
    function Harness() {
      renderCount++;
      return <InkCanvas session={session} viewportRef={ref} active />;
    }

    render(<Harness />);
    const initialRenders = renderCount;

    vi.mocked(committed.ctx.stroke).mockClear();
    vi.mocked(committed.ctx.clearRect).mockClear();
    vi.mocked(committed.ctx.drawImage).mockClear();
    vi.mocked(wet.ctx.stroke).mockClear();
    vi.mocked(wet.ctx.clearRect).mockClear();

    // pointerdown + 같은 프레임 내 다수 pointermove -> React state 리렌더 0회 + RAF 전 wetCtx 1회 배칭 대기
    act(() => {
      dispatchPen(pageEl, 'pointerdown', { clientX: 20, clientY: 20 });
      dispatchPen(pageEl, 'pointermove', { clientX: 40, clientY: 30 });
      dispatchPen(pageEl, 'pointermove', { clientX: 60, clientY: 40 });
      dispatchPen(pageEl, 'pointermove', { clientX: 80, clientY: 50 });
    });

    expect(renderCount).toBe(initialRenders);
    expect(committed.ctx.stroke).not.toHaveBeenCalled();
    expect(committed.ctx.clearRect).not.toHaveBeenCalled();

    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });

    // Active Layer(wet)가 desynchronized:true 누락 합성 버그 없이 표준 2D 컨텍스트로 즉시 화면에 커밋되어야 함
    expect(wetGetContextArgs.length).toBeGreaterThan(0);
    expect(wetGetContextArgs.every((args) => args.length === 1 && args[0] === '2d')).toBe(true);
    expect(wet.ctx.stroke).toHaveBeenCalled();
    expect(wet.ctx.clearRect).not.toHaveBeenCalled();
    expect(committed.ctx.stroke).not.toHaveBeenCalled();

    // pointerup 시 정적 레이어 1회 베이크 + wet 1회 초기화
    act(() => dispatchPen(pageEl, 'pointerup', { clientX: 100, clientY: 60 }));
    expect(committed.ctx.drawImage).toHaveBeenCalledTimes(1);
    expect(committed.ctx.stroke).toHaveBeenCalled();
    expect(wet.ctx.clearRect).toHaveBeenCalledTimes(1);
    expect(strokes.getAll()).toHaveLength(1);
  });

  it('3. getIncrementalStrokeGeometry가 5종 펜 전체에서 일괄 계산과 동일하고 정지 필압 갱신을 반영한다', () => {
    const penTypes: Array<Stroke['penType']> = [
      'pencil',
      'fountain-sharp',
      'fountain-flat',
      'ballpoint',
      'brush',
    ];

    for (const penType of penTypes) {
      const stroke: Stroke = {
        id: newStrokeId(),
        tool: 'pencil',
        penType,
        color: '#111827',
        size: 4,
        points: [
          [10, 20, 0.3],
          [24, 36, 0.5],
        ],
      };
      const inc1 = getIncrementalStrokeGeometry(stroke);
      const batch1Pts = computeCausalSmoothedPoints(stroke.points, penType);
      expect(inc1.smoothed).toEqual(batch1Pts);
      expect(inc1.widths).toEqual(computeCausalStrokeWidths(stroke, batch1Pts));

      stroke.points[1][2] = 0.92;
      const inc2 = getIncrementalStrokeGeometry(stroke);
      const batch2Pts = computeCausalSmoothedPoints(stroke.points, penType);
      expect(inc2.smoothed).toEqual(batch2Pts);
      expect(inc2.widths).toEqual(computeCausalStrokeWidths(stroke, batch2Pts));

      stroke.points.push([52, 58, 0.78]);
      const inc3 = getIncrementalStrokeGeometry(stroke);
      const batch3Pts = computeCausalSmoothedPoints(stroke.points, penType);
      expect(inc3.smoothed).toEqual(batch3Pts);
      expect(inc3.widths).toEqual(computeCausalStrokeWidths(stroke, batch3Pts));
    }
  });

  it('4. 지우개 드래그 중 destination-out 후 pointerup 시 영향 청크만 1회 재구성하고 NoteSession.checkDirty는 JSON.stringify 없이 동작한다', () => {
    useSettings.setState({ tool: 'eraser', eraserSize: 20, penSize: 4, autoStraighten: false });
    const history = new CompositeHistoryManager();
    const sChunk0: Stroke = {
      id: newStrokeId(),
      tool: 'pencil',
      penType: 'pencil',
      color: '#111827',
      size: 4,
      points: [
        [100, 120, 0.6],
        [160, 120, 0.6],
      ],
    };
    const sChunk1Erase: Stroke = {
      id: newStrokeId(),
      tool: 'pencil',
      penType: 'pencil',
      color: '#ef4444',
      size: 4,
      points: [
        [100, CHUNK_HEIGHT + 240, 0.6],
        [180, CHUNK_HEIGHT + 240, 0.6],
      ],
    };
    const strokes = new StrokeStore(history, [sChunk0, sChunk1Erase]);
    const noteId = 'note-erase-virtualized-restore';
    useSessions.getState().patch(noteId, { loaded: true, readOnly: false, lassoIds: [], moveMode: false, zoom: 1 });

    const viewport = document.createElement('div');
    const pageEl = document.createElement('div');
    viewport.appendChild(pageEl);
    document.body.appendChild(viewport);
    const fullRect = {
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 800,
      bottom: CHUNK_HEIGHT * 2 + 200,
      width: 800,
      height: CHUNK_HEIGHT * 2 + 200,
      toJSON: () => ({}),
    };
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(fullRect);
    vi.spyOn(pageEl, 'getBoundingClientRect').mockReturnValue(fullRect);

    const chunk0 = makeMockCtx();
    const chunk1 = makeMockCtx();
    const wet = makeMockCtx();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
      if (this.dataset.testid === 'ink-canvas-wet') return wet.ctx as never;
      if (this.dataset.testid === 'ink-canvas-chunk-1') return chunk1.ctx as never;
      return chunk0.ctx as never;
    });

    const sessionProxy = {
      id: noteId,
      history,
      strokes,
      pageEl,
      get ui() {
        return useSessions.getState().sessions[noteId]!;
      },
      patch(p: Parameters<ReturnType<typeof useSessions.getState>['patch']>[1]) {
        useSessions.getState().patch(noteId, p);
      },
    } as unknown as NoteSession;

    const ref = createRef<HTMLDivElement>();
    ref.current = viewport;
    render(<InkCanvas session={sessionProxy} viewportRef={ref} active />);

    chunk0.ops.length = 0;
    chunk1.ops.length = 0;
    vi.mocked(chunk0.ctx.clearRect).mockClear();
    vi.mocked(chunk1.ctx.clearRect).mockClear();

    act(() => dispatchPen(pageEl, 'pointerdown', { clientX: 100, clientY: CHUNK_HEIGHT + 240 }));
    act(() => dispatchPen(pageEl, 'pointermove', { clientX: 110, clientY: CHUNK_HEIGHT + 240 }));

    expect(strokes.getAll().map((s) => s.id)).toEqual([sChunk0.id]);
    expect(chunk1.ctx.clearRect).not.toHaveBeenCalled();
    expect(chunk1.ops).toContain('stroke:destination-out');
    expect(chunk0.ctx.clearRect).not.toHaveBeenCalled();

    act(() => dispatchPen(pageEl, 'pointerup', { clientX: 110, clientY: CHUNK_HEIGHT + 240 }));
    expect(chunk1.ctx.clearRect).toHaveBeenCalledTimes(1);
    expect(chunk0.ctx.clearRect).toHaveBeenCalledTimes(0);

    // NoteSession O(1) dirty check + quantized maxY
    const fullSession = new NoteSession(createMockRecord({ strokes: [sChunk0] }));
    const stringifySpy = vi.spyOn(JSON, 'stringify');
    fullSession.strokes.addStroke(sChunk1Erase);
    fullSession.checkDirty();
    expect(fullSession.ui.dirty).toBe(true);
    expect(fullSession.strokes.getQuantizedMaxY()).toBe(2000);
    expect(stringifySpy).not.toHaveBeenCalled();
    fullSession.destroy();
  });
});
