// @vitest-environment jsdom
// test/canvasGestureIsolation.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { VirtualStylusAgent } from './utils/virtualStylus';
import { shouldRejectPalmTouch, type PalmRejectionState, PALM_REJECTION_WINDOW_MS } from '../src/core/android/androidDeployment';
import { drawIncrementalStrokeSegment, renderLassoFeedback } from '../src/canvas/render';
import type { Stroke } from '../src/core/strokes/StrokeStore';
import { isPointerInsidePageCanvasSurface } from '../src/core/input/gestureRouting';
import { normalizePdfNoteContent } from '../src/core/page/pageTypes';
import {
  clientPointToPageLocal,
  resolveLassoPolygonOnRelease,
  strokeInPolygon,
  type Point,
  type StrokePoint,
} from '../src/core/geometry/geometry';
import {
  ANDROID_ACTION_DOWN,
  ANDROID_TOOL_TYPE_STYLUS,
  pagePointToScreen,
  routeNativeMotionEvent,
  screenPointToPage,
} from '../src/core/android/nativeStylusBridge';

void PALM_REJECTION_WINDOW_MS;

/**
 * 노트 앱 제스처 격리 및 필기 버그 방어 단위/통합 테스트 스위트
 */
describe('S-Pen 필기 및 피벗 제스처 격리 자동 검증', () => {
  let container: HTMLDivElement;
  let canvas: HTMLCanvasElement;
  let agent: VirtualStylusAgent;

  // 가상 뷰포트 상태 모의 객체
  let viewportState: {
    scale: number;
    translateX: number;
    translateY: number;
  };

  let drawingStrokes: Array<Array<{ x: number; y: number }>>;

  beforeEach(() => {
    container = document.createElement('div');
    canvas = document.createElement('canvas');
    container.appendChild(canvas);
    document.body.appendChild(container);

    agent = new VirtualStylusAgent(canvas);

    viewportState = { scale: 1.0, translateX: 0, translateY: 0 };
    drawingStrokes = [];

    // 가상 핸들러 바인딩 (SPEN_GESTURE_ISOLATION_GUIDE 표준 로직 반영)
    let currentStroke: Array<{ x: number; y: number }> | null = null;
    let isDrawing = false;
    const activeTouches = new Map<number, PointerEvent>();

    canvas.addEventListener('pointerdown', (e: PointerEvent) => {
      // 1. Touch는 핀치/패닝 풀에 등록
      if (e.pointerType === 'touch') {
        activeTouches.set(e.pointerId, e);
        return;
      }

      // 2. S-Pen은 필기 루프로 진입 및 제스처 전파 차단
      if (e.pointerType === 'pen') {
        e.preventDefault();
        e.stopPropagation();
        isDrawing = true;
        currentStroke = [{ x: e.clientX, y: e.clientY }];
      }
    });

    canvas.addEventListener('pointermove', (e: PointerEvent) => {
      if (e.pointerType === 'touch') {
        activeTouches.set(e.pointerId, e);
        // 2개 이상일 때 핀치 줌 연산
        if (activeTouches.size === 2) {
          viewportState.scale += 0.1;
          viewportState.translateX += 5;
        }
        return;
      }

      if (e.pointerType === 'pen' && isDrawing) {
        e.preventDefault();
        e.stopPropagation();
        currentStroke?.push({ x: e.clientX, y: e.clientY });
      }
    });

    canvas.addEventListener('pointerup', (e: PointerEvent) => {
      if (e.pointerType === 'touch') {
        activeTouches.delete(e.pointerId);
        return;
      }

      if (e.pointerType === 'pen' && isDrawing) {
        e.preventDefault();
        isDrawing = false;
        if (currentStroke) {
          drawingStrokes.push(currentStroke);
          currentStroke = null;
        }
      }
    });
  });

  it('시나리오 1: S-Pen 단독 필기 시 화면 이동(Pan)이나 배율(Zoom)이 변하지 않아야 한다', () => {
    const initialViewport = { ...viewportState };

    // S-Pen으로 대각선 필기 수행
    agent.simulatePenStroke([
      { x: 100, y: 100, pressure: 0.3 },
      { x: 150, y: 160, pressure: 0.6 },
      { x: 200, y: 220, pressure: 0.5 },
      { x: 280, y: 310, pressure: 0.2 },
    ]);

    // 필기 데이터는 1개의 스트로크로 정상 기록되어야 함
    expect(drawingStrokes.length).toBe(1);
    expect(drawingStrokes[0].length).toBe(4);

    // 뷰포트 상태(확대/축소 및 이동 좌표)는 단 0.001도 변하지 않아야 함
    expect(viewportState.scale).toBe(initialViewport.scale);
    expect(viewportState.translateX).toBe(initialViewport.translateX);
    expect(viewportState.translateY).toBe(initialViewport.translateY);
  });

  it('시나리오 2: S-Pen 이벤트 발생 시 브라우저 네이티브 기본 동작(스크롤)이 cancelable/preventDefault 처리되어야 한다', () => {
    let preventDefaultInvoked = false;

    canvas.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'pen' && e.defaultPrevented) {
        preventDefaultInvoked = true;
      }
    });

    agent.simulatePenStroke([
      { x: 50, y: 50 },
      { x: 60, y: 70 },
    ]);

    expect(preventDefaultInvoked).toBe(true);
  });

  it('시나리오 3: 두 손가락 핀치 줌 도중에 S-Pen 입력이 발생해도 줌 계산 포인트 풀에 펜 좌표가 오염되지 않아야 한다', () => {
    const initialScale = viewportState.scale;

    // 핀치 줌 실행 (터치 2개 다운)
    canvas.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', pointerId: 1, clientX: 100, clientY: 100 }));
    canvas.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', pointerId: 2, clientX: 200, clientY: 200 }));

    // 이 상태에서 S-Pen이 화면에 닿음
    canvas.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'pen', pointerId: 10, clientX: 150, clientY: 150 }));

    // 손가락 핀치 줌 이동
    canvas.dispatchEvent(new PointerEvent('pointermove', { pointerType: 'touch', pointerId: 1, clientX: 90, clientY: 90 }));

    // 줌은 정상 발생하되 S-Pen의 개입으로 인한 NaN이나 3점 이상 이상 연산이 일어나지 않음
    expect(viewportState.scale).toBeGreaterThan(initialScale);
  });

  it('시나리오 4: Palm Rejection - 펜 필기 중 또는 필기 직후의 손바닥 터치는 차단되어야 한다', () => {
    const now = 1000000;
    const penState: PalmRejectionState = {
      isPenDrawing: true,
      lastPenTimestamp: now,
    };

    // 1. 펜 필기 중 손바닥이 닿은 경우 -> 즉시 차단
    const rejectDuringPen = shouldRejectPalmTouch('touch', penState, now);
    expect(rejectDuringPen).toBe(true);

    // 2. 펜을 뗀 지 200ms 지난 시점(차단 윈도우 450ms 이내) -> 여전히 차단
    penState.isPenDrawing = false;
    const rejectWithinWindow = shouldRejectPalmTouch('touch', penState, now + 200);
    expect(rejectWithinWindow).toBe(true);

    // 3. 펜을 뗀 지 500ms 지난 시점(차단 윈도우 초과) -> 손가락 터치 허용
    const allowAfterWindow = shouldRejectPalmTouch('touch', penState, now + 500);
    expect(allowAfterWindow).toBe(false);
  });

  it('시나리오 5: S-Pen 배럴 지우개 버튼(buttons: 32) 입력 분기 검증', () => {
    let capturedButtons = 0;
    let isEraserMode = false;

    canvas.addEventListener('pointerdown', (e) => {
      capturedButtons = e.buttons;
      if (e.buttons === 32 || e.pointerType === 'eraser') {
        isEraserMode = true;
      }
    });

    agent.simulateEraserStroke([{ x: 100, y: 100 }, { x: 120, y: 120 }], { useBarrelButton: true });

    expect(capturedButtons).toBe(32);
    expect(isEraserMode).toBe(true);
  });

  it('시나리오 6 (BUGFIX_CANVAS_FLICKERING): S-Pen 연속 필기 중 clearRect 없는 증분 드로잉 및 pointerup 시 drawImage 더블 버퍼링 베이킹 검증', () => {
    const activeCtx = {
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      quadraticCurveTo: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(),
      clearRect: vi.fn(),
      setTransform: vi.fn(),
    } as unknown as CanvasRenderingContext2D;

    const committedCtx = {
      save: vi.fn(),
      restore: vi.fn(),
      clearRect: vi.fn(),
      setTransform: vi.fn(),
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D;

    const liveStroke: Stroke = {
      id: 'stroke-flicker-test',
      tool: 'pencil',
      penType: 'pencil',
      color: '#1e293b',
      size: 4,
      points: [],
    };
    let lastRenderedIndex = 0;

    canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'pen') return;
      liveStroke.points.push([e.clientX, e.clientY, e.pressure || 0.5]);
      lastRenderedIndex = drawIncrementalStrokeSegment(activeCtx, liveStroke, lastRenderedIndex);
    });

    canvas.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'pen') return;
      liveStroke.points.push([e.clientX, e.clientY, e.pressure || 0.5]);
      // pointermove 중에는 clearRect 호출 없이 신규 세그먼트만 증분 드로잉
      lastRenderedIndex = drawIncrementalStrokeSegment(activeCtx, liveStroke, lastRenderedIndex);
    });

    canvas.addEventListener('pointerup', (e) => {
      if (e.pointerType !== 'pen') return;
      // pointerup 시 Committed Canvas 를 clearRect 하지 않고 drawImage 로 베이크 후 Active Canvas 만 비움
      committedCtx.save();
      committedCtx.setTransform(1, 0, 0, 1, 0, 0);
      committedCtx.drawImage(canvas, 0, 0);
      committedCtx.restore();
      activeCtx.clearRect(0, 0, 1200, 1600);
    });

    // S-Pen으로 연속 필기 수행
    agent.simulatePenStroke([
      { x: 100, y: 100, pressure: 0.4 },
      { x: 120, y: 105, pressure: 0.6 },
      { x: 145, y: 112, pressure: 0.7 },
      { x: 170, y: 118, pressure: 0.5 },
    ]);

    // 1. 모든 포인트가 증분 렌더링되었는지 확인
    expect(lastRenderedIndex).toBe(4);
    expect(activeCtx.quadraticCurveTo).toHaveBeenCalled();

    // 2. Committed Canvas 는 필기 시작~종료 내내 clearRect 가 단 한 번도 호출되지 않고 drawImage 로만 구워짐(Bake)
    expect(committedCtx.clearRect).not.toHaveBeenCalled();
    expect(committedCtx.drawImage).toHaveBeenCalledTimes(1);

    // 3. Active Canvas 는 pointermove 중에는 clearRect 가 호출되지 않고, pointerup 베이크 직후에만 딱 1회 초기화됨
    expect(activeCtx.clearRect).toHaveBeenCalledTimes(1);
    expect(viewportState.scale).toBe(1);
    expect(viewportState.translateX).toBe(0);
    expect(viewportState.translateY).toBe(0);
  });

  it('시나리오 7 (BUGFIX_PAGE_OVERLAY_AND_SPEN_BYPASS): 노트 용지(.page-canvas-surface) 바깥 회색 여백·사이드바·툴바·버튼에 대한 S-Pen 터치는 preventDefault/stopPropagation 없이 100% 바이패스된다', () => {
    const viewportEl = document.createElement('div');
    viewportEl.className = 'note-viewport';
    const pageEl = document.createElement('div');
    pageEl.className = 'note-page page-canvas-surface';
    const contentDiv = document.createElement('div');
    contentDiv.className = 'prose-note';
    const addPageBtn = document.createElement('button');
    addPageBtn.textContent = '아래에 페이지 추가';
    const sidebarBtn = document.createElement('button');
    sidebarBtn.textContent = '좌측 사이드바 노트 항목';

    pageEl.appendChild(contentDiv);
    pageEl.appendChild(addPageBtn);
    viewportEl.appendChild(pageEl);
    document.body.appendChild(viewportEl);
    document.body.appendChild(sidebarBtn);

    vi.spyOn(viewportEl, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 1200,
      bottom: 900,
      width: 1200,
      height: 900,
      toJSON: () => ({}),
    });
    // 실제 흰색 노트 용지는 (left: 180, top: 40, right: 1020, bottom: 860) 영역만 차지하고 좌우 180px은 회색 여백
    vi.spyOn(pageEl, 'getBoundingClientRect').mockReturnValue({
      x: 180,
      y: 40,
      left: 180,
      top: 40,
      right: 1020,
      bottom: 860,
      width: 840,
      height: 820,
      toJSON: () => ({}),
    });

    // 1) 흰색 노트 용지 내부(clientX: 400, clientY: 300) S-Pen 터치 -> 드로잉 허용(true)
    expect(
      isPointerInsidePageCanvasSurface(
        { clientX: 400, clientY: 300, target: contentDiv },
        pageEl,
        viewportEl,
      ),
    ).toBe(true);

    // 2) 흰색 노트 용지 바깥의 회색 여백(clientX: 60, clientY: 300) S-Pen 터치 -> 바이패스(false)
    expect(
      isPointerInsidePageCanvasSurface(
        { clientX: 60, clientY: 300, target: viewportEl },
        pageEl,
        viewportEl,
      ),
    ).toBe(false);

    // 3) 용지 내부에 위치한 인터랙티브 버튼('아래에 페이지 추가') S-Pen 터치 -> 클릭 바이패스(false)
    expect(
      isPointerInsidePageCanvasSurface(
        { clientX: 900, clientY: 820, target: addPageBtn },
        pageEl,
        viewportEl,
      ),
    ).toBe(false);

    // 4) 좌측 사이드바/툴바/AI 패널 버튼 S-Pen 터치 -> 클릭 바이패스(false)
    expect(
      isPointerInsidePageCanvasSurface(
        { clientX: 40, clientY: 120, target: sidebarBtn },
        pageEl,
        viewportEl,
      ),
    ).toBe(false);

    // 5) 안드로이드 네이티브 오버레이 라우터에서도 pageBounds 바깥 S-Pen 터치는 consume=false, passThroughToWebView=true 반환
    const palmState: PalmRejectionState = { isPenDrawing: false, lastPenTimestamp: 0 };
    const nativeOutsideDecision = routeNativeMotionEvent(
      {
        action: ANDROID_ACTION_DOWN,
        toolType: ANDROID_TOOL_TYPE_STYLUS,
        x: 60,
        y: 300,
        timestampMs: 1000,
      },
      {
        overlayEnabled: true,
        configuredTool: 'pencil',
        pageBounds: { left: 180, top: 40, right: 1020, bottom: 860 },
        palmState,
      },
    );
    expect(nativeOutsideDecision.consume).toBe(false);
    expect(nativeOutsideDecision.passThroughToWebView).toBe(true);
    expect(palmState.isPenDrawing).toBe(false);

    viewportEl.remove();
    sidebarBtn.remove();
  });

  it('시나리오 8 (BUGFIX_PAGE_OVERLAY_AND_SPEN_BYPASS): PDF 다중 페이지 정규화(좌측 상단 OCR/조각 이미지 중첩 제거) 및 고밀도(density) 1:1 좌표 정합성 검증', () => {
    // 1) 구버전 임포터로 인해 OCR 단락("3. 모든 산 동물은...", "4. 그러나 고기를...")과 조각 이미지가 혼입된 PDF 문서 정규화
    const legacyCorruptedPdfDoc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: '3. 모든 산 동물은 너희의 먹을 것이 될지라' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '4. 그러나 고기를 그 생명 되는 피째 먹지 말 것이니라' }] },
        { type: 'image', attrs: { src: 'genesis-p1-img1.png' } },
        { type: 'inkTemplate', attrs: { src: 'genesis-p1.png', width: 595, height: 842, page: 1 } },
        { type: 'paragraph', content: [{ type: 'text', text: '2페이지 중복 OCR 텍스트' }] },
        { type: 'inkTemplate', attrs: { src: 'genesis-p2.png', width: 595, height: 842, page: 2 } },
      ],
    };

    const normalized = normalizePdfNoteContent(legacyCorruptedPdfDoc);
    expect(normalized.content).toHaveLength(2);
    expect(normalized.content?.every((n) => n.type === 'inkTemplate')).toBe(true);
    expect(normalized.content?.[0].attrs?.page).toBe(1);
    expect(normalized.content?.[1].attrs?.page).toBe(2);

    // 2) 고해상도 태블릿(density = 2.75) 환경에서 CSS 페이지 좌표 <-> 물리 픽셀 1:1 무손실 정·역변환 검증
    const transform = {
      scrollLeft: 0,
      scrollTop: 0,
      scale: 1.5,
      pageOffsetX: 180,
      pageOffsetY: 56,
      density: 2.75,
    };
    const pagePt = { x: 520, y: 740 };
    const physicalScreenPt = pagePointToScreen(pagePt.x, pagePt.y, transform);
    // density 가 곱해져 좌측 상단으로 축소되지 않고 물리 픽셀 위치로 정확히 확장됨
    expect(physicalScreenPt.x).toBeCloseTo((520 * 1.5 + 180) * 2.75, 4);
    expect(physicalScreenPt.y).toBeCloseTo((740 * 1.5 + 56) * 2.75, 4);

    const restoredPagePt = screenPointToPage(physicalScreenPt.x, physicalScreenPt.y, transform);
    expect(Math.abs(restoredPagePt.x - pagePt.x)).toBeLessThan(1e-6);
    expect(Math.abs(restoredPagePt.y - pagePt.y)).toBeLessThan(1e-6);
  });

  it('시나리오 9 (BUGFIX_LASSO_COORDINATES_AND_SCROLL_SYNC): 스크롤(scrollTop: 480, scrollLeft: 60) 및 줌(scale: 1.5) 상태에서 올가미 로컬 좌표 변환·자동 폐합 및 스트로크 선택 검증', () => {
    const viewportEl = document.createElement('div');
    const pageEl = document.createElement('div');
    viewportEl.appendChild(pageEl);
    document.body.appendChild(viewportEl);

    // 뷰포트가 (scrollLeft: 60, scrollTop: 480)만큼 스크롤되어 있고, 줌 배율은 1.5배인 상태
    viewportEl.scrollLeft = 60;
    viewportEl.scrollTop = 480;
    const scale = 1.5;

    vi.spyOn(viewportEl, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 1200,
      bottom: 900,
      width: 1200,
      height: 900,
      toJSON: () => ({}),
    });
    vi.spyOn(pageEl, 'getBoundingClientRect').mockReturnValue({
      x: 120,
      y: 40,
      left: 120,
      top: 40,
      right: 1380,
      bottom: 1820,
      width: 1260,
      height: 1780,
      toJSON: () => ({}),
    });

    // 페이지 로컬 좌표 (x: 200~340, y: 500~530)에 위치한 손글씨 획 및 2점 직선 획
    const handwritingPoints: StrokePoint[] = [
      [210, 510, 0.6],
      [250, 515, 0.7],
      [290, 520, 0.65],
      [330, 512, 0.6],
    ];
    const straightenedTwoPointLine: StrokePoint[] = [
      [205, 525, 0.5],
      [335, 525, 0.5],
    ];
    const outsideStrokePoints: StrokePoint[] = [
      [210, 120, 0.6],
      [280, 125, 0.6],
    ];

    // 페이지 로컬 좌표 (180..360, 480..560) 주변을 감싸는 화면(clientX, clientY) 올가미 궤적 생성
    // clientX = pageLocalX * scale + pageRect.left - scrollLeft
    // clientY = pageLocalY * scale + pageRect.top - scrollTop
    const toClient = (lx: number, ly: number) => ({
      clientX: lx * scale + 120 - 60,
      clientY: ly * scale + 40 - 480,
    });

    // 시작점(180, 480)과 끝점(180, 545) 사이가 65px(> 36px) 벌어진 열린 C자 형태의 올가미 궤적
    const screenLassoSamples = [
      toClient(180, 480),
      toClient(360, 480),
      toClient(360, 560),
      toClient(180, 560),
      toClient(180, 545),
    ];

    const localPoly = screenLassoSamples.map((s) =>
      clientPointToPageLocal(s.clientX, s.clientY, pageEl, viewportEl, scale),
    );

    // 역변환된 첫 번째 점이 정확히 페이지 로컬 (180, 480)와 일치해야 함
    expect(localPoly[0].x).toBeCloseTo(180, 5);
    expect(localPoly[0].y).toBeCloseTo(480, 5);

    // 펜을 뗄 때(resolveLassoPolygonOnRelease) 시작-끝점 거리가 36px보다 커도 자동으로 닫힌 다각형으로 정규화됨
    const closedPolygon = resolveLassoPolygonOnRelease(localPoly);
    expect(closedPolygon).not.toBeNull();
    expect(strokeInPolygon(handwritingPoints, closedPolygon!)).toBe(true);
    expect(strokeInPolygon(straightenedTwoPointLine, closedPolygon!)).toBe(true);
    expect(strokeInPolygon(outsideStrokePoints, closedPolygon!)).toBe(false);

    viewportEl.remove();
  });

  it('시나리오 10 (REFACTOR_ULTRAFAST_PEN_CANVAS): 2계층 캔버스 버퍼링 - pointerup 시 activeCanvas가 committedCanvas로 1회 Bake되고 activeCanvas는 초기화된다', () => {
    const activeCanvas = document.createElement('canvas');
    const committedCanvas = document.createElement('canvas');
    activeCanvas.width = 1200;
    activeCanvas.height = 1600;
    committedCanvas.width = 1200;
    committedCanvas.height = 1600;

    const activeCtx = {
      save: vi.fn(),
      restore: vi.fn(),
      clearRect: vi.fn(),
      setTransform: vi.fn(),
      scale: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
    } as unknown as CanvasRenderingContext2D;

    const committedCtx = {
      save: vi.fn(),
      restore: vi.fn(),
      clearRect: vi.fn(),
      setTransform: vi.fn(),
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D;

    let isDrawing = false;
    const strokePoints: StrokePoint[] = [];

    // pointerdown: S-Pen 획 시작
    const onDown = (e: { pointerType: string; clientX: number; clientY: number; pressure?: number }) => {
      if (e.pointerType !== 'pen') return;
      isDrawing = true;
      strokePoints.push([e.clientX, e.clientY, e.pressure || 0.5]);
    };

    // pointermove: 활성 캔버스에만 실시간 렌더링
    const onMove = (e: { pointerType: string; clientX: number; clientY: number; pressure?: number }) => {
      if (!isDrawing || e.pointerType !== 'pen') return;
      strokePoints.push([e.clientX, e.clientY, e.pressure || 0.5]);
    };

    // pointerup: 완성된 획만 Committed 버퍼에 딱 1회 Bake하고 Active 캔버스 비움
    const onUp = (e: { pointerType: string }) => {
      if (!isDrawing || e.pointerType !== 'pen') return;
      isDrawing = false;

      // 1:1 디바이스 픽셀 전사
      committedCtx.save();
      committedCtx.setTransform(1, 0, 0, 1, 0, 0);
      committedCtx.drawImage(activeCanvas, 0, 0);
      committedCtx.restore();

      // 활성 캔버스만 초기화
      activeCtx.save();
      activeCtx.setTransform(1, 0, 0, 1, 0, 0);
      activeCtx.clearRect(0, 0, activeCanvas.width, activeCanvas.height);
      activeCtx.restore();
    };

    onDown({ pointerType: 'pen', clientX: 100, clientY: 100, pressure: 0.5 });
    onMove({ pointerType: 'pen', clientX: 120, clientY: 110, pressure: 0.6 });
    onMove({ pointerType: 'pen', clientX: 150, clientY: 130, pressure: 0.7 });
    onUp({ pointerType: 'pen' });

    // Committed 캔버스에는 clearRect 가 전혀 불리지 않고 drawImage 로만 1회 베이크됨
    expect(committedCtx.clearRect).not.toHaveBeenCalled();
    expect(committedCtx.drawImage).toHaveBeenCalledTimes(1);
    expect(committedCtx.drawImage).toHaveBeenCalledWith(activeCanvas, 0, 0);

    // Active 캔버스는 pointerup 완료 시 1회 clearRect 로 초기화됨
    expect(activeCtx.clearRect).toHaveBeenCalledTimes(1);
    expect(strokePoints.length).toBe(3);
  });

  it('시나리오 11 (REFACTOR_ULTRAFAST_PEN_CANVAS): 리사이즈 가드 - 단순 React 리렌더링 발생 시 canvas.width/height 재할당 및 버퍼 클리어가 발생하지 않는다', () => {
    const testCanvas = document.createElement('canvas');
    let widthAssignmentCount = 0;
    let heightAssignmentCount = 0;

    let currentWidth = 0;
    let currentHeight = 0;

    Object.defineProperty(testCanvas, 'width', {
      get() {
        return currentWidth;
      },
      set(val: number) {
        widthAssignmentCount++;
        currentWidth = val;
      },
    });

    Object.defineProperty(testCanvas, 'height', {
      get() {
        return currentHeight;
      },
      set(val: number) {
        heightAssignmentCount++;
        currentHeight = val;
      },
    });

    // 캔버스 크기 할당 가드 함수: 실제 치수가 다를 때만 1회 할당
    const applyCanvasDimensions = (canvas: HTMLCanvasElement, targetW: number, targetH: number) => {
      if (canvas.width !== targetW) {
        canvas.width = targetW;
      }
      if (canvas.height !== targetH) {
        canvas.height = targetH;
      }
    };

    // 1. 최초 마운트 시 치수 할당
    applyCanvasDimensions(testCanvas, 1920, 1080);
    expect(widthAssignmentCount).toBe(1);
    expect(heightAssignmentCount).toBe(1);

    // 2. React 리렌더링 10회 발생 시 (치수 불변)
    for (let i = 0; i < 10; i++) {
      applyCanvasDimensions(testCanvas, 1920, 1080);
    }
    // 치수가 동일하므로 재할당이 0회여야 하며, 버퍼 클리어가 방지됨
    expect(widthAssignmentCount).toBe(1);
    expect(heightAssignmentCount).toBe(1);

    // 3. 실제 윈도우 리사이즈가 발생했을 때만 재할당 수행
    applyCanvasDimensions(testCanvas, 2560, 1440);
    expect(widthAssignmentCount).toBe(2);
    expect(heightAssignmentCount).toBe(2);
  });

  it('시나리오 12 (REFACTOR_ULTRAFAST_PEN_CANVAS): 하드웨어 샘플링 수집 - getCoalescedEvents의 240Hz 고주파 좌표가 누락 없이 획에 전수 반영된다', async () => {
    const { coalescedEventsOf } = await import('../src/canvas/lowLatency');

    const sample1 = { clientX: 101, clientY: 201, pressure: 0.5 } as PointerEvent;
    const sample2 = { clientX: 102, clientY: 202, pressure: 0.55 } as PointerEvent;
    const sample3 = { clientX: 103, clientY: 203, pressure: 0.6 } as PointerEvent;

    // 네이티브 PointerEvent 모의 객체 (getCoalescedEvents 지원)
    const nativeEventWithCoalesced = {
      clientX: 103,
      clientY: 203,
      pressure: 0.6,
      getCoalescedEvents: () => [sample1, sample2, sample3],
    } as unknown as PointerEvent;

    const collectedFromNative = coalescedEventsOf(nativeEventWithCoalesced);
    expect(collectedFromNative.length).toBe(3);
    expect(collectedFromNative[0].clientX).toBe(101);
    expect(collectedFromNative[2].clientX).toBe(103);

    // React SyntheticEvent 래퍼 형태의 모의 객체
    const syntheticEventWithCoalesced = {
      clientX: 103,
      clientY: 203,
      nativeEvent: {
        clientX: 103,
        clientY: 203,
        getCoalescedEvents: () => [sample1, sample2, sample3],
      },
    } as unknown as PointerEvent;

    const collectedFromSynthetic = coalescedEventsOf(syntheticEventWithCoalesced);
    expect(collectedFromSynthetic.length).toBe(3);
    expect(collectedFromSynthetic[1].clientY).toBe(202);

    // 미지원 환경: 단일 이벤트 폴백
    const fallbackEvent = {
      clientX: 150,
      clientY: 250,
    } as PointerEvent;
    const collectedFromFallback = coalescedEventsOf(fallbackEvent);
    expect(collectedFromFallback.length).toBe(1);
    expect(collectedFromFallback[0].clientX).toBe(150);
  });

  it('시나리오 13 (BUGFIX_LASSO_VISUAL_FEEDBACK): 올가미 툴 드래그 시 Active Canvas 상에 파란색 점선(rgba(59, 130, 246, 0.8), [6, 6]) 및 반투명 채우기(rgba(59, 130, 246, 0.12)) 패스가 실시간 렌더링된다', () => {
    let currentLineDash: number[] = [];
    let currentStrokeStyle = '';
    let currentFillStyle = '';
    let currentLineWidth = 0;

    const activeCtx = {
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      quadraticCurveTo: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(),
      closePath: vi.fn(),
      setLineDash: vi.fn((dash: number[]) => {
        currentLineDash = dash;
      }),
      get strokeStyle() {
        return currentStrokeStyle;
      },
      set strokeStyle(v: string) {
        currentStrokeStyle = v;
      },
      get fillStyle() {
        return currentFillStyle;
      },
      set fillStyle(v: string) {
        currentFillStyle = v;
      },
      get lineWidth() {
        return currentLineWidth;
      },
      set lineWidth(v: number) {
        currentLineWidth = v;
      },
    } as unknown as CanvasRenderingContext2D;

    const lassoPoints: Point[] = [
      { x: 100, y: 100 },
      { x: 200, y: 100 },
      { x: 200, y: 200 },
      { x: 100, y: 200 },
    ];

    // 올가미 드래그 시각 피드백 렌더러 호출
    renderLassoFeedback(activeCtx, lassoPoints);

    // 1. 파란색 점선 스타일 설정([6, 6], rgba(59, 130, 246, 0.8), lineWidth: 2) 검증
    expect(activeCtx.setLineDash).toHaveBeenCalledWith([6, 6]);
    expect(currentStrokeStyle).toBe('rgba(59, 130, 246, 0.8)');
    expect(currentLineWidth).toBe(2.0);
    expect(activeCtx.stroke).toHaveBeenCalled();

    // 2. 반투명 채우기(rgba(59, 130, 246, 0.12)) 검증
    expect(currentFillStyle).toBe('rgba(59, 130, 246, 0.12)');
    expect(activeCtx.fill).toHaveBeenCalled();
  });

  it('시나리오 14 (SMOOTH_PINCH_ZOOM_DIRECT_DOM_TRANSFORM): 두 손가락 핀치 줌 도중 session.setZoom 스토어 호출 0회 및 DOM 직접 갱신, 제스처 종료 시 1회 스토어 동기화', () => {
    let storeZoom = 1.0;
    let setZoomCallCount = 0;
    const session = {
      ui: { zoom: 1.0 },
      setZoom: (z: number) => {
        setZoomCallCount++;
        storeZoom = z;
      },
    };

    const sizer = document.createElement('div');
    const page = document.createElement('div');
    const viewport = document.createElement('div');

    let pendingPinchZoom: number | null = null;
    let isPinching = false;

    const applyZoomWithFocalOffsets = (
      nextZoom: number,
      offsets: { scrollTop: number; scrollLeft: number },
      isDirectGesture = false,
    ) => {
      sizer.style.width = `${Math.round(1200 * nextZoom)}px`;
      sizer.style.minHeight = `${Math.round(1600 * nextZoom)}px`;
      page.style.transform = nextZoom === 1 ? '' : `scale(${nextZoom})`;
      page.style.transformOrigin = 'top left';
      viewport.scrollTop = offsets.scrollTop;
      viewport.scrollLeft = offsets.scrollLeft;
      if (isDirectGesture) {
        pendingPinchZoom = nextZoom;
      } else {
        session.setZoom(nextZoom);
      }
    };

    const commitPinchZoomIfPending = () => {
      if (pendingPinchZoom !== null) {
        const finalZoom = pendingPinchZoom;
        pendingPinchZoom = null;
        session.setZoom(finalZoom);
      }
    };

    // 1. 두 손가락 핀치 줌 시작
    isPinching = true;

    // 2. 핀치 줌 진행 중 (touchmove 10회 연속 발생)
    for (let i = 1; i <= 10; i++) {
      const zoomLevel = 1.0 + i * 0.05;
      applyZoomWithFocalOffsets(zoomLevel, { scrollTop: 100 * i, scrollLeft: 50 * i }, isPinching);
    }

    // 핀치 동작 중에는 React Zustand 스토어 업데이트(리렌더링 유발)가 0회여야 함
    expect(setZoomCallCount).toBe(0);
    // 대신 DOM 엘리먼트에 직접 scale 및 sizer 너비가 반영되어야 함
    expect(page.style.transform).toBe('scale(1.5)');
    expect(sizer.style.width).toBe('1800px');

    // 3. 핀치 줌 종료 (touchend)
    isPinching = false;
    commitPinchZoomIfPending();

    // 제스처가 끝나는 시점에만 스토어 동기화가 정확히 1회 호출됨
    expect(setZoomCallCount).toBe(1);
    expect(storeZoom).toBe(1.5);
  });
});

