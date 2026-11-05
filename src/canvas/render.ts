import { getStroke } from 'perfect-freehand';
import type { Stroke } from '../core/strokes/StrokeStore';
import { strokeBounds } from '../core/strokes/StrokeStore';
import type { AABB } from '../core/geometry/geometry';
import { unionBounds } from '../core/geometry/geometry';

const pathCache = new WeakMap<Stroke, Path2D>();

function outlineToPath(points: number[][]): Path2D {
  const path = new Path2D();
  if (points.length === 0) return path;
  path.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length - 1; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[i + 1];
    path.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
  }
  path.closePath();
  return path;
}

export function getPenStrokeOptions(stroke: Stroke, simulatePressure = false) {
  const penType = stroke.penType || 'pencil';
  const hasPressure = stroke.points.some((p) => p[2] !== 0.5);
  const sim = simulatePressure || !hasPressure;

  switch (penType) {
    case 'fountain-sharp':
      // 1. 끝이 뾰족한 만년필: 필압에 민감하게 반응하고 끝이 날카롭게 테이퍼링됨
      return {
        size: stroke.size,
        thinning: 0.72,
        smoothing: 0.55,
        streamline: 0.48,
        start: { taper: 4, cap: true },
        end: { taper: 8, cap: true },
        simulatePressure: sim,
        last: true,
      };
    case 'fountain-flat':
      // 2. 끝이 뭉툭한 만년필: 납작한 닙 형태의 캘리그래피 질감
      return {
        size: stroke.size,
        thinning: 0.25,
        smoothing: 0.4,
        streamline: 0.4,
        start: { taper: 0, cap: false },
        end: { taper: 0, cap: false },
        simulatePressure: sim,
        last: true,
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
        last: true,
      };
    case 'brush':
      // 5. 붓: 극적인 굵기 변화와 부드러운 유선형 끝단
      return {
        size: stroke.size * 1.25,
        thinning: 0.88,
        smoothing: 0.75,
        streamline: 0.65,
        start: { taper: 10, cap: true },
        end: { taper: 14, cap: true },
        simulatePressure: sim,
        last: true,
      };
    case 'pencil':
    default:
      // 4. 연필: 기존 자연스러운 필기감
      return {
        size: stroke.size,
        thinning: 0.55,
        smoothing: 0.5,
        streamline: 0.45,
        start: { taper: 2, cap: true },
        end: { taper: 3, cap: true },
        simulatePressure: sim,
        last: true,
      };
  }
}

export function pencilPath(stroke: Stroke, simulatePressure = false): Path2D {
  const cached = pathCache.get(stroke);
  if (cached) return cached;
  const outline = getStroke(stroke.points, getPenStrokeOptions(stroke, simulatePressure));
  const path = outlineToPath(outline);
  pathCache.set(stroke, path);
  return path;
}

/** 스트로크 하나 그리기. 형광펜은 opacity 0.35 + multiply 합성, 사각 끝단 */
export function drawStroke(ctx: CanvasRenderingContext2D, stroke: Stroke, opts: { faded?: boolean } = {}) {
  ctx.save();
  if (stroke.tool === 'highlighter') {
    ctx.globalAlpha = opts.faded ? 0.12 : 0.35;
    ctx.globalCompositeOperation = 'multiply';
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.size;
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'miter';
    ctx.beginPath();
    stroke.points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    if (stroke.points.length === 1) ctx.lineTo(stroke.points[0][0] + 0.1, stroke.points[0][1]);
    ctx.stroke();
  } else {
    if (opts.faded) ctx.globalAlpha = 0.2;
    ctx.fillStyle = stroke.color;
    ctx.fill(pencilPath(stroke));
  }
  ctx.restore();
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
