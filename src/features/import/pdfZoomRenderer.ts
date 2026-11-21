export const MAX_PDF_RERENDER_DIM = 4096;
export const MAX_PDF_RERENDER_SCALE = 12.0;
export const MIN_PDF_RERENDER_SCALE = 1.0;
export const MAX_PDF_LRU_PAGES = 6;
export const MAX_CACHED_PDF_DOCS = 3;
export const PDF_ZOOM_RERENDER_DEBOUNCE_MS = 200;

export interface PdfRenderTaskLike {
  promise: Promise<void>;
  cancel?: () => void;
}

export interface PdfPageLike {
  getViewport: (opts: { scale: number }) => { width: number; height: number };
  render: (params: {
    canvas: HTMLCanvasElement;
    viewport: unknown;
    transform?: number[];
    background?: string;
  }) => PdfRenderTaskLike;
  cleanup?: () => void;
}

export interface PdfDocumentLike {
  numPages: number;
  getPage: (pageNumber: number) => Promise<PdfPageLike>;
  destroy?: () => Promise<void>;
}

export type PdfDocumentLoader = (noteId: string, pdfSrc: string) => Promise<PdfDocumentLike | null>;

/**
 * 현재 PDF 페이지 CSS 폭·상위 줌 배율·화면 DPR을 그대로 곱한 무감쇠 목표 PDF 배율을 계산한다.
 * targetScale = baseScale * currentZoom * dpr (baseScale = renderedCssWidth / basePdfWidth)
 */
export function computeTargetPdfScale(
  basePdfWidth: number,
  _basePdfHeight: number,
  renderedCssWidth: number,
  zoom: number,
  dpr: number,
): number {
  const safeBaseW = Math.max(1, basePdfWidth);
  const safeCssW = Math.max(1, renderedCssWidth);
  const safeZoom = zoom > 0 ? zoom : 1;
  const safeDpr = Math.min(Math.max(dpr || 1, 1), 3.0);

  const baseScale = safeCssW / safeBaseW;
  const targetScale = baseScale * safeZoom * safeDpr;
  return Math.max(MIN_PDF_RERENDER_SCALE, Math.min(MAX_PDF_RERENDER_SCALE, targetScale));
}

