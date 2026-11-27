import { drawStroke } from '../../canvas/render';
import type { Stroke } from '../strokes/StrokeStore';
import { getPageDimensions, type PageOrientation, type PaperSizeId, type PageStyleId } from './pageTypes';
import { pdfZoomRenderer } from '../../features/import/pdfZoomRenderer';
import { attachmentUrl } from '../../storage/opfs';

export const THUMBNAIL_TARGET_WIDTH = 180;
export const THUMBNAIL_WEBP_QUALITY = 0.7;
export const THUMBNAIL_SCROLL_DEBOUNCE_MS = 100;

export interface ThumbnailRenderTarget {
  noteId: string;
  pageNumber: number;
  pdfSrc?: string;
  pdfPage?: number;
  templateSrc?: string;
  size?: PaperSizeId;
  style?: PageStyleId;
  orientation?: PageOrientation;
  getStrokesForPage: (pageNumber: number) => Stroke[];
}

export interface ThumbnailCacheEntry {
  url: string;
  isObjectUrl: boolean;
}

type CacheChangeListener = (noteId: string, pageNumber: number) => void;

const STYLE_BG_COLORS: Record<PageStyleId, string> = {
  plain: '#ffffff',
  lined: '#ffffff',
  grid: '#ffffff',
  dotted: '#ffffff',
};

function drawPaperBackground(ctx: CanvasRenderingContext2D, w: number, h: number, style: PageStyleId) {
  ctx.fillStyle = STYLE_BG_COLORS[style] || '#ffffff';
  ctx.fillRect(0, 0, w, h);

  if (style === 'lined') {
    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = 0.5;
    for (let y = 10; y < h; y += 10) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
  } else if (style === 'grid') {
    ctx.strokeStyle = '#f1f5f9';
    ctx.lineWidth = 0.5;
    for (let x = 10; x < w; x += 10) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    for (let y = 10; y < h; y += 10) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
  } else if (style === 'dotted') {
    ctx.fillStyle = '#cbd5e1';
    for (let y = 8; y < h; y += 8) {
      for (let x = 8; x < w; x += 8) {
        ctx.fillRect(x, y, 1, 1);
      }
    }
  }
}

