import { getStroke } from 'perfect-freehand';
import type { Stroke } from '../core/strokes/StrokeStore';
import { strokeBounds } from '../core/strokes/StrokeStore';
import type { AABB, Point } from '../core/geometry/geometry';
import { unionBounds } from '../core/geometry/geometry';
import { traceMidpointQuadratic } from './lowLatency';

const pathCache = new WeakMap<Stroke, Path2D>();

function traceOutline(target: CanvasPath, points: number[][]): void {
  const n = points.length;
  if (n === 0) return;
  if (n < 3) {
    target.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < n; i++) target.lineTo(points[i][0], points[i][1]);
    target.closePath();
    return;
  }
  // 첫 점과 마지막 점 사이의 중점에서 시작하여 닫힌 윤곽선 전체를 2차 베지어로 완전 순환
  const startX = (points[0][0] + points[n - 1][0]) / 2;
  const startY = (points[0][1] + points[n - 1][1]) / 2;
  target.moveTo(startX, startY);
  for (let i = 0; i < n; i++) {
    const [cx, cy] = points[i];
    const [nx, ny] = points[(i + 1) % n];
    target.quadraticCurveTo(cx, cy, (cx + nx) / 2, (cy + ny) / 2);
  }
  target.closePath();
}

function outlineToPath(points: number[][]): Path2D {
  const path = new Path2D();
  traceOutline(path, points);
  return path;
}

/**
 * 자연스러운 필압 S-커브 (Hermite smoothstep):
 * 미세한 손떨림으로 인한 급격한 굵기 튐을 방지하고 유려한 붓/만년필 필기감 제공
 */
export const naturalPenEasing = (t: number): number => {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
};

export function getPenStrokeOptions(stroke: Stroke, simulatePressure = false, isComplete = true) {
  const penType = stroke.penType || 'pencil';
  const hasPressure = stroke.points.some((p) => p[2] !== 0.5);
  const sim = simulatePressure || !hasPressure;

  switch (penType) {
    case 'fountain-sharp':
      // 1. 끝이 뾰족한 만년필: 필압에 민감하게 반응하고 끝이 날카롭게 테이퍼링됨
      return {
        size: stroke.size,
        thinning: 0.72,
        smoothing: 0.58,
        streamline: 0.5,
        easing: naturalPenEasing,
        start: { taper: 4, cap: true },
        end: { taper: isComplete ? 8 : 0, cap: true },
        simulatePressure: sim,
        last: isComplete,
      };
    case 'fountain-flat':
      // 2. 끝이 뭉툭한 만년필: 납작한 닙 형태의 캘리그래피 질감
      return {
        size: stroke.size,
        thinning: 0.25,
        smoothing: 0.45,
        streamline: 0.42,
        start: { taper: 0, cap: false },
        end: { taper: 0, cap: false },
        simulatePressure: sim,
        last: isComplete,
      };
    case 'ballpoint':
      // 3. 볼펜: 일정한 굵기, 둥근 캡, 압력 변화 최소화
      return {
        size: stroke.size,
        thinning: 0.05,
        smoothing: 0.6,
        streamline: 0.5,
        start: { taper: 0, cap: true },
        end: { taper: 0, cap: true },
        simulatePressure: false,
        last: isComplete,
      };
    case 'brush':
      // 5. 붓: 극적인 굵기 변화와 부드러운 유선형 끝단
      return {
        size: stroke.size * 1.25,
        thinning: 0.88,
        smoothing: 0.75,
        streamline: 0.65,
        easing: naturalPenEasing,
        start: { taper: 10, cap: true },
        end: { taper: isComplete ? 14 : 0, cap: true },
        simulatePressure: sim,
        last: isComplete,
      };
    case 'pencil':
    default:
      // 4. 연필: 기존 자연스러운 필기감
      return {
        size: stroke.size,
        thinning: 0.55,
        smoothing: 0.52,
        streamline: 0.48,
        easing: naturalPenEasing,
        start: { taper: 2, cap: true },
        end: { taper: isComplete ? 3 : 0, cap: true },
        simulatePressure: sim,
        last: isComplete,
      };
  }
}

