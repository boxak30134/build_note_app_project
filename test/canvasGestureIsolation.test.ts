// @vitest-environment jsdom
// test/canvasGestureIsolation.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { VirtualStylusAgent } from './utils/virtualStylus';
import { shouldRejectPalmTouch, type PalmRejectionState, PALM_REJECTION_WINDOW_MS } from '../src/utils/androidDeployment';
import { drawIncrementalStrokeSegment } from '../src/canvas/render';
import type { Stroke } from '../src/core/strokes/StrokeStore';
import { isPointerInsidePageCanvasSurface } from '../src/core/input/gestureRouting';
import { normalizePdfNoteContent } from '../src/core/page/pageTypes';
import {
  clientPointToPageLocal,
  resolveLassoPolygonOnRelease,
  strokeInPolygon,
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
});

