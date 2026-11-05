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
