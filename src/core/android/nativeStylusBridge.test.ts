import { describe, expect, it } from 'vitest';
import { CompositeHistoryManager } from '../history/CompositeHistoryManager';
import { StrokeStore } from '../strokes/StrokeStore';
import type { PalmRejectionState } from './androidDeployment';
import {
  ANDROID_ACTION_DOWN,
  ANDROID_ACTION_MOVE,
  ANDROID_ACTION_UP,
  ANDROID_BUTTON_STYLUS_PRIMARY,
  ANDROID_TOOL_TYPE_ERASER,
  ANDROID_TOOL_TYPE_FINGER,
  ANDROID_TOOL_TYPE_STYLUS,
  bindStrokeStoreToNativeOverlay,
  convertScreenSamplesToPagePoints,
  fallbackNativeStylusPlugin,
  pagePointToScreen,
  routeNativeMotionEvent,
  screenPointToPage,
} from './nativeStylusBridge';

describe('REQ_NATIVE_STYLUS_OVERLAY: Android Native Stylus Overlay Bridge & Touch Pass-through', () => {
  it('1. TOOL_TYPE_STYLUS 및 TOOL_TYPE_ERASER(배럴 버튼 포함) 입력은 네이티브 오버레이가 즉시 가로채서 소비(consume=true, passThroughToWebView=false)한다', () => {
    const palmState: PalmRejectionState = { isPenDrawing: false, lastPenTimestamp: 0 };

    // 일반 S-Pen 필기
    const penDown = routeNativeMotionEvent(
      {
        action: ANDROID_ACTION_DOWN,
        toolType: ANDROID_TOOL_TYPE_STYLUS,
        buttonState: 0,
        x: 300,
        y: 420,
        pressure: 0.72,
        timestampMs: 1000,
      },
      {
        overlayEnabled: true,
        configuredTool: 'pencil',
        palmState,
      },
    );
    expect(penDown.consume).toBe(true);
    expect(penDown.passThroughToWebView).toBe(false);
    expect(penDown.effectiveTool).toBe('pencil');
    expect(palmState.isPenDrawing).toBe(true);

    // S-Pen 배럴 버튼(BUTTON_STYLUS_PRIMARY = 32) 누른 상태 -> 지우개 자동 분기
    const barrelMove = routeNativeMotionEvent(
      {
        action: ANDROID_ACTION_MOVE,
        toolType: ANDROID_TOOL_TYPE_STYLUS,
        buttonState: ANDROID_BUTTON_STYLUS_PRIMARY,
        x: 310,
        y: 430,
        timestampMs: 1016,
      },
      {
        overlayEnabled: true,
        configuredTool: 'pencil',
        palmState,
      },
    );
    expect(barrelMove.consume).toBe(true);
    expect(barrelMove.effectiveTool).toBe('eraser');

    // 전용 지우개 펜촉(TOOL_TYPE_ERASER)
    const eraserTip = routeNativeMotionEvent(
      {
        action: ANDROID_ACTION_DOWN,
        toolType: ANDROID_TOOL_TYPE_ERASER,
        x: 320,
        y: 440,
        timestampMs: 1032,
      },
      {
        overlayEnabled: true,
        configuredTool: 'highlighter',
        palmState,
      },
    );
    expect(eraserTip.consume).toBe(true);
    expect(eraserTip.effectiveTool).toBe('eraser');
  });

  it('2. 평상시 TOOL_TYPE_FINGER(손가락 터치)는 소비하지 않고 하단 Capacitor WebView로 100% 투과(consume=false, passThroughToWebView=true)한다', () => {
    const palmState: PalmRejectionState = { isPenDrawing: false, lastPenTimestamp: 0 };

    const fingerDown = routeNativeMotionEvent(
      {
        action: ANDROID_ACTION_DOWN,
        toolType: ANDROID_TOOL_TYPE_FINGER,
        x: 400,
        y: 500,
        timestampMs: 2000,
      },
      {
        overlayEnabled: true,
        configuredTool: 'pencil',
        palmState,
      },
    );
    expect(fingerDown.consume).toBe(false);
    expect(fingerDown.passThroughToWebView).toBe(true);
    expect(fingerDown.rejectedPalm).toBe(false);
  });

  it('3. 펜 필기 중이거나 펜을 뗀 후 450ms(PALM_REJECTION_WINDOW_MS) 이내에 들어온 TOOL_TYPE_FINGER는 팜 리젝션으로 차단하고, 450ms 이후에는 다시 투과한다', () => {
    const palmState: PalmRejectionState = { isPenDrawing: false, lastPenTimestamp: 0 };

    // 1) 펜 필기 시작 (t = 5000ms)
    routeNativeMotionEvent(
      {
        action: ANDROID_ACTION_DOWN,
        toolType: ANDROID_TOOL_TYPE_STYLUS,
        x: 200,
        y: 200,
        timestampMs: 5000,
      },
      { overlayEnabled: true, configuredTool: 'pencil', palmState },
    );

    // 필기 도중 손바닥 터치 (t = 5100ms) -> 차단(consume = true, rejectedPalm = true)
    const palmDuringDraw = routeNativeMotionEvent(
      {
        action: ANDROID_ACTION_DOWN,
        toolType: ANDROID_TOOL_TYPE_FINGER,
        x: 500,
        y: 600,
        timestampMs: 5100,
      },
      { overlayEnabled: true, configuredTool: 'pencil', palmState },
    );
    expect(palmDuringDraw.consume).toBe(true);
    expect(palmDuringDraw.passThroughToWebView).toBe(false);
    expect(palmDuringDraw.rejectedPalm).toBe(true);

    // 2) 펜 뗌 (t = 5200ms)
    routeNativeMotionEvent(
      {
        action: ANDROID_ACTION_UP,
        toolType: ANDROID_TOOL_TYPE_STYLUS,
        x: 220,
        y: 220,
        timestampMs: 5200,
      },
      { overlayEnabled: true, configuredTool: 'pencil', palmState },
    );

    // 펜 뗀 직후 300ms 시점 손바닥 터치 (t = 5500ms <= 5200 + 450) -> 차단
    const palmAfterUp = routeNativeMotionEvent(
      {
        action: ANDROID_ACTION_DOWN,
        toolType: ANDROID_TOOL_TYPE_FINGER,
        x: 510,
        y: 610,
        timestampMs: 5500,
      },
      { overlayEnabled: true, configuredTool: 'pencil', palmState },
    );
    expect(palmAfterUp.consume).toBe(true);
    expect(palmAfterUp.rejectedPalm).toBe(true);

    // 3) 펜 뗀 후 460ms 경과 시점 정상 손가락 스크롤 (t = 5660ms > 5200 + 450) -> WebView 투과
    const fingerScrollAfterWindow = routeNativeMotionEvent(
      {
        action: ANDROID_ACTION_DOWN,
        toolType: ANDROID_TOOL_TYPE_FINGER,
        x: 510,
        y: 610,
        timestampMs: 5660,
      },
      { overlayEnabled: true, configuredTool: 'pencil', palmState },
    );
    expect(fingerScrollAfterWindow.consume).toBe(false);
    expect(fingerScrollAfterWindow.passThroughToWebView).toBe(true);
    expect(fingerScrollAfterWindow.rejectedPalm).toBe(false);
  });

  it('4. 상단 헤더·툴바·플로팅 팝오버 등 exclusionRects 영역을 S-Pen으로 탭할 때는 드로잉하지 않고 WebView UI 클릭으로 투과한다', () => {
    const palmState: PalmRejectionState = { isPenDrawing: false, lastPenTimestamp: 0 };
    const exclusionRects = [
      { left: 0, top: 0, right: 1280, bottom: 96 }, // Header + Toolbar
      { left: 400, top: 200, right: 680, bottom: 380 }, // Floating Popover
    ];

    const penTapOnToolbar = routeNativeMotionEvent(
      {
        action: ANDROID_ACTION_DOWN,
        toolType: ANDROID_TOOL_TYPE_STYLUS,
        x: 240,
        y: 48,
        timestampMs: 3000,
      },
      {
        overlayEnabled: true,
        configuredTool: 'pencil',
        exclusionRects,
        palmState,
      },
    );
    expect(penTapOnToolbar.consume).toBe(false);
    expect(penTapOnToolbar.passThroughToWebView).toBe(true);
    expect(penTapOnToolbar.hitExclusionRect).toBe(true);
  });

  it('5. 뷰포트 스크롤(scrollLeft, scrollTop) 및 줌 배율(scale) 매트릭스 정변환·역변환 시 페이지 로컬 좌표 오차가 1e-6 미만이다', () => {
    const transform = {
      scrollLeft: 120,
      scrollTop: 340,
      scale: 1.75,
      pageOffsetX: 64,
      pageOffsetY: 96,
    };

    const originalPagePt = { x: 412.5, y: 885.25 };
    const screenPt = pagePointToScreen(originalPagePt.x, originalPagePt.y, transform);
    const restoredPagePt = screenPointToPage(screenPt.x, screenPt.y, transform);

    expect(Math.abs(restoredPagePt.x - originalPagePt.x)).toBeLessThan(1e-6);
    expect(Math.abs(restoredPagePt.y - originalPagePt.y)).toBeLessThan(1e-6);

    const convertedPoints = convertScreenSamplesToPagePoints(
      [[screenPt.x, screenPt.y, 0.82]],
      transform,
    );
    expect(convertedPoints).toHaveLength(1);
    expect(Math.abs(convertedPoints[0][0] - originalPagePt.x)).toBeLessThan(1e-6);
    expect(Math.abs(convertedPoints[0][1] - originalPagePt.y)).toBeLessThan(1e-6);
    expect(convertedPoints[0][2]).toBeCloseTo(0.82, 5);
  });

  it('6. onStrokeFinished 및 onStrokesErased 수신 시 CompositeHistoryManager에 기록되며, Undo/Redo 3회 왕복 시 네이티브 오버레이의 committedStrokes가 정확히 역동기화된다', async () => {
    const history = new CompositeHistoryManager();
    const strokeStore = new StrokeStore(history);

    const unbind = await bindStrokeStoreToNativeOverlay({
      paneId: 'primary',
      pageId: 'note-alpha',
      strokeStore,
      bridge: fallbackNativeStylusPlugin,
    });

    // 네이티브에서 획 2개 연속 필기 완료 이벤트 발행
    fallbackNativeStylusPlugin.emitStrokeFinished({
      paneId: 'primary',
      pageId: 'note-alpha',
      stroke: {
        id: 'native-s1',
        tool: 'pencil',
        penType: 'ballpoint',
        color: '#000000',
        size: 3.5,
        points: [
          [100, 100, 0.6],
          [120, 110, 0.7],
          [140, 120, 0.65],
        ],
      },
    });

    fallbackNativeStylusPlugin.emitStrokeFinished({
      paneId: 'primary',
      pageId: 'note-alpha',
      stroke: {
        id: 'native-s2',
        tool: 'highlighter',
        penType: 'brush',
        color: '#FACC15',
        size: 12,
        points: [
          [200, 200, 0.5],
          [260, 200, 0.5],
        ],
      },
    });

    expect(strokeStore.getAll()).toHaveLength(2);
    expect(fallbackNativeStylusPlugin.committedStrokesByKey.get('primary:note-alpha')).toHaveLength(2);

    // Undo / Redo 3회 왕복 검증
    for (let cycle = 0; cycle < 3; cycle++) {
      history.undo();
      expect(strokeStore.getAll().map((s) => s.id)).toEqual(['native-s1']);
      expect(
        fallbackNativeStylusPlugin.committedStrokesByKey
          .get('primary:note-alpha')
          ?.map((s) => s.id),
      ).toEqual(['native-s1']);

      history.redo();
      expect(strokeStore.getAll().map((s) => s.id)).toEqual(['native-s1', 'native-s2']);
      expect(
        fallbackNativeStylusPlugin.committedStrokesByKey
          .get('primary:note-alpha')
          ?.map((s) => s.id),
      ).toEqual(['native-s1', 'native-s2']);
    }

    // 네이티브 지우개 이벤트('onStrokesErased') 수신 및 Undo 복원 검증
    fallbackNativeStylusPlugin.emitStrokesErased({
      paneId: 'primary',
      pageId: 'note-alpha',
      erasedPoints: [[110, 105]],
      radius: 15,
    });
    expect(strokeStore.getAll().map((s) => s.id)).toEqual(['native-s2']);

    history.undo();
    expect(strokeStore.getAll().map((s) => s.id)).toEqual(['native-s1', 'native-s2']);

    await unbind();
  });
});

