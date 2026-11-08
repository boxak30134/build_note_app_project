import { Capacitor, registerPlugin } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';
import type { Point, StrokePoint } from '../geometry/geometry';
import { resolveLassoPolygonOnRelease, strokeInPolygon } from '../geometry/geometry';
import type { PenType, Stroke, StrokeStore, StrokeTool } from '../strokes/StrokeStore';
import {
  PALM_REJECTION_WINDOW_MS,
  normalizePenPressure,
  type PalmRejectionState,
} from './androidDeployment';

/** Android MotionEvent ToolType 상수 (android.view.MotionEvent와 1:1 대응) */
export const ANDROID_TOOL_TYPE_UNKNOWN = 0;
export const ANDROID_TOOL_TYPE_FINGER = 1;
export const ANDROID_TOOL_TYPE_STYLUS = 2;
export const ANDROID_TOOL_TYPE_MOUSE = 3;
export const ANDROID_TOOL_TYPE_ERASER = 4;

/** Android MotionEvent S-Pen 배럴 버튼 상수 (MotionEvent.BUTTON_STYLUS_PRIMARY) */
export const ANDROID_BUTTON_STYLUS_PRIMARY = 32;

/** Android MotionEvent Action 상수 */
export const ANDROID_ACTION_DOWN = 0;
export const ANDROID_ACTION_UP = 1;
export const ANDROID_ACTION_MOVE = 2;
export const ANDROID_ACTION_CANCEL = 3;

export type WorkspacePaneId = 'primary' | 'secondary';
export type NativeActiveTool = 'pencil' | 'highlighter' | 'eraser' | 'lasso';

export type ScreenRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

export type NativeToolConfigPayload = {
  tool: NativeActiveTool;
  penType: PenType;
  color: string;
  size: number;
  eraserRadius?: number;
};

export type NativeViewportTransformPayload = {
  paneId: WorkspacePaneId;
  pageId: string;
  scrollLeft: number;
  scrollTop: number;
  scale: number;
  /** 웹뷰 내 페이지 컨테이너의 화면 기준 오프셋 (px) */
  pageOffsetX: number;
  pageOffsetY: number;
  /** 클리핑을 위한 워크스페이스 뷰포트 경계 (px) */
  viewportBounds: ScreenRect;
};

export type NativeStrokeFinishedPayload = {
  paneId: WorkspacePaneId;
  pageId: string;
  stroke: Stroke;
};

export type NativeStrokesErasedPayload = {
  paneId: WorkspacePaneId;
  pageId: string;
  erasedPoints: Array<[number, number]>;
  radius: number;
};

export type NativeLassoMovedPayload = {
  paneId: WorkspacePaneId;
  pageId: string;
  polygon: Array<[number, number]>;
  dx: number;
  dy: number;
};

export type NativeCommittedStrokesPayload = {
  paneId: WorkspacePaneId;
  pageId: string;
  strokes: Stroke[];
};

export interface NativeStylusOverlayPluginContract {
  setOverlayEnabled(options: { enabled: boolean }): Promise<{ enabled: boolean }>;
  setToolConfig(options: NativeToolConfigPayload): Promise<void>;
  syncViewportTransform(options: NativeViewportTransformPayload): Promise<void>;
  setExclusionRects(options: { rects: ScreenRect[] }): Promise<void>;
  syncCommittedStrokes(options: NativeCommittedStrokesPayload): Promise<void>;
  addListener(
    eventName: 'onStrokeFinished',
    listenerFunc: (payload: NativeStrokeFinishedPayload) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'onStrokesErased',
    listenerFunc: (payload: NativeStrokesErasedPayload) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'onLassoMoved',
    listenerFunc: (payload: NativeLassoMovedPayload) => void,
  ): Promise<PluginListenerHandle>;
}

export type NativeMotionEventSample = {
  action: number;
  toolType: number;
  buttonState?: number;
  x: number;
  y: number;
  pressure?: number;
  timestampMs?: number;
};

