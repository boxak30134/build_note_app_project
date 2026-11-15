// @vitest-environment jsdom
import { createRef } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import {
  computeCausalSmoothedPoints,
  computeCausalStrokeWidths,
  drawIncrementalStrokeSegment,
  drawStroke,
} from '../src/canvas/render';
import { InkCanvas } from '../src/canvas/InkCanvas';
import type { Stroke } from '../src/core/strokes/StrokeStore';
import { StrokeStore } from '../src/core/strokes/StrokeStore';
import { CompositeHistoryManager } from '../src/core/history/CompositeHistoryManager';
import { useSessions } from '../src/store/sessionStore';
import type { NoteSession } from '../src/session/NoteSession';

describe('REQ_HIGH_QUALITY_STROKE_RENDERING: 고품질 필기 렌더링 및 대각선 계단 현상 제거', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('1. 대각선 입력의 계단 지터가 인과적 스무딩으로 완화되면서 원시 stroke.points 는 변조되지 않는다', () => {
    // 45도 대각선에 +/- 1.5px 수직 지터(계단 노이즈) 포함
    const rawPts = Array.from({ length: 12 }, (_, i) => {
      const jitter = i % 2 === 0 ? 1.5 : -1.5;
      return [i * 4, i * 4 + jitter, 0.5] as const;
    });
    const snapshot = rawPts.map((p) => [...p]);

    const smoothed = computeCausalSmoothedPoints(rawPts, 'pencil');
    expect(smoothed).toHaveLength(rawPts.length);
    // 원시 배열 무결성 보장
    expect(rawPts.map((p) => [...p])).toEqual(snapshot);

    // 대각선(y = x)에서의 수직 편차(절대값 |y - x|) 평균이 원시 노이즈(1.5)보다 현저히 감소해야 함
    const avgDeviation =
      smoothed.slice(1).reduce((acc, p) => acc + Math.abs(p[1] - p[0]), 0) / (smoothed.length - 1);
    expect(avgDeviation).toBeLessThan(1.0);
  });

  it('2. 5종 펜이 필압·속도·닙 각도에 따라 고유한 필기감(굵기 변화)을 생성한다', () => {
    // 1) fountain-sharp vs ballpoint: 필압·속도 변화 대비
    const dynamicPts = computeCausalSmoothedPoints(
      [
        [0, 0, 0.25],
        [4, 4, 0.3],
        [8, 12, 0.85],
        [12, 20, 0.9],
        [36, 20, 0.3], // 빠른 꼬리 빼기
      ],
      'fountain-sharp',
    );
    const fountainWidths = computeCausalStrokeWidths({ size: 5, penType: 'fountain-sharp' }, dynamicPts);
    const ballpointWidths = computeCausalStrokeWidths({ size: 5, penType: 'ballpoint' }, dynamicPts);
    const brushWidths = computeCausalStrokeWidths({ size: 5, penType: 'brush' }, dynamicPts);

    const spread = (arr: number[]) => Math.max(...arr) - Math.min(...arr);
    expect(spread(brushWidths)).toBeGreaterThan(spread(fountainWidths));
    expect(spread(fountainWidths)).toBeGreaterThan(spread(ballpointWidths));
    // 빠른 꼬리 빼기(마지막 구간)에서 fountain-sharp 굵기가 줄어들어 자연스럽게 테이퍼링됨
    expect(fountainWidths[fountainWidths.length - 1]).toBeLessThan(fountainWidths[3]);

    // 2) fountain-flat: 45도 닙 방향에 따른 획 굵기 차이 검증 (-45도 평행 vs +45도 수직)
    const alongNib = computeCausalSmoothedPoints(
      [
        [0, 0, 0.5],
        [10, -10, 0.5],
        [20, -20, 0.5],
      ],
      'fountain-flat',
    );
    const acrossNib = computeCausalSmoothedPoints(
      [
        [0, 0, 0.5],
        [10, 10, 0.5],
        [20, 20, 0.5],
      ],
      'fountain-flat',
    );
    const wAlong = computeCausalStrokeWidths({ size: 6, penType: 'fountain-flat' }, alongNib);
    const wAcross = computeCausalStrokeWidths({ size: 6, penType: 'fountain-flat' }, acrossNib);
    expect(wAcross[2]).toBeGreaterThan(wAlong[2]);
  });

  it('3. 실시간 점진 드로잉(drawIncrementalStrokeSegment)과 drawStroke 전체 재렌더링 명령이 100% 일치한다', () => {
    const recordOps = () => {
      const ops: string[] = [];
      const ctx = {
        lineWidth: 1,
        strokeStyle: '',
        fillStyle: '',
        lineCap: 'butt',
        lineJoin: 'miter',
        globalAlpha: 1,
        globalCompositeOperation: 'source-over',
        imageSmoothingEnabled: false,
        imageSmoothingQuality: 'low',
        save: () => ops.push('save'),
        restore: () => ops.push('restore'),
        beginPath: () => ops.push('beginPath'),
        moveTo: (x: number, y: number) => ops.push(`moveTo:${x.toFixed(2)},${y.toFixed(2)}`),
        lineTo: (x: number, y: number) => ops.push(`lineTo:${x.toFixed(2)},${y.toFixed(2)}:w=${ctx.lineWidth.toFixed(2)}`),
        quadraticCurveTo: (cx: number, cy: number, x: number, y: number) =>
          ops.push(`quad:${cx.toFixed(2)},${cy.toFixed(2)}->${x.toFixed(2)},${y.toFixed(2)}:w=${ctx.lineWidth.toFixed(2)}`),
        arc: (x: number, y: number, r: number) => ops.push(`arc:${x.toFixed(2)},${y.toFixed(2)},${r.toFixed(2)}`),
        fill: () => ops.push('fill'),
        stroke: () => ops.push('stroke'),
      } as unknown as CanvasRenderingContext2D;
      return { ctx, ops };
    };

    const stroke: Stroke = {
      id: 'hq-parity-1',
      tool: 'pencil',
      penType: 'fountain-sharp',
      color: '#0f172a',
      size: 5,
      points: [
        [10, 10, 0.3],
        [24, 24, 0.7],
        [44, 42, 0.85],
        [72, 58, 0.4],
      ],
    };

    const liveRec = recordOps();
    const growing: Stroke = { ...stroke, points: [] };
    let idx = 0;
    for (const pt of stroke.points) {
      growing.points.push(pt);
      idx = drawIncrementalStrokeSegment(liveRec.ctx, growing, idx);
    }

    const redrawRec = recordOps();
    drawStroke(redrawRec.ctx, stroke);

    const drawCmds = (list: string[]) =>
      list.filter((c) => c.startsWith('arc:') || c.startsWith('moveTo:') || c.startsWith('lineTo:') || c.startsWith('quad:'));
    expect(drawCmds(liveRec.ops)).toEqual(drawCmds(redrawRec.ops));
    // 서브스텝 보간으로 부드러운 다중 곡선 명령이 생성되는지 확인
    expect(drawCmds(redrawRec.ops).some((c) => c.startsWith('quad:'))).toBe(true);
  });

  it('4. 1x 디스플레이에서도 최소 2.0x 슈퍼샘플링 해상도와 high 스무딩을 적용해 계단 현상을 차단한다', () => {
    const originalDpr = window.devicePixelRatio;
    Object.defineProperty(window, 'devicePixelRatio', { value: 1.0, configurable: true });

    try {
      const history = new CompositeHistoryManager();
      const strokes = new StrokeStore(history, []);
      const noteId = 'note-supersample-1';
      useSessions.getState().patch(noteId, { loaded: true, readOnly: false, lassoIds: [], moveMode: false, zoom: 1 });

      const viewport = document.createElement('div');
      const page = document.createElement('div');
      page.className = 'note-page page-canvas-surface';
      Object.defineProperty(page, 'offsetWidth', { value: 800, configurable: true });
      Object.defineProperty(page, 'offsetHeight', { value: 1000, configurable: true });
      const rect = { x: 0, y: 0, left: 0, top: 0, width: 800, height: 1000, right: 800, bottom: 1000, toJSON: () => ({}) };
      vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(rect);
      vi.spyOn(page, 'getBoundingClientRect').mockReturnValue(rect);
      viewport.appendChild(page);
      document.body.appendChild(viewport);

      const contexts: Array<{ imageSmoothingEnabled: boolean; imageSmoothingQuality: string }> = [];
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => {
        const mockCtx = {
          imageSmoothingEnabled: false,
          imageSmoothingQuality: 'low',
          save: vi.fn(),
          restore: vi.fn(),
          setTransform: vi.fn(),
          clearRect: vi.fn(),
          beginPath: vi.fn(),
          moveTo: vi.fn(),
          lineTo: vi.fn(),
          quadraticCurveTo: vi.fn(),
          arc: vi.fn(),
          fill: vi.fn(),
          stroke: vi.fn(),
          drawImage: vi.fn(),
        };
        contexts.push(mockCtx);
        return mockCtx as unknown as CanvasRenderingContext2D;
      });

      const session = {
        id: noteId,
        history,
        strokes,
        pageEl: page,
        scrollEl: viewport,
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

      const committed = container.querySelector<HTMLCanvasElement>('[data-testid="ink-canvas-committed"]');
      expect(committed?.width).toBe(800 * 2); // 1x 화면에서도 2.0x 슈퍼샘플링
      expect(contexts.some((c) => c.imageSmoothingEnabled && c.imageSmoothingQuality === 'high')).toBe(true);
    } finally {
      Object.defineProperty(window, 'devicePixelRatio', { value: originalDpr, configurable: true });
    }
  });
});
