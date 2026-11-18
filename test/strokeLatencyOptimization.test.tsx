// @vitest-environment jsdom
import { createRef } from 'react';
import { render, cleanup, act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InkCanvas, CHUNK_HEIGHT } from '../src/canvas/InkCanvas';
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
    id: 'mock-latency-note',
    title: '필기 지연 최적화 테스트 노트',
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

describe('필기·지우기 저지연 GPU 파이프라인(v2) 검증', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('1. getIncrementalStrokeGeometry가 5종 펜 전체에서 일괄 계산과 동일한 결과를 내고 정지 필압 갱신을 반영한다', () => {
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
          [22, 34, 0.5],
        ],
      };

      const inc1 = getIncrementalStrokeGeometry(stroke);
      const batch1Pts = computeCausalSmoothedPoints(stroke.points, penType);
      const batch1Widths = computeCausalStrokeWidths(stroke, batch1Pts);
      expect(inc1.smoothed).toEqual(batch1Pts);
      expect(inc1.widths).toEqual(batch1Widths);

      // 정지 상태에서 마지막 점의 필압(last[2])만 증가한 경우(점 개수 불변)도 정확히 재계산해야 함
      stroke.points[1][2] = 0.92;
      const inc2 = getIncrementalStrokeGeometry(stroke);
      const batch2Pts = computeCausalSmoothedPoints(stroke.points, penType);
      const batch2Widths = computeCausalStrokeWidths(stroke, batch2Pts);
      expect(inc2.smoothed).toEqual(batch2Pts);
      expect(inc2.widths).toEqual(batch2Widths);

      // 후속 점 추가 시 증분 계산 결과 역시 일괄 계산과 100% 일치
      stroke.points.push([48, 52, 0.78], [76, 68, 0.64]);
      const inc3 = getIncrementalStrokeGeometry(stroke);
      const batch3Pts = computeCausalSmoothedPoints(stroke.points, penType);
      const batch3Widths = computeCausalStrokeWidths(stroke, batch3Pts);
      expect(inc3.smoothed).toEqual(batch3Pts);
      expect(inc3.widths).toEqual(batch3Widths);
    }
  });

  it('2. 필기 드래그(pointermove) 중에는 wet 레이어에만 증분 렌더링하고 Committed 청크에는 그리지 않는다', () => {
    useSettings.setState({ tool: 'pencil', penSize: 4, autoStraighten: false, mouseDraw: false });
    const history = new CompositeHistoryManager();
    const strokes = new StrokeStore(history, []);
    const noteId = 'note-wet-only-v2';
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
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
      if (this.dataset.testid === 'ink-canvas-wet') return wet.ctx as never;
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
    render(<InkCanvas session={session} viewportRef={ref} active />);

    vi.mocked(committed.ctx.stroke).mockClear();
    vi.mocked(committed.ctx.clearRect).mockClear();
    vi.mocked(committed.ctx.drawImage).mockClear();
    vi.mocked(wet.ctx.stroke).mockClear();

    act(() => dispatchPen(pageEl, 'pointerdown', { clientX: 20, clientY: 20 }));
    act(() => dispatchPen(pageEl, 'pointermove', { clientX: 45, clientY: 32 }));
    act(() => dispatchPen(pageEl, 'pointermove', { clientX: 80, clientY: 44 }));

    expect(wet.ctx.stroke).toHaveBeenCalled();
    expect(committed.ctx.stroke).not.toHaveBeenCalled();
    expect(committed.ctx.clearRect).not.toHaveBeenCalled();

    act(() => dispatchPen(pageEl, 'pointerup', { clientX: 80, clientY: 44 }));
    expect(committed.ctx.drawImage).toHaveBeenCalledTimes(1);
    expect(committed.ctx.stroke).toHaveBeenCalled();
    expect(strokes.getAll()).toHaveLength(1);
  });

  it('3. 지우개 드래그 중에는 destination-out 마스크만 적용하고 pointerup 시 수정된 청크만 1회 clean restore 한다', () => {
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
    const sChunk1Keep: Stroke = {
      id: newStrokeId(),
      tool: 'pencil',
      penType: 'pencil',
      color: '#2563eb',
      size: 4,
      points: [
        [140, CHUNK_HEIGHT + 180, 0.6],
        [140, CHUNK_HEIGHT + 300, 0.6],
      ],
    };
    const strokes = new StrokeStore(history, [sChunk0, sChunk1Erase, sChunk1Keep]);

    // erasePoints 배치 API 검증
    const noteId = 'note-erase-gpu-v2';
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
    render(<InkCanvas session={session} viewportRef={ref} active />);

    chunk0.ops.length = 0;
    chunk1.ops.length = 0;
    vi.mocked(chunk0.ctx.clearRect).mockClear();
    vi.mocked(chunk1.ctx.clearRect).mockClear();

    // Chunk 1 영역의 sChunk1Erase 만 지나가고 sChunk1Keep 은 비켜가는 지우기 드래그
    act(() => dispatchPen(pageEl, 'pointerdown', { clientX: 100, clientY: CHUNK_HEIGHT + 240 }));
    act(() => dispatchPen(pageEl, 'pointermove', { clientX: 110, clientY: CHUNK_HEIGHT + 240 }));

    expect(strokes.getAll().map((s) => s.id)).toEqual([sChunk0.id, sChunk1Keep.id]);
    // 드래그 중에는 전체 청크 clearRect 없이 destination-out 마스크만 사용
    expect(chunk1.ctx.clearRect).not.toHaveBeenCalled();
    expect(chunk1.ops).toContain('stroke:destination-out');
    expect(chunk1.ops).toContain('restore');
    expect(chunk0.ctx.clearRect).not.toHaveBeenCalled();

    // pointerup 시 오염된 Chunk 1 만 clean restore 하고 Chunk 0 은 건드리지 않음
    act(() => dispatchPen(pageEl, 'pointerup', { clientX: 110, clientY: CHUNK_HEIGHT + 240 }));
    expect(chunk1.ctx.clearRect).toHaveBeenCalledTimes(1);
    expect(chunk0.ctx.clearRect).toHaveBeenCalledTimes(0);
  });

  it('4. NoteSession.checkDirty는 JSON.stringify 없이 O(1) 참조 비교로 동작하고 StrokeStore.getQuantizedMaxY를 정확히 갱신한다', () => {
    const strokeA: Stroke = {
      id: newStrokeId(),
      tool: 'pencil',
      penType: 'pencil',
      color: '#111827',
      size: 3,
      points: [
        [10, 420, 0.5],
        [40, 510, 0.5],
      ],
    };
    const strokeB: Stroke = {
      id: newStrokeId(),
      tool: 'pencil',
      penType: 'pencil',
      color: '#111827',
      size: 3,
      points: [
        [10, 1250, 0.5],
        [40, 1410, 0.5],
      ],
    };

    const session = new NoteSession(createMockRecord({ strokes: [strokeA] }));
    expect(session.ui.dirty).toBe(false);
    expect(session.strokes.getQuantizedMaxY()).toBe(600);

    const stringifySpy = vi.spyOn(JSON, 'stringify');
    session.strokes.addStroke(strokeB);
    session.checkDirty();
    expect(session.ui.dirty).toBe(true);
    expect(session.strokes.getQuantizedMaxY()).toBe(1600);
    // hasStrokesChanged() 단락 평가 및 O(1) 참조 비교로 checkDirty() 중 strokes 직렬화가 발생하지 않아야 함
    expect(stringifySpy).not.toHaveBeenCalled();

    session.history.undo();
    session.checkDirty();
    expect(session.ui.dirty).toBe(false);
    expect(session.strokes.getQuantizedMaxY()).toBe(600);
    expect(stringifySpy.mock.calls.some(([arg]) => arg === session.strokes.getAll())).toBe(false);

    session.destroy();
  });
});