export type NativeMotionRouteDecision = {
  /** NativeInkOverlayView.onTouchEvent 반환값 (true = 네이티브 소비, false = 하단 WebView로 투과) */
  consume: boolean;
  /** 하단 Capacitor WebView로 이벤트가 투과되는지 여부 (!consume) */
  passThroughToWebView: boolean;
  /** 팜 리젝션에 의해 차단된 손바닥 터치인지 여부 */
  rejectedPalm: boolean;
  /** 헤더·툴바·모달 등 UI 배제 영역(exclusionRects) 터치로 인해 웹뷰로 투과되었는지 여부 */
  hitExclusionRect: boolean;
  /** 스타일러스 입력일 때 실제 적용될 도구(배럴 버튼/지우개 펜촉 자동 전환 반영) */
  effectiveTool: NativeActiveTool | null;
};

/**
 * 점이 화면 사각형(ScreenRect) 내부에 포함되는지 검사
 */
export function isPointInScreenRect(x: number, y: number, rect: ScreenRect): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

/**
 * NativeInkOverlayView.onTouchEvent의 핵심 터치 투과(Pass-through) 및 450ms 하드웨어 팜 리젝션 판별 로직
 *
 * 1. overlayEnabled === false 이거나 UI 배제 영역(exclusionRects) 내부 터치 시:
 *    펜/손가락 무관하게 consume = false (웹뷰 UI 클릭이 정상 동작하도록 투과).
 * 2. TOOL_TYPE_STYLUS 또는 TOOL_TYPE_ERASER:
 *    배럴 버튼(BUTTON_STYLUS_PRIMARY = 32) 또는 TOOL_TYPE_ERASER 감지 시 지우개 모드로 즉시 분기하며,
 *    팜 리젝션 상태를 갱신하고 consume = true 반환(웹뷰 스크롤/줌 전파 원천 차단).
 * 3. TOOL_TYPE_FINGER:
 *    - 펜 필기 중(isPenDrawing === true)이거나 펜을 뗀 후 450ms(PALM_REJECTION_WINDOW_MS) 이내이면
 *      손바닥 오터치로 판정하여 consume = true, rejectedPalm = true로 폐기(웹뷰로 전달하지 않음).
 *    - 평상시 손가락 터치는 consume = false, passThroughToWebView = true를 반환하여
 *      하단 Capacitor WebView의 핀치 줌·스크롤·텍스트 커서 조작을 100% 보장.
 */
export function routeNativeMotionEvent(
  event: NativeMotionEventSample,
  options: {
    overlayEnabled: boolean;
    configuredTool: NativeActiveTool;
    exclusionRects?: ScreenRect[];
    /** 활성 흰색 노트 용지(.page-canvas-surface)의 화면 경계 — 이 영역 바깥 펜 터치는 웹뷰로 바이패스 */
    pageBounds?: ScreenRect;
    palmState: PalmRejectionState;
    palmWindowMs?: number;
  },
): NativeMotionRouteDecision {
  const nowMs = event.timestampMs ?? Date.now();
  const palmWindowMs = options.palmWindowMs ?? PALM_REJECTION_WINDOW_MS;

  if (!options.overlayEnabled) {
    return {
      consume: false,
      passThroughToWebView: true,
      rejectedPalm: false,
      hitExclusionRect: false,
      effectiveTool: null,
    };
  }

  // 액션 진행 중인 펜 스트로크가 아닐 때(ACTION_DOWN 시점) UI 배제 영역 또는 노트 용지 바깥 영역 검사
  if (event.action === ANDROID_ACTION_DOWN && !options.palmState.isPenDrawing) {
    if (
      options.exclusionRects &&
      options.exclusionRects.some((rect) => isPointInScreenRect(event.x, event.y, rect))
    ) {
      return {
        consume: false,
        passThroughToWebView: true,
        rejectedPalm: false,
        hitExclusionRect: true,
        effectiveTool: null,
      };
    }

    if (options.pageBounds && !isPointInScreenRect(event.x, event.y, options.pageBounds)) {
      return {
        consume: false,
        passThroughToWebView: true,
        rejectedPalm: false,
        hitExclusionRect: true,
        effectiveTool: null,
      };
    }
  }

  const isStylus =
    event.toolType === ANDROID_TOOL_TYPE_STYLUS || event.toolType === ANDROID_TOOL_TYPE_ERASER;

  if (isStylus) {
    if (event.action === ANDROID_ACTION_DOWN || event.action === ANDROID_ACTION_MOVE) {
      options.palmState.isPenDrawing = true;
      options.palmState.lastPenTimestamp = nowMs;
    } else if (event.action === ANDROID_ACTION_UP || event.action === ANDROID_ACTION_CANCEL) {
      options.palmState.isPenDrawing = false;
      options.palmState.lastPenTimestamp = nowMs;
    }

    const isBarrelOrEraserTip =
      event.toolType === ANDROID_TOOL_TYPE_ERASER ||
      ((event.buttonState ?? 0) & ANDROID_BUTTON_STYLUS_PRIMARY) !== 0;

    const effectiveTool: NativeActiveTool = isBarrelOrEraserTip ? 'eraser' : options.configuredTool;

    return {
      consume: true,
      passThroughToWebView: false,
      rejectedPalm: false,
      hitExclusionRect: false,
      effectiveTool,
    };
  }

  // 손가락 터치(TOOL_TYPE_FINGER 등) 분기: 450ms 팜 리젝션 검사
  if (event.toolType === ANDROID_TOOL_TYPE_FINGER) {
    const isWithinPalmWindow =
      options.palmState.isPenDrawing ||
      (options.palmState.lastPenTimestamp > 0 &&
        nowMs - options.palmState.lastPenTimestamp <= palmWindowMs);

    if (isWithinPalmWindow) {
      return {
        consume: true,
        passThroughToWebView: false,
        rejectedPalm: true,
        hitExclusionRect: false,
        effectiveTool: null,
      };
    }

    return {
      consume: false,
      passThroughToWebView: true,
      rejectedPalm: false,
      hitExclusionRect: false,
      effectiveTool: null,
    };
  }

  return {
    consume: false,
    passThroughToWebView: true,
    rejectedPalm: false,
    hitExclusionRect: false,
    effectiveTool: null,
  };
}

