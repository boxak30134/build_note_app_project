/**
 * pageLayout.ts
 * DOM 실측 기반 페이지 오프셋 및 치수 측정 모듈
 * 
 * 메타데이터 추정 오차(누적 px 차이)를 배제하고
 * 실제 렌더링된 DOM 엘리먼트의 offsetTop / offsetHeight를 직접 측정하여
 * 정확한 스크롤 및 스크롤 스파이 위치를 제공한다.
 */

export interface PageLayout {
  offsets: number[];
  heights: number[];
  totalHeight: number;
  count: number;
}

/**
 * 주어진 컨테이너 내부의 페이지 요소들을 실측하여 PageLayout을 반환한다.
 * - PDF 템플릿: `[data-ink-template]`, `.ink-template` (1-based data-page)
 * - 분리형 시트: `[data-page-index]`, `.page-sheet` (0-based data-page-index)
 */
export function getMeasuredPageLayout(container: HTMLElement, _zoom: number = 1): PageLayout {
  if (!container) {
    return { offsets: [], heights: [], totalHeight: 0, count: 0 };
  }

  const rawEls = Array.from(
    container.querySelectorAll<HTMLElement>('[data-page-index], [data-ink-template], .ink-template, .page-sheet'),
  );

  // 중복 및 내부 하위 요소 필터링 (최상위 페이지만 선별)
  const pageEls: HTMLElement[] = [];
  const seen = new Set<HTMLElement>();

  for (const el of rawEls) {
    if (seen.has(el)) continue;
    // 부모 중에 이미 rawEls에 포함된 요소가 있으면 자식 요소이므로 제외
    let isChild = false;
    let parent = el.parentElement;
    while (parent && parent !== container) {
      if (rawEls.includes(parent as HTMLElement)) {
        isChild = true;
        break;
      }
      parent = parent.parentElement;
    }
    if (isChild) continue;

    seen.add(el);
    pageEls.push(el);
  }

  // data-page(1-based) 또는 data-page-index(0-based) 기준 정렬, 없으면 DOM 순서
  pageEls.sort((a, b) => {
    const idxA = extractPageIndex(a);
    const idxB = extractPageIndex(b);
    if (idxA !== null && idxB !== null) {
      return idxA - idxB;
    }
    if (idxA !== null) return -1;
    if (idxB !== null) return 1;
    return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  });

  const offsets = pageEls.map((el) => el.offsetTop);
  const heights = pageEls.map((el) => el.offsetHeight);
  const totalHeight =
    offsets.length > 0
      ? (offsets[offsets.length - 1] ?? 0) + (heights[heights.length - 1] ?? 0)
      : 0;

  return {
    offsets,
    heights,
    totalHeight,
    count: pageEls.length,
  };
}

function extractPageIndex(el: HTMLElement): number | null {
  const pageIdxAttr = el.getAttribute('data-page-index');
  if (pageIdxAttr !== null && pageIdxAttr !== '') {
    const num = Number(pageIdxAttr);
    if (!Number.isNaN(num)) return num;
  }

  const pageAttr = el.getAttribute('data-page');
  if (pageAttr !== null && pageAttr !== '') {
    const num = Number(pageAttr);
    if (!Number.isNaN(num)) return num - 1; // 1-based -> 0-based
  }

  return null;
}
