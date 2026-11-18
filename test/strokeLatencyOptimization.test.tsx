// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { createRef } from 'react';
import {
  computeCausalSmoothedPoints,
  computeCausalStrokeWidths,
  getIncrementalStrokeGeometry,
} from '../src/canvas/render';
import { InkCanvas, CHUNK_HEIGHT } from '../src/canvas/InkCanvas';
import { StrokeStore, type PenType, type Stroke } from '../src/core/strokes/StrokeStore';
import { CompositeHistoryManager } from '../src/core/history/CompositeHistoryManager';
import { NoteSession } from '../src/session/NoteSession';
import { emptyNote } from '../src/storage/db';
import { useSettings } from '../src/store/settingsStore';

vi.mock('../src/search/searchClient', () => ({
  indexNote: vi.fn(),
  unindexNote: vi.fn(),
  searchRelated: vi.fn().mockResolvedValue([]),
}));

function makeStroke(id: string, penType: PenType, points: Array<[number, number, number]>): Stroke {
  return {
    id,
    tool: 'pencil',
    penType,
    color: '#0f172a',
    size: 2.4,
    points,
  };
}

describe('REQ_stroke_latency_optimization: 선 품질 무손실 필기·지우기 지연 최적화', () => {
  beforeEach(() => {
    cleanup();
    vi.restoreAllMocks();
    useSettings.setState({ tool: 'pencil', penType: 'fountain-sharp', eraserSize: 12 });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('1. getIncrementalStrokeGeometry는 5종 펜 모두에서 일괄 스무딩·굵기 수식과 수치적으로 100% 일치하고 캐시를 재사용한다', () => {
    const pens: PenType[] = ['fountain-sharp', 'fountain-flat', 'ballpoint', 'pencil', 'brush'];
    for (const penType of pens) {
      const pts: Array<[number, number, number]> = Array.from({ length: 18 }, (_, i) => [
        10 + i * 6.5,
        20 + Math.sin(i * 0.4) * 14 + i * 2.1,
        0.25 + (i % 7) * 0.1,
      ]);

      const incrementalStroke = makeStroke(`inc-${penType}`, penType, [pts[0]]);
      getIncrementalStrokeGeometry(incrementalStroke);

      // 실시간 pointermove처럼 점들을 순차 누적 호출
      for (let end = 2; end <= pts.length; end += 3) {
        for (let k = incrementalStroke.points.length; k < end; k++) {
          incrementalStroke.points.push(pts[k]);
        }
        getIncrementalStrokeGeometry(incrementalStroke);
      }
      for (let k = incrementalStroke.points.length; k < pts.length; k++) {
        incrementalStroke.points.push(pts[k]);
      }
      const incResult = getIncrementalStrokeGeometry(incrementalStroke);

      const expectedSmoothed = computeCausalSmoothedPoints(pts, penType);
      const expectedWidths = computeCausalStrokeWidths(incrementalStroke, expectedSmoothed);

      expect(incResult.smoothed).toHaveLength(expectedSmoothed.length);
      expect(incResult.widths).toHaveLength(expectedWidths.length);

      for (let i = 0; i < expectedSmoothed.length; i++) {
        expect(incResult.smoothed[i][0]).toBeCloseTo(expectedSmoothed[i][0], 10);
        expect(incResult.smoothed[i][1]).toBeCloseTo(expectedSmoothed[i][1], 10);
        expect(incResult.smoothed[i][2]).toBeCloseTo(expectedSmoothed[i][2], 10);
        expect(incResult.widths[i]).toBeCloseTo(expectedWidths[i], 10);
      }

      // 동일 스트로크 재호출 시 O(1) 동일 캐시 참조 반환
      const secondCall = getIncrementalStrokeGeometry(incrementalStroke);
      expect(secondCall).toBe(incResult);
    }
  });

  it('2. StrokeStore.erasePoints는 다중 coalesced 좌표를 단일 배치(1회 emit)로 삭제하고 정확한 removedBounds와 단일 Undo를 제공한다', () => {
    const history = new CompositeHistoryManager();
    const sChunk0 = makeStroke('s-chunk0', 'pencil', [
      [50, 100, 0.5],
      [90, 120, 0.5],
    ]);
    const sChunk1A = makeStroke('s-chunk1-a', 'pencil', [
      [40, CHUNK_HEIGHT + 200, 0.5],
      [100, CHUNK_HEIGHT + 200, 0.5],
    ]);
    const sChunk1B = makeStroke('s-chunk1-b', 'pencil', [
      [140, CHUNK_HEIGHT + 260, 0.5],
      [200, CHUNK_HEIGHT + 260, 0.5],
    ]);
    const store = new StrokeStore(history, [sChunk0, sChunk1A, sChunk1B]);

    const onEmit = vi.fn();
    store.subscribe(onEmit);

    const res = store.erasePoints(
      [
        { x: 70, y: CHUNK_HEIGHT + 200 },
        { x: 170, y: CHUNK_HEIGHT + 260 },
      ],
      14,
    );

    expect(res.removedIds).toEqual(['s-chunk1-a', 's-chunk1-b']);
    expect(onEmit).toHaveBeenCalledTimes(1);
    expect(res.removedBounds).not.toBeNull();
    expect(res.removedBounds!.minY).toBeGreaterThan(CHUNK_HEIGHT);
    expect(store.getAll().map((s) => s.id)).toEqual(['s-chunk0']);

    // 단일 Undo 로 두 스트로크 동시 복원
    history.undo();
    expect(store.getAll()).toHaveLength(3);
  });

  it('3. NoteSession.checkDirty는 다량 획 환경에서도 JSON.stringify(strokes) 없이 O(1) 참조/동등성 비교로 변경을 감지한다', () => {
    const initialStrokes = Array.from({ length: 600 }, (_, i) =>
      makeStroke(`bulk-${i}`, 'pencil', [
        [10 + (i % 50) * 10, 20 + Math.floor(i / 50) * 20, 0.5],
        [18 + (i % 50) * 10, 26 + Math.floor(i / 50) * 20, 0.5],
      ]),
    );
    const note = emptyNote({ id: 'note-perf-dirty', title: '성능 테스트', strokes: initialStrokes });
    const session = new NoteSession(note);

    const stringifySpy = vi.spyOn(JSON, 'stringify');
    session.checkDirty();
    const callsBefore = stringifySpy.mock.calls.filter(([arg]) => Array.isArray(arg) && arg.length === 600);
    expect(callsBefore).toHaveLength(0);
    expect(session.ui.dirty).toBe(false);

    // 획 1개 추가 시 dirty = true 감지 (JSON.stringify 미사용)
    session.strokes.addStroke(
      makeStroke('bulk-extra', 'pencil', [
        [300, 300, 0.5],
        [320, 320, 0.5],
      ]),
    );
    session.checkDirty();
    const callsAfterAdd = stringifySpy.mock.calls.filter(([arg]) => Array.isArray(arg) && arg.length >= 600);
    expect(callsAfterAdd).toHaveLength(0);
    expect(session.ui.dirty).toBe(true);

    // Undo 복원 시 dirty = false 복귀
    session.undo();
    session.checkDirty();
    expect(session.ui.dirty).toBe(false);

    session.destroy();
  });

  it('4. InkCanvas 지우개 삭제 시 삭제 영역과 교차하는 더티 청크만 부분 재렌더링하고 비영향 청크는 재드로잉하지 않는다', () => {
    const clearCallsByCanvas = new Map<HTMLCanvasElement, number>();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
      const canvas = this;
      return {
        imageSmoothingEnabled: true,
        imageSmoothingQuality: 'high',
        fillStyle: '#000',
        strokeStyle: '#000',
        lineWidth: 1,
        lineCap: 'round',
        lineJoin: 'round',
        globalAlpha: 1,
        globalCompositeOperation: 'source-over',
        setTransform: vi.fn(),
        clearRect: vi.fn(() => {
          clearCallsByCanvas.set(canvas, (clearCallsByCanvas.get(canvas) ?? 0) + 1);
        }),
        save: vi.fn(),
        restore: vi.fn(),
        beginPath: vi.fn(),
        moveTo: vi.fn(),
        lineTo: vi.fn(),
        quadraticCurveTo: vi.fn(),
        arc: vi.fn(),
        fill: vi.fn(),
        stroke: vi.fn(),
        drawImage: vi.fn(),
        setLineDash: vi.fn(),
        strokeRect: vi.fn(),
      } as unknown as CanvasRenderingContext2D;
    });

    const rafQueue: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      rafQueue.push(cb);
      return rafQueue.length;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);

    const strokeChunk0 = makeStroke('c0-s1', 'pencil', [
      [50, 100, 0.5],
      [120, 120, 0.5],
    ]);
    const strokeChunk1 = makeStroke('c1-s1', 'pencil', [
      [50, CHUNK_HEIGHT + 240, 0.5],
      [120, CHUNK_HEIGHT + 240, 0.5],
    ]);

    const note = emptyNote({
      id: 'note-dirty-chunk-1',
      title: '부분 청크 재렌더',
      strokes: [strokeChunk0, strokeChunk1],
    });
    const session = new NoteSession(note);

    const viewport = document.createElement('div');
    const page = document.createElement('div');
    page.className = 'note-page';
    Object.defineProperty(page, 'offsetWidth', { value: 800, configurable: true });
    Object.defineProperty(page, 'offsetHeight', { value: CHUNK_HEIGHT * 2 + 200, configurable: true });
    page.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 800, bottom: CHUNK_HEIGHT * 2 + 200, width: 800, height: CHUNK_HEIGHT * 2 + 200 } as DOMRect);
    viewport.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 800, bottom: CHUNK_HEIGHT * 2 + 200, width: 800, height: CHUNK_HEIGHT * 2 + 200 } as DOMRect);
    viewport.appendChild(page);
    document.body.appendChild(viewport);
    session.pageEl = page;

    const viewportRef = createRef<HTMLDivElement>();
    (viewportRef as { current: HTMLDivElement | null }).current = viewport;

    render(<InkCanvas session={session} viewportRef={viewportRef} active={true} />);

    // 초기 전체 렌더 flush
    act(() => {
      while (rafQueue.length > 0) rafQueue.shift()!(16);
    });

    const chunk0Canvas = document.querySelector('[data-testid="ink-canvas-committed"]') as HTMLCanvasElement;
    const chunk1Canvas = document.querySelector('[data-testid="ink-canvas-chunk-1"]') as HTMLCanvasElement;
    expect(chunk0Canvas).toBeTruthy();
    expect(chunk1Canvas).toBeTruthy();

    clearCallsByCanvas.clear();
    useSettings.setState({ tool: 'eraser', eraserSize: 16 });

    // Chunk 1 위치(y = CHUNK_HEIGHT + 240) 지우개 드래그
    const down = new Event('pointerdown', { bubbles: true, cancelable: true }) as PointerEvent;
    Object.defineProperties(down, {
      pointerType: { value: 'pen' },
      pointerId: { value: 1 },
      clientX: { value: 80 },
      clientY: { value: CHUNK_HEIGHT + 240 },
      pressure: { value: 0.5 },
    });
    page.dispatchEvent(down);

    act(() => {
      while (rafQueue.length > 0) rafQueue.shift()!(32);
    });

    // Chunk 1 은 지워진 획을 반영하기 위해 clearRect 가 호출되지만, Chunk 0 은 재렌더하지 않아야 함
    expect(clearCallsByCanvas.get(chunk1Canvas) ?? 0).toBeGreaterThanOrEqual(1);
    expect(clearCallsByCanvas.get(chunk0Canvas) ?? 0).toBe(0);

    document.body.removeChild(viewport);
    session.destroy();
  });
});