/**
 * 페이지 로컬 좌표 (pageX, pageY, CSS px) -> 안드로이드 화면 물리 픽셀 좌표 (screenX, screenY) 정변환
 */
export function pagePointToScreen(
  pageX: number,
  pageY: number,
  transform: Pick<
    NativeViewportTransformPayload,
    'scrollLeft' | 'scrollTop' | 'scale' | 'pageOffsetX' | 'pageOffsetY'
  > & { density?: number },
): Point {
  const safeScale = transform.scale > 0 ? transform.scale : 1;
  const dpr = transform.density && transform.density > 0 ? transform.density : 1;
  return {
    x: ((pageX - transform.scrollLeft) * safeScale + transform.pageOffsetX) * dpr,
    y: ((pageY - transform.scrollTop) * safeScale + transform.pageOffsetY) * dpr,
  };
}

/**
 * 안드로이드 화면 물리 픽셀 좌표 (screenX, screenY) -> 페이지 로컬 좌표 (pageX, pageY, CSS px) 역변환
 */
export function screenPointToPage(
  screenX: number,
  screenY: number,
  transform: Pick<
    NativeViewportTransformPayload,
    'scrollLeft' | 'scrollTop' | 'scale' | 'pageOffsetX' | 'pageOffsetY'
  > & { density?: number },
): Point {
  const safeScale = transform.scale > 0 ? transform.scale : 1;
  const dpr = transform.density && transform.density > 0 ? transform.density : 1;
  return {
    x: (screenX / dpr - transform.pageOffsetX) / safeScale + transform.scrollLeft,
    y: (screenY / dpr - transform.pageOffsetY) / safeScale + transform.scrollTop,
  };
}

/**
 * 네이티브 화면 픽셀 샘플 배열 [[screenX, screenY, rawPressure], ...]을
 * 페이지 로컬 StrokePoint 배열 [[pageX, pageY, normalizedPressure], ...]로 변환
 */
export function convertScreenSamplesToPagePoints(
  samples: Array<[number, number, number]>,
  transform: Pick<
    NativeViewportTransformPayload,
    'scrollLeft' | 'scrollTop' | 'scale' | 'pageOffsetX' | 'pageOffsetY'
  > & { density?: number },
): StrokePoint[] {
  return samples.map(([sx, sy, rawPressure]) => {
    const pt = screenPointToPage(sx, sy, transform);
    const pressure = normalizePenPressure(rawPressure, 'pen');
    return [pt.x, pt.y, pressure];
  });
}