export function pencilPath(stroke: Stroke, simulatePressure = false, isComplete = true): Path2D {
  if (isComplete) {
    const cached = pathCache.get(stroke);
    if (cached) return cached;
  }
  const outline = getStroke(stroke.points, getPenStrokeOptions(stroke, simulatePressure, isComplete));
  const path = outlineToPath(outline);
  if (isComplete) {
    pathCache.set(stroke, path);
  }
  return path;
}

/**
 * 스트로크 하나 그리기:
 * - 실시간 증분 드로잉(`drawIncrementalStrokeSegment`) 및 `drawImage` 베이킹 결과와 100% 동일한
 *   Midpoint Quadratic Bezier 세그먼트 렌더러를 사용하여, 지우개 접촉·스크롤·줌 재렌더링 시에도
 *   글씨 모양이나 굵기가 1픽셀도 변하지 않도록 보장한다.
 */
export function drawStroke(
  ctx: CanvasRenderingContext2D,
  stroke: Stroke,
  opts: { faded?: boolean; isComplete?: boolean } = {},
) {
  ctx.save();
  if (stroke.tool === 'highlighter') {
    ctx.globalAlpha = opts.faded ? 0.12 : 0.35;
    ctx.globalCompositeOperation = 'multiply';
    drawIncrementalStrokeSegment(ctx, stroke, 0);
  } else {
    if (opts.faded) ctx.globalAlpha = 0.2;
    drawIncrementalStrokeSegment(ctx, stroke, 0);
  }
  ctx.restore();
}

/**
 * 실시간 활성 획(Active Canvas) 전용 증분(Incremental) 세그먼트 드로잉:
 * - pointermove 도중 clearRect()를 호출하지 않고 새로 유입된 샘플 구간(fromIndex ~ n-1)만
 *   Midpoint Quadratic Bezier 곡선으로 즉시 이어 그려 깜빡임(Flickering/Tearing)을 원천 차단한다.
 * @returns 렌더링 완료된 최신 점 개수 (다음 호출의 fromIndex)
 */
export function drawIncrementalStrokeSegment(
  ctx: CanvasRenderingContext2D,
  stroke: Stroke,
  fromIndex: number,
): number {
  const pts = stroke.points;
  const n = pts.length;
  if (n === 0 || fromIndex >= n) return n;

  ctx.save();
  if (stroke.tool === 'highlighter') {
    // Active Canvas 자체가 opacity: 0.35 + multiply 블렌딩으로 표시되므로 내부 세그먼트는 불투명하게 이어 그린다
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.size;
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'miter';
    ctx.beginPath();
    if (n === 1) {
      ctx.moveTo(pts[0][0], pts[0][1]);
      ctx.lineTo(pts[0][0] + 0.01, pts[0][1]);
    } else {
      const startIdx = Math.max(1, fromIndex);
      for (let i = startIdx; i < n; i++) {
        const p0 = pts[Math.max(0, i - 2)];
        const p1 = pts[i - 1];
        const p2 = pts[i];
        const m1x = (p0[0] + p1[0]) * 0.5;
        const m1y = (p0[1] + p1[1]) * 0.5;
        const m2x = (p1[0] + p2[0]) * 0.5;
        const m2y = (p1[1] + p2[1]) * 0.5;
        if (i === 1) {
          ctx.moveTo(p1[0], p1[1]);
          ctx.lineTo(m2x, m2y);
        } else {
          ctx.moveTo(m1x, m1y);
          ctx.quadraticCurveTo(p1[0], p1[1], m2x, m2y);
        }
      }
    }
    ctx.stroke();
  } else {
    ctx.strokeStyle = stroke.color;
    ctx.fillStyle = stroke.color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (fromIndex === 0 && n >= 1) {
      const p0 = pts[0];
      const r = Math.max(0.6, stroke.size * (0.4 + 0.6 * naturalPenEasing(p0[2] ?? 0.5)) * 0.5);
      ctx.beginPath();
      ctx.arc(p0[0], p0[1], r, 0, Math.PI * 2);
      ctx.fill();
    }

    const startIdx = Math.max(1, fromIndex);
    for (let i = startIdx; i < n; i++) {
      const p0 = pts[Math.max(0, i - 2)];
      const p1 = pts[i - 1];
      const p2 = pts[i];
      const m1x = (p0[0] + p1[0]) * 0.5;
      const m1y = (p0[1] + p1[1]) * 0.5;
      const m2x = (p1[0] + p2[0]) * 0.5;
      const m2y = (p1[1] + p2[1]) * 0.5;
      const avgPressure = ((p1[2] ?? 0.5) + (p2[2] ?? 0.5)) * 0.5;
      const widthScale = stroke.penType === 'ballpoint' ? 0.85 : 0.35 + 0.65 * naturalPenEasing(avgPressure);
      ctx.lineWidth = Math.max(0.8, stroke.size * widthScale);
      ctx.beginPath();
      if (i === 1) {
        ctx.moveTo(p1[0], p1[1]);
        ctx.lineTo(m2x, m2y);
      } else {
        ctx.moveTo(m1x, m1y);
        ctx.quadraticCurveTo(p1[0], p1[1], m2x, m2y);
      }
      ctx.stroke();
    }
  }
  ctx.restore();
  return n;
}

