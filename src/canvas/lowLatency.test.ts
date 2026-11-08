// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  OVERLAY_CONTEXT_OPTIONS,
  OPAQUE_CONTEXT_OPTIONS,
  appendStrokePoint,
  coalescedEventsOf,
  getLowLatencyContext,
  predictedEventsOf,
  traceMidpointQuadratic,
} from './lowLatency';
import type { StrokePoint } from '../core/geometry/geometry';
import { getPenStrokeOptions, naturalPenEasing } from './render';
import type { Stroke } from '../core/strokes/StrokeStore';

const root = resolve(__dirname, '../..');

describe('S-Pen 초저지연 필기 & 하드웨어 가속 가이드', () => {
  it('1.1 매니페스트 application/activity 양쪽에 hardwareAccelerated="true" 가 선언된다', () => {
    const xml = readFileSync(resolve(root, 'android/app/src/main/AndroidManifest.xml'), 'utf8');
    const app = /<application[\s\S]*?>/.exec(xml)?.[0] ?? '';
    const act = /<activity[\s\S]*?>/.exec(xml)?.[0] ?? '';
    expect(app).toContain('android:hardwareAccelerated="true"');
    expect(act).toContain('android:hardwareAccelerated="true"');
  });

  it('1.2 MainActivity 가 WebView 를 LAYER_TYPE_HARDWARE 로 고정한다', () => {
    const java = readFileSync(resolve(root, 'android/app/src/main/java/com/eduink/studio/MainActivity.java'), 'utf8');
    expect(java).toContain('setLayerType(View.LAYER_TYPE_HARDWARE, null)');
    expect(java).toContain('OVER_SCROLL_NEVER');
  });

  it('2.1 desynchronized 컨텍스트 옵션으로 캔버스를 1회만 초기화한다', () => {
    expect(OVERLAY_CONTEXT_OPTIONS).toMatchObject({ desynchronized: true, alpha: true });
    expect(OPAQUE_CONTEXT_OPTIONS).toMatchObject({ desynchronized: true, alpha: false });
    const canvas = document.createElement('canvas');
    const fake = {} as CanvasRenderingContext2D;
    const spy = vi.spyOn(canvas, 'getContext').mockReturnValue(fake as never);
    expect(getLowLatencyContext(canvas)).toBe(fake);
    expect(getLowLatencyContext(canvas)).toBe(fake);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('2d', OVERLAY_CONTEXT_OPTIONS);
  });

  it('2.2 getCoalescedEvents 로 프레임 사이 240Hz 샘플을 모두 복원하고, 미지원 시 원본 이벤트로 폴백한다', () => {
    const samples = [{ clientX: 1 }, { clientX: 2 }, { clientX: 3 }, { clientX: 4 }] as PointerEvent[];
    const e = { getCoalescedEvents: () => samples, getPredictedEvents: () => samples } as unknown as PointerEvent;
    expect(coalescedEventsOf(e)).toHaveLength(4);
    expect(predictedEventsOf(e, 2)).toHaveLength(2);
    const legacy = { clientX: 9 } as PointerEvent;
    expect(coalescedEventsOf(legacy)).toEqual([legacy]);
    expect(predictedEventsOf(legacy)).toEqual([]);
  });

  it('지터 샘플은 in-place 로 걸러지되 최대 필압은 보존된다', () => {
    const pts: StrokePoint[] = [[0, 0, 0.3]];
    const ref = pts;
    expect(appendStrokePoint(pts, [0.1, 0.1, 0.8])).toBe(false);
    expect(pts[0][2]).toBe(0.8);
    expect(appendStrokePoint(pts, [5, 5, 0.5])).toBe(true);
    expect(pts).toBe(ref);
    expect(pts).toHaveLength(2);
  });

  it('2.4 Midpoint Quadratic Bezier: 가운데 점을 제어점, 중점을 끝점으로 보간한다', () => {
    const calls: Array<[string, ...number[]]> = [];
    const ctx = {
      moveTo: (x: number, y: number) => calls.push(['M', x, y]),
      lineTo: (x: number, y: number) => calls.push(['L', x, y]),
      quadraticCurveTo: (cx: number, cy: number, x: number, y: number) => calls.push(['Q', cx, cy, x, y]),
    };
    traceMidpointQuadratic(ctx, [
      [0, 0, 0.5],
      [10, 0, 0.5],
      [10, 10, 0.5],
    ]);
    expect(calls).toEqual([
      ['M', 0, 0],
      ['Q', 10, 0, 10, 5],
      ['L', 10, 10],
    ]);
    calls.length = 0;
    traceMidpointQuadratic(ctx, [{ x: 3, y: 4 }]);
    expect(calls[0]).toEqual(['M', 3, 4]);
    expect(calls).toHaveLength(2);
  });

  it('2.3 필기 캔버스 CSS 에 touch-action:none / user-select:none 이 적용된다', () => {
    const css = readFileSync(resolve(root, 'src/index.css'), 'utf8');
    const block = /\.ink-canvas,\s*\.ink-canvas-wet\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(block).toContain('touch-action: none');
    expect(block).toContain('user-select: none');
    expect(block).toContain('overscroll-behavior: none');
  });

  it('자연스러운 필기감: naturalPenEasing S-곡선 및 실시간 미완성 획(isComplete: false) 테이퍼링 방지', () => {
    // 1. Hermite smoothstep 필압 곡선
    expect(naturalPenEasing(0)).toBe(0);
    expect(naturalPenEasing(1)).toBe(1);
    expect(naturalPenEasing(0.5)).toBe(0.5);
    expect(naturalPenEasing(0.2)).toBeCloseTo(0.2 * 0.2 * 2.6);

    const stroke: Stroke = {
      id: 'test-fountain',
      tool: 'pencil',
      penType: 'fountain-sharp',
      color: '#000000',
      size: 4,
      points: [[10, 10, 0.4], [20, 20, 0.7]],
    };

    // 실시간 필기 중(in-progress): 펜촉 끝단이 조기 테이퍼링되어 깜빡이지 않음 (last: false, end.taper: 0)
    const inProgress = getPenStrokeOptions(stroke, false, false);
    expect(inProgress.last).toBe(false);
    expect(inProgress.end?.taper).toBe(0);
    expect(inProgress.easing).toBe(naturalPenEasing);

    // 필기 완료(completed): 자연스러운 끝단 테이퍼 형성 (last: true, end.taper: 8)
    const completed = getPenStrokeOptions(stroke, false, true);
    expect(completed.last).toBe(true);
    expect(completed.end?.taper).toBe(8);
  });
});

