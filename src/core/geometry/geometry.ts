/** 벡터 필기 엔진 기하 연산: Ray-Casting, AABB, 이동 변환, 지우개 교차 판정 */

export interface Point {
  x: number;
  y: number;
}

/** 스트로크 점: [x, y, pressure] */
export type StrokePoint = [number, number, number];

export interface AABB {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Ray-Casting (Point-in-Polygon). 다각형은 자동으로 닫힌 것으로 간주한다. */
export function pointInPolygon(p: Point, polygon: Point[]): boolean {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;
    const intersects = yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/**
 * 스트로크가 올가미 다각형에 포함되는지 판정.
 * 결정: 점의 threshold(기본 60%) 이상이 내부에 있으면 선택 — 손떨림으로 끝점이 살짝 벗어나도 선택되도록.
 */
export function strokeInPolygon(points: StrokePoint[], polygon: Point[], threshold = 0.6): boolean {
  if (points.length === 0) return false;
  let inside = 0;
  for (const [x, y] of points) if (pointInPolygon({ x, y }, polygon)) inside++;
  return inside / points.length >= threshold;
}

/** 다각선(Polyline)의 총 길이 계산 */
export function polylineLength(poly: Point[]): number {
  let len = 0;
  for (let i = 1; i < poly.length; i++) {
    len += Math.hypot(poly[i].x - poly[i - 1].x, poly[i].y - poly[i - 1].y);
  }
  return len;
}

/** 두 선분 (p1-p2) 와 (p3-p4) 의 교점 반환 (교차하지 않으면 null) */
export function segmentIntersection(p1: Point, p2: Point, p3: Point, p4: Point): Point | null {
  const rx = p2.x - p1.x;
  const ry = p2.y - p1.y;
  const sx = p4.x - p3.x;
  const sy = p4.y - p3.y;
  const rxs = rx * sy - ry * sx;
  if (Math.abs(rxs) < 1e-8) return null;
  const qpx = p3.x - p1.x;
  const qpy = p3.y - p1.y;
  const t = (qpx * sy - qpy * sx) / rxs;
  const u = (qpx * ry - qpy * rx) / rxs;
  if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
    return { x: p1.x + t * rx, y: p1.y + t * ry };
  }
  return null;
}

export interface LassoClosureOptions {
  /** 시작점과 끝점 사이가 이 거리(px) 이하로 가까워지면 폐곡선(closed curve)으로 인정 (기본 36px) */
  closeDistance?: number;
  /** 최소 루프 둘레 길이(px) — 미세한 점/직선 터치가 폐곡선으로 오판되는 것을 방지 (기본 36px) */
  minLoopLength?: number;
}

/**
 * 스타일러스 궤적(poly)이 폐곡선(closed curve)을 형성했는지 판별하고,
 * 형성된 경우 내부(closure) 다각형 좌표 배열을 반환한다. 폐곡선이 아니면 null 을 반환한다.
 * - 1) 궤적이 스스로 교차(self-intersection)하여 닫힌 고리를 만든 경우 교차 루프 추출
 * - 2) 시작점과 끝점이 closeDistance 이내로 만나 닫힌 고리를 만든 경우 전체 루프 반환
 */
export function extractClosedLassoPolygon(
  poly: Point[],
  options: LassoClosureOptions = {},
): Point[] | null {
  if (poly.length < 3) return null;
  const closeDistance = options.closeDistance ?? 36;
  const minLoopLength = options.minLoopLength ?? 36;

  // 1. 자체 교차(Self-intersection) 검사: 뒤쪽 선분이 앞쪽 비인접 선분과 교차하는지 확인
  for (let i = 2; i < poly.length - 1; i++) {
    const p3 = poly[i];
    const p4 = poly[i + 1];
    for (let j = 0; j <= i - 2; j++) {
      const p1 = poly[j];
      const p2 = poly[j + 1];
      const hit = segmentIntersection(p1, p2, p3, p4);
      if (hit) {
        const loop = [hit, ...poly.slice(j + 1, i + 1), hit];
        if (loop.length >= 4 && polylineLength(loop) >= minLoopLength) {
          return loop;
        }
      }
    }
  }

  // 2. 시작점-끝점 근접 폐곡선 검사
  const totalLen = polylineLength(poly);
  if (totalLen < minLoopLength) return null;
  const first = poly[0];
  const last = poly[poly.length - 1];
  if (Math.hypot(last.x - first.x, last.y - first.y) <= closeDistance) {
    return [...poly, first];
  }

  return null;
}

export function isClosedLassoCurve(poly: Point[], options?: LassoClosureOptions): boolean {
  return extractClosedLassoPolygon(poly, options) !== null;
}

export function boundsOfPoints(points: Array<StrokePoint | Point>): AABB {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    const x = Array.isArray(p) ? p[0] : p.x;
    const y = Array.isArray(p) ? p[1] : p.y;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

export function unionBounds(boxes: AABB[]): AABB | null {
  if (boxes.length === 0) return null;
  return boxes.reduce((a, b) => ({
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  }));
}

/** 이동 변환: 모든 좌표에 (dx, dy) 가산. 원본을 변경하지 않고 새 배열을 반환한다. */
export function translatePoints(points: StrokePoint[], dx: number, dy: number): StrokePoint[] {
  return points.map(([x, y, p]) => [x + dx, y + dy, p]);
}

/** 점 p 와 선분 ab 의 최소 거리 제곱 (제곱근 연산 생략으로 고속 충돌 판정) */
export function distToSegmentSquared(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = p.x - (a.x + t * dx);
  const cy = p.y - (a.y + t * dy);
  return cx * cx + cy * cy;
}

/** 점 p 와 선분 ab 의 최소 거리 */
export function distanceToSegment(p: Point, a: Point, b: Point): number {
  return Math.sqrt(distToSegmentSquared(p, a, b));
}

/** 지우개 점(반경 r)이 스트로크(굵기 width)와 교차하는지 */
export function eraserHitsStroke(eraser: Point, radius: number, points: StrokePoint[], width = 0): boolean {
  if (points.length === 0) return false;
  const r = radius + width / 2;
  const rSq = r * r;
  if (points.length === 1) {
    const dx = points[0][0] - eraser.x;
    const dy = points[0][1] - eraser.y;
    return dx * dx + dy * dy <= rSq;
  }
  for (let i = 0; i < points.length - 1; i++) {
    const p1 = { x: points[i][0], y: points[i][1] };
    const p2 = { x: points[i + 1][0], y: points[i + 1][1] };
    if (distToSegmentSquared(eraser, p1, p2) <= rSq) return true;
  }
  return false;
}

export {
  DEFAULT_NOTE_ZOOM,
  MIN_NOTE_ZOOM,
  MAX_NOTE_ZOOM,
  NOTE_ZOOM_STEP,
  clampNoteZoom,
  touchDistance,
  touchMidpoint,
  computePinchZoom,
  type PinchZoomInput,
} from '../page/pageTypes';

export interface EraserPointerEventLike {
  pointerType: string;
  button?: number;
  buttons?: number;
}

/**
 * 현재 입력 포인터가 하드웨어 지우개(스테들러 노리스 점보 후면 지우개 팁, S펜 측면 버튼 등)인지 판별하는 헬퍼 함수
 * - 1. 디바이스 자체가 포인터 타입을 'eraser'로 보고하는 경우 (Samsung/Wacom 드라이버)
 * - 2. pointerType이 'pen'이면서 지우개 플래그(buttons & 32: W3C 지우개 비트마스크 또는 button === 5)가 활성화된 경우
 * - 3. S펜 배럴(측면) 버튼을 누른 상태 (보조 지우개 제스처: buttons & 2 또는 button === 2)
 */
export function isEraserPointer(e: EraserPointerEventLike): boolean {
  if (e.pointerType === 'eraser') return true;
  const buttons = e.buttons ?? 0;
  const button = e.button ?? -1;
  if (e.pointerType === 'pen' && ((buttons & 32) !== 0 || button === 5)) return true;
  if (e.pointerType === 'pen' && ((buttons & 2) !== 0 || button === 2)) return true;
  return false;
}
