import { describe, expect, it } from 'vitest';
import { classifyOps, groupLines, isHandwritingPage, itemsToBlocks, templateExcludedOps, type PdfTextItem } from './pdfAnalysis';

const item = (str: string, x: number, y: number, height = 12, width = str.length * 6): PdfTextItem => ({ str, x, y, height, width });

describe('PDF 텍스트 → 마크다운 블록', () => {
  it('같은 기준선 아이템을 한 줄로, 위→아래 순서로 정렬', () => {
    const lines = groupLines([item('세계', 80, 700), item('안녕', 40, 700.5), item('둘째 줄', 40, 684)]);
    expect(lines.map((l) => l.text)).toEqual(['안녕 세계', '둘째 줄']);
  });

  it('줄 간격이 크면 새 단락, 큰 글꼴은 제목', () => {
    const blocks = itemsToBlocks([
      item('인지부하 이론', 40, 760, 24),
      item('첫 단락 첫 줄', 40, 720),
      item('첫 단락 둘째 줄', 40, 705),
      item('두 번째 단락', 40, 660),
      item('• 목록 항목', 40, 645),
    ]);
    expect(blocks[0]).toMatchObject({ type: 'heading', attrs: { level: 1 } });
    expect(blocks[1]).toMatchObject({ type: 'paragraph', content: [{ text: '첫 단락 첫 줄 첫 단락 둘째 줄' }] });
    expect(blocks[2]).toMatchObject({ type: 'paragraph', content: [{ text: '두 번째 단락' }] });
    expect(blocks[3]).toMatchObject({ type: 'paragraph', content: [{ text: '• 목록 항목' }] });
  });

  it('빈 문자열 아이템 무시, 텍스트 없으면 빈 배열', () => {
    expect(itemsToBlocks([item('', 0, 0)])).toEqual([]);
  });
});

describe('연산자 분류 / 손글씨 페이지 판정', () => {
  const OPS = { showText: 44, showSpacedText: 45, constructPath: 91, stroke: 20, fill: 22, paintImageXObject: 85, paintImageMaskXObject: 83 };

  it('텍스트·패스·이미지 연산 집계 (constructPath 와 칠하기 중복 집계 안 함)', () => {
    const fn = [44, 45, 91, 20, 91, 22, 85, 85];
    const args = [[], [], [], [], [], [], ['img_1'], ['img_1']];
    const s = classifyOps(fn, args, OPS);
    expect(s).toEqual({ textOps: 2, pathOps: 2, imageOps: 2, imageIds: ['img_1'] });
    expect(isHandwritingPage(s)).toBe(false);
  });

  it('다수의 벡터 패스(손글씨 획)가 있으면 손글씨 페이지', () => {
    const fn = Array.from({ length: 30 }, () => 91);
    const s = classifyOps(fn, fn.map(() => []), OPS);
    expect(isHandwritingPage(s)).toBe(true);
  });

  it('템플릿 렌더링에서 텍스트·이미지 연산 제외', () => {
    const ex = templateExcludedOps(OPS);
    expect(ex.has(44)).toBe(true);
    expect(ex.has(85)).toBe(true);
    expect(ex.has(91)).toBe(false);
  });
});
