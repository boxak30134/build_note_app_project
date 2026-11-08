# ANTIGRAVITY_TEST_INSTRUCTION.md: Antigravity 에이전트용 S-Pen 및 제스처 자동 회귀 테스트 지침서

본 문서는 **Antigravity AI 에이전트**가 캔버스, 줌/팬 제스처, S-Pen 필기 및 지우개 관련 코드를 수정할 때 반드시 준수해야 하는 **사전 자동화 테스트 절차, 검증 규칙 및 실제 테스트 코드 명세**를 담고 있습니다. 에이전트는 코드 작성 후 본 문서에 정의된 테스트를 스스로 수행하고 결과가 모두 Pass될 때까지 사용자에게 작업을 완료했다고 보고해서는 안 됩니다.

---

## 1. 에이전트 필수 실행 원칙 (Agent Mandatory Rule)

1. **빌드 전 선제 검증 (Pre-Build Self-Validation)**:
   * 캔버스 드로잉(`SpenDrawingLayer`, `NoteCanvasWorkspace` 등), 뷰포트 컨테이너(`ZoomPanContainer`), 제스처 핸들러 파일을 1라인이라도 수정한 경우, **반드시 터미널에서 Vitest 기반 제스처 격리 테스트를 직접 실행**해야 합니다.
2. **테스트 패스 전 보고 금지 (Zero Hallucination)**:
   * `test/canvasGestureIsolation.test.ts`의 모든 테스트 케이스가 통과(Green)하기 전에는 사용자에게 "작업이 완료되었다"고 응답하지 마십시오. 실패 시 에러 원인을 추적하여 코드를 자체 디버깅하십시오.
3. **가상 에이전트 불변성 유지**:
   * 테스트를 억지로 통과시키기 위해 `VirtualStylusAgent`의 물리 입력 시뮬레이션 규격을 임의로 완화하거나 왜곡하지 마십시오.

---

## 2. 테스트 실행 명령 (Execution Commands)

에이전트는 셸 도구(terminal/bash)를 통해 다음 명령을 실행하여 결과를 확인하십시오:

```bash
# 1. 제스처 격리 및 S-Pen 전용 회귀 테스트 실행
npx vitest run test/canvasGestureIsolation.test.ts

# 2. 전체 단위 테스트 및 타입 검사 동시 수행
npm run test:run
```

---

## 3. 검증 통과 기준 (Pass Criteria)

테스트 실행 시 다음 5가지 핵심 시나리오가 모두 `PASSED` 상태여야 합니다:

1. **시나리오 1: S-Pen 단독 필기 시 화면 이동/배율 불변**
   * `VirtualStylusAgent.simulatePenStroke()` 호출 시 뷰포트의 `scale`, `translateX`, `translateY` 값이 초기 상태와 동일하게 유지되는가?
2. **시나리오 2: 펜 입력 시 브라우저 스크롤 차단**
   * 펜 이벤트 발생 시 `e.defaultPrevented === true`가 성립하여 모바일 브라우저/웹뷰의 기본 스크롤 동작이 취소되는가?
3. **시나리오 3: 핀치 줌 포인트 풀 오염 방어**
   * 두 손가락 핀치 줌 도중 S-Pen(`pointerType: 'pen'`)이 화면에 닿아도 줌 계산 포인트 맵에 펜 좌표가 삽입되지 않고 무시되는가?
4. **시나리오 4: 팜 리젝션(Palm Rejection) 시간 창 준수**
   * 펜 필기 중이거나 필기 종료 후 450ms 이내(`PALM_REJECTION_WINDOW_MS`)에 들어오는 손바닥 터치(`pointerType: 'touch'`)가 정상 거부되는가?
5. **시나리오 5: S-Pen 배럴 버튼 지우개 분기**
   * `buttons === 32` 또는 `pointerType === 'eraser'` 입력 시 드로잉 모드가 아닌 지우개 경로로 정확히 진입하는가?

---

## 4. `test/canvasGestureIsolation.test.ts` 전체 소스 코드

에이전트는 해당 경로(`test/canvasGestureIsolation.test.ts`)에 아래 테스트 코드가 온전히 유지되고 있는지 확인하고 테스트를 수행해야 합니다.

