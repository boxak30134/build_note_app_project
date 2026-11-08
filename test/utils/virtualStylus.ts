// test/utils/virtualStylus.ts

export interface StylusPointInput {
  x: number;
  y: number;
  pressure?: number;
}

export interface EraserStrokeOptions {
  useBarrelButton?: boolean;
  pointerId?: number;
}

class PolyfillPointerEvent extends MouseEvent {
  readonly pointerId: number;
  readonly pointerType: string;
  readonly pressure: number;
  readonly tiltX: number;
  readonly tiltY: number;
  readonly isPrimary: boolean;

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, {
      bubbles: init.bubbles ?? true,
      cancelable: init.cancelable ?? true,
      clientX: init.clientX ?? 0,
      clientY: init.clientY ?? 0,
      button: init.button ?? 0,
      buttons: init.buttons ?? 0,
    });
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? 'mouse';
    this.pressure = init.pressure ?? 0.5;
    this.tiltX = init.tiltX ?? 0;
    this.tiltY = init.tiltY ?? 0;
    this.isPrimary = init.isPrimary ?? true;
  }
}

if (
  typeof globalThis.PointerEvent === 'undefined' ||
  new globalThis.PointerEvent('pointerdown', { pointerType: 'pen' }).pointerType !== 'pen'
) {
  globalThis.PointerEvent = PolyfillPointerEvent as unknown as typeof PointerEvent;
}

/**
 * S-Pen 물리 입력(필기, 필압, 배럴 버튼 지우개 등)을 시뮬레이션하는 가상 스타일러스 에이전트
 */
export class VirtualStylusAgent {
  constructor(private readonly target: HTMLElement) {}

  simulatePenStroke(points: StylusPointInput[], options?: { pointerId?: number }): void {
    if (points.length === 0) return;
    const pointerId = options?.pointerId ?? 1;
    const first = points[0];

    this.target.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        pointerId,
        pointerType: 'pen',
        clientX: first.x,
        clientY: first.y,
        pressure: first.pressure ?? 0.5,
        button: 0,
        buttons: 1,
      }),
    );

    for (let i = 1; i < points.length; i++) {
      const pt = points[i];
      this.target.dispatchEvent(
        new PointerEvent('pointermove', {
          bubbles: true,
          cancelable: true,
          pointerId,
          pointerType: 'pen',
          clientX: pt.x,
          clientY: pt.y,
          pressure: pt.pressure ?? 0.5,
          button: 0,
          buttons: 1,
        }),
      );
    }

    const last = points[points.length - 1];
    this.target.dispatchEvent(
      new PointerEvent('pointerup', {
        bubbles: true,
        cancelable: true,
        pointerId,
        pointerType: 'pen',
        clientX: last.x,
        clientY: last.y,
        pressure: 0,
        button: 0,
        buttons: 0,
      }),
    );
  }

  simulateEraserStroke(points: StylusPointInput[], options?: EraserStrokeOptions): void {
    if (points.length === 0) return;
    const useBarrel = options?.useBarrelButton ?? false;
    const pointerId = options?.pointerId ?? 2;
    const pointerType = useBarrel ? 'pen' : 'eraser';
    const buttons = useBarrel ? 32 : 1;
    const button = useBarrel ? 5 : 0;
    const first = points[0];

    this.target.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        pointerId,
        pointerType,
        clientX: first.x,
        clientY: first.y,
        pressure: first.pressure ?? 0.5,
        button,
        buttons,
      }),
    );

    for (let i = 1; i < points.length; i++) {
      const pt = points[i];
      this.target.dispatchEvent(
        new PointerEvent('pointermove', {
          bubbles: true,
          cancelable: true,
          pointerId,
          pointerType,
          clientX: pt.x,
          clientY: pt.y,
          pressure: pt.pressure ?? 0.5,
          button,
          buttons,
        }),
      );
    }

    const last = points[points.length - 1];
    this.target.dispatchEvent(
      new PointerEvent('pointerup', {
        bubbles: true,
        cancelable: true,
        pointerId,
        pointerType,
        clientX: last.x,
        clientY: last.y,
        pressure: 0,
        button: 0,
        buttons: 0,
      }),
    );
  }
}

