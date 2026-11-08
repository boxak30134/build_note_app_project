/**
 * S-Pen 필기 ↔ 손가락 제스처(패닝·피벗 핀치 줌) 입력 격리 유틸리티.
 * - pen/eraser 포인터는 뷰포트 이동·줌 연산 풀에 절대 진입하지 않는다.
 * - touch 포인터만 1손가락 패닝 / 2손가락 피벗 핀치 줌에 참여한다.
 */

export type Point2D = { x: number; y: number };

export type ScrollOffsets = { scrollTop: number; scrollLeft: number };

type TouchLike = { clientX: number; clientY: number; touchType?: string };

/** 스타일러스(S-Pen 펜촉·지우개 팁) 포인터 여부 */
export const isStylusPointerType = (pointerType: string): boolean =>
  pointerType === 'pen' || pointerType === 'eraser';

/** 뷰포트 제스처(패닝·줌) 추적 맵에 등록 가능한 포인터인지 판정 — 오직 손가락 터치만 허용 */
export const isGesturePointerType = (pointerType: string): boolean => pointerType === 'touch';

/**
 * TouchEvent.touches 중 손가락 터치만 추출한다.
 * Android Chrome 은 S-Pen 입력도 TouchEvent(touchType: 'stylus')로 함께 발생시키므로,
 * 펜 + 손바닥이 2-터치 핀치로 오인되지 않도록 스타일러스 터치를 배제한다.
 */
export function fingerTouchesOf<T extends TouchLike>(touches: ArrayLike<T>): T[] {
  return Array.from(touches).filter((t) => t.touchType !== 'stylus');
}

/** 1손가락 패닝: 손가락 이동량 (Δx, Δy) 만큼 스크롤을 반대 방향으로 이동 */
export function computeSingleFingerPan(prev: Point2D, curr: Point2D, scroll: ScrollOffsets): ScrollOffsets {
  return {
    scrollLeft: scroll.scrollLeft - (curr.x - prev.x),
    scrollTop: scroll.scrollTop - (curr.y - prev.y),
  };
}

/** 관성 스크롤 감쇠 계수(프레임당) 및 정지 임계 속도(px/ms) */
export const PAN_INERTIA_DECAY = 0.92;
export const PAN_INERTIA_MIN_VELOCITY = 0.02;

/** 지수 이동 평균으로 패닝 속도(px/ms)를 갱신 */
export function updatePanVelocity(prevVelocity: Point2D, delta: Point2D, dtMs: number): Point2D {
  if (dtMs <= 0) return prevVelocity;
  const vx = delta.x / dtMs;
  const vy = delta.y / dtMs;
  return { x: prevVelocity.x * 0.2 + vx * 0.8, y: prevVelocity.y * 0.2 + vy * 0.8 };
}

/**
 * [Hit-Testing Guard] 포인터 이벤트(특히 S-Pen)가 실제 '활성 노트 용지(.page-canvas-surface)' 내부에서 발생했는지 판정한다.
 *
 * - 인터랙티브 UI 요소(버튼, 링크, 입력창, 플로팅 오버레이, 배지 등) 위이거나
 * - 흰색 노트 용지(Page Canvas Bounding Rect) 바깥의 회색 여백, 사이드바, 툴바, 우측 AI 패널인 경우 false 를 반환하여
 *   호출부가 e.preventDefault() / e.stopPropagation() / setPointerCapture() 를 호출하지 않고
 *   하위 DOM 클릭·스크롤로 100% 바이패스(Pass-through)하도록 보장한다.
 */
export function isPointerInsidePageCanvasSurface(
  event: { clientX: number; clientY: number; target: EventTarget | null },
  pageEl: HTMLElement | null,
  viewportEl?: HTMLElement | null,
): boolean {
  if (!pageEl) return false;
  const targetEl = event.target instanceof Element ? event.target : null;
  if (!targetEl) return false;

  // 1. 플로팅 오버레이, 버튼, 링크, 입력창 등 UI 컨트롤 위에서는 펜 드로잉 대신 클릭 바이패스
  if (
    targetEl.closest(
      '[data-overlay], button, a, input, textarea, select, [role="button"], .ink-template-badge',
    )
  ) {
    return false;
  }

  // 2. 명시적 .page-canvas-surface 클래스가 문서에 존재하는 경우 타깃이 반드시 그 내부여야 함
  const hasExplicitSurface =
    pageEl.classList.contains('page-canvas-surface') ||
    pageEl.querySelector('.page-canvas-surface') !== null;

  let surfaceEl: HTMLElement = pageEl;
  if (hasExplicitSurface) {
    const matched = targetEl.closest('.page-canvas-surface') as HTMLElement | null;
    if (!matched || (!pageEl.contains(matched) && matched !== pageEl)) {
      return false;
    }
    surfaceEl = matched;
  } else if (
    !pageEl.contains(targetEl) &&
    targetEl !== pageEl &&
    targetEl !== viewportEl
  ) {
    return false;
  }

  // 3. clientX, clientY가 활성 용지(pageEl 및 surfaceEl)의 Bounding Rect 내부인지 정밀 판정
  const pageRect = pageEl.getBoundingClientRect();
  if (pageRect.width > 0 && pageRect.height > 0) {
    if (
      event.clientX < pageRect.left ||
      event.clientX > pageRect.right ||
      event.clientY < pageRect.top ||
      event.clientY > pageRect.bottom
    ) {
      return false;
    }
  }

  if (surfaceEl !== pageEl) {
    const sRect = surfaceEl.getBoundingClientRect();
    if (sRect.width > 0 && sRect.height > 0) {
      if (
        event.clientX < sRect.left ||
        event.clientX > sRect.right ||
        event.clientY < sRect.top ||
        event.clientY > sRect.bottom
      ) {
        return false;
      }
    }
  }

  // 4. 뷰포트 가시 영역(viewportEl)이 주어진 경우 가시 영역 내부인지 추가 검증
  if (viewportEl) {
    const vRect = viewportEl.getBoundingClientRect();
    if (vRect.width > 0 && vRect.height > 0) {
      if (
        event.clientX < vRect.left ||
        event.clientX > vRect.right ||
        event.clientY < vRect.top ||
        event.clientY > vRect.bottom
      ) {
        return false;
      }
    }
  }

  return true;
}