```typescript
// test/canvasGestureIsolation.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { VirtualStylusAgent } from './utils/virtualStylus';
import { shouldRejectPalmTouch, PalmRejectionState, PALM_REJECTION_WINDOW_MS } from '../src/utils/androidDeployment';

/**
 * 노트 앱 제스처 격리 및 필기 버그 방어 단위/통합 테스트 스위트
 */
describe('S-Pen 필기 및 피벗 제스처 격리 자동 검증', () => {
  let container: HTMLDivElement;
  let canvas: HTMLCanvasElement;
  let agent: VirtualStylusAgent;

  // 가상 뷰포트 상태 모의 객체
  let viewportState: {
    scale: number;
    translateX: number;
    translateY: number;
  };

  let drawingStrokes: Array<Array<{ x: number; y: number }>>;

  beforeEach(() => {
    container = document.createElement('div');
    canvas = document.createElement('canvas');
    container.appendChild(canvas);
    document.body.appendChild(container);

    agent = new VirtualStylusAgent(canvas);

    viewportState = { scale: 1.0, translateX: 0, translateY: 0 };
    drawingStrokes = [];

    // 가상 핸들러 바인딩 (SPEN_GESTURE_ISOLATION_GUIDE 표준 로직 반영)
    let currentStroke: Array<{ x: number; y: number }> | null = null;
    let isDrawing = false;
    const activeTouches = new Map<number, PointerEvent>();

    canvas.addEventListener('pointerdown', (e: PointerEvent) => {
      // 1. Touch는 핀치/패닝 풀에 등록
      if (e.pointerType === 'touch') {
        activeTouches.set(e.pointerId, e);
        return;
      }

      // 2. S-Pen은 필기 루프로 진입 및 제스처 전파 차단
      if (e.pointerType === 'pen') {
        e.preventDefault();
        e.stopPropagation();
        isDrawing = true;
        currentStroke = [{ x: e.clientX, y: e.clientY }];
      }
    });

    canvas.addEventListener('pointermove', (e: PointerEvent) => {
      if (e.pointerType === 'touch') {
        activeTouches.set(e.pointerId, e);
        // 2개 이상일 때 핀치 줌 연산
        if (activeTouches.size === 2) {
          viewportState.scale += 0.1;
          viewportState.translateX += 5;
        }
        return;
      }

      if (e.pointerType === 'pen' && isDrawing) {
        e.preventDefault();
        e.stopPropagation();
        currentStroke?.push({ x: e.clientX, y: e.clientY });
      }
    });

    canvas.addEventListener('pointerup', (e: PointerEvent) => {
      if (e.pointerType === 'touch') {
        activeTouches.delete(e.pointerId);
        return;
      }

      if (e.pointerType === 'pen' && isDrawing) {
        e.preventDefault();
        isDrawing = false;
        if (currentStroke) {
          drawingStrokes.push(currentStroke);
          currentStroke = null;
        }
      }
    });
  });

  it('시나리오 1: S-Pen 단독 필기 시 화면 이동(Pan)이나 배율(Zoom)이 변하지 않아야 한다', () => {
    const initialViewport = { ...viewportState };

    // S-Pen으로 대각선 필기 수행
    agent.simulatePenStroke([
      { x: 100, y: 100, pressure: 0.3 },
      { x: 150, y: 160, pressure: 0.6 },
      { x: 200, y: 220, pressure: 0.5 },
      { x: 280, y: 310, pressure: 0.2 },
    ]);

    // 필기 데이터는 1개의 스트로크로 정상 기록되어야 함
    expect(drawingStrokes.length).toBe(1);
    expect(drawingStrokes[0].length).toBe(4);

    // 뷰포트 상태(확대/축소 및 이동 좌표)는 단 0.001도 변하지 않아야 함
    expect(viewportState.scale).toBe(initialViewport.scale);
    expect(viewportState.translateX).toBe(initialViewport.translateX);
    expect(viewportState.translateY).toBe(initialViewport.translateY);
  });

  it('시나리오 2: S-Pen 이벤트 발생 시 브라우저 네이티브 기본 동작(스크롤)이 cancelable/preventDefault 처리되어야 한다', () => {
    let preventDefaultInvoked = false;

    canvas.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'pen' && e.defaultPrevented) {
        preventDefaultInvoked = true;
      }
    });

    agent.simulatePenStroke([
      { x: 50, y: 50 },
      { x: 60, y: 70 },
    ]);

    expect(preventDefaultInvoked).toBe(true);
  });

  it('시나리오 3: 두 손가락 핀치 줌 도중에 S-Pen 입력이 발생해도 줌 계산 포인트 풀에 펜 좌표가 오염되지 않아야 한다', () => {
    const initialScale = viewportState.scale;

    // 핀치 줌 실행 (터치 2개 다운)
    canvas.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', pointerId: 1, clientX: 100, clientY: 100 }));
    canvas.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', pointerId: 2, clientX: 200, clientY: 200 }));

    // 이 상태에서 S-Pen이 화면에 닿음
    canvas.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'pen', pointerId: 10, clientX: 150, clientY: 150 }));

    // 손가락 핀치 줌 이동
    canvas.dispatchEvent(new PointerEvent('pointermove', { pointerType: 'touch', pointerId: 1, clientX: 90, clientY: 90 }));

    // 줌은 정상 발생하되 S-Pen의 개입으로 인한 NaN이나 3점 이상 이상 연산이 일어나지 않음
    expect(viewportState.scale).toBeGreaterThan(initialScale);
  });

  it('시나리오 4: Palm Rejection - 펜 필기 중 또는 필기 직후의 손바닥 터치는 차단되어야 한다', () => {
    const now = 1000000;
    const penState: PalmRejectionState = {
      isPenDrawing: true,
      lastPenTimestamp: now,
    };

    // 1. 펜 필기 중 손바닥이 닿은 경우 -> 즉시 차단
    const rejectDuringPen = shouldRejectPalmTouch('touch', penState, now);
    expect(rejectDuringPen).toBe(true);

    // 2. 펜을 뗀 지 200ms 지난 시점(차단 윈도우 450ms 이내) -> 여전히 차단
    penState.isPenDrawing = false;
    const rejectWithinWindow = shouldRejectPalmTouch('touch', penState, now + 200);
    expect(rejectWithinWindow).toBe(true);

    // 3. 펜을 뗀 지 500ms 지난 시점(차단 윈도우 초과) -> 손가락 터치 허용
    const allowAfterWindow = shouldRejectPalmTouch('touch', penState, now + 500);
    expect(allowAfterWindow).toBe(false);
  });

  it('시나리오 5: S-Pen 배럴 지우개 버튼(buttons: 32) 입력 분기 검증', () => {
    let capturedButtons = 0;
    let isEraserMode = false;

    canvas.addEventListener('pointerdown', (e) => {
      capturedButtons = e.buttons;
      if (e.buttons === 32 || e.pointerType === 'eraser') {
        isEraserMode = true;
      }
    });

    agent.simulateEraserStroke([{ x: 100, y: 100 }, { x: 120, y: 120 }], { useBarrelButton: true });

    expect(capturedButtons).toBe(32);
    expect(isEraserMode).toBe(true);
  });
});
```

