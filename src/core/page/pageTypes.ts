export type PaperSizeId = 'A4' | 'A3' | 'A5' | 'B5' | 'Letter';

export type PageOrientation = 'portrait' | 'landscape';

export type PageStyleId = 'plain' | 'lined' | 'grid' | 'dotted';

/**
 * 문서 포맷 모드:
 * - 'paginated': 페이지 분리형 문서 포맷 (표준 용지 규격 단위로 페이지 분리)
 * - 'continuous': 내용이 추가되는 대로 페이지가 분리되지 않고 하나의 페이지에서 계속 작성하는 포맷
 */
export type DocFormatMode = 'paginated' | 'continuous';

export type PaperSpec = {
  id: PaperSizeId;
  label: string;
  mmWidth: number;
  mmHeight: number;
  /** 4px/mm 기준 기본 세로(Portrait) 픽셀 너비 */
  pxWidth: number;
  /** 4px/mm 기준 기본 세로(Portrait) 픽셀 높이 */
  pxHeight: number;
};

/** 기본 용지 규격은 가장 대중적인 A4 용지 */
export const DEFAULT_PAPER_SIZE: PaperSizeId = 'A4';
export const DEFAULT_PAGE_STYLE: PageStyleId = 'plain';
export const DEFAULT_PAGE_ORIENTATION: PageOrientation = 'portrait';
export const DEFAULT_DOC_FORMAT: DocFormatMode = 'paginated';

/** 터치하여 위로 밀어 올릴 때 새 페이지가 생성되는 최소 스와이프 거리(px) */
export const PULL_UP_THRESHOLD_PX = 60;

/** 노트 확대/축소(Pinch-to-Zoom) 기본값 및 허용 범위 */
export const DEFAULT_NOTE_ZOOM = 1;
export const MIN_NOTE_ZOOM = 0.5;
export const MAX_NOTE_ZOOM = 3.0;
export const NOTE_ZOOM_STEP = 0.1;

/** 노트 배율을 허용 범위 [min, max] 내로 클램핑하고 소수점 3자리로 정규화한다 */
export function clampNoteZoom(
  zoom: number,
  min: number = MIN_NOTE_ZOOM,
  max: number = MAX_NOTE_ZOOM,
): number {
  if (typeof zoom !== 'number' || Number.isNaN(zoom) || !Number.isFinite(zoom)) {
    return DEFAULT_NOTE_ZOOM;
  }
  const clamped = Math.max(min, Math.min(max, zoom));
  return Math.round(clamped * 1000) / 1000;
}

/** 두 터치 지점 사이의 유클리드 거리 계산 */
export function touchDistance(
  p1: { x: number; y: number },
  p2: { x: number; y: number },
): number {
  return Math.hypot(p2.x - p1.x, p2.y - p1.y);
}

/** 두 터치 지점의 중심점(Midpoint) 계산 */
export function touchMidpoint(
  p1: { x: number; y: number },
  p2: { x: number; y: number },
): { x: number; y: number } {
  return {
    x: (p1.x + p2.x) / 2,
    y: (p1.y + p2.y) / 2,
  };
}

export interface PinchZoomInput {
  startDistance: number;
  currentDistance: number;
  startZoom: number;
  minZoom?: number;
  maxZoom?: number;
}

/**
 * 태블릿 두 손가락 핀치(확대/축소) 터치 무브먼트에 따른 노트 배율 계산
 * - 두 손가락 사이 거리가 멀어지면(currentDistance > startDistance) 비례하여 확대
 * - 두 손가락 사이 거리가 가까워지면(currentDistance < startDistance) 비례하여 축소
 */
export function computePinchZoom(input: PinchZoomInput): number {
  const { startDistance, currentDistance, startZoom, minZoom, maxZoom } = input;
  if (startDistance <= 0 || currentDistance <= 0) {
    return clampNoteZoom(startZoom, minZoom, maxZoom);
  }
  const scaleRatio = currentDistance / startDistance;
  return clampNoteZoom(startZoom * scaleRatio, minZoom, maxZoom);
}

/**
 * 핀치/휠 줌 기준점(Focal Point Anchor)
 * 두 손가락 중심점 아래의 unscaled 문서 좌표 및 뷰포트 내 기준 오프셋을 보존하여
 * 확대/축소 시 손가락이 닿은 위치가 화면 밖이나 상단(0,0)으로 튀지 않고 고정되도록 한다.
 */