/**
 * 비-안드로이드(웹 브라우저 / Vitest) 환경을 위한 인메모리 폴백 플러그인
 */
class FallbackNativeStylusOverlayPlugin implements NativeStylusOverlayPluginContract {
  private enabled = false;
  private strokeFinishedListeners = new Set<(payload: NativeStrokeFinishedPayload) => void>();
  private strokesErasedListeners = new Set<(payload: NativeStrokesErasedPayload) => void>();
  private lassoMovedListeners = new Set<(payload: NativeLassoMovedPayload) => void>();

  public lastToolConfig: NativeToolConfigPayload | null = null;
  public lastViewportTransforms = new Map<string, NativeViewportTransformPayload>();
  public lastExclusionRects: ScreenRect[] = [];
  public committedStrokesByKey = new Map<string, Stroke[]>();

  async setOverlayEnabled(options: { enabled: boolean }): Promise<{ enabled: boolean }> {
    this.enabled = options.enabled;
    return { enabled: this.enabled };
  }

  async setToolConfig(options: NativeToolConfigPayload): Promise<void> {
    this.lastToolConfig = { ...options };
  }

  async syncViewportTransform(options: NativeViewportTransformPayload): Promise<void> {
    this.lastViewportTransforms.set(`${options.paneId}:${options.pageId}`, { ...options });
  }

  async setExclusionRects(options: { rects: ScreenRect[] }): Promise<void> {
    this.lastExclusionRects = options.rects.slice();
  }

  async syncCommittedStrokes(options: NativeCommittedStrokesPayload): Promise<void> {
    this.committedStrokesByKey.set(
      `${options.paneId}:${options.pageId}`,
      options.strokes.map((s) => ({ ...s, points: s.points.slice() })),
    );
  }

  async addListener(
    eventName: 'onStrokeFinished' | 'onStrokesErased' | 'onLassoMoved',
    listenerFunc:
      | ((payload: NativeStrokeFinishedPayload) => void)
      | ((payload: NativeStrokesErasedPayload) => void)
      | ((payload: NativeLassoMovedPayload) => void),
  ): Promise<PluginListenerHandle> {
    if (eventName === 'onStrokeFinished') {
      const fn = listenerFunc as (payload: NativeStrokeFinishedPayload) => void;
      this.strokeFinishedListeners.add(fn);
      return {
        remove: async () => {
          this.strokeFinishedListeners.delete(fn);
        },
      };
    }
    if (eventName === 'onStrokesErased') {
      const fn = listenerFunc as (payload: NativeStrokesErasedPayload) => void;
      this.strokesErasedListeners.add(fn);
      return {
        remove: async () => {
          this.strokesErasedListeners.delete(fn);
        },
      };
    }
    const fn = listenerFunc as (payload: NativeLassoMovedPayload) => void;
    this.lassoMovedListeners.add(fn);
    return {
      remove: async () => {
        this.lassoMovedListeners.delete(fn);
      },
    };
  }

  /** 테스트 및 시뮬레이션용 이벤트 디스패처 */
  emitStrokeFinished(payload: NativeStrokeFinishedPayload) {
    this.strokeFinishedListeners.forEach((fn) => fn(payload));
  }

  emitStrokesErased(payload: NativeStrokesErasedPayload) {
    this.strokesErasedListeners.forEach((fn) => fn(payload));
  }

  emitLassoMoved(payload: NativeLassoMovedPayload) {
    this.lassoMovedListeners.forEach((fn) => fn(payload));
  }
}

export const fallbackNativeStylusPlugin = new FallbackNativeStylusOverlayPlugin();

const RegisteredNativeStylusOverlay = registerPlugin<NativeStylusOverlayPluginContract>(
  'NativeStylusOverlay',
  {
    web: () => Promise.resolve(fallbackNativeStylusPlugin),
  },
);

/**
 * 현재 런타임이 안드로이드 네이티브 오버레이를 사용하는지 여부 반환
 */
export function isAndroidNativeStylusPlatform(): boolean {
  try {
    return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
  } catch {
    return false;
  }
}