const boundsCache = new WeakMap<Stroke, AABB>();

/** 스트로크 객체 단위 캐시된 바운딩 박스 (스트로크는 불변 객체로 교체되므로 안전) */
export function cachedBounds(s: Stroke): AABB {
  let b = boundsCache.get(s);
  if (!b) {
    b = strokeBounds(s);
    boundsCache.set(s, b);
  }
  return b;
}

export function intersects(a: AABB, b: AABB): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

/** 올가미 선택 스트로크를 PNG(Base64 dataURL)로 캡처 — AI 질의 컨텍스트용 */
export function renderStrokesToDataUrl(strokes: Stroke[], pad = 16): string | null {
  const box = unionBounds(strokes.map(strokeBounds));
  if (!box) return null;
  const w = Math.ceil(box.maxX - box.minX + pad * 2);
  const h = Math.ceil(box.maxY - box.minY + pad * 2);
  const scale = Math.min(2, 1600 / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.scale(scale, scale);
  ctx.translate(pad - box.minX, pad - box.minY);
  strokes.forEach((s) => drawStroke(ctx, s));
  return canvas.toDataURL('image/png');
}

/**
 * 올가미(Lasso) 드래그 시각 피드백 렌더링:
 * 파란색 점선(rgba(59, 130, 246, 0.8), [6, 6]) 및 반투명 채우기 면(rgba(59, 130, 246, 0.12))
 */
export function renderLassoFeedback(
  ctx: CanvasRenderingContext2D,
  poly: Point[],
  closedPoly?: Point[] | null,
): void {
  if (poly.length === 0) return;
  ctx.save();
  ctx.globalCompositeOperation = 'source-over';

  const start = poly[0];
  ctx.fillStyle = '#3b82f6';
  ctx.beginPath();
  ctx.arc(start.x, start.y, 3, 0, Math.PI * 2);
  ctx.fill();

  if (poly.length > 1) {
    ctx.setLineDash([6, 6]);
    ctx.strokeStyle = 'rgba(59, 130, 246, 0.8)';
    ctx.lineWidth = 2.0;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // 궤적 외곽선 점선
    ctx.beginPath();
    traceMidpointQuadratic(ctx, poly);
    const last = poly[poly.length - 1];
    ctx.lineTo(last.x, last.y);
    ctx.stroke();

    // 반투명 면 채우기 (폐곡선 또는 3개 이상의 드래그 궤적 패스)
    const fillPoly = closedPoly && closedPoly.length > 2 ? closedPoly : poly.length > 2 ? poly : null;
    if (fillPoly) {
      ctx.fillStyle = 'rgba(59, 130, 246, 0.12)';
      ctx.beginPath();
      fillPoly.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      if (typeof ctx.closePath === 'function') {
        ctx.closePath();
      }
      ctx.fill();
    }
  }
  ctx.restore();
}
