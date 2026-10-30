/**
 * PDF 가져오기용 순수 분석 로직 (pdf.js 비의존 → 단위 테스트 가능)
 * - 텍스트 아이템 → 줄/단락/제목 블록 (TipTap JSON)
 * - 연산자 목록 분류 → 손글씨(벡터 패스) 페이지 판정
 */
import type { JSONContent } from '@tiptap/core';

export interface PdfTextItem {
  str: string;
  /** PDF 좌표 (좌하단 원점) */
  x: number;
  y: number;
  /** 글꼴 높이 */
  height: number;
  width: number;
  hasEOL?: boolean;
}

interface Line {
  y: number;
  height: number;
  text: string;
}

/** 같은 기준선(y)의 아이템을 한 줄로 묶는다 */
export function groupLines(items: PdfTextItem[]): Line[] {
  const visible = items.filter((i) => i.str.length > 0);
  // 위에서 아래(PDF y 내림차순), 같은 줄은 왼쪽→오른쪽
  const sorted = [...visible].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: Array<{ y: number; height: number; parts: PdfTextItem[] }> = [];
  for (const it of sorted) {
    const tol = Math.max(2, (it.height || 10) * 0.45);
    const line = lines.find((l) => Math.abs(l.y - it.y) <= tol);
    if (line) {
      line.parts.push(it);
      line.height = Math.max(line.height, it.height);
    } else lines.push({ y: it.y, height: it.height || 10, parts: [it] });
  }
  return lines
    .sort((a, b) => b.y - a.y)
    .map((l) => {
      const parts = l.parts.sort((a, b) => a.x - b.x);
      let text = '';
      let lastEnd: number | null = null;
      for (const p of parts) {
        // 아이템 사이 간격이 글자 폭의 0.25배 이상이면 공백 삽입
        if (lastEnd !== null && p.x - lastEnd > Math.max(1, p.height * 0.25) && !text.endsWith(' ') && !p.str.startsWith(' ')) text += ' ';
        text += p.str;
        lastEnd = p.x + p.width;
      }
      return { y: l.y, height: l.height, text: text.replace(/\s+/g, ' ').trim() };
    })
    .filter((l) => l.text.length > 0);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * 줄 → 단락/제목 블록.
 * - 줄 간격이 본문 줄 높이의 1.6배를 넘으면 새 단락
 * - 글꼴 높이가 본문 중앙값의 1.35배 이상인 줄은 제목(h1/h2)
 * - 한국어 줄바꿈 연결: 단락 내 줄은 공백 하나로 이어 붙인다
 */
export function linesToBlocks(lines: Line[]): JSONContent[] {
  if (lines.length === 0) return [];
  const body = median(lines.map((l) => l.height)) || 10;
  const blocks: JSONContent[] = [];
  let para: string[] = [];
  let prev: Line | null = null;
  const flush = () => {
    if (para.length) blocks.push({ type: 'paragraph', content: [{ type: 'text', text: para.join(' ') }] });
    para = [];
  };
  for (const line of lines) {
    const ratio = line.height / body;
    if (ratio >= 1.35) {
      flush();
      blocks.push({ type: 'heading', attrs: { level: ratio >= 1.8 ? 1 : 2 }, content: [{ type: 'text', text: line.text }] });
      prev = null;
      continue;
    }
    if (prev && prev.y - line.y > Math.max(prev.height, line.height) * 1.6) flush();
    if (/^([•·▪◦\-*]|\d+[.)])\s+/.test(line.text)) flush();
    para.push(line.text);
    prev = line;
  }
  flush();
  return blocks;
}

export function itemsToBlocks(items: PdfTextItem[]): JSONContent[] {
  return linesToBlocks(groupLines(items));
}

export interface OpStats {
  textOps: number;
  pathOps: number;
  imageOps: number;
  imageIds: string[];
}

export type OpsTable = Record<string, number>;

const TEXT_OPS = ['showText', 'showSpacedText', 'nextLineShowText', 'nextLineSetSpacingShowText'];
const PATH_OPS = ['constructPath', 'rawFillPath', 'stroke', 'closeStroke', 'fill', 'eoFill', 'fillStroke', 'eoFillStroke', 'closeFillStroke', 'closeEOFillStroke'];
const IMAGE_OPS = ['paintImageXObject', 'paintInlineImageXObject', 'paintImageXObjectRepeat', 'paintInlineImageXObjectGroup'];
const MASK_OPS = ['paintImageMaskXObject', 'paintImageMaskXObjectGroup', 'paintImageMaskXObjectRepeat', 'paintSolidColorImageMask'];

function idSet(OPS: OpsTable, names: string[]): Set<number> {
  return new Set(names.map((n) => OPS[n]).filter((v) => typeof v === 'number'));
}

/** 연산자 목록 분류 */
export function classifyOps(fnArray: number[], argsArray: unknown[][], OPS: OpsTable): OpStats {
  const text = idSet(OPS, TEXT_OPS);
  // constructPath 는 경로 구성 후 칠하기 연산을 포함하므로 칠하기 연산과 중복 집계하지 않는다
  const construct = OPS.constructPath;
  const paint = idSet(OPS, PATH_OPS.filter((n) => n !== 'constructPath'));
  const image = idSet(OPS, IMAGE_OPS);
  const mask = idSet(OPS, MASK_OPS);
  const stats: OpStats = { textOps: 0, pathOps: 0, imageOps: 0, imageIds: [] };
  let pendingConstruct = false;
  fnArray.forEach((fn, i) => {
    if (text.has(fn)) stats.textOps++;
    else if (fn === construct) {
      stats.pathOps++;
      pendingConstruct = true;
      return;
    } else if (paint.has(fn)) {
      if (!pendingConstruct) stats.pathOps++;
    } else if (image.has(fn)) {
      stats.imageOps++;
      const id = argsArray[i]?.[0];
      if (typeof id === 'string' && !stats.imageIds.includes(id)) stats.imageIds.push(id);
    } else if (mask.has(fn)) {
      stats.pathOps++; // 스캔/잉크 마스크도 손글씨 후보
    }
    pendingConstruct = false;
  });
  return stats;
}

/** 손글씨 포함 페이지 판정: 벡터 패스가 임계값 이상 (삼성 노트 PDF 는 획마다 패스 생성) */
export const HANDWRITING_PATH_THRESHOLD = 12;

export function isHandwritingPage(stats: OpStats): boolean {
  return stats.pathOps >= HANDWRITING_PATH_THRESHOLD;
}

/** 템플릿 렌더링 시 그리지 않을 연산 (텍스트는 마크다운으로, 이미지는 첨부로 분리되므로) */
export function templateExcludedOps(OPS: OpsTable): Set<number> {
  return new Set([...idSet(OPS, TEXT_OPS), ...idSet(OPS, IMAGE_OPS)]);
}
