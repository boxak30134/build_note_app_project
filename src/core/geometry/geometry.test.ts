import { describe, expect, it } from 'vitest';
import { boundsOfPoints, eraserHitsStroke, pointInPolygon, strokeInPolygon, translatePoints, type StrokePoint } from './geometry';

const square = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 100 },
  { x: 0, y: 100 },
];

describe('pointInPolygon (Ray-Casting)', () => {
  it('판별: 내부/외부', () => {
    expect(pointInPolygon({ x: 50, y: 50 }, square)).toBe(true);
    expect(pointInPolygon({ x: 150, y: 50 }, square)).toBe(false);
    expect(pointInPolygon({ x: -1, y: -1 }, square)).toBe(false);
  });

  it('오목 다각형(U자형)의 홈 부분은 외부', () => {
    const u = [
      { x: 0, y: 0 },
      { x: 30, y: 0 },
      { x: 30, y: 70 },
      { x: 70, y: 70 },
      { x: 70, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ];
    expect(pointInPolygon({ x: 50, y: 30 }, u)).toBe(false);
    expect(pointInPolygon({ x: 15, y: 30 }, u)).toBe(true);
    expect(pointInPolygon({ x: 50, y: 85 }, u)).toBe(true);
  });

  it('점이 3개 미만이면 항상 false', () => {
    expect(pointInPolygon({ x: 0, y: 0 }, [{ x: 0, y: 0 }, { x: 1, y: 1 }])).toBe(false);
  });

  it('strokeInPolygon: 대부분의 점이 내부일 때 선택', () => {
    const inside: StrokePoint[] = [
      [10, 10, 0.5],
      [20, 20, 0.5],
      [30, 30, 0.5],
    ];
    const half: StrokePoint[] = [
      [10, 10, 0.5],
      [200, 200, 0.5],
      [300, 300, 0.5],
    ];
    expect(strokeInPolygon(inside, square)).toBe(true);
    expect(strokeInPolygon(half, square)).toBe(false);
  });
});

describe('translatePoints (Δx, Δy 이동 변환)', () => {
  it('모든 좌표에 변위를 가산하고 필압은 유지, 원본 불변', () => {
    const pts: StrokePoint[] = [
      [1, 2, 0.3],
      [3, 4, 0.9],
    ];
    const moved = translatePoints(pts, 10, -5);
    expect(moved).toEqual([
      [11, -3, 0.3],
      [13, -1, 0.9],
    ]);
    expect(pts[0]).toEqual([1, 2, 0.3]);
    const b = boundsOfPoints(moved);
    expect(b).toEqual({ minX: 11, minY: -3, maxX: 13, maxY: -1 });
  });
});

describe('eraserHitsStroke', () => {
  it('선분 근처는 적중, 멀면 미적중', () => {
    const pts: StrokePoint[] = [
      [0, 0, 0.5],
      [100, 0, 0.5],
    ];
    expect(eraserHitsStroke({ x: 50, y: 5 }, 4, pts, 4)).toBe(true);
    expect(eraserHitsStroke({ x: 50, y: 30 }, 4, pts, 4)).toBe(false);
  });
});