export interface PdfTileCropRect {
  /** 정규화된 가시 영역 비율 (0..1) */
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

export interface PdfTilePlan {
  mode: 'full' | 'tile';
  viewportWidth: number;
  viewportHeight: number;
  canvasWidth: number;
  canvasHeight: number;
  cropX: number;
  cropY: number;
  leftPct: number;
  topPct: number;
  widthPct: number;
  heightPct: number;
}

/**
 * 전체 목표 픽셀 크기(viewportWidth x viewportHeight)가 GPU 상한(4096px) 이내면 전체 페이지 모드로,
 * 고배율 확대(>4096px) 시에는 배율 감쇠 없이 가시 뷰포트 크롭 영역만 타일 캔버스(<=4096px)로 계획한다.
 */
export function computePdfTilePlan(
  viewportWidth: number,
  viewportHeight: number,
  crop?: PdfTileCropRect | null,
): PdfTilePlan {
  const fullW = Math.max(1, Math.round(viewportWidth));
  const fullH = Math.max(1, Math.round(viewportHeight));

  if (fullW <= MAX_PDF_RERENDER_DIM && fullH <= MAX_PDF_RERENDER_DIM) {
    return {
      mode: 'full',
      viewportWidth: fullW,
      viewportHeight: fullH,
      canvasWidth: fullW,
      canvasHeight: fullH,
      cropX: 0,
      cropY: 0,
      leftPct: 0,
      topPct: 0,
      widthPct: 100,
      heightPct: 100,
    };
  }

  const u0 = crop ? Math.max(0, Math.min(1, crop.u0)) : 0;
  const v0 = crop ? Math.max(0, Math.min(1, crop.v0)) : 0;
  const u1 = crop ? Math.max(u0, Math.min(1, crop.u1)) : 1;
  const v1 = crop ? Math.max(v0, Math.min(1, crop.v1)) : 1;

  let cropW = Math.max(1, Math.ceil((u1 - u0) * fullW));
  let cropH = Math.max(1, Math.ceil((v1 - v0) * fullH));
  let cropX = Math.floor(u0 * fullW);
  let cropY = Math.floor(v0 * fullH);

  if (cropW > MAX_PDF_RERENDER_DIM) {
    cropX += Math.floor((cropW - MAX_PDF_RERENDER_DIM) * 0.5);
    cropW = MAX_PDF_RERENDER_DIM;
  }
  if (cropH > MAX_PDF_RERENDER_DIM) {
    cropY += Math.floor((cropH - MAX_PDF_RERENDER_DIM) * 0.5);
    cropH = MAX_PDF_RERENDER_DIM;
  }

  cropX = Math.max(0, Math.min(fullW - cropW, cropX));
  cropY = Math.max(0, Math.min(fullH - cropH, cropY));

  return {
    mode: 'tile',
    viewportWidth: fullW,
    viewportHeight: fullH,
    canvasWidth: cropW,
    canvasHeight: cropH,
    cropX,
    cropY,
    leftPct: (cropX / fullW) * 100,
    topPct: (cropY / fullH) * 100,
    widthPct: (cropW / fullW) * 100,
    heightPct: (cropH / fullH) * 100,
  };
}

/**
 * 줌/타일 영역 변화에 따른 재렌더 필요 여부 판정
 */
export function shouldRerenderForZoom(
  currentRenderedScale: number,
  targetScale: number,
  hasHiRes: boolean,
  prevPlan?: PdfTilePlan | null,
  nextCrop?: PdfTileCropRect | null,
): boolean {
  if (!hasHiRes || !prevPlan) {
    return true;
  }
  const scaleDiffRatio = Math.abs(targetScale - currentRenderedScale) / Math.max(0.5, currentRenderedScale);
  if (scaleDiffRatio >= 0.08) {
    return true;
  }
  if (prevPlan.mode === 'tile' && nextCrop) {
    const curU0 = prevPlan.cropX / prevPlan.viewportWidth;
    const curV0 = prevPlan.cropY / prevPlan.viewportHeight;
    const curU1 = (prevPlan.cropX + prevPlan.canvasWidth) / prevPlan.viewportWidth;
    const curV1 = (prevPlan.cropY + prevPlan.canvasHeight) / prevPlan.viewportHeight;
    // 가시 영역이 이미 렌더된 타일 경계를 벗어나면 타일 이동 재렌더
    if (nextCrop.u0 < curU0 - 0.01 || nextCrop.v0 < curV0 - 0.01 || nextCrop.u1 > curU1 + 0.01 || nextCrop.v1 > curV1 + 0.01) {
      return true;
    }
  }
  return false;
}

export async function findFallbackPdfSrc(noteId: string): Promise<string | null> {
  try {
    const { listNoteAttachments } = await import('../../storage/opfs');
    if (typeof listNoteAttachments !== 'function') return null;
    const files = await listNoteAttachments(noteId);
    const sourcePdf = files.find((f) => /-source\.pdf$/i.test(f.name)) ?? files.find((f) => /\.pdf$/i.test(f.name));
    return sourcePdf ? sourcePdf.relPath : null;
  } catch {
    return null;
  }
}

async function defaultPdfLoader(noteId: string, pdfSrc: string): Promise<PdfDocumentLike | null> {
  const { readAttachmentBlob } = await import('../../storage/opfs');
  if (typeof readAttachmentBlob !== 'function') {
    throw new Error('OPFS 읽기 미지원');
  }
  const blob = await readAttachmentBlob(noteId, pdfSrc);
  if (!blob) {
    throw new Error('OPFS에 원본 PDF 없음');
  }
  const [pdfjs, { default: workerUrl }] = await Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const data = new Uint8Array(await blob.arrayBuffer());
  const loadingTask = pdfjs.getDocument({ data });
  const doc = await loadingTask.promise;
  return {
    numPages: doc.numPages,
    getPage: (pageNumber: number) => doc.getPage(pageNumber) as unknown as Promise<PdfPageLike>,
    destroy: () => loadingTask.destroy(),
  };
}

export interface RenderHiResPageParams {
  key: string;
  noteId: string;
  pdfSrc: string;
  pageNumber: number;
  canvas: HTMLCanvasElement;
  targetScale: number;
  crop?: PdfTileCropRect | null;
  onEvict?: () => void;
}

export interface RenderHiResPageResult {
  rendered: boolean;
  scale: number;
  plan?: PdfTilePlan;
  errorReason?: string;
}

export class PdfZoomRenderer {
  private docCache = new Map<string, Promise<PdfDocumentLike>>();
  private activeTasks = new Map<string, { token: number; task: PdfRenderTaskLike | null }>();
  private lruCanvases = new Map<string, () => void>();
  private tokenCounter = 0;

  constructor(private readonly loader: PdfDocumentLoader = defaultPdfLoader) {}

  private docKey(noteId: string, pdfSrc: string): string {
    return `${noteId}::${pdfSrc}`;
  }

  async getDocument(noteId: string, pdfSrc: string): Promise<PdfDocumentLike> {
    const dk = this.docKey(noteId, pdfSrc);
    const existing = this.docCache.get(dk);
    if (existing) {
      this.docCache.delete(dk);
      this.docCache.set(dk, existing);
      return existing;
    }

    const promise = this.loader(noteId, pdfSrc).then((doc) => {
      if (!doc) throw new Error('PDF 문서 로드 실패');
      return doc;
    });
    this.docCache.set(dk, promise);

    if (this.docCache.size > MAX_CACHED_PDF_DOCS) {
      const oldestKey = this.docCache.keys().next().value;
      if (oldestKey) {
        const oldestPromise = this.docCache.get(oldestKey);
        this.docCache.delete(oldestKey);
        void oldestPromise?.then((d) => d?.destroy?.().catch(() => undefined)).catch(() => undefined);
      }
    }

    try {
      return await promise;
    } catch (err) {
      this.docCache.delete(dk);
      throw err;
    }
  }