export interface FocalZoomAnchor {
  docX: number;
  docY: number;
  pageOffsetX: number;
  pageOffsetY: number;
}

export function createFocalZoomAnchor(
  focalPoint: { x: number; y: number },
  zoom: number,
  viewport: { scrollTop: number; scrollLeft: number; rect: { top: number; left: number } },
  pageRect?: { top: number; left: number } | null,
): FocalZoomAnchor {
  const pLeft = pageRect ? pageRect.left : viewport.rect.left;
  const pTop = pageRect ? pageRect.top : viewport.rect.top;
  const safeZoom = zoom > 0 ? zoom : 1;
  return {
    docX: (focalPoint.x - pLeft) / safeZoom,
    docY: (focalPoint.y - pTop) / safeZoom,
    pageOffsetX: pLeft - viewport.rect.left + viewport.scrollLeft,
    pageOffsetY: pTop - viewport.rect.top + viewport.scrollTop,
  };
}

export function computeFocalZoomScrollOffsets(
  anchor: FocalZoomAnchor,
  nextZoom: number,
  currentFocalPoint: { x: number; y: number },
  viewportRect: { top: number; left: number },
): { scrollTop: number; scrollLeft: number } {
  return {
    scrollTop: Math.max(0, anchor.pageOffsetY + anchor.docY * nextZoom - (currentFocalPoint.y - viewportRect.top)),
    scrollLeft: Math.max(0, anchor.pageOffsetX + anchor.docX * nextZoom - (currentFocalPoint.x - viewportRect.left)),
  };
}

export const PAPER_SPECS: Record<PaperSizeId, PaperSpec> = {
  A4: {
    id: 'A4',
    label: 'A4 (210×297mm · 기본)',
    mmWidth: 210,
    mmHeight: 297,
    pxWidth: 840,
    pxHeight: 1188,
  },
  A3: {
    id: 'A3',
    label: 'A3 (297×420mm)',
    mmWidth: 297,
    mmHeight: 420,
    pxWidth: 1188,
    pxHeight: 1680,
  },
  A5: {
    id: 'A5',
    label: 'A5 (148×210mm)',
    mmWidth: 148,
    mmHeight: 210,
    pxWidth: 592,
    pxHeight: 840,
  },
  B5: {
    id: 'B5',
    label: 'B5 (176×250mm)',
    mmWidth: 176,
    mmHeight: 250,
    pxWidth: 704,
    pxHeight: 1000,
  },
  Letter: {
    id: 'Letter',
    label: 'Letter (216×279mm)',
    mmWidth: 216,
    mmHeight: 279,
    pxWidth: 864,
    pxHeight: 1116,
  },
};

export const PAGE_STYLE_LABELS: Record<PageStyleId, string> = {
  plain: '무지 (Plain)',
  lined: '줄노트 (Lined)',
  grid: '모눈 (Grid)',
  dotted: '점선 (Dotted)',
};

export type NotePage = {
  id: string;
  size: PaperSizeId;
  style: PageStyleId;
  orientation: PageOrientation;
};

let pageSeq = 0;

