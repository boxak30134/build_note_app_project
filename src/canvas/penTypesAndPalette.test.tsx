// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import {
  useSettings,
  PEN_TYPES,
  DEFAULT_PALETTE_COLORS,
  PALETTE_COLOR_NAMES,
  activeColor,
} from '../store/settingsStore';
import { getPenStrokeOptions, pencilPath } from './render';
import { hexToRgb, rgbToHex } from '../components/RgbColorPickerModal';
import { isApproximatelyStraight, straightenStrokePoints, type StrokePoint } from '../core/geometry/geometry';
import { Toolbar } from '../components/Toolbar';
import { PenSettingsPopup } from '../components/PenSettingsPopup';
import type { Stroke } from '../core/strokes/StrokeStore';

if (typeof Path2D === 'undefined') {
  class MockPath2D {
    moveTo() {}
    lineTo() {}
    quadraticCurveTo() {}
    closePath() {}
  }
  (globalThis as any).Path2D = MockPath2D;
}

describe('Pen Types & Palette (5종 펜 종류 및 빨주노초파남보 검정 + RGB 지정 창)', () => {
  afterEach(() => {
    cleanup();
  });
  beforeEach(() => {
    useSettings.setState({
      tool: 'pencil',
      penType: 'fountain-sharp',
      autoStraighten: false,
      colorSlots: [...DEFAULT_PALETTE_COLORS],
      activeSlot: 7, // 검정
      customColor: '#E11D48',
      isCustomColorActive: false,
      penSize: 4,
    });
  });

  describe('1. 5종 펜 종류 정의 및 스트로크 렌더링 옵션', () => {
    it('5종 펜(끝이 뾰족한 만년필, 끝이 뭉툭한 만년필, 볼펜, 연필, 붓)이 정확히 정의되어 있다', () => {
      expect(PEN_TYPES).toHaveLength(5);
      expect(PEN_TYPES.map((p) => p.name)).toEqual([
        '끝이 뾰족한 만년필',
        '끝이 뭉툭한 만년필',
        '볼펜',
        '연필',
        '붓',
      ]);
      expect(PEN_TYPES.map((p) => p.id)).toEqual([
        'fountain-sharp',
        'fountain-flat',
        'ballpoint',
        'pencil',
        'brush',
      ]);
    });

    it('펜 종류별로 차별화된 perfect-freehand 옵션이 생성된다', () => {
      const dummyStroke = (penType: any): Stroke => ({
        id: 's-test',
        tool: 'pencil',
        penType,
        color: '#000000',
        size: 6,
        points: [
          [10, 10, 0.4],
          [20, 20, 0.7],
          [30, 30, 0.5],
        ],
      });

      // 1. 끝이 뾰족한 만년필: 높은 thinning 및 테이퍼링
      const sharpOpts = getPenStrokeOptions(dummyStroke('fountain-sharp'));
      expect(sharpOpts.thinning).toBeGreaterThan(0.6);
      expect(sharpOpts.start.cap).toBe(true);

      // 2. 끝이 뭉툭한 만년필: 캘리그래피 플랫 캡 (cap: false)
      const flatOpts = getPenStrokeOptions(dummyStroke('fountain-flat'));
      expect(flatOpts.start.cap).toBe(false);
      expect(flatOpts.end.cap).toBe(false);

      // 3. 볼펜: 일정한 두께 (thinning 거의 0)
      const ballpointOpts = getPenStrokeOptions(dummyStroke('ballpoint'));
      expect(ballpointOpts.thinning).toBeLessThanOrEqual(0.1);
      expect(ballpointOpts.simulatePressure).toBe(false);

      // 4. 연필: 자연스러운 필기감
      const pencilOpts = getPenStrokeOptions(dummyStroke('pencil'));
      expect(pencilOpts.thinning).toBeGreaterThan(0.4);

      // 5. 붓: 극적인 굵기 및 유선형
      const brushOpts = getPenStrokeOptions(dummyStroke('brush'));
      expect(brushOpts.thinning).toBeGreaterThanOrEqual(0.85);
      expect(brushOpts.size).toBeGreaterThan(dummyStroke('brush').size);
    });

    it('5종 펜 모두 pencilPath 렌더링 시 정상적인 Path2D 객체를 반환한다', () => {
      const types = ['fountain-sharp', 'fountain-flat', 'ballpoint', 'pencil', 'brush'] as const;
      for (const t of types) {
        const stroke: Stroke = {
          id: `s-${t}`,
          tool: 'pencil',
          penType: t,
          color: '#1E3A8A',
          size: 4,
          points: [
            [0, 0, 0.5],
            [15, 10, 0.6],
            [30, 25, 0.7],
          ],
        };
        const path = pencilPath(stroke);
        expect(path).toBeInstanceOf(Path2D);
      }
    });
  });

  describe('2. 기본 8색 팔레트 (왼쪽부터 빨주노초파남보 검정)', () => {
    it('팔레트 색상이 왼쪽부터 빨주노초파남보 검정 순서로 배치되어 있다', () => {
      expect(PALETTE_COLOR_NAMES).toEqual(['빨강', '주황', '노랑', '초록', '파랑', '남색', '보라', '검정']);
      expect(DEFAULT_PALETTE_COLORS).toHaveLength(8);
      expect(DEFAULT_PALETTE_COLORS[0]).toBe('#EF4444'); // 빨
      expect(DEFAULT_PALETTE_COLORS[1]).toBe('#F97316'); // 주
      expect(DEFAULT_PALETTE_COLORS[2]).toBe('#FACC15'); // 노
      expect(DEFAULT_PALETTE_COLORS[3]).toBe('#22C55E'); // 초
      expect(DEFAULT_PALETTE_COLORS[4]).toBe('#3B82F6'); // 파
      expect(DEFAULT_PALETTE_COLORS[5]).toBe('#1E3A8A'); // 남
      expect(DEFAULT_PALETTE_COLORS[6]).toBe('#8B5CF6'); // 보
      expect(DEFAULT_PALETTE_COLORS[7]).toBe('#000000'); // 검정
    });

    it('슬롯을 선택하면 activeColor가 해당 색상으로 즉시 반영된다', () => {
      useSettings.getState().selectSlot(0); // 빨강
      expect(activeColor()).toBe('#EF4444');

      useSettings.getState().selectSlot(2); // 노랑
      expect(activeColor()).toBe('#FACC15');

      useSettings.getState().selectSlot(7); // 검정
      expect(activeColor()).toBe('#000000');
    });
  });

  describe('3. 검정 오른쪽의 RGB 사용자 지정 창 및 색상 변환', () => {
    it('hexToRgb 와 rgbToHex 변환이 수학적으로 정확하다', () => {
      expect(hexToRgb('#EF4444')).toEqual([239, 68, 68]);
      expect(rgbToHex(239, 68, 68)).toBe('#EF4444');

      expect(hexToRgb('#000000')).toEqual([0, 0, 0]);
      expect(rgbToHex(0, 0, 0)).toBe('#000000');

      expect(hexToRgb('#FFFFFF')).toEqual([255, 255, 255]);
      expect(rgbToHex(255, 255, 255)).toBe('#FFFFFF');
    });

    it('사용자 지정 색상을 설정하면 isCustomColorActive 가 활성화되고 activeColor 가 customColor 를 반환한다', () => {
      const customHex = '#FF0055';
      useSettings.getState().setCustomColor(customHex);
      expect(useSettings.getState().isCustomColorActive).toBe(true);
      expect(useSettings.getState().customColor).toBe(customHex);
      expect(activeColor()).toBe(customHex);

      // 기본 팔레트 슬롯을 누르면 customColor 가 비활성화되고 해당 슬롯 색상이 activeColor 가 된다
      useSettings.getState().selectSlot(1); // 주황
      expect(useSettings.getState().isCustomColorActive).toBe(false);
      expect(activeColor()).toBe('#F97316');
    });
  });

  describe('4. 직선 자동 보정 (isApproximatelyStraight & straightenStrokePoints)', () => {
    it('직선에 가까운 점 배열은 직선으로 판별되고 완벽한 선분으로 보정된다', () => {
      const straightPoints: StrokePoint[] = [
        [0, 0, 0.5],
        [10, 1, 0.5],
        [20, 0, 0.5],
        [30, -1, 0.5],
        [40, 0, 0.5],
      ];
      expect(isApproximatelyStraight(straightPoints, 5)).toBe(true);

      const straightened = straightenStrokePoints(straightPoints);
      expect(straightened[0]).toEqual([0, 0, 0.5]);
      expect(straightened[straightened.length - 1]).toEqual([40, 0, 0.5]);
    });

    it('곡선이나 지그재그 점 배열은 직선으로 오판되지 않는다', () => {
      const curvedPoints: StrokePoint[] = [
        [0, 0, 0.5],
        [20, 30, 0.5],
        [40, 0, 0.5],
        [60, -30, 0.5],
      ];
      expect(isApproximatelyStraight(curvedPoints, 5)).toBe(false);
    });
  });

  describe('5. UI 컴포넌트 렌더링 검증', () => {
    it('툴바에 빨주노초파남보 검정 8개 색상 버튼과 오른쪽의 RGB 지정 동그라미가 렌더링된다', () => {
      render(<Toolbar />);

      // 8색 슬롯 검증
      for (let i = 0; i < 8; i++) {
        const slot = screen.getByTestId(`color-slot-${i}`);
        expect(slot).toBeTruthy();
      }

      // 검정 오른쪽의 RGB 지정 버튼 검증
      const rgbBtn = screen.getByTestId('rgb-custom-picker-btn');
      expect(rgbBtn).toBeTruthy();
      expect(rgbBtn.getAttribute('title')).toContain('RGB 사용자 지정');
    });

    it('PenSettingsPopup 에서 5종 펜과 직선 자동 보정 스위치 및 RGB 버튼이 표시된다', () => {
      render(<PenSettingsPopup open={true} onClose={() => {}} />);

      // 5종 펜 버튼
      expect(screen.getByTestId('pen-type-fountain-sharp')).toBeTruthy();
      expect(screen.getByTestId('pen-type-fountain-flat')).toBeTruthy();
      expect(screen.getByTestId('pen-type-ballpoint')).toBeTruthy();
      expect(screen.getByTestId('pen-type-pencil')).toBeTruthy();
      expect(screen.getByTestId('pen-type-brush')).toBeTruthy();

      // 직선 자동 보정 스위치
      expect(screen.getByRole('switch')).toBeTruthy();

      // RGB 사용자 지정 원형 버튼
      expect(screen.getByTestId('rgb-color-circle-btn')).toBeTruthy();
    });

    it('RGB 지정 버튼을 클릭하면 RGB 사용자 지정 창이 열리고 R, G, B 입력이 가능하다', () => {
      render(<PenSettingsPopup open={true} onClose={() => {}} />);

      const rgbBtn = screen.getByTestId('rgb-color-circle-btn');
      fireEvent.click(rgbBtn);

      // RGB 모달 확인
      expect(screen.getByTestId('rgb-color-modal')).toBeTruthy();
      expect(screen.getByText('사용자 지정 RGB 색상')).toBeTruthy();
      expect(screen.getByText('R')).toBeTruthy();
      expect(screen.getByText('G')).toBeTruthy();
      expect(screen.getByText('B')).toBeTruthy();
    });
  });
});