  cancelRender(key: string): void {
    const cur = this.activeTasks.get(key);
    if (cur) {
      cur.token = ++this.tokenCounter;
      try {
        cur.task?.cancel?.();
      } catch {
        /* ignore cancel errors */
      }
      this.activeTasks.delete(key);
    }
  }

  releasePage(key: string): void {
    this.cancelRender(key);
    const release = this.lruCanvases.get(key);
    if (release) {
      this.lruCanvases.delete(key);
      release();
    }
  }

  evictNote(noteId: string): void {
    const prefix = `${noteId}::`;
    for (const key of Array.from(this.lruCanvases.keys())) {
      if (key.startsWith(prefix)) {
        this.releasePage(key);
      }
    }
    for (const dk of Array.from(this.docCache.keys())) {
      if (dk.startsWith(prefix)) {
        const p = this.docCache.get(dk);
        this.docCache.delete(dk);
        void p?.then((d) => d?.destroy?.().catch(() => undefined)).catch(() => undefined);
      }
    }
  }

  private touchLru(key: string, canvas: HTMLCanvasElement, onEvict?: () => void): void {
    if (this.lruCanvases.has(key)) {
      this.lruCanvases.delete(key);
    }
    this.lruCanvases.set(key, () => {
      canvas.width = 0;
      canvas.height = 0;
      canvas.style.opacity = '0';
      onEvict?.();
    });

    while (this.lruCanvases.size > MAX_PDF_LRU_PAGES) {
      const oldestKey = this.lruCanvases.keys().next().value;
      if (!oldestKey || oldestKey === key) break;
      const release = this.lruCanvases.get(oldestKey);
      this.lruCanvases.delete(oldestKey);
      release?.();
    }
  }

  async renderPageHiRes(params: RenderHiResPageParams): Promise<RenderHiResPageResult> {
    const { key, noteId, pdfSrc, pageNumber, canvas, targetScale, crop, onEvict } = params;
    this.cancelRender(key);
    const token = ++this.tokenCounter;
    const state = { token, task: null as PdfRenderTaskLike | null };
    this.activeTasks.set(key, state);

    let doc: PdfDocumentLike;
    try {
      doc = await this.getDocument(noteId, pdfSrc);
    } catch (err) {
      if (this.activeTasks.get(key)?.token === token) {
        this.activeTasks.delete(key);
      }
      return { rendered: false, scale: 0, errorReason: (err as Error)?.message || 'PDF 로드 실패' };
    }

    if (this.activeTasks.get(key)?.token !== token) {
      return { rendered: false, scale: 0 };
    }
    if (pageNumber < 1 || pageNumber > doc.numPages) {
      this.activeTasks.delete(key);
      return { rendered: false, scale: 0, errorReason: `페이지 범위 초과(${pageNumber}/${doc.numPages})` };
    }

    let page: PdfPageLike | null = null;
    try {
      page = await doc.getPage(pageNumber);
      if (this.activeTasks.get(key)?.token !== token) {
        return { rendered: false, scale: 0 };
      }

      const viewport = page.getViewport({ scale: targetScale });
      const plan = computePdfTilePlan(viewport.width, viewport.height, crop);

      canvas.width = plan.canvasWidth;
      canvas.height = plan.canvasHeight;
      canvas.style.left = `${plan.leftPct}%`;
      canvas.style.top = `${plan.topPct}%`;
      canvas.style.width = `${plan.widthPct}%`;
      canvas.style.height = `${plan.heightPct}%`;

      const renderParams: {
        canvas: HTMLCanvasElement;
        viewport: unknown;
        transform?: number[];
        background?: string;
      } = {
        canvas,
        viewport,
        background: '#ffffff',
      };
      if (plan.mode === 'tile' && (plan.cropX !== 0 || plan.cropY !== 0)) {
        renderParams.transform = [1, 0, 0, 1, -plan.cropX, -plan.cropY];
      }

      const task = page.render(renderParams);
      state.task = task;
      await task.promise;

      if (this.activeTasks.get(key)?.token !== token) {
        return { rendered: false, scale: 0 };
      }

      this.activeTasks.delete(key);
      this.touchLru(key, canvas, onEvict);
      return { rendered: true, scale: targetScale, plan };
    } catch (err) {
      const name = (err as { name?: string })?.name;
      if (name === 'RenderingCancelledException') {
        return { rendered: false, scale: 0 };
      }
      if (this.activeTasks.get(key)?.token === token) {
        this.activeTasks.delete(key);
      }
      return { rendered: false, scale: 0, errorReason: (err as Error)?.message || '렌더 실패' };
    } finally {
      try {
        page?.cleanup?.();
      } catch {
        /* ignore */
      }
    }
  }

  getActiveLruCount(): number {
    return this.lruCanvases.size;
  }
}

export const pdfZoomRenderer = new PdfZoomRenderer();