/**
 * 활성 브릿지 인스턴스 반환 (안드로이드 네이티브 환경이면 Capacitor 플러그인, 아니면 인메모리 폴백)
 */
export function getNativeStylusBridge(): NativeStylusOverlayPluginContract {
  if (isAndroidNativeStylusPlatform()) {
    return RegisteredNativeStylusOverlay;
  }
  return fallbackNativeStylusPlugin;
}

/**
 * 특정 (paneId, pageId)의 StrokeStore 및 CompositeHistoryManager를
 * 안드로이드 네이티브 오버레이 플러그인과 양방향으로 바인딩한다.
 *
 * - 네이티브 ACTION_UP ('onStrokeFinished') -> StrokeStore.addStroke (CompositeHistoryManager에 단일 명령으로 적재)
 * - 네이티브 지우개 ('onStrokesErased') -> StrokeStore.eraseAt (동일 제스처 내 단일 mergeCommandId로 병합 적재)
 * - 네이티브 올가미 이동 ('onLassoMoved') -> strokeInPolygon 판정 후 StrokeStore.moveStrokes 적재
 * - 웹뷰 Undo/Redo 또는 스트로크 변경 -> NativeStylusOverlay.syncCommittedStrokes 자동 호출하여 네이티브 캔버스 재베이크
 */
export async function bindStrokeStoreToNativeOverlay(options: {
  paneId: WorkspacePaneId;
  pageId: string;
  strokeStore: StrokeStore;
  bridge?: NativeStylusOverlayPluginContract;
  onLassoSelected?: (ids: string[]) => void;
}): Promise<() => Promise<void>> {
  const bridge = options.bridge ?? getNativeStylusBridge();
  const { paneId, pageId, strokeStore, onLassoSelected } = options;

  // 초기 마운트 시 현재 페이지의 확정된 스트로크를 네이티브 오버레이에 동기화
  await bridge.syncCommittedStrokes({
    paneId,
    pageId,
    strokes: strokeStore.getAll(),
  });

  // StrokeStore 변경(Undo/Redo 포함) 시 네이티브 오버레이의 committedBitmap을 즉시 갱신
  const unsubscribeStore = strokeStore.subscribe(() => {
    void bridge.syncCommittedStrokes({
      paneId,
      pageId,
      strokes: strokeStore.getAll(),
    });
  });

  const finishedHandle = await bridge.addListener('onStrokeFinished', (payload) => {
    if (payload.paneId !== paneId || payload.pageId !== pageId) return;
    const normalizedTool: StrokeTool =
      payload.stroke.tool === 'highlighter' ? 'highlighter' : 'pencil';
    strokeStore.addStroke({
      ...payload.stroke,
      tool: normalizedTool,
    });
  });

  const erasedHandle = await bridge.addListener('onStrokesErased', (payload) => {
    if (payload.paneId !== paneId || payload.pageId !== pageId) return;
    let mergeCommandId: string | undefined;
    const radius = payload.radius > 0 ? payload.radius : 12;
    for (const [x, y] of payload.erasedPoints) {
      const res = strokeStore.eraseAt(x, y, radius, mergeCommandId);
      if (res.commandId) {
        mergeCommandId = res.commandId;
      }
    }
  });

  const lassoHandle = await bridge.addListener('onLassoMoved', (payload) => {
    if (payload.paneId !== paneId || payload.pageId !== pageId) return;
    if (payload.polygon.length < 3) return;
    const rawPolygonPts: Point[] = payload.polygon.map(([x, y]) => ({ x, y }));
    const closedPoly =
      resolveLassoPolygonOnRelease(rawPolygonPts, { closeDistance: 48, minLoopLength: 24 }) ??
      rawPolygonPts;
    const selectedIds = strokeStore
      .getAll()
      .filter((s) => strokeInPolygon(s.points, closedPoly))
      .map((s) => s.id);
    onLassoSelected?.(selectedIds);
    if (selectedIds.length > 0 && (payload.dx !== 0 || payload.dy !== 0)) {
      strokeStore.moveStrokes(selectedIds, payload.dx, payload.dy);
    }
  });

  return async () => {
    unsubscribeStore();
    await finishedHandle.remove();
    await erasedHandle.remove();
    await lassoHandle.remove();
  };
}
