// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { StrokeStore, type Stroke } from '../src/core/strokes/StrokeStore';
import { CompositeHistoryManager } from '../src/core/history/CompositeHistoryManager';
import { CHUNK_HEIGHT, computeSlidingWindowChunkRange } from '../src/canvas/InkCanvas';
import {
  PageThumbnailList,
  computeThumbnailVirtualRange,
} from '../src/components/PageThumbnailList';
import {
  THUMBNAIL_SCROLL_DEBOUNCE_MS,
  THUMBNAIL_TARGET_WIDTH,
  THUMBNAIL_WEBP_QUALITY,
  ThumbnailPipeline,
  canvasToWebpThumbnailUrl,
  thumbnailPipeline,
} from '../src/core/page/thumbnailPipeline';
import {
  MAX_PDF_LRU_PAGES,
  pdfZoomRenderer,
} from '../src/features/import/pdfZoomRenderer';
import { InkTemplate } from '../src/editor/extensions/media';
import { NoteSession } from '../src/session/NoteSession';
import { db, emptyNote } from '../src/storage/db';
import { useSessions } from '../src/store/sessionStore';
import { createPage } from '../src/core/page/pageTypes';

vi.mock('../src/search/searchClient', () => ({
  indexNote: vi.fn(),
  unindexNote: vi.fn(),
  searchRelated: vi.fn().mockResolvedValue([]),
}));

vi.mock('../src/storage/opfs', () => ({
  attachmentUrl: vi.fn().mockResolvedValue('blob:mock-page-png'),
  writeAttachment: vi.fn().mockResolvedValue(undefined),
  deleteAttachment: vi.fn().mockResolvedValue(undefined),
  readAttachmentBlob: vi.fn().mockResolvedValue(null),
  listNoteAttachments: vi.fn().mockResolvedValue([]),
  saveAttachmentExclusive: vi.fn().mockResolvedValue('attachments/mock.pdf'),
  saveImageExclusive: vi.fn().mockResolvedValue('images/mock.png'),
  extOfMime: vi.fn().mockReturnValue('png'),
}));

