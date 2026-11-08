import type { Point, StrokePoint } from '../core/geometry/geometry';

/**
 * S-Pen 초저지연 필기 유틸 (tablet_s_pen_low_latency_and_hardware_acceleration_guide §2)
 * - 2.1 desynchronized 저지연 컨텍스트
 * - 2.2 getCoalescedEvents 240Hz 샘플 복원 + getPredictedEvents 예측 잉크
 * - 2.4 Midpoint Quadratic Bezier 보간
 */

/** 투명 오버레이(Layer 2) 캔버스용: 노트 본문이 비쳐야 하므로 alpha 는 유지한다 */
export const OVERLAY_CONTEXT_OPTIONS: CanvasRenderingContext2DSettings = {
  desynchronized: true,
  alpha: true,
  willReadFrequently: false,
};

/** 불투명 배경 캔버스용(가이드 원문 규칙): alpha:false 로 GPU 블렌딩 비용 제거 */
export const OPAQUE_CONTEXT_OPTIONS: CanvasRenderingContext2DSettings = {
  desynchronized: true,
  alpha: false,
  willReadFrequently: false,
};

const ctxCache = new WeakMap<HTMLCanvasElement, CanvasRenderingContext2D | null>();

/** 저지연 2D 컨텍스트 획득 (최초 1회 옵션 지정, 미지원 환경은 기본 컨텍스트로 폴백) */
export function getLowLatencyContext(
  canvas: HTMLCanvasElement,
  opts: CanvasRenderingContext2DSettings = OVERLAY_CONTEXT_OPTIONS,
): CanvasRenderingContext2D | null {
  if (ctxCache.has(canvas)) return ctxCache.get(canvas) ?? null;
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = canvas.getContext('2d', opts);
  } catch {
    ctx = null;
  }
  if (!ctx) {
    try {
      ctx = canvas.getContext('2d');
    } catch {
      ctx = null;
    }
  }
  if (ctx) ctxCache.set(canvas, ctx);
  return ctx;
}

/** 표준 2D 컨텍스트 획득 (확정된 영구 획 보관용 Dry 캔버스: desynchronized 비활성화로 CSS 블렌딩 및 컴포지터 무결성 보장) */
export function getStandardContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  if (ctxCache.has(canvas)) return ctxCache.get(canvas) ?? null;
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = canvas.getContext('2d');
  } catch {
    ctx = null;
  }
  if (ctx) ctxCache.set(canvas, ctx);
  return ctx;
}

/** 2.2: 화면 주사율에 맞춰 병합된 원시 디지타이저 샘플(240Hz) 전수 복원 */
export function coalescedEventsOf(e: PointerEvent): PointerEvent[] {
  // 네이티브 PointerEvent 또는 React SyntheticEvent 래퍼 모두 지원
  const target = (e as any).nativeEvent || e;
  if (typeof target.getCoalescedEvents === 'function') {
    try {
      const list = target.getCoalescedEvents();
      if (list && list.length) return list;
    } catch {
      /* 일부 WebView 는 신뢰되지 않은 이벤트에서 예외 */
    }
  }
  return [e];
}

/**
 * 2계층 캔버스 버퍼링: 완성된 활성(Active) 획을 누적(Committed) 캔버스에 1:1 디바이스 픽셀로 베이크하고 활성 캔버스를 초기화
 */
export function bakeActiveToCommitted(
  activeCanvas: HTMLCanvasElement,
  committedCanvas: HTMLCanvasElement,
): void {
  const committedCtx = committedCanvas.getContext('2d');
  const activeCtx = activeCanvas.getContext('2d');

  if (committedCtx && activeCanvas.width > 0 && activeCanvas.height > 0) {
    committedCtx.save();
    committedCtx.setTransform(1, 0, 0, 1, 0, 0); // DPR 스케일 왜곡 차단
    committedCtx.drawImage(activeCanvas, 0, 0);
    committedCtx.restore();
  }

  if (activeCtx && activeCanvas.width > 0 && activeCanvas.height > 0) {
    activeCtx.save();
    activeCtx.setTransform(1, 0, 0, 1, 0, 0);
    activeCtx.clearRect(0, 0, activeCanvas.width, activeCanvas.height);
    activeCtx.restore();
  }
}

/** 예측 이벤트(다음 1~2 프레임 펜 위치). 렌더링 전용이며 저장하지 않는다 */
export function predictedEventsOf(e: PointerEvent, max = 3): PointerEvent[] {
  if (typeof e.getPredictedEvents !== 'function') return [];
  try {
    return e.getPredictedEvents().slice(0, max);
  } catch {
    return [];
  }
}

/** 중복/미세 지터 샘플을 거르고 in-place 로 추가 (O(1), 배열 복사 없음). 추가되면 true */
export function appendStrokePoint(points: StrokePoint[], p: StrokePoint, minDist = 0.35): boolean {
  const last = points[points.length - 1];
  if (last) {
    const dx = p[0] - last[0];
    const dy = p[1] - last[1];
    if (dx * dx + dy * dy < minDist * minDist) {
      // 위치는 그대로, 필압만 최신값으로 갱신해 펜을 누르는 감각을 놓치지 않는다
      last[2] = Math.max(last[2], p[2]);
      return false;
    }
  }
  points.push(p);
  return true;
}

/** 2.4: 연속 세 점의 중점을 끝점, 가운데 점을 제어점으로 하는 2차 베지어 경로 */
export function traceMidpointQuadratic(
  ctx: Pick<CanvasRenderingContext2D, 'moveTo' | 'lineTo' | 'quadraticCurveTo'>,
  points: ReadonlyArray<Point | readonly number[]>,
): void {
  const xy = (p: Point | readonly number[]): [number, number] =>
    Array.isArray(p) ? [p[0] as number, p[1] as number] : [(p as Point).x, (p as Point).y];
  const n = points.length;
  if (n === 0) return;
  const [x0, y0] = xy(points[0]);
  ctx.moveTo(x0, y0);
  if (n === 1) {
    ctx.lineTo(x0 + 0.1, y0);
    return;
  }
  if (n === 2) {
    const [x1, y1] = xy(points[1]);
    ctx.lineTo(x1, y1);
    return;
  }
  for (let i = 1; i < n - 1; i++) {
    const [cx, cy] = xy(points[i]);
    const [nx, ny] = xy(points[i + 1]);
    ctx.quadraticCurveTo(cx, cy, (cx + nx) / 2, (cy + ny) / 2);
  }
  const [lx, ly] = xy(points[n - 1]);
  ctx.lineTo(lx, ly);
}

