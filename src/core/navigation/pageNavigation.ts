/**
 * pageNavigation.ts
 * 순수 상태 기계 기반 페이지 내비게이션 및 스크롤 스파이 모듈
 * 
 * 사용자 내비게이션 의도(targetPageIndex)와 스크롤 관찰(visiblePageIndex)을 분리하여
 * 프로그램 스크롤 도중 스파이가 중간 페이지로 덮어쓰는 경합(flicker)을 차단한다.
 */

export interface NavState {
  target: number | null;
  visible: number;
  programmatic: boolean;
  startedAt: number;
}

export interface PageLayoutLike {
  offsets: readonly number[];
  heights?: readonly number[];
  totalHeight?: number;
  count?: number;
}

export function createInitialNavState(initialVisible = 0): NavState {
  return {
    target: null,
    visible: Math.max(0, initialVisible),
    programmatic: false,
    startedAt: 0,
  };
}

/**
 * 외부에 노출되는 현재 페이지 인덱스 (목표 페이지 우선, 스크롤 완료 후 관찰값)
 */
export function getCurrentPageIndex(state: NavState): number {
  return state.target ?? state.visible;
}

/**
 * 사용자의 썸네일 클릭 등 명시적 페이지 이동 요청
 */
export function onNavigateRequest(state: NavState, index: number, now: number = Date.now()): NavState {
  return {
    ...state,
    target: Math.max(0, index),
    programmatic: true,
    startedAt: now,
  };
}

/**
 * 뷰포트 중앙선(scrollTop + viewportH / 2)을 기준으로 현재 보이는 페이지 인덱스를 결정한다.
 * - 상단선이나 50% 교차 판정의 떨림을 원천 제거.
 * - 문서 하단 도달 또는 마지막 짧은 페이지인 경우 마지막 인덱스를 반환.
 */
export function resolveVisibleIndex(
  scrollTop: number,
  viewportH: number,
  layout: PageLayoutLike,
): number {
  const count = layout.offsets.length;
  if (count <= 1) return 0;

  const center = scrollTop + viewportH / 2;
  const lastOffset = layout.offsets[count - 1] ?? 0;
  const lastHeight = layout.heights?.[count - 1] ?? 0;
  const totalHeight = layout.totalHeight ?? (lastOffset + lastHeight);

  // 문서 하단에 도달했거나 중앙선이 전체 높이를 초과한 경우 마지막 페이지 반환
  if (center >= totalHeight || (totalHeight > 0 && scrollTop + viewportH >= totalHeight - 2)) {
    return count - 1;
  }

  // 뷰포트 중앙선이 속한 페이지 탐색 (offsets는 오름차순 정렬됨)
  for (let i = count - 1; i >= 0; i--) {
    const pageTop = layout.offsets[i];
    if (center >= pageTop) {
      return i;
    }
  }

  return 0;
}

/**
 * 스크롤 샘플 이벤트 수신 시 상태 갱신
 */
export function onScrollSample(
  state: NavState,
  scrollTop: number,
  viewportH: number,
  layout: PageLayoutLike,
  now: number = Date.now(),
): NavState {
  const visible = resolveVisibleIndex(scrollTop, viewportH, layout);

  if (state.programmatic) {
    // 안전장치 1: 1500ms 타임아웃 초과 시 강제 settle
    if (now - state.startedAt >= 1500) {
      return {
        target: null,
        visible: state.target ?? visible,
        programmatic: false,
        startedAt: 0,
      };
    }

    // 안전장치 2: 목표 위치(targetOffset)에 오차 2px 이내로 도달 시 settle
    if (state.target !== null && layout.offsets.length > state.target) {
      const targetOffset = layout.offsets[state.target];
      if (Math.abs(scrollTop - targetOffset) <= 2) {
        return {
          target: null,
          visible: state.target,
          programmatic: false,
          startedAt: 0,
        };
      }
    }
  }

  return {
    ...state,
    visible,
  };
}

/**
 * 스크롤 완료(scrollend 또는 idle debounce) 시 호출
 */
export function onScrollSettled(
  state: NavState,
  scrollTop?: number,
  viewportH?: number,
  layout?: PageLayoutLike,
): NavState {
  let settledVisible = state.target ?? state.visible;
  if (scrollTop !== undefined && viewportH !== undefined && layout !== undefined) {
    settledVisible = resolveVisibleIndex(scrollTop, viewportH, layout);
  }

  return {
    target: null,
    visible: state.target !== null ? state.target : settledVisible,
    programmatic: false,
    startedAt: 0,
  };
}

/**
 * 프로그램 스크롤 도중 사용자가 직접 휠/터치를 조작했을 때 즉시 settle
 */
export function onUserScrollIntent(state: NavState): NavState {
  if (!state.programmatic) return state;
  return {
    ...state,
    target: null,
    programmatic: false,
    startedAt: 0,
  };
}

