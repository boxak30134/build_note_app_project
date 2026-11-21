export const MAX_PDF_RERENDER_DIM = 4096;
export const MAX_PDF_RERENDER_SCALE = 5.0;
export const MIN_PDF_RERENDER_SCALE = 1.5;
export const MAX_PDF_LRU_PAGES = 6;
export const MAX_CACHED_PDF_DOCS = 3;
export const PDF_ZOOM_RERENDER_DEBOUNCE_MS = 150;

export interface PdfRenderTaskLike {
  promise: Promise<void>;
  cancel?: () => void;
}

export interface PdfPageLike {
  getViewport: (opts: { scale: number }) => { width: number; height: number };
  render: (params: { canvas: HTMLCanvasElement; viewport: unknown; background?: string }) => PdfRenderTaskLike;
  cleanup?: () => void;
}

export interface PdfDocumentLike {
  numPages: number;
  getPage: (pageNumber: number) => Promise<PdfPageLike>;
  destroy?: () => Promise<void>;
}

export type PdfDocumentLoader = (noteId: string, pdfSrc: string) => Promise<PdfDocumentLike | null>;

/**
 * 현재 CSS 렌더 폭·노트 줌·화면 DPR을 기준으로 GPU 안전 상한(4096px / 5.0x) 내 목표 PDF 벡터 배율을 계산한다.
 */
export function computeTargetPdfScale(
  basePdfWidth: number,
  basePdfHeight: number,
  renderedCssWidth: number,
  zoom: number,
  dpr: number,
): number {
  const safeBaseW = Math.max(1, basePdfWidth);
  const safeBaseH = Math.max(1, basePdfHeight);
  const safeCssW = Math.max(1, renderedCssWidth);
  const safeZoom = zoom > 0 ? zoom : 1;
  const safeDpr = Math.min(Math.max(dpr || 1, 1), 3.0);

  const desiredScale = (safeCssW * safeZoom * safeDpr) / safeBaseW;
  const maxScaleByDim = MAX_PDF_RERENDER_DIM / Math.max(safeBaseW, safeBaseH);
  return Math.max(0.5, Math.min(MAX_PDF_RERENDER_SCALE, maxScaleByDim, Math.max(MIN_PDF_RERENDER_SCALE, desiredScale)));
}

/**
 * 초기 2.0x PNG 프리뷰 대비 재렌더링 필요 여부 및 배율 변화(±15%)를 판정한다.
 */
export function shouldRerenderForZoom(currentRenderedScale: number, targetScale: number, hasHiRes: boolean): boolean {
  if (!hasHiRes) {
    return targetScale > 2.05;
  }
  return Math.abs(targetScale - currentRenderedScale) / Math.max(0.5, currentScaleFallback(currentRenderedScale)) >= 0.15;
}

function currentScaleFallback(v: number): number {
  return Number.isFinite(v) && v > 0 ? v : 2.0;
}

async function defaultPdfLoader(noteId: string, pdfSrc: string): Promise<PdfDocumentLike | null> {
  const { readAttachmentBlob } = await import('../../storage/opfs');
  if (typeof readAttachmentBlob !== 'function') return null;
  const blob = await readAttachmentBlob(noteId, pdfSrc);
  if (!blob) return null;
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
  onEvict?: () => void;
}

export class PdfZoomRenderer {
  private docCache = new Map<string, Promise<PdfDocumentLike | null>>();
  private activeTasks = new Map<string, { token: number; task: PdfRenderTaskLike | null }>();
  private lruCanvases = new Map<string, () => void>();
  private tokenCounter = 0;

  constructor(private readonly loader: PdfDocumentLoader = defaultPdfLoader) {}

  private docKey(noteId: string, pdfSrc: string): string {
    return `${noteId}::${pdfSrc}`;
  }

  async getDocument(noteId: string, pdfSrc: string): Promise<PdfDocumentLike | null> {
    const dk = this.docKey(noteId, pdfSrc);
    const existing = this.docCache.get(dk);
    if (existing) {
      // LRU 터치
      this.docCache.delete(dk);
      this.docCache.set(dk, existing);
      return existing;
    }

    const promise = this.loader(noteId, pdfSrc).catch(() => null);
    this.docCache.set(dk, promise);

    if (this.docCache.size > MAX_CACHED_PDF_DOCS) {
      const oldestKey = this.docCache.keys().next().value;
      if (oldestKey) {
        const oldestPromise = this.docCache.get(oldestKey);
        this.docCache.delete(oldestKey);
        void oldestPromise?.then((d) => d?.destroy?.().catch(() => undefined));
      }
    }

    const resolved = await promise;
    if (!resolved) {
      this.docCache.delete(dk);
    }
    return resolved;
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
        void p?.then((d) => d?.destroy?.().catch(() => undefined));
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

  async renderPageHiRes(params: RenderHiResPageParams): Promise<{ rendered: boolean; scale: number }> {
    const { key, noteId, pdfSrc, pageNumber, canvas, targetScale, onEvict } = params;
    this.cancelRender(key);
    const token = ++this.tokenCounter;
    const state = { token, task: null as PdfRenderTaskLike | null };
    this.activeTasks.set(key, state);

    const doc = await this.getDocument(noteId, pdfSrc);
    if (!doc || this.activeTasks.get(key)?.token !== token) {
      return { rendered: false, scale: 0 };
    }
    if (pageNumber < 1 || pageNumber > doc.numPages) {
      this.activeTasks.delete(key);
      return { rendered: false, scale: 0 };
    }

    let page: PdfPageLike | null = null;
    try {
      page = await doc.getPage(pageNumber);
      if (this.activeTasks.get(key)?.token !== token) {
        return { rendered: false, scale: 0 };
      }

      const viewport = page.getViewport({ scale: targetScale });
      const w = Math.max(1, Math.min(MAX_PDF_RERENDER_DIM, Math.ceil(viewport.width)));
      const h = Math.max(1, Math.min(MAX_PDF_RERENDER_DIM, Math.ceil(viewport.height)));

      canvas.width = w;
      canvas.height = h;
      const task = page.render({ canvas, viewport, background: '#ffffff' });
      state.task = task;
      await task.promise;

      if (this.activeTasks.get(key)?.token !== token) {
        return { rendered: false, scale: 0 };
      }

      this.activeTasks.delete(key);
      this.touchLru(key, canvas, onEvict);
      return { rendered: true, scale: targetScale };
    } catch (err) {
      const name = (err as { name?: string })?.name;
      if (name === 'RenderingCancelledException') {
        return { rendered: false, scale: 0 };
      }
      if (this.activeTasks.get(key)?.token === token) {
        this.activeTasks.delete(key);
      }
      return { rendered: false, scale: 0 };
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