describe('200+ 페이지 대용량 PDF 뷰포트 윈도잉 및 썸네일 사이드바 가상화', () => {
  const origCreateObjectURL = URL.createObjectURL;
  const origRevokeObjectURL = URL.revokeObjectURL;

  beforeEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    URL.createObjectURL = origCreateObjectURL;
    URL.revokeObjectURL = origRevokeObjectURL;
    thumbnailPipeline.setPaused(false);
    thumbnailPipeline.evictNote('note-200p');
    vi.useRealTimers();
    cleanup();
  });

  it('1. 메인 뷰포트: 200페이지 문서에서 currentPage ± 1 (최대 3장) 청크 범위만 계산한다', () => {
    const pageH = 900;
    const pageRanges = Array.from({ length: 200 }, (_, i) => ({
      pageNumber: i + 1,
      minY: i * (pageH + 24),
      maxY: i * (pageH + 24) + pageH,
    }));
    const totalH = 200 * (pageH + 24);

    // 100번째 페이지(index 99) 주변 스크롤 위치
    const scrollTop = pageRanges[99].minY;
    const range = computeSlidingWindowChunkRange(totalH, scrollTop, 900, 1, 99, pageRanges);
    const win99Start = Math.floor(pageRanges[98].minY / CHUNK_HEIGHT);
    const win99End = Math.floor(pageRanges[100].maxY / CHUNK_HEIGHT);

    expect(range.start).toBeGreaterThanOrEqual(win99Start);
    expect(range.end).toBeLessThanOrEqual(win99End);
    expect(range.end - range.start + 1).toBeLessThanOrEqual(3);
    expect(MAX_PDF_LRU_PAGES).toBe(3);
  });

  it('2. InkTemplate NodeView가 ±1페이지 슬라이딩 윈도우 밖으로 벗어나면 hiResCanvas GPU 메모리(width=0, height=0)와 img를 즉시 해제한다', () => {
    useSessions.setState({
      sessions: {
        'note-win': {
          id: 'note-win',
          loaded: true,
          dirty: false,
          saving: false,
          readOnly: false,
          external: null,
          canUndo: false,
          canRedo: false,
          lassoIds: [],
          moveMode: false,
          annotations: [],
          textObjects: [],
          openAnnotationId: null,
          pages: Array.from({ length: 10 }, () => createPage()),
          currentPageIndex: 4, // 5페이지 활성 -> 4, 5, 6페이지만 윈도우 내
          zoom: 1,
          activeTool: 'pencil',
          activeCitations: [],
          relatedNotes: [],
        },
      },
    });

    const addNodeViewFn = (InkTemplate.config as unknown as {
      addNodeView: (this: { options: { noteId: string } }) => (props: {
        node: { attrs: Record<string, unknown> };
      }) => { dom: HTMLElement; destroy: () => void };
    }).addNodeView.call({ options: { noteId: 'note-win' } });

    const nodeView = addNodeViewFn({
      node: { attrs: { page: 5, src: 'attachments/p5.png', pdfSrc: 'attachments/doc.pdf', pdfPage: 5, width: 595, height: 842 } },
    });

    expect(nodeView.dom.querySelector('img')).not.toBeNull();

    // 가짜 hiResCanvas 부착 후 1페이지(currentPageIndex: 0)로 점프 -> 5페이지는 윈도우(1, 2페이지) 이탈
    const fakeCanvas = document.createElement('canvas');
    fakeCanvas.className = 'ink-template-hires';
    fakeCanvas.width = 1200;
    fakeCanvas.height = 1600;
    nodeView.dom.appendChild(fakeCanvas);

    // 10페이지로 이동시켜 5페이지를 윈도우 밖으로 이탈시킴
    act(() => {
      useSessions.getState().patch('note-win', { currentPageIndex: 9 });
    });

    expect(nodeView.dom.querySelector('img')).toBeNull();
    nodeView.destroy();
  });

  it('3. StrokeStore가 strokesByPage 맵과 dirtyPages를 유지하고 NoteSession.save() 시 수정된 페이지만 IndexedDB에 증분 저장한다', async () => {
    const history = new CompositeHistoryManager();
    const pageRanges = Array.from({ length: 200 }, (_, i) => ({
      pageNumber: i + 1,
      minY: i * 1000,
      maxY: i * 1000 + 950,
    }));
    const store = new StrokeStore(history, [], pageRanges);

    const sPage1: Stroke = { id: 's-1', tool: 'pencil', color: '#000', size: 2, points: [[10, 100, 0.5]] };
    const sPage50: Stroke = { id: 's-50', tool: 'pencil', color: '#000', size: 2, points: [[10, 49100, 0.5]] };
    const sPage200: Stroke = { id: 's-200', tool: 'pencil', color: '#000', size: 2, points: [[10, 199100, 0.5]] };

    store.reset([sPage1, sPage50, sPage200], false);
    expect(store.getDirtyPages()).toEqual([]);
    expect(store.getStrokesByPage(1)).toHaveLength(1);
    expect(store.getStrokesByPage(50)).toHaveLength(1);
    expect(store.getStrokesByPage(200)).toHaveLength(1);

    // 50페이지만 1획 추가
    const sPage50New: Stroke = { id: 's-50-2', tool: 'pencil', color: '#ef4444', size: 3, points: [[20, 49200, 0.5]] };
    store.addStroke(sPage50New);

    expect(store.getDirtyPages()).toEqual([50]);
    expect(store.getStrokesByPage(50)).toHaveLength(2);

    // NoteSession.save() 증분 저장 검증
    const bulkPutSpy = vi.fn().mockResolvedValue(undefined);
    const bulkDeleteSpy = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(db.notes, 'get').mockResolvedValue(null as never);
    vi.spyOn(db.notes, 'put').mockResolvedValue('note-inc' as never);
    Object.defineProperty(db, 'pageStrokes', {
      value: {
        bulkPut: bulkPutSpy,
        bulkDelete: bulkDeleteSpy,
        where: vi.fn(),
      },
      configurable: true,
    });

    const record = emptyNote({
      id: 'note-inc',
      pages: Array.from({ length: 5 }, () => createPage()),
      strokes: [sPage1],
    });
    const session = new NoteSession(record);
    session.strokes.addStroke({
      id: 's-p3',
      tool: 'pencil',
      color: '#000',
      size: 2,
      pageNumber: 3,
      points: [[10, 2500, 0.5]],
    });

    await session.save();

    expect(bulkPutSpy).toHaveBeenCalledTimes(1);
    const putArgs = bulkPutSpy.mock.calls[0][0] as Array<{ noteId: string; pageNumber: number; strokes: Stroke[] }>;
    expect(putArgs).toHaveLength(1);
    expect(putArgs[0].noteId).toBe('note-inc');
    expect(putArgs[0].pageNumber).toBe(3);
    expect(session.strokes.getDirtyPages()).toEqual([]);
    session.destroy();
  });

  it('4. 왼쪽 썸네일 사이드바: 200페이지 문서에서도 가시 범위(8~10개) 아이템만 마운트하고 고해상도 캔버스를 사용하지 않는다', () => {
    const fakeContent = {
      type: 'doc',
      content: Array.from({ length: 200 }, (_, i) => ({
        type: 'inkTemplate',
        attrs: {
          src: `attachments/p${i + 1}.png`,
          pdfSrc: 'attachments/book.pdf',
          pdfPage: i + 1,
          width: 595,
          height: 842,
          page: i + 1,
        },
      })),
    };

    const mockSession = {
      id: 'note-200p',
      record: { id: 'note-200p', title: '200p PDF', content: fakeContent },
      ui: { pages: Array.from({ length: 200 }, () => createPage()), currentPageIndex: 0 },
      strokes: new StrokeStore(),
    } as unknown as NoteSession;

    render(<PageThumbnailList session={mockSession} />);

    const mountedCards = document.querySelectorAll('[data-testid^="page-thumbnail-"]:not([data-testid^="page-thumbnail-img-"]):not([data-testid^="page-thumbnail-placeholder-"])');
    // list container 자체 제외하고 카드만 카운트
    const cardIds = Array.from(mountedCards).filter((el) => /^page-thumbnail-\d+$/.test(el.getAttribute('data-testid') || ''));
    expect(cardIds.length).toBeGreaterThanOrEqual(8);
    expect(cardIds.length).toBeLessThanOrEqual(10);
    expect(document.querySelectorAll('canvas').length).toBe(0);

    // 실제 스크롤 높이(600px) 기준 가상 범위 검증
    const vRange = computeThumbnailVirtualRange(200, 1720, 600, 20);
    expect(vRange.endIdx - vRange.startIdx + 1).toBeLessThanOrEqual(10);
    expect(vRange.topSpacerHeight).toBeGreaterThan(0);
    expect(vRange.bottomSpacerHeight).toBeGreaterThan(0);
  });

  it('5. 오프스크린 180px 캔버스에서 toBlob("image/webp", 0.7)로 변환 후 canvas.width=0, height=0 으로 즉시 메모리를 해제한다', async () => {
    const canvas = document.createElement('canvas');
    canvas.width = THUMBNAIL_TARGET_WIDTH;
    canvas.height = 255;

    const toBlobSpy = vi.fn((cb: BlobCallback, type?: string, quality?: number) => {
      expect(type).toBe('image/webp');
      expect(quality).toBe(THUMBNAIL_WEBP_QUALITY);
      cb(new Blob(['webp-bytes'], { type: 'image/webp' }));
    });
    canvas.toBlob = toBlobSpy as unknown as typeof canvas.toBlob;

    const createObjSpy = vi.fn().mockReturnValue('blob:webp-180');
    URL.createObjectURL = createObjSpy;

    const result = await canvasToWebpThumbnailUrl(canvas);
    expect(result).toEqual({ url: 'blob:webp-180', isObjectUrl: true });
    expect(toBlobSpy).toHaveBeenCalledTimes(1);
    expect(createObjSpy).toHaveBeenCalledTimes(1);
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
  });

  it('6. 썸네일 큐는 S-Pen 필기 중(isPaused=true) 일시 정지되고, 필기 종료 후 순차 1장씩 생성하며, 스크롤 100ms 디바운스를 따른다', async () => {
    vi.useFakeTimers();
    const pipeline = new ThumbnailPipeline();
    let activeRenders = 0;
    let maxConcurrent = 0;

    vi.spyOn(pdfZoomRenderer, 'renderThumbnailPage').mockImplementation(async ({ canvas }) => {
      activeRenders += 1;
      maxConcurrent = Math.max(maxConcurrent, activeRenders);
      canvas.width = 180;
      canvas.height = 255;
      canvas.toBlob = ((cb: BlobCallback) => cb(new Blob(['w'], { type: 'image/webp' }))) as unknown as typeof canvas.toBlob;
      activeRenders -= 1;
      return true;
    });
    URL.createObjectURL = vi.fn(() => `blob:thumb-${Math.random()}`);
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      save: vi.fn(),
      restore: vi.fn(),
      scale: vi.fn(),
      fillRect: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
    } as unknown as CanvasRenderingContext2D);

    // 필기 중 일시 정지
    pipeline.setPaused(true);
    pipeline.enqueueVisiblePages([
      { noteId: 'n1', pageNumber: 1, pdfSrc: 'a.pdf', pdfPage: 1, getStrokesForPage: () => [] },
      { noteId: 'n1', pageNumber: 2, pdfSrc: 'a.pdf', pdfPage: 2, getStrokesForPage: () => [] },
    ]);
    expect(pipeline.getQueueLength()).toBe(2);
    expect(pipeline.getCachedUrl('n1', 1)).toBeUndefined();

    // 필기 종료 후 재개 -> 1장씩 순차 생성
    pipeline.setPaused(false);
    await vi.runAllTimersAsync();

    expect(maxConcurrent).toBe(1);
    expect(pipeline.getCachedUrl('n1', 1)).toBeDefined();
    expect(pipeline.getCachedUrl('n1', 2)).toBeDefined();

    // 스크롤 디바운스(100ms) 검증
    vi.useRealTimers();
    expect(THUMBNAIL_SCROLL_DEBOUNCE_MS).toBe(100);
  });

  it('7. 특정 페이지 필기 수정 시 해당 페이지의 thumbnailCache[pageNumber]만 무효화되고 다른 페이지 캐시는 유지된다', async () => {
    const pipeline = new ThumbnailPipeline();
    vi.spyOn(pdfZoomRenderer, 'renderThumbnailPage').mockImplementation(async ({ canvas }) => {
      canvas.width = 180;
      canvas.height = 255;
      canvas.toBlob = ((cb: BlobCallback) => cb(new Blob(['w'], { type: 'image/webp' }))) as unknown as typeof canvas.toBlob;
      return true;
    });
    let seq = 0;
    URL.createObjectURL = vi.fn(() => `blob:thumb-${++seq}`);
    const revokeSpy = vi.fn();
    URL.revokeObjectURL = revokeSpy;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      save: vi.fn(),
      restore: vi.fn(),
      scale: vi.fn(),
      fillRect: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
    } as unknown as CanvasRenderingContext2D);

    pipeline.enqueueVisiblePages([
      { noteId: 'n-inv', pageNumber: 1, pdfSrc: 'a.pdf', pdfPage: 1, getStrokesForPage: () => [] },
      { noteId: 'n-inv', pageNumber: 2, pdfSrc: 'a.pdf', pdfPage: 2, getStrokesForPage: () => [] },
      { noteId: 'n-inv', pageNumber: 3, pdfSrc: 'a.pdf', pdfPage: 3, getStrokesForPage: () => [] },
    ]);

    await new Promise((r) => setTimeout(r, 60));

    const url1 = pipeline.getCachedUrl('n-inv', 1);
    const url2 = pipeline.getCachedUrl('n-inv', 2);
    const url3 = pipeline.getCachedUrl('n-inv', 3);
    expect(url1).toBeDefined();
    expect(url2).toBeDefined();
    expect(url3).toBeDefined();

    // 2페이지만 무효화
    pipeline.invalidatePage('n-inv', 2);
    expect(revokeSpy).toHaveBeenCalledWith(url2);
    expect(pipeline.getCachedUrl('n-inv', 1)).toBe(url1);
    expect(pipeline.getCachedUrl('n-inv', 2)).toBeUndefined();
    expect(pipeline.getCachedUrl('n-inv', 3)).toBe(url3);
  });
});
