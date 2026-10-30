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

/** 점 p 와 선분 ab 의 최소 거리 */
export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = a.x + t * dx;
  const cy = a.y + t * dy;
  return Math.hypot(p.x - cx, p.y - cy);
}

/** 지우개 점(반경 r)이 스트로크(굵기 width)와 교차하는지 */
export function eraserHitsStroke(eraser: Point, radius: number, points: StrokePoint[], width: number): boolean {
  const r = radius + width / 2;
  if (points.length === 1) return Math.hypot(points[0][0] - eraser.x, points[0][1] - eraser.y) <= r;
  for (let i = 1; i < points.length; i++) {
    const a = { x: points[i - 1][0], y: points[i - 1][1] };
    const b = { x: points[i][0], y: points[i][1] };
    if (distanceToSegment(eraser, a, b) <= r) return true;
  }
  return false;
}
