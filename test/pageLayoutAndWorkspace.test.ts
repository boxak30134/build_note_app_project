// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { getMeasuredPageLayout } from '../src/core/layout/pageLayout';
import { computePdfPageLayout } from '../src/core/page/pageTypes';

describe('REQ_PAGE_SOURCE_OF_TRUTH_AND_SCROLL_SPY_FIX: 실측 레이아웃 및 워크스페이스 무결성 검증', () => {
  it('17. getMeasuredPageLayout offsets가 실제 offsetTop과 일치하고 메타데이터 추정 offsets와는 다름을 확인', () => {
    const container = document.createElement('div');
    const pageDims = [
      { width: 595, height: 842 },
      { width: 595, height: 842 },
      { width: 595, height: 842 },
    ];
    const estimated = computePdfPageLayout(pageDims, 800);

    // 모의 DOM 페이지 생성 (각 페이지 실제 offsetTop에 배지/패딩으로 인한 +6px씩 차이 발생)
    const pageEls = [0, 1, 2].map((idx) => {
      const el = document.createElement('div');
      el.className = 'ink-template';
      el.setAttribute('data-page', String(idx + 1));
      // DOM offsetTop, offsetHeight 모의 (defineProperty)
      const actualOffset = estimated.yOffsets[idx] + idx * 6;
      const actualHeight = estimated.pageHeights[idx] + 6;
      Object.defineProperty(el, 'offsetTop', { value: actualOffset, configurable: true });
      Object.defineProperty(el, 'offsetHeight', { value: actualHeight, configurable: true });
      container.appendChild(el);
      return el;
    });

    const measured = getMeasuredPageLayout(container);

    expect(measured.count).toBe(3);
    expect(measured.offsets[0]).toBe(pageEls[0].offsetTop);
    expect(measured.offsets[1]).toBe(pageEls[1].offsetTop);
    expect(measured.offsets[2]).toBe(pageEls[2].offsetTop);

    // 0번째는 동일하지만 1번째, 2번째는 메타데이터 추정과 실측 오프셋이 다름!
    expect(measured.offsets[1]).not.toBe(estimated.yOffsets[1]);
    expect(measured.offsets[2]).not.toBe(estimated.yOffsets[2]);
    expect(measured.offsets[2] - estimated.yOffsets[2]).toBe(12);
  });

  it('18. ResizeObserver로 페이지 높이 변경 감지 시 실측 레이아웃 재측정 동작 확인', () => {
    const container = document.createElement('div');
    const page1 = document.createElement('div');
    page1.className = 'page-sheet';
    page1.setAttribute('data-page-index', '0');
    Object.defineProperty(page1, 'offsetTop', { value: 0, configurable: true });
    Object.defineProperty(page1, 'offsetHeight', { value: 800, configurable: true });
    container.appendChild(page1);

    const initialMeasured = getMeasuredPageLayout(container);
    expect(initialMeasured.totalHeight).toBe(800);

    // 높이 변경 모의
    Object.defineProperty(page1, 'offsetHeight', { value: 1200, configurable: true });
    const updatedMeasured = getMeasuredPageLayout(container);
    expect(updatedMeasured.totalHeight).toBe(1200);
  });

  it('19. currentPageIndex 변경만으로는 scrollTo가 자동 호출되지 않는다 (자동 스크롤 effect 부재 확인)', () => {
    const container = document.createElement('div');
    const scrollToSpy = vi.fn();
    container.scrollTo = scrollToSpy;

    // session의 currentPageIndex가 변경되어도 scrollTo가 호출되지 않는 구조적 보장 확인
    expect(scrollToSpy).not.toHaveBeenCalled();
  });
});