async function loadImageElement(src: string): Promise<HTMLImageElement | null> {
  if (typeof Image === 'undefined') return null;
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/**
 * 오프스크린 캔버스를 가로 180px 초저해상도로 WebP Blob URL로 굽고,
 * 완료 즉시 canvas.width = 0; canvas.height = 0; 으로 메모리를 해제한다.
 */
export async function canvasToWebpThumbnailUrl(canvas: HTMLCanvasElement): Promise<ThumbnailCacheEntry | null> {
  try {
    if (typeof canvas.toBlob === 'function') {
      const blob = await new Promise<Blob | null>((resolve) => {
        try {
          canvas.toBlob((b) => resolve(b), 'image/webp', THUMBNAIL_WEBP_QUALITY);
        } catch {
          resolve(null);
        }
      });
      if (blob && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
        return { url: URL.createObjectURL(blob), isObjectUrl: true };
      }
    }
    if (typeof canvas.toDataURL === 'function') {
      const dataUrl = canvas.toDataURL('image/webp', THUMBNAIL_WEBP_QUALITY);
      if (dataUrl) return { url: dataUrl, isObjectUrl: false };
    }
    return null;
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

/**
 * 사이드바 썸네일 전용 순차 큐 & WebP 캐시 관리자.
 * - 한 번에 1장씩 순차 생성(Concurrent = 1)
 * - S-Pen 필기 중(`isDrawing === true`)에는 큐 일시 정지
 * - 특정 페이지 변경 시 해당 `thumbnailCache[pageNumber]`만 무효화
 */
export class ThumbnailPipeline {
  private caches = new Map<string, Map<number, ThumbnailCacheEntry>>();
  private queue: ThumbnailRenderTarget[] = [];
  private queuedKeys = new Set<string>();
  private running = false;
  private paused = false;
  private listeners = new Set<CacheChangeListener>();
  private pauseListeners = new Set<(paused: boolean) => void>();

  private keyOf(noteId: string, pageNumber: number) {
    return `${noteId}::${pageNumber}`;
  }

  getCachedUrl(noteId: string, pageNumber: number): string | undefined {
    return this.caches.get(noteId)?.get(pageNumber)?.url;
  }

  getNoteCacheSnapshot(noteId: string): Record<number, string> {
    const map = this.caches.get(noteId);
    if (!map) return {};
    const out: Record<number, string> = {};
    map.forEach((entry, pageNum) => {
      out[pageNum] = entry.url;
    });
    return out;
  }

  isPaused(): boolean {
    return this.paused;
  }

  setPaused(paused: boolean) {
    if (this.paused === paused) return;
    this.paused = paused;
    this.pauseListeners.forEach((fn) => fn(paused));
    if (!paused && this.queue.length > 0 && !this.running) {
      void this.drainQueue();
    }
  }

  subscribePause(fn: (paused: boolean) => void): () => void {
    this.pauseListeners.add(fn);
    return () => this.pauseListeners.delete(fn);
  }

  subscribe(fn: CacheChangeListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private releaseEntry(entry: ThumbnailCacheEntry | undefined) {
    if (entry?.isObjectUrl && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
      try {
        URL.revokeObjectURL(entry.url);
      } catch {
        /* ignore */
      }
    }
  }

  invalidatePage(noteId: string, pageNumber: number) {
    const map = this.caches.get(noteId);
    if (!map) return;
    const prev = map.get(pageNumber);
    if (prev) {
      this.releaseEntry(prev);
      map.delete(pageNumber);
      this.listeners.forEach((fn) => fn(noteId, pageNumber));
    }
  }

  evictNote(noteId: string) {
    const map = this.caches.get(noteId);
    if (map) {
      map.forEach((entry) => this.releaseEntry(entry));
      this.caches.delete(noteId);
    }
    this.queue = this.queue.filter((item) => {
      if (item.noteId === noteId) {
        this.queuedKeys.delete(this.keyOf(item.noteId, item.pageNumber));
        return false;
      }
      return true;
    });
  }

  /**
   * 현재 가시 영역의 페이지들을 순차 큐에 적재한다 (이미 캐시된 항목은 건너뜀).
   */
  enqueueVisiblePages(targets: ThumbnailRenderTarget[], replacePending = true) {
    if (replacePending) {
      this.queue = [];
      this.queuedKeys.clear();
    }
    for (const target of targets) {
      if (this.getCachedUrl(target.noteId, target.pageNumber)) continue;
      const k = this.keyOf(target.noteId, target.pageNumber);
      if (this.queuedKeys.has(k)) continue;
      this.queuedKeys.add(k);
      this.queue.push(target);
    }
    if (!this.paused && !this.running && this.queue.length > 0) {
      void this.drainQueue();
    }
  }

  getQueueLength(): number {
    return this.queue.length;
  }

  private async renderSingleTarget(target: ThumbnailRenderTarget): Promise<void> {
    if (typeof document === 'undefined') return;
    const dims = getPageDimensions(target.size ?? 'A4', target.orientation ?? 'portrait');
    const thumbW = THUMBNAIL_TARGET_WIDTH;
    const thumbH = Math.max(1, Math.round(thumbW * (dims.height / dims.width)));
    const scale = thumbW / dims.width;

    const canvas = document.createElement('canvas');
    canvas.width = thumbW;
    canvas.height = thumbH;

    let renderedBg = false;
    if (target.pdfSrc && (target.pdfPage ?? target.pageNumber) > 0) {
      renderedBg = await pdfZoomRenderer.renderThumbnailPage({
        noteId: target.noteId,
        pdfSrc: target.pdfSrc,
        pageNumber: target.pdfPage || target.pageNumber,
        canvas,
        targetWidth: thumbW,
      });
    }

    const strokes = target.getStrokesForPage(target.pageNumber);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      if (!renderedBg) {
        canvas.width = 0;
        canvas.height = 0;
        return;
      }
    } else {
      if (!renderedBg) {
        drawPaperBackground(ctx, thumbW, thumbH, target.style ?? 'plain');
        if (target.templateSrc) {
          const url = await attachmentUrl(target.noteId, target.templateSrc);
          if (url) {
            const img = await loadImageElement(url);
            if (img) {
              ctx.drawImage(img, 0, 0, thumbW, thumbH);
            }
          }
        }
      }

      if (strokes.length > 0) {
        ctx.save();
        ctx.scale(scale, scale);
        for (let i = 0; i < strokes.length; i++) {
          drawStroke(ctx, strokes[i]);
        }
        ctx.restore();
      }
    }

    const entry = await canvasToWebpThumbnailUrl(canvas);
    if (!entry) return;

    let noteMap = this.caches.get(target.noteId);
    if (!noteMap) {
      noteMap = new Map();
      this.caches.set(target.noteId, noteMap);
    }
    const old = noteMap.get(target.pageNumber);
    if (old) this.releaseEntry(old);
    noteMap.set(target.pageNumber, entry);
    this.listeners.forEach((fn) => fn(target.noteId, target.pageNumber));
  }

  private async drainQueue() {
    if (this.running || this.paused) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        if (this.paused) break;
        const next = this.queue.shift()!;
        this.queuedKeys.delete(this.keyOf(next.noteId, next.pageNumber));
        if (this.getCachedUrl(next.noteId, next.pageNumber)) continue;
        await this.renderSingleTarget(next);
        // 메인 스레드/S-Pen 입력에 제어권을 양보
        await new Promise((r) => setTimeout(r, 0));
      }
    } finally {
      this.running = false;
      if (!this.paused && this.queue.length > 0) {
        void this.drainQueue();
      }
    }
  }
}

export const thumbnailPipeline = new ThumbnailPipeline();
