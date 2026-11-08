// @vitest-environment jsdom
import { createRef } from 'react';
import { render, cleanup, act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InkCanvas, CHUNK_HEIGHT } from './InkCanvas';
import { drawIncrementalStrokeSegment, drawStroke } from './render';
import { CompositeHistoryManager } from '../core/history/CompositeHistoryManager';
import { StrokeStore, type Stroke } from '../core/strokes/StrokeStore';
import { useSettings } from '../store/settingsStore';
import { useSessions } from '../store/sessionStore';
import type { NoteSession } from '../session/NoteSession';

type Sample = { clientX: number; clientY: number; pressure?: number };

function pen(target: HTMLElement, type: string, s: Sample, coalesced?: Sample[]) {
  const ev = new Event(type, { bubbles: true, cancelable: true }) as PointerEvent;
  const mk = (c: Sample) => ({ ...c, pressure: c.pressure ?? 0.6, pointerType: 'pen', pointerId: 7 }) as unknown as PointerEvent;
  Object.defineProperties(ev, {
    pointerId: { value: 7 },
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

describe('InkCanvas 저지연 필기 파이프라인', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('coalesced 240Hz 샘플을 모두 획에 반영하고, 필기 중 touch-action:none·is-inking 을 적용한다', () => {
    useSettings.setState({ tool: 'pencil', penSize: 4, autoStraighten: false, mouseDraw: false });
    const history = new CompositeHistoryManager();
    const strokes = new StrokeStore(history, []);
    const noteId = 'note-low-latency';
    useSessions.getState().patch(noteId, { loaded: true, readOnly: false, lassoIds: [], moveMode: false });

    const viewport = document.createElement('div');
    const pageEl = document.createElement('div');
    viewport.appendChild(pageEl);
    document.body.appendChild(viewport);
    const rect = { x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 1000, width: 800, height: 1000, toJSON: () => ({}) };
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(rect);
    vi.spyOn(pageEl, 'getBoundingClientRect').mockReturnValue(rect);

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

    const { getByTestId } = render(<InkCanvas session={session} viewportRef={ref} active />);
    expect(getByTestId('ink-canvas-wet')).toBeTruthy();

    act(() => pen(viewport, 'pointerdown', { clientX: 10, clientY: 10 }));
    expect(viewport.style.touchAction).toBe('none');
    expect(viewport.classList.contains('is-inking')).toBe(true);

    // 한 프레임에 병합된 4개의 디지타이저 샘플
    act(() =>
      pen(viewport, 'pointermove', { clientX: 40, clientY: 10 }, [
        { clientX: 20, clientY: 10 },
        { clientX: 20.1, clientY: 10 }, // 지터 → 제거
        { clientX: 30, clientY: 10 },
        { clientX: 40, clientY: 10 },
      ]),
    );
    act(() => pen(viewport, 'pointerup', { clientX: 40, clientY: 10 }));

    const [s] = strokes.getAll();
    expect(s.points.map((p) => p[0])).toEqual([10, 20, 30, 40]);
    expect(viewport.classList.contains('is-inking')).toBe(false);
    // S-Pen 필기 종료 즉시 touchAction 이 복원되어 손가락 터치 스크롤이 차단되지 않는다
    expect(viewport.style.touchAction).toBe('');
  });

  it('손필기 직후 손가락 터치 제스처 시 이벤트가 차단되지 않고 스크롤이 정상 동작한다', () => {
    useSettings.setState({ tool: 'pencil', penSize: 4 });
    const history = new CompositeHistoryManager();
    const strokes = new StrokeStore(history, []);
    const noteId = 'note-touch-scroll-restore';
    useSessions.getState().patch(noteId, { loaded: true, readOnly: false, lassoIds: [], moveMode: false });

    const viewport = document.createElement('div');
    const pageEl = document.createElement('div');
    viewport.appendChild(pageEl);
    document.body.appendChild(viewport);
    const rect = { x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 1000, width: 800, height: 1000, toJSON: () => ({}) };
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(rect);
    vi.spyOn(pageEl, 'getBoundingClientRect').mockReturnValue(rect);

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

    // 1. 펜으로 필기 시작 및 완료
    act(() => pen(viewport, 'pointerdown', { clientX: 100, clientY: 100 }));
    expect(viewport.style.touchAction).toBe('none');
    act(() => pen(viewport, 'pointerup', { clientX: 120, clientY: 100 }));

    // 펜을 뗀 직후 touch-action 은 반드시 복원되어 있어야 한다
    expect(viewport.style.touchAction).toBe('');

    // 2. 필기 직후 펜 호버링이 일어나도 touchAction 이 'none'으로 잠기지 않는다
    const hoverPen = new Event('pointermove', { bubbles: true, cancelable: true }) as PointerEvent;
    Object.defineProperties(hoverPen, {
      pointerId: { value: 7 },
      pointerType: { value: 'pen' },
      clientX: { value: 130 },
      clientY: { value: 100 },
      button: { value: -1 },
      buttons: { value: 0 },
    });
    act(() => viewport.dispatchEvent(hoverPen));
    expect(viewport.style.touchAction).toBe('');

    // 3. 필기 직후 손가락으로 화면을 위로 밀어올려 스크롤할 때 touch 이벤트가 preventDefault 로 삼켜지지 않는다
    const touchEv = new Event('pointerdown', { bubbles: true, cancelable: true }) as PointerEvent;
    Object.defineProperties(touchEv, {
      pointerId: { value: 99 },
      pointerType: { value: 'touch' },
      clientX: { value: 200 },
      clientY: { value: 500 },
      button: { value: 0 },
      buttons: { value: 1 },
    });
    act(() => viewport.dispatchEvent(touchEv));
    expect(touchEv.defaultPrevented).toBe(false);
  });

  it('pointercancel 이벤트가 발생해도 사용자가 입력한 필기 획이 사라지지 않고 영구 보존된다 (펜 소실 방지)', () => {
    useSettings.setState({ tool: 'pencil', penSize: 4, autoStraighten: false });
    const history = new CompositeHistoryManager();
    const strokes = new StrokeStore(history, []);
    const noteId = 'note-stroke-preserve-on-cancel';
    useSessions.getState().patch(noteId, { loaded: true, readOnly: false, lassoIds: [], moveMode: false });

    const viewport = document.createElement('div');
    const pageEl = document.createElement('div');
    viewport.appendChild(pageEl);
    document.body.appendChild(viewport);
    const rect = { x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 1000, width: 800, height: 1000, toJSON: () => ({}) };
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(rect);
    vi.spyOn(pageEl, 'getBoundingClientRect').mockReturnValue(rect);

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

    // 펜으로 필기 시작 및 이동
    act(() => pen(viewport, 'pointerdown', { clientX: 50, clientY: 50 }));
    act(() => pen(viewport, 'pointermove', { clientX: 60, clientY: 55 }));
    act(() => pen(viewport, 'pointermove', { clientX: 70, clientY: 60 }));

    // 태블릿 OS/브라우저에 의해 pointercancel 이 발생하더라도 획이 폐기되지 않는다
    act(() => pen(viewport, 'pointercancel', { clientX: 70, clientY: 60 }));

    const all = strokes.getAll();
    expect(all.length).toBe(1);
    expect(all[0].points.length).toBeGreaterThanOrEqual(2);
    expect(all[0].points[0][0]).toBe(50);
  });

  it('확대 상태(zoom 1.5x)에서도 필기 완료 후 획이 정상 등록되고 소실되지 않는다', () => {
    useSettings.setState({ tool: 'pencil', penSize: 4, autoStraighten: false });
    const history = new CompositeHistoryManager();
    const strokes = new StrokeStore(history, []);
    const noteId = 'note-zoom-stroke-preserve';
    useSessions.getState().patch(noteId, { loaded: true, readOnly: false, lassoIds: [], moveMode: false, zoom: 1.5 });

    const viewport = document.createElement('div');
    const pageEl = document.createElement('div');
    viewport.appendChild(pageEl);
    document.body.appendChild(viewport);
    const rect = { x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 1000, width: 800, height: 1000, toJSON: () => ({}) };
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(rect);
    vi.spyOn(pageEl, 'getBoundingClientRect').mockReturnValue(rect);

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

    act(() => pen(viewport, 'pointerdown', { clientX: 150, clientY: 150 }));
    act(() => pen(viewport, 'pointermove', { clientX: 180, clientY: 180 }));
    act(() => pen(viewport, 'pointerup', { clientX: 180, clientY: 180 }));

    const all = strokes.getAll();
    expect(all.length).toBe(1);
    expect(all[0].points[0][0]).toBeCloseTo(150 / 1.5);
    expect(all[0].points[0][1]).toBeCloseTo(150 / 1.5);
  });

  it('BUGFIX_CANVAS_FLICKERING: 연속 필기 시 pointermove 중 clearRect 를 호출하지 않고 pointerup 시 Committed Canvas 에 drawImage 로 베이크한다', () => {
    useSettings.setState({ tool: 'pencil', penSize: 4, autoStraighten: false });
    const history = new CompositeHistoryManager();
    const strokes = new StrokeStore(history, []);
    const noteId = 'note-double-buffer-bake';
    useSessions.getState().patch(noteId, { loaded: true, readOnly: false, lassoIds: [], moveMode: false, zoom: 1 });

    const viewport = document.createElement('div');
    const pageEl = document.createElement('div');
    viewport.appendChild(pageEl);
    document.body.appendChild(viewport);
    const rect = { x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 1000, width: 800, height: 1000, toJSON: () => ({}) };
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(rect);
    vi.spyOn(pageEl, 'getBoundingClientRect').mockReturnValue(rect);

    const makeMockCtx = () =>
      ({
        save: vi.fn(),
        restore: vi.fn(),
        setTransform: vi.fn(),
        translate: vi.fn(),
        scale: vi.fn(),
        clearRect: vi.fn(),
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
      }) as unknown as CanvasRenderingContext2D;

    const committedCtx = makeMockCtx();
    const wetCtx = makeMockCtx();

    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
      if (this.dataset.testid === 'ink-canvas-wet') return wetCtx as never;
      return committedCtx as never;
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

    // 초기 마운트 이후 카운터 리셋
    vi.mocked(committedCtx.clearRect).mockClear();
    vi.mocked(committedCtx.drawImage).mockClear();
    vi.mocked(wetCtx.clearRect).mockClear();

    // 1. pointerdown 및 연속 pointermove 수행
    act(() => pen(viewport, 'pointerdown', { clientX: 20, clientY: 20 }));
    act(() => pen(viewport, 'pointermove', { clientX: 40, clientY: 25 }));
    act(() => pen(viewport, 'pointermove', { clientX: 60, clientY: 30 }));

    // 필기 도중에는 Active Canvas(wetCtx)와 Committed Canvas(committedCtx) 모두 clearRect 가 0회여야 함
    expect(wetCtx.clearRect).not.toHaveBeenCalled();
    expect(committedCtx.clearRect).not.toHaveBeenCalled();

    // 2. pointerup 시 Committed Canvas 는 clearRect 없이 drawImage 로 베이크되고, Active Canvas 만 1회 비워짐
    act(() => pen(viewport, 'pointerup', { clientX: 80, clientY: 35 }));
    expect(committedCtx.clearRect).not.toHaveBeenCalled();
    expect(committedCtx.drawImage).toHaveBeenCalledTimes(1);
    expect(wetCtx.clearRect).toHaveBeenCalledTimes(1);
    expect(strokes.getAll()).toHaveLength(1);

    // 3. 지우개 모드로 전환 후 획이 없는 빈 공간에 지우개가 닿았을 때 Committed Canvas 가 불필요하게 clearRect 되지 않음
    vi.mocked(committedCtx.clearRect).mockClear();
    useSettings.setState({ tool: 'eraser', eraserSize: 12 });
    act(() => pen(viewport, 'pointerdown', { clientX: 500, clientY: 500 }));
    act(() => pen(viewport, 'pointerup', { clientX: 500, clientY: 500 }));
    expect(committedCtx.clearRect).not.toHaveBeenCalled();
  });

  it('지우개 진입/재렌더링 시 손글씨 모양 불변: 실시간 증분 드로잉과 drawStroke 재렌더링의 곡선 명령이 100% 일치한다', () => {
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

    const fullStroke: Stroke = {
      id: 's-shape-check',
      tool: 'pencil',
      penType: 'pencil',
      color: '#111827',
      size: 4,
      points: [
        [10, 20, 0.4],
        [25, 24, 0.6],
        [45, 32, 0.75],
        [70, 35, 0.5],
      ],
    };

    // A: 실시간 필기처럼 1점씩 추가하며 drawIncrementalStrokeSegment 호출
    const liveRec = recordOps();
    const growing: Stroke = { ...fullStroke, points: [] };
    let lastIdx = 0;
    for (const pt of fullStroke.points) {
      growing.points.push(pt);
      lastIdx = drawIncrementalStrokeSegment(liveRec.ctx, growing, lastIdx);
    }

    // B: 지우개/스크롤 등으로 전체 재렌더링될 때 drawStroke 호출
    const redrawRec = recordOps();
    drawStroke(redrawRec.ctx, fullStroke);

    // 실제 그려지는 도형 명령(arc, moveTo, lineTo, quad)이 100% 동일해야 모양 변화가 전혀 발생하지 않음
    const filterDrawCmds = (list: string[]) =>
      list.filter((c) => c.startsWith('arc:') || c.startsWith('moveTo:') || c.startsWith('lineTo:') || c.startsWith('quad:'));
    expect(filterDrawCmds(liveRec.ops)).toEqual(filterDrawCmds(redrawRec.ops));
  });

  it('BUGFIX_CANVAS_STROKE_BLUR: 다중 페이지(25,000px) 문서에서도 dpr 이 0.32 로 다운스케일되지 않고 100% 고해상도(CHUNK_HEIGHT 분할 타일)를 유지한다', () => {
    // 1. 21페이지 문서 환경 설정: 높이 25,000px, devicePixelRatio = 2.0 (고해상도 태블릿)
    const originalDpr = window.devicePixelRatio;
    Object.defineProperty(window, 'devicePixelRatio', { value: 2.0, configurable: true });

    try {
      const history = new CompositeHistoryManager();
      const strokes = new StrokeStore(history);
      const noteId = 'note-blur-test';
      useSessions.getState().patch(noteId, { loaded: true, readOnly: false, lassoIds: [], moveMode: false, zoom: 1 });

      const viewport = document.createElement('div');
      const page = document.createElement('div');
      page.className = 'note-page page-canvas-surface';
      // 21페이지 문서 크기: 840px x 25,000px
      Object.defineProperty(page, 'offsetWidth', { value: 840, configurable: true });
      Object.defineProperty(page, 'offsetHeight', { value: 25000, configurable: true });
      const rect = {
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        width: 840,
        height: 25000,
        right: 840,
        bottom: 25000,
        toJSON: () => ({}),
      };
      vi.spyOn(page, 'getBoundingClientRect').mockReturnValue(rect);
      vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(rect);

      viewport.appendChild(page);
      document.body.appendChild(viewport);

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

      const ref = { current: viewport };
      const { container } = render(<InkCanvas session={session} viewportRef={ref} active />);

      // 2. 단일 거대 캔버스가 아닌 CHUNK_HEIGHT(1600px) 단위 타일 캔버스들이 분할 생성되었는지 확인
      // 25,000 / 1600 = 15.625 -> 총 16개의 청크 캔버스
      const chunkCanvases = container.querySelectorAll<HTMLCanvasElement>('.ink-canvas-chunk');
      expect(chunkCanvases.length).toBe(Math.ceil(25000 / CHUNK_HEIGHT));

      // 3. 첫 번째 청크 및 모든 청크의 DPR 100% 무손실 고해상도 검증:
      // 기존 버그에서는 dpr이 8192 / 25000 = 0.327로 축소되어 canvas.width가 275px에 불과했음.
      // 정상 타일링에서는 dpr = 2.0이 유지되어 canvas.width = 840 * 2 = 1680px이어야 함!
      const firstChunk = chunkCanvases[0];
      expect(firstChunk.width).toBe(840 * 2); // 1680px (DPR 2.0 100% 무손실)
      expect(firstChunk.height).toBe(CHUNK_HEIGHT * 2); // 3200px (GPU 한도 8192px 이내)
    } finally {
      Object.defineProperty(window, 'devicePixelRatio', { value: originalDpr, configurable: true });
    }
  });

  it('BUGFIX_STROKE_DISAPPEAR_ON_PEN_UP: 일반 펜(pencil) 필기 완료(pointerup) 직후 획이 화면에서 소실되지 않고 청크 캔버스에 보존된다', () => {
    useSettings.setState({ tool: 'pencil', penSize: 4, autoStraighten: false });
    const history = new CompositeHistoryManager();
    const strokes = new StrokeStore(history);
    const noteId = 'note-disappear-test';
    useSessions.getState().patch(noteId, { loaded: true, readOnly: false, lassoIds: [], moveMode: false, zoom: 1 });

    const viewport = document.createElement('div');
    const page = document.createElement('div');
    page.className = 'note-page page-canvas-surface';
    Object.defineProperty(page, 'offsetWidth', { value: 800, configurable: true });
    Object.defineProperty(page, 'offsetHeight', { value: 1200, configurable: true });
    const rect = { x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 1200, width: 800, height: 1200, toJSON: () => ({}) };
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(rect);
    vi.spyOn(page, 'getBoundingClientRect').mockReturnValue(rect);

    viewport.appendChild(page);
    document.body.appendChild(viewport);

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

    render(<InkCanvas session={session} viewportRef={ref} active />);

    // 1. 펜 필기 수행 (down -> move -> up)
    act(() => pen(page, 'pointerdown', { clientX: 100, clientY: 100 }));
    act(() => pen(page, 'pointermove', { clientX: 150, clientY: 120 }));
    act(() => pen(page, 'pointerup', { clientX: 200, clientY: 140 }));

    // 2. pointerup 후 strokes 스토어에 획이 정상 등록되고 소실되지 않아야 함
    const allStrokes = strokes.getAll();
    expect(allStrokes).toHaveLength(1);
    expect(allStrokes[0].tool).toBe('pencil');
    expect(allStrokes[0].points.length).toBeGreaterThan(1);
  });

  it('BUGFIX_STROKE_DISAPPEAR_ON_POINTERUP: pointerup 시 committedCanvas 에 setTransform(1, 0, 0, 1, 0, 0) 기반 drawImage 전사가 수행되고 캔버스 크기 변조 및 리렌더링 버퍼 리셋이 차단된다', () => {
    useSettings.setState({ tool: 'pencil', penSize: 4, autoStraighten: false });
    const history = new CompositeHistoryManager();
    const strokes = new StrokeStore(history, []);
    const noteId = 'note-disappear-pointerup-fix';
    useSessions.getState().patch(noteId, { loaded: true, readOnly: false, lassoIds: [], moveMode: false, zoom: 1 });

    const viewport = document.createElement('div');
    const pageEl = document.createElement('div');
    pageEl.className = 'note-page page-canvas-surface';
    viewport.appendChild(pageEl);
    document.body.appendChild(viewport);
    const rect = { x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 1200, width: 800, height: 1200, toJSON: () => ({}) };
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(rect);
    vi.spyOn(pageEl, 'getBoundingClientRect').mockReturnValue(rect);

    const makeMockCtx = () =>
      ({
        save: vi.fn(),
        restore: vi.fn(),
        setTransform: vi.fn(),
        translate: vi.fn(),
        scale: vi.fn(),
        clearRect: vi.fn(),
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
      }) as unknown as CanvasRenderingContext2D;

    const committedCtx = makeMockCtx();
    const wetCtx = makeMockCtx();

    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
      if (this.dataset.testid === 'ink-canvas-wet') return wetCtx as never;
      return committedCtx as never;
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

    const committedCanvas = container.querySelector<HTMLCanvasElement>('[data-testid="ink-canvas-committed"]');
    expect(committedCanvas).toBeTruthy();
    // 0. Committed 청크 캔버스에 .ink-canvas 클래스(z-index: 30, mix-blend-mode: multiply)가 반드시 포함되어 본문(z-10) 뒤로 가려지지 않아야 함
    expect(committedCanvas!.classList.contains('ink-canvas')).toBe(true);
    const initialWidth = committedCanvas!.width;
    const initialHeight = committedCanvas!.height;

    // 카운터 리셋
    vi.mocked(committedCtx.setTransform).mockClear();
    vi.mocked(committedCtx.drawImage).mockClear();
    vi.mocked(committedCtx.clearRect).mockClear();
    vi.mocked(committedCtx.stroke).mockClear();

    // 1. 펜 필기 수행 (down -> move -> up)
    act(() => pen(pageEl, 'pointerdown', { clientX: 50, clientY: 50 }));
    act(() => pen(pageEl, 'pointermove', { clientX: 70, clientY: 70 }));
    // pointerup 직전 카운터 확인 후 pointerup 시 벡터 drawStroke + drawImage 동시 확정 검증
    vi.mocked(committedCtx.stroke).mockClear();
    act(() => pen(pageEl, 'pointerup', { clientX: 90, clientY: 90 }));

    // 2. pointerup 시 committedCtx 에 setTransform(1, 0, 0, 1, 0, 0)과 drawImage 및 벡터 stroke 가 모두 수행되어야 함
    expect(committedCtx.setTransform).toHaveBeenCalledWith(1, 0, 0, 1, 0, 0);
    expect(committedCtx.drawImage).toHaveBeenCalledTimes(1);
    expect(committedCtx.stroke).toHaveBeenCalled();

    // 3. pointerup 직후 페이지 높이(pageH: 1200 -> 1450)가 확장되더라도 committedCanvas 의 width/height 가 재할당되지 않아야 함
    Object.defineProperty(pageEl, 'offsetHeight', { value: 1450, configurable: true });
    act(() => pen(pageEl, 'pointerdown', { clientX: 100, clientY: 100 }));
    act(() => pen(pageEl, 'pointerup', { clientX: 120, clientY: 120 }));
    expect(committedCanvas!.width).toBe(initialWidth);
    expect(committedCanvas!.height).toBe(initialHeight);

    // 4. strokes 등록 후 리렌더링 시에도 committedCanvas 에 clearRect 가 호출되지 않고 보존됨
    expect(committedCtx.clearRect).not.toHaveBeenCalled();
    expect(strokes.getAll()).toHaveLength(2);
  });

  it('BUGFIX_LASSO_LIVE_TRAIL_VISIBILITY: 올가미 선택 시 드로잉 중 wet 레이어에 실시간 궤적(#4f46e5 점선 및 펜촉 끝점)이 0ms 지연으로 렌더링된다', () => {
    useSettings.setState({ tool: 'highlighter', highlighterSize: 12, autoStraighten: false, mouseDraw: false });
    const history = new CompositeHistoryManager();
    const strokes = new StrokeStore(history, [
      {
        id: 'stroke-1',
        tool: 'pencil',
        penType: 'ballpoint',
        color: '#000000',
        size: 3,
        points: [[100, 100, 0.5], [120, 120, 0.5], [140, 140, 0.5]],
      },
    ]);
    const noteId = 'note-lasso-trail';
    useSessions.getState().patch(noteId, { loaded: true, readOnly: false, lassoIds: [], moveMode: false });

    const viewport = document.createElement('div');
    const pageEl = document.createElement('div');
    pageEl.className = 'page-canvas-surface';
    viewport.appendChild(pageEl);
    document.body.appendChild(viewport);
    const rect = { x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 1000, width: 800, height: 1000, toJSON: () => ({}) };
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(rect);
    vi.spyOn(pageEl, 'getBoundingClientRect').mockReturnValue(rect);
    Object.defineProperty(pageEl, 'offsetWidth', { value: 800, configurable: true });
    Object.defineProperty(pageEl, 'offsetHeight', { value: 1000, configurable: true });

    const makeMockCtx = () =>
      ({
        save: vi.fn(),
        restore: vi.fn(),
        setTransform: vi.fn(),
        translate: vi.fn(),
        scale: vi.fn(),
        clearRect: vi.fn(),
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
        strokeStyle: '',
        fillStyle: '',
        lineWidth: 1,
      }) as unknown as CanvasRenderingContext2D;

    const committedCtx = makeMockCtx();
    const wetCtx = makeMockCtx();

    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
      if (this.dataset.testid === 'ink-canvas-wet') return wetCtx as never;
      return committedCtx as never;
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
    const wetCanvas = container.querySelector<HTMLCanvasElement>('[data-testid="ink-canvas-wet"]');
    expect(wetCanvas).toBeTruthy();

    // 1. 형광펜 상태에서 시작하여 캔버스 잔류 스타일(opacity: 0.35)이 설정될 수 있는 상황 시뮬레이션
    wetCanvas!.style.opacity = '0.35';
    wetCanvas!.style.mixBlendMode = 'multiply';

    // 2. 도구를 lasso 로 전환
    useSettings.setState({ tool: 'lasso' });

    // 3. 올가미 시작 (pointerdown): 잔류 불투명도 강제 리셋(opacity 1, mixBlendMode '') 및 시작 앵커 렌더링 검증
    vi.mocked(wetCtx.arc).mockClear();
    vi.mocked(wetCtx.fill).mockClear();
    act(() => pen(pageEl, 'pointerdown', { clientX: 50, clientY: 50 }));

    expect(wetCanvas!.style.opacity).toBe('1');
    expect(wetCanvas!.style.mixBlendMode).toBe('');
    expect(wetCtx.arc).toHaveBeenCalledWith(50, 50, 3, 0, Math.PI * 2);
    expect(wetCtx.fill).toHaveBeenCalled();

    // 4. 올가미 드래그 (pointermove): 0ms 즉시 궤적 렌더링 및 펜촉 끝점 lineTo 검증
    vi.mocked(wetCtx.stroke).mockClear();
    vi.mocked(wetCtx.lineTo).mockClear();
    vi.mocked(wetCtx.setLineDash).mockClear();

    act(() => pen(pageEl, 'pointermove', { clientX: 70, clientY: 70 }));

    expect(wetCtx.setLineDash).toHaveBeenCalledWith([6, 4]);
    expect(wetCtx.strokeStyle).toBe('#4f46e5');
    expect(wetCtx.lineWidth).toBe(2.0);
    expect(wetCtx.stroke).toHaveBeenCalled();
    // 마지막 펜촉 위치(70, 70)까지 lineTo 가 호출되어 끝점이 잘리지 않는지 검증
    expect(wetCtx.lineTo).toHaveBeenCalledWith(70, 70);

    // 5. 올가미 추가 이동 후 종료 (pointerup)
    act(() => pen(pageEl, 'pointermove', { clientX: 90, clientY: 90 }));
    act(() => pen(pageEl, 'pointerup', { clientX: 90, clientY: 90 }));
  });
});