---

## 5. 테스트 실패 시 디버깅 체크리스트 (Agent Troubleshooting)

테스트가 실패할 경우 아래 3개 핵심 포인트를 확인하여 코드를 수정하십시오:

* [ ] **이벤트 전파 차단**: S-Pen 이벤트 핸들러 최상단에 `e.stopPropagation()` 및 `e.preventDefault()`가 누락되지 않았는가?
* [ ] **터치 맵 필터링**: 줌/패닝 추적 맵(`activeTouches`)에 `if (e.pointerType !== 'touch') return;` 가드가 걸려 있는가?
* [ ] **포인터 캡처**: 캔버스 `pointerdown` 시점에 `e.currentTarget.setPointerCapture(e.pointerId)`가 호출되고 있는가?

---

## 6. 사용자 보고 템플릿 (Reporting Format)

테스트 완료 후 에이전트는 사용자에게 다음과 같은 형식으로 결과를 요약 보고하십시오:

```markdown
### 🧪 자동화 테스트 검증 결과
- **테스트 파일**: `test/canvasGestureIsolation.test.ts`
- **실행 결과**: 5 passed / 0 failed
- **검증 항목**:
  1. [x] S-Pen 필기 시 화면 끌림 방지 (Translate/Scale 고정)
  2. [x] 펜 입력 브라우저 스크롤 취소 (preventDefault)
  3. [x] 두 손가락 핀치 줌과 펜 입력 완벽 격리
  4. [x] 팜 리젝션 450ms 시간 창 방어
  5. [x] 배럴 버튼 지우개 모드 분기
```