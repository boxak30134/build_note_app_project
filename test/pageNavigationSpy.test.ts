import { describe, expect, it } from 'vitest';
import {
  createInitialNavState,
  getCurrentPageIndex,
  onNavigateRequest,
  onScrollSample,
  onScrollSettled,
  onUserScrollIntent,
  resolveVisibleIndex,
  type PageLayoutLike,
} from '../src/core/navigation/pageNavigation';

describe('REQ_PAGE_SOURCE_OF_TRUTH_AND_SCROLL_SPY_FIX: 순수 내비게이션 & 스크롤 스파이 상태 기계 검증', () => {
  const dummyLayout: PageLayoutLike = {
    offsets: [0, 800, 1600, 2400],
    heights: [800, 800, 800, 800],
    totalHeight: 3200,
    count: 4,
  };

  it('10. onNavigateRequest(s, 2) 후 currentPageIndex === 2 유지; 중간 scroll 이벤트 중에도 하이라이트가 중간 페이지로 바뀌지 않는다', () => {
    let state = createInitialNavState(0);
    const now = 1000;

    // 2번 페이지(인덱스 2)로 이동 요청
    state = onNavigateRequest(state, 2, now);
    expect(getCurrentPageIndex(state)).toBe(2);
    expect(state.programmatic).toBe(true);

    // 스크롤이 0쪽, 1쪽을 지나가는 동안의 샘플
    // scrollTop = 400 (0쪽 영역)
    state = onScrollSample(state, 400, 600, dummyLayout, now + 50);
    expect(state.visible).toBe(0); // 실제 보이는 뷰포트 중앙은 0쪽
    expect(getCurrentPageIndex(state)).toBe(2); // 하지만 외부에 노출되는 인덱스는 여전히 목표치인 2

    // scrollTop = 900 (1쪽 영역)
    state = onScrollSample(state, 900, 600, dummyLayout, now + 100);
    expect(state.visible).toBe(1);
    expect(getCurrentPageIndex(state)).toBe(2);

    // scrollTop = 1200 (1쪽 영역)
    state = onScrollSample(state, 1200, 600, dummyLayout, now + 150);
    expect(state.visible).toBe(1);
    expect(getCurrentPageIndex(state)).toBe(2);
  });

  it('11. onScrollSettled 후 target === null, visible === 2 로 정상 안착된다', () => {
    let state = createInitialNavState(0);
    state = onNavigateRequest(state, 2, 1000);

    // 목적지 도달 후 settle 호출
    state = onScrollSettled(state, 1600, 600, dummyLayout);
    expect(state.target).toBeNull();
    expect(state.programmatic).toBe(false);
    expect(state.visible).toBe(2);
    expect(getCurrentPageIndex(state)).toBe(2);
  });

  it('12. 요청 후 1500ms 경과 시 onScrollSample에서 강제 settle된다', () => {
    let state = createInitialNavState(0);
    const start = 1000;
    state = onNavigateRequest(state, 3, start);

    // 1500ms 경과 (start + 1501)
    state = onScrollSample(state, 2000, 600, dummyLayout, start + 1501);
    expect(state.target).toBeNull();
    expect(state.programmatic).toBe(false);
    expect(state.visible).toBe(3);
    expect(getCurrentPageIndex(state)).toBe(3);
  });

  it('13. resolveVisibleIndex: 뷰포트 중앙선 기준 판정 및 마지막 짧은 페이지 반환', () => {
    // offsets: [0, 800, 1600, 2400], heights: [800, 800, 800, 400], totalHeight: 2800
    const layout: PageLayoutLike = {
      offsets: [0, 800, 1600, 2400],
      heights: [800, 800, 800, 400],
      totalHeight: 2800,
      count: 4,
    };

    // scrollTop = 0, viewportH = 600 -> center = 300 (< 800) -> 0페이지
    expect(resolveVisibleIndex(0, 600, layout)).toBe(0);

    // scrollTop = 550, viewportH = 600 -> center = 850 (>= 800 and < 1600) -> 1페이지
    expect(resolveVisibleIndex(550, 600, layout)).toBe(1);

    // 경계 정확 일치: scrollTop = 500, viewportH = 600 -> center = 800 -> 1페이지
    expect(resolveVisibleIndex(500, 600, layout)).toBe(1);

    // 마지막 짧은 페이지: 문서 바닥에 도달 (scrollTop = 2200, viewportH = 600 -> center = 2500 >= 2400) -> 3페이지
    expect(resolveVisibleIndex(2200, 600, layout)).toBe(3);

    // 중앙선이 전체 높이를 초과할 때도 마지막 페이지 인덱스(3) 반환
    expect(resolveVisibleIndex(2500, 600, layout)).toBe(3);
  });

  it('14. 사용자 직접 입력(onUserScrollIntent) 발생 시 즉시 settle되어 사용자 조작을 차단하지 않는다', () => {
    let state = createInitialNavState(0);
    state = onNavigateRequest(state, 3, 1000);
    expect(state.programmatic).toBe(true);

    // 사용자 wheel / 터치 개입
    state = onUserScrollIntent(state);
    expect(state.target).toBeNull();
    expect(state.programmatic).toBe(false);
  });

  it('15. 20페이지 누적 오차 환경 대조 테스트: 추정 기반이면 오점프 발생, 실측 기반이면 정확히 19쪽 판정', () => {
    const pageH = 500;
    const gap = 10;
    const errorPerDoc = 10; // DOM 배지/패딩/경계선으로 인한 페이지당 10px 누적 오차

    // 메타데이터 추정 레이아웃 (오차 미반영)
    const estimatedOffsets = Array.from({ length: 20 }, (_, i) => i * (pageH + gap));
    // 실제 DOM 실측 레이아웃 (오차 반영)
    const measuredOffsets = Array.from({ length: 20 }, (_, i) => i * (pageH + gap + errorPerDoc));

    const measuredLayout: PageLayoutLike = {
      offsets: measuredOffsets,
      heights: Array(20).fill(pageH + errorPerDoc),
      totalHeight: measuredOffsets[19] + pageH + errorPerDoc,
      count: 20,
    };

    const viewportH = 300; // 뷰포트 높이 300px (중앙선 +150px)

    // 1) DOM 실측 기반 offset으로 스크롤했을 때 (measuredOffsets[19] = 9880)
    const measuredScrollTop = measuredOffsets[19];
    const measuredResult = resolveVisibleIndex(measuredScrollTop, viewportH, measuredLayout);
    // 정확하게 19페이지(20번째 페이지)로 판정됨
    expect(measuredResult).toBe(19);

    // 2) 메타데이터 추정 기반 offset으로 스크롤했을 때 (estimatedOffsets[19] = 9690)
    // 누적 오차(190px)가 뷰포트 중앙선 오프셋(150px)보다 커서 실제 19페이지 상단에 도달하지 못함 (9690 + 150 = 9840 < 9880)
    const wrongEstimatedResult = resolveVisibleIndex(estimatedOffsets[19], viewportH, measuredLayout);
    // 19번째 페이지에 미치지 못해 18페이지로 오점프 발생 검증!
    expect(wrongEstimatedResult).toBe(18);
  });
});
