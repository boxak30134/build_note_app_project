import { describe, expect, it, beforeEach } from 'vitest';
import {
  createPage,
  DEFAULT_DOC_FORMAT,
  DEFAULT_PAPER_SIZE,
  getPageDimensions,
  insertPageBelow,
  PAPER_SPECS,
  PULL_UP_THRESHOLD_PX,
  shouldCreatePageOnPullUp,
} from './pageTypes';
import { useSettings } from '../../store/settingsStore';

describe('Additional Features 1. Page (페이지 규격, 현재 페이지 아래 추가, 터치 밀어올리기, 문서 포맷 전환)', () => {
  beforeEach(() => {
    useSettings.setState({
      docFormat: DEFAULT_DOC_FORMAT,
      defaultPaperSize: DEFAULT_PAPER_SIZE,
      defaultPageStyle: 'plain',
      defaultOrientation: 'portrait',
    });
  });

  it('기본 용지 규격은 가장 대중적인 A4 용지이며 A4, A3, A5, B5, Letter 표준 규격을 지원한다', () => {
    expect(DEFAULT_PAPER_SIZE).toBe('A4');
    const defaultPage = createPage();
    expect(defaultPage.size).toBe('A4');
    expect(defaultPage.style).toBe('plain');
    expect(defaultPage.orientation).toBe('portrait');

    const a4Dims = getPageDimensions('A4', 'portrait');
    expect(a4Dims.mmWidth).toBe(210);
    expect(a4Dims.mmHeight).toBe(297);
    expect(a4Dims.width).toBe(840);
    expect(a4Dims.height).toBe(1188);

    const a3Dims = getPageDimensions('A3', 'portrait');
    expect(a3Dims.mmWidth).toBe(297);
    expect(a3Dims.mmHeight).toBe(420);
    expect(a3Dims.width).toBe(1188);
    expect(a3Dims.height).toBe(1680);

    const a4Landscape = getPageDimensions('A4', 'landscape');
    expect(a4Landscape.width).toBe(1188);
    expect(a4Landscape.height).toBe(840);
    expect(Object.keys(PAPER_SPECS)).toEqual(['A4', 'A3', 'A5', 'B5', 'Letter']);
  });

  it('페이지를 추가하면 현재 페이지 바로 밑(currentIndex + 1)에 생성되며 동일한 규격·스타일을 상속한다', () => {
    const p1 = createPage({ size: 'A4', style: 'lined', orientation: 'portrait' }, 'p1');
    const p2 = createPage({ size: 'A3', style: 'grid', orientation: 'landscape' }, 'p2');
    const p3 = createPage({ size: 'B5', style: 'dotted', orientation: 'portrait' }, 'p3');

    // 첫 번째 페이지(index 0)에서 페이지 추가 → index 1(p1 바로 밑)에 p1과 동일한 A4/lined/portrait 페이지 생성
    const res1 = insertPageBelow([p1, p2, p3], 0);
    expect(res1.insertedIndex).toBe(1);
    expect(res1.pages).toHaveLength(4);
    expect(res1.pages[0].id).toBe('p1');
    expect(res1.pages[1]).toEqual(
      expect.objectContaining({
        size: 'A4',
        style: 'lined',
        orientation: 'portrait',
      }),
    );
    expect(res1.pages[2].id).toBe('p2');
    expect(res1.pages[3].id).toBe('p3');

    // 두 번째 페이지(p2, A3/grid/landscape)에서 페이지 추가 → 바로 밑에 A3/grid/landscape 생성
    const res2 = insertPageBelow([p1, p2, p3], 1);
    expect(res2.insertedIndex).toBe(2);
    expect(res2.insertedPage.size).toBe('A3');
    expect(res2.insertedPage.style).toBe('grid');
    expect(res2.insertedPage.orientation).toBe('landscape');
  });

  it('현재 페이지를 터치하여 위로 밀어 올리면(Pull-up) 동일 규격·스타일 페이지 자동 생성 조건이 충족된다', () => {
    // 터치로 페이지 하단에서 위로 PULL_UP_THRESHOLD_PX(60px) 이상 밀어 올린 경우
    expect(
      shouldCreatePageOnPullUp({
        startY: 500,
        endY: 500 - PULL_UP_THRESHOLD_PX - 10,
        pointerType: 'touch',
        atBottom: true,
      }),
    ).toBe(true);

    // 위로 밀어 올린 거리가 임계값 미만인 경우
    expect(
      shouldCreatePageOnPullUp({
        startY: 500,
        endY: 470,
        pointerType: 'touch',
        atBottom: true,
      }),
    ).toBe(false);

    // 아래로 내린 경우
    expect(
      shouldCreatePageOnPullUp({
        startY: 300,
        endY: 450,
        pointerType: 'touch',
        atBottom: true,
      }),
    ).toBe(false);

    // 마우스나 펜 입력은 터치 밀어 올리기 제스처에서 제외
    expect(
      shouldCreatePageOnPullUp({
        startY: 500,
        endY: 350,
        pointerType: 'pen',
        atBottom: true,
      }),
    ).toBe(false);
  });

  it('설정에서 페이지 분리형(paginated) 포맷과 연속 단일 페이지(continuous) 포맷을 언제든지 전환할 수 있다', () => {
    expect(useSettings.getState().docFormat).toBe('paginated');

    useSettings.getState().setDocFormat('continuous');
    expect(useSettings.getState().docFormat).toBe('continuous');

    useSettings.getState().setDocFormat('paginated');
    expect(useSettings.getState().docFormat).toBe('paginated');
  });
});
