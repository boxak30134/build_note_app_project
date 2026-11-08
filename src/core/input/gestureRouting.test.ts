import { describe, expect, it } from 'vitest';
import {
  computeSingleFingerPan,
  fingerTouchesOf,
  isGesturePointerType,
  isStylusPointerType,
  updatePanVelocity,
} from './gestureRouting';

describe('gestureRouting — S-Pen/손가락 입력 격리', () => {
  it('제스처 추적 맵에는 오직 touch 포인터만 등록된다', () => {
    expect(isGesturePointerType('touch')).toBe(true);
    expect(isGesturePointerType('pen')).toBe(false);
    expect(isGesturePointerType('eraser')).toBe(false);
    expect(isGesturePointerType('mouse')).toBe(false);
    expect(isStylusPointerType('pen')).toBe(true);
    expect(isStylusPointerType('eraser')).toBe(true);
    expect(isStylusPointerType('touch')).toBe(false);
  });

  it('S-Pen(stylus) TouchEvent 는 핀치 판정용 손가락 목록에서 제외된다 (Palm Rejection)', () => {
    const touches = [
      { clientX: 10, clientY: 10, touchType: 'stylus' },
      { clientX: 200, clientY: 300, touchType: 'direct' },
    ];
    const fingers = fingerTouchesOf(touches);
    expect(fingers).toHaveLength(1);
    expect(fingers[0].clientX).toBe(200);
    // touchType 미지원 브라우저는 손가락으로 간주
    expect(fingerTouchesOf([{ clientX: 1, clientY: 1 }])).toHaveLength(1);
  });

  it('1손가락 패닝은 손가락 이동 반대 방향으로 스크롤을 이동시킨다', () => {
    const next = computeSingleFingerPan({ x: 100, y: 100 }, { x: 80, y: 60 }, { scrollTop: 500, scrollLeft: 50 });
    expect(next).toEqual({ scrollTop: 540, scrollLeft: 70 });
  });

  it('패닝 속도는 dt<=0 이면 유지되고, 그 외에는 EMA 로 갱신된다', () => {
    expect(updatePanVelocity({ x: 1, y: 1 }, { x: 10, y: 10 }, 0)).toEqual({ x: 1, y: 1 });
    const v = updatePanVelocity({ x: 0, y: 0 }, { x: 16, y: -32 }, 16);
    expect(v.x).toBeCloseTo(0.8);
    expect(v.y).toBeCloseTo(-1.6);
  });
});