function makePageId(): string {
  pageSeq += 1;
  return `page-${Date.now().toString(36)}-${pageSeq.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** 규격과 방향에 따른 페이지 픽셀 크기 반환 */
export function getPageDimensions(
  size: PaperSizeId = DEFAULT_PAPER_SIZE,
  orientation: PageOrientation = DEFAULT_PAGE_ORIENTATION,
): { width: number; height: number; mmWidth: number; mmHeight: number; label: string } {
  const spec = PAPER_SPECS[size] ?? PAPER_SPECS.A4;
  if (orientation === 'landscape') {
    return {
      width: spec.pxHeight,
      height: spec.pxWidth,
      mmWidth: spec.mmHeight,
      mmHeight: spec.mmWidth,
      label: spec.label,
    };
  }
  return {
    width: spec.pxWidth,
    height: spec.pxHeight,
    mmWidth: spec.mmWidth,
    mmHeight: spec.mmHeight,
    label: spec.label,
  };
}

/** 새 페이지 객체 생성 (기본값: A4, plain, portrait) */
export function createPage(options: Partial<Omit<NotePage, 'id'>> = {}, customId?: string): NotePage {
  return {
    id: customId ?? makePageId(),
    size: options.size ?? DEFAULT_PAPER_SIZE,
    style: options.style ?? DEFAULT_PAGE_STYLE,
    orientation: options.orientation ?? DEFAULT_PAGE_ORIENTATION,
  };
}

/**
 * 현재 페이지 바로 밑(currentIndex + 1)에 새 페이지를 생성한다.
 * 기본 동작으로 현재 페이지와 동일한 규격(size, orientation) 및 동일한 스타일(style)을 상속한다.
 */
export function insertPageBelow(
  pages: readonly NotePage[],
  currentIndex: number,
  override?: Partial<Omit<NotePage, 'id'>>,
): { pages: NotePage[]; insertedIndex: number; insertedPage: NotePage } {
  const safeList = pages.length > 0 ? [...pages] : [createPage()];
  const clampedIndex = Math.max(0, Math.min(safeList.length - 1, currentIndex));
  const currentPage = safeList[clampedIndex];

  const insertedPage = createPage({
    size: override?.size ?? currentPage.size,
    style: override?.style ?? currentPage.style,
    orientation: override?.orientation ?? currentPage.orientation,
  });

  const insertedIndex = clampedIndex + 1;
  safeList.splice(insertedIndex, 0, insertedPage);

  return {
    pages: safeList,
    insertedIndex,
    insertedPage,
  };
}

export type PullUpGestureInput = {
  startY: number;
  endY: number;
  pointerType?: string;
  atBottom: boolean;
  thresholdPx?: number;
};

/**
 * 사용자가 현재 페이지를 터치하여 위로 밀어 올렸는지(Pull-up) 판별한다.
 * - 터치 입력(touch)으로 페이지 하단에서 위로 thresholdPx 이상 밀어 올리면 true 반환.
 */
export function shouldCreatePageOnPullUp(input: PullUpGestureInput): boolean {
  const threshold = input.thresholdPx ?? PULL_UP_THRESHOLD_PX;
  const isTouch = !input.pointerType || input.pointerType === 'touch';
  if (!isTouch || !input.atBottom) return false;
  const deltaUp = input.startY - input.endY;
  return deltaUp >= threshold;
}

/** PDF 캔버스 템플릿 페이지 간격 (px) */
export const PDF_PAGE_GAP_PX = 24;

export type PdfPageDimensionInput = {
  width: number;
  height: number;
};

export type PdfPageLayoutResult = {
  pageHeights: number[];
  yOffsets: number[];
  totalHeight: number;
};

/**
 * PDF 페이지(`inkTemplate`) 목록의 렌더링 높이와 페이지별 yOffset, 전체 높이를 계산한다.
 * - H_i = round(containerWidth * (height_i / width_i))
 * - yOffset(k) = sum_{i=0}^{k-1} (H_i + gapPx)
 * - totalHeight = sum_{i=0}^{N-1} H_i + max(0, N - 1) * gapPx (하단 유령 여백 제거)
 */
export function computePdfPageLayout(
  pages: readonly PdfPageDimensionInput[],
  containerWidth: number,
  gapPx: number = PDF_PAGE_GAP_PX,
): PdfPageLayoutResult {
  if (pages.length === 0 || containerWidth <= 0) {
    return { pageHeights: [], yOffsets: [], totalHeight: 0 };
  }
  const safeGap = Math.max(0, gapPx);
  const pageHeights: number[] = [];
  const yOffsets: number[] = [];
  let runningY = 0;

  for (let i = 0; i < pages.length; i++) {
    const rawW = pages[i].width > 0 ? pages[i].width : 595;
    const rawH = pages[i].height > 0 ? pages[i].height : 842;
    const renderedH = Math.round(containerWidth * (rawH / rawW));
    yOffsets.push(runningY);
    pageHeights.push(renderedH);
    runningY += renderedH + (i < pages.length - 1 ? safeGap : 0);
  }

  return {
    pageHeights,
    yOffsets,
    totalHeight: runningY,
  };
}

/**
 * TipTap 문서 JSON에서 `inkTemplate` 노드의 원본 치수(width, height) 배열을 추출한다.
 * 노드가 없을 경우 fallbackPages 규격 치수를 반환한다.
 */
export function extractInkTemplateDimensions(
  docContent: unknown,
  fallbackPages: readonly NotePage[] = [],
): PdfPageDimensionInput[] {
  const dims: PdfPageDimensionInput[] = [];
  const root = docContent as { content?: Array<{ type?: string; attrs?: { width?: number; height?: number } }> } | null;
  if (root && Array.isArray(root.content)) {
    for (const node of root.content) {
      if (node?.type === 'inkTemplate') {
        const w = Number(node.attrs?.width) || 595;
        const h = Number(node.attrs?.height) || 842;
        dims.push({ width: w, height: h });
      }
    }
  }
  if (dims.length > 0) {
    // 만약 pages 배열에 추가된 페이지가 더 많다면 부족분도 함께 반영
    for (let i = dims.length; i < fallbackPages.length; i++) {
      const d = getPageDimensions(fallbackPages[i].size, fallbackPages[i].orientation);
      dims.push({ width: d.width, height: d.height });
    }
    return dims;
  }
  return fallbackPages.map((p) => {
    const d = getPageDimensions(p.size, p.orientation);
    return { width: d.width, height: d.height };
  });
}

/**
 * PDF 문서(TipTap JSON) 내 targetPageIndex 번째 `inkTemplate` 바로 아래에
 * 새 빈 `inkTemplate` 노드를 삽입하고 전체 `inkTemplate` 페이지 번호를 1..N 으로 재정렬한다.
 */
export function insertBlankInkTemplateBelow<
  T extends { type?: string; content?: Array<{ type?: string; attrs?: Record<string, unknown> }> },
>(
  docContent: T,
  targetPageIndex: number,
  insertedPage: NotePage,
  override?: Partial<Omit<NotePage, 'id'>>,
): T {
  if (!docContent || !Array.isArray(docContent.content)) return docContent;
  const templateIndices: number[] = [];
  docContent.content.forEach((node, idx) => {
    if (node?.type === 'inkTemplate') templateIndices.push(idx);
  });
  if (templateIndices.length === 0) return docContent;

  const clampedTarget = Math.max(0, Math.min(templateIndices.length - 1, targetPageIndex));
  const targetDocIdx = templateIndices[clampedTarget];
  const targetNode = docContent.content[targetDocIdx];
  const fallbackDims = getPageDimensions(insertedPage.size, insertedPage.orientation);
  const hasExplicitSize = Boolean(override?.size || override?.orientation);
  const newWidth = hasExplicitSize
    ? fallbackDims.width
    : Number(targetNode?.attrs?.width) || fallbackDims.width;
  const newHeight = hasExplicitSize
    ? fallbackDims.height
    : Number(targetNode?.attrs?.height) || fallbackDims.height;

  const nextContent = [...docContent.content];
  nextContent.splice(targetDocIdx + 1, 0, {
    type: 'inkTemplate',
    attrs: {
      src: '',
      width: newWidth,
      height: newHeight,
      page: clampedTarget + 2,
      style: insertedPage.style,
    },
  });

  let seq = 0;
  const renumbered = nextContent.map((node) => {
    if (node?.type === 'inkTemplate') {
      seq += 1;
      return {
        ...node,
        attrs: {
          ...node.attrs,
          page: seq,
        },
      };
    }
    return node;
  });

  return {
    ...docContent,
    content: renumbered,
  };
}

/**
 * PDF 임포트 문서(내부에 `inkTemplate` 노드가 존재하는 문서)에서
 * 구버전 임포터로 인해 혼입된 중복 OCR 단락(`paragraph`/`heading`) 및
 * 중복 XObject 조각 이미지(`*-p1-img1.png`)를 제거하여
 * 각 페이지가 단일 `inkTemplate` 1:1 컨테이너로만 격리되도록 정규화한다.
 */
export function normalizePdfNoteContent<
  T extends { type?: string; content?: Array<{ type?: string; attrs?: Record<string, unknown> }> },
>(docContent: T): T {
  if (!docContent || !Array.isArray(docContent.content)) return docContent;
  const hasPdfTemplate = docContent.content.some(
    (node) => node?.type === 'inkTemplate' && typeof node.attrs?.src === 'string' && node.attrs.src.length > 0,
  );
  if (!hasPdfTemplate) return docContent;

  const onlyTemplates = docContent.content.filter((node) => node?.type === 'inkTemplate');
  if (onlyTemplates.length === 0 || onlyTemplates.length === docContent.content.length) {
    return docContent;
  }

  let seq = 0;
  const cleaned = onlyTemplates.map((node) => {
    seq += 1;
    return {
      ...node,
      attrs: {
        ...node.attrs,
        page: Number(node.attrs?.page) || seq,
      },
    };
  });

  return {
    ...docContent,
    content: cleaned,
  };
}
