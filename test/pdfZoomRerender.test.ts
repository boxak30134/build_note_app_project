// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_TEMPLATE_PX, TEMPLATE_SCALE } from '../src/features/import/pdfImport';
import { assemblePdfImportResult } from '../src/features/import/importer';
import type { PdfImportResult } from '../src/features/import/pdfImport';
import {
  computePdfTilePlan,
  computeTargetPdfScale,
  MAX_PDF_LRU_PAGES,
  MAX_PDF_RERENDER_DIM,
  PDF_ZOOM_RERENDER_DEBOUNCE_MS,
  PdfZoomRenderer,
  pdfZoomRenderer,
  shouldRerenderForZoom,
  type PdfDocumentLike,
} from '../src/features/import/pdfZoomRenderer';
import { NoteSession } from '../src/session/NoteSession';
import { emptyNote } from '../src/storage/db';
import { listNoteAttachments } from '../src/storage/opfs';
import { useSessions } from '../src/store/sessionStore';

vi.mock('../src/storage/db', async () => {
  const actual = await vi.importActual<typeof import('../src/storage/db')>('../src/storage/db');
  return {
    ...actual,
    db: {
      notes: {
        put: vi.fn().mockResolvedValue('test-note-id'),
        get: vi.fn().mockResolvedValue(null),
      },
    },
  };
});

vi.mock('../src/storage/opfs', () => ({
  attachmentUrl: vi.fn().mockResolvedValue('blob:preview-png'),
  writeAttachment: vi.fn().mockResolvedValue(undefined),
  deleteAttachment: vi.fn().mockResolvedValue(undefined),
  readAttachmentBlob: vi.fn().mockResolvedValue(null),
  listNoteAttachments: vi.fn().mockResolvedValue([]),
  saveAttachmentExclusive: vi.fn().mockResolvedValue('attachments/mock.pdf'),
  saveImageExclusive: vi.fn().mockResolvedValue('images/mock.png'),
  extOfMime: vi.fn().mockReturnValue('png'),
}));

vi.mock('../src/features/search/documentLinker', () => ({
  searchRelatedDocuments: vi.fn().mockResolvedValue([]),
}));

describe('REQ_pdf_zoom_rerender: PDF 고화질 PNG 초기 변환 및 줌 적응형 재렌더링', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('1. 초기 템플릿 품질 기준(2.0x / 2400px / 무손실 PNG) 및 원본 pdfSrc·pdfPage 속성 보존', async () => {
    expect(TEMPLATE_SCALE).toBeGreaterThanOrEqual(2.0);
    expect(MAX_TEMPLATE_PX).toBeGreaterThanOrEqual(2400);

    const mockResult: PdfImportResult = {
      title: '고화질_수업자료',
      pages: [
        {
          index: 1,
          width: 595,
          height: 842,
          blocks: [],
          images: [],
          template: { blob: new Blob(['png-1'], { type: 'image/png' }), width: 595, height: 842 },
          stats: { textOps: 5, pathOps: 10, imageOps: 0, imageIds: [] },
        },
        {
          index: 2,
          width: 595,
          height: 842,
          blocks: [],
          images: [],
          template: { blob: new Blob(['png-2'], { type: 'image/png' }), width: 595, height: 842 },
          stats: { textOps: 4, pathOps: 8, imageOps: 0, imageIds: [] },
        },
      ],
    };

    const savedNames: string[] = [];
    const assembled = await assemblePdfImportResult(
      mockResult,
      '강의노트.pdf',
      async (_blob, fileName) => {
        savedNames.push(fileName);
        return `attachments/${fileName}`;
      },
      { pdfSrc: 'attachments/강의노트-source.pdf' },
    );

    expect(savedNames).toEqual(['강의노트-p1.png', '강의노트-p2.png']);
    expect(assembled.doc.content?.[0]?.attrs).toMatchObject({
      src: 'attachments/강의노트-p1.png',
      pdfSrc: 'attachments/강의노트-source.pdf',
      pdfPage: 1,
    });
    expect(assembled.doc.content?.[1]?.attrs).toMatchObject({
      src: 'attachments/강의노트-p2.png',
      pdfSrc: 'attachments/강의노트-source.pdf',
      pdfPage: 2,
    });
  });

  it('2. v2 무감쇠 targetScale = baseScale * zoom * dpr 및 4096px 초과 시 뷰포트 크롭 타일 계획을 산출한다', () => {
    // 1.0x zoom, 2.0 DPR -> (840 / 595) * 1.0 * 2.0 ≈ 2.8235x (초기 1x에서도 즉각 선명화 가능)
    const scale1x = computeTargetPdfScale(595, 842, 840, 1.0, 2.0);
    expect(scale1x).toBeCloseTo((840 / 595) * 2.0, 2);
    expect(shouldRerenderForZoom(0, scale1x, false)).toBe(true);

    // 2.5x zoom, 2.0 DPR -> 정확히 2.5배 상승 (조기 4096px 클램프 없이 ~7.0588x)
    const scale25x = computeTargetPdfScale(595, 842, 840, 2.5, 2.0);
    expect(scale25x).toBeCloseTo(scale1x * 2.5, 2);

    // 1.0x -> 전체 모드 (canvas <= 4096), 2.5x -> viewportWidth/Height ~4200x5944 (>4096) -> 타일 크롭 모드
    const fullPlan = computePdfTilePlan(595 * scale1x, 842 * scale1x);
    expect(fullPlan.mode).toBe('full');
    expect(fullPlan.viewportWidth).toBe(Math.round(595 * scale1x));

    const tilePlan = computePdfTilePlan(595 * scale25x, 842 * scale25x, {
      u0: 0.2,
      v0: 0.25,
      u1: 0.7,
      v1: 0.65,
    });
    expect(tilePlan.mode).toBe('tile');
    expect(tilePlan.viewportWidth).toBe(Math.round(595 * scale25x));
    expect(tilePlan.viewportHeight).toBe(Math.round(842 * scale25x));
    expect(tilePlan.canvasWidth).toBeLessThanOrEqual(MAX_PDF_RERENDER_DIM);
    expect(tilePlan.canvasHeight).toBeLessThanOrEqual(MAX_PDF_RERENDER_DIM);
    expect(tilePlan.cropX).toBeGreaterThan(0);
    expect(tilePlan.cropY).toBeGreaterThan(0);

    // 8% 미만 미세 변화는 생략, 타일 경계 이탈 시에는 재렌더 트리거
    expect(shouldRerenderForZoom(scale25x, scale25x * 1.03, true, tilePlan, { u0: 0.25, v0: 0.3, u1: 0.65, v1: 0.6 })).toBe(false);
    expect(shouldRerenderForZoom(scale25x, scale25x * 1.03, true, tilePlan, { u0: 0.05, v0: 0.3, u1: 0.55, v1: 0.6 })).toBe(true);
  });

  it('3. 고배율 타일 render() transform 전달, 이전 renderTask 취소, 6페이지 초과 LRU 해제가 동작한다', async () => {
    const cancelSpy = vi.fn();
    const capturedTransforms: Array<number[] | undefined> = [];
    let rejectFirst!: (err: unknown) => void;
    let markFirstRenderStarted!: () => void;
    const firstRenderStarted = new Promise<void>((res) => {
      markFirstRenderStarted = res;
    });

    const mockDoc: PdfDocumentLike = {
      numPages: 10,
      destroy: vi.fn().mockResolvedValue(undefined),
      getPage: vi.fn().mockImplementation(async (pageNum: number) => ({
        getViewport: ({ scale }: { scale: number }) => ({ width: 595 * scale, height: 842 * scale }),
        render: ({ canvas, transform }: { canvas: HTMLCanvasElement; transform?: number[] }) => {
          capturedTransforms.push(transform);
          if (pageNum === 1 && cancelSpy.mock.calls.length === 0) {
            markFirstRenderStarted();
            return {
              promise: new Promise<void>((_res, rej) => {
                rejectFirst = rej;
              }),
              cancel: () => {
                cancelSpy();
                rejectFirst(Object.assign(new Error('cancelled'), { name: 'RenderingCancelledException' }));
              },
            };
          }
          expect(canvas.width).toBeGreaterThan(0);
          expect(canvas.width).toBeLessThanOrEqual(MAX_PDF_RERENDER_DIM);
          expect(canvas.height).toBeLessThanOrEqual(MAX_PDF_RERENDER_DIM);
          return { promise: Promise.resolve(), cancel: vi.fn() };
        },
        cleanup: vi.fn(),
      })),
    };

    const renderer = new PdfZoomRenderer(async () => mockDoc);
    const c1 = document.createElement('canvas');

    const p1 = renderer.renderPageHiRes({
      key: 'n1::doc.pdf::1',
      noteId: 'n1',
      pdfSrc: 'doc.pdf',
      pageNumber: 1,
      canvas: c1,
      targetScale: 2.5,
    });
    await firstRenderStarted;
    // 7.0x 고배율 + 크롭 타일 요청 -> viewport > 4096 이지만 canvas는 <=4096 이고 음수 오프셋 transform 전달
    const p2 = renderer.renderPageHiRes({
      key: 'n1::doc.pdf::1',
      noteId: 'n1',
      pdfSrc: 'doc.pdf',
      pageNumber: 1,
      canvas: c1,
      targetScale: 7.0,
      crop: { u0: 0.2, v0: 0.3, u1: 0.7, v1: 0.7 },
    });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(cancelSpy).toHaveBeenCalledTimes(1);
    expect(r1.rendered).toBe(false);
    expect(r2.rendered).toBe(true);
    expect(r2.scale).toBe(7.0);
    expect(r2.plan?.mode).toBe('tile');
    expect(capturedTransforms.at(-1)).toEqual([1, 0, 0, 1, -r2.plan!.cropX, -r2.plan!.cropY]);

    // LRU 상한(6페이지) 초과 검증
    const canvases: HTMLCanvasElement[] = [c1];
    for (let p = 2; p <= MAX_PDF_LRU_PAGES + 1; p++) {
      const cp = document.createElement('canvas');
      canvases.push(cp);
      await renderer.renderPageHiRes({
        key: `n1::doc.pdf::${p}`,
        noteId: 'n1',
        pdfSrc: 'doc.pdf',
        pageNumber: p,
        canvas: cp,
        targetScale: 3.0,
      });
    }

    expect(renderer.getActiveLruCount()).toBe(MAX_PDF_LRU_PAGES);
    expect(c1.width).toBe(0);
    expect(c1.height).toBe(0);

    // 노트 닫힘 시 전체 문서 캐시 및 캔버스 메모리 정리
    renderer.evictNote('n1');
    await Promise.resolve();
    expect(renderer.getActiveLruCount()).toBe(0);
    expect(mockDoc.destroy).toHaveBeenCalledTimes(1);
  });

  it('4. InkTemplate NodeView가 줌 변화(100%->250%)에 따라 200ms 디바운스 재렌더 및 실시간 해상도 배지를 갱신한다', async () => {
    vi.useFakeTimers();

    const noteId = 'note-pdf-nodeview-zoom';
    useSessions.getState().patch(noteId, { zoom: 1.0 });

    const renderSpy = vi.spyOn(pdfZoomRenderer, 'renderPageHiRes').mockImplementation(async ({ canvas, targetScale, crop }) => {
      const vpW = Math.round(595 * targetScale);
      const vpH = Math.round(842 * targetScale);
      const plan = computePdfTilePlan(vpW, vpH, crop);
      canvas.width = plan.canvasWidth;
      canvas.height = plan.canvasHeight;
      return { rendered: true, scale: targetScale, plan };
    });
    const releaseSpy = vi.spyOn(pdfZoomRenderer, 'releasePage');

    const note = emptyNote({
      id: noteId,
      title: '줌 재렌더 노드뷰 테스트',
      content: {
        type: 'doc',
        content: [
          {
            type: 'inkTemplate',
            attrs: {
              src: 'attachments/p1.png',
              pdfSrc: 'attachments/source.pdf',
              pdfPage: 1,
              width: 595,
              height: 842,
              page: 1,
            },
          },
        ],
      },
    });

    const session = new NoteSession(note);
    try {
      const domEl = session.host.querySelector<HTMLElement>('[data-ink-template]');
      expect(domEl).toBeTruthy();
      expect(domEl!.dataset.pdfSrc).toBe('attachments/source.pdf');
      expect(domEl!.dataset.pdfPage).toBe('1');
      Object.defineProperty(domEl!, 'clientWidth', { value: 840, configurable: true });
      vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(2.0);

      // 초기 배지 확인 및 250% 줌 확대 -> 200ms 디바운스 전 미호출, 디바운스 후 실제 재렌더
      useSessions.getState().patch(noteId, { zoom: 2.5 });
      expect(renderSpy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(PDF_ZOOM_RERENDER_DEBOUNCE_MS + 20);
      await Promise.resolve();
      await Promise.resolve();

      expect(renderSpy).toHaveBeenCalledTimes(1);
      expect(renderSpy.mock.calls[0][0]).toMatchObject({
        noteId,
        pdfSrc: 'attachments/source.pdf',
        pageNumber: 1,
      });

      const hiResCanvas = domEl!.querySelector<HTMLCanvasElement>('canvas.ink-template-hires');
      expect(hiResCanvas).toBeTruthy();
      expect(hiResCanvas!.style.opacity).toBe('1');
      expect(Number(hiResCanvas!.dataset.viewportWidth)).toBeGreaterThanOrEqual(4100);

      const badge = domEl!.querySelector<HTMLElement>('[data-testid="pdf-resolution-badge"]');
      expect(badge).toBeTruthy();
      expect(badge!.textContent).toContain('배율: 250%');
      expect(badge!.textContent).toContain('해상도:');
      expect(badge!.dataset.zoomPct).toBe('250');
    } finally {
      session.destroy();
    }

    expect(releaseSpy).toHaveBeenCalled();
  });

  it('5. pdfSrc가 누락된 기존 PDF 노트도 OPFS -source.pdf 폴백 탐색으로 고해상도 재렌더 경로를 복구한다', async () => {
    vi.useFakeTimers();

    const noteId = 'note-pdf-legacy-fallback';
    useSessions.getState().patch(noteId, { zoom: 2.0 });
    vi.mocked(listNoteAttachments).mockResolvedValueOnce([
      { relPath: 'attachments/legacy-p1.png', name: 'legacy-p1.png', blob: new Blob(['png']) },
      { relPath: 'attachments/legacy-source.pdf', name: 'legacy-source.pdf', blob: new Blob(['pdf']) },
    ]);

    const renderSpy = vi.spyOn(pdfZoomRenderer, 'renderPageHiRes').mockImplementation(async ({ canvas, targetScale }) => {
      const plan = computePdfTilePlan(595 * targetScale, 842 * targetScale);
      canvas.width = plan.canvasWidth;
      canvas.height = plan.canvasHeight;
      return { rendered: true, scale: targetScale, plan };
    });

    const note = emptyNote({
      id: noteId,
      title: '레거시 PDF 폴백',
      content: {
        type: 'doc',
        content: [
          {
            type: 'inkTemplate',
            attrs: {
              src: 'attachments/legacy-p1.png',
              width: 595,
              height: 842,
              page: 1,
            },
          },
        ],
      },
    });

    const session = new NoteSession(note);
    try {
      const domEl = session.host.querySelector<HTMLElement>('[data-ink-template]');
      Object.defineProperty(domEl!, 'clientWidth', { value: 840, configurable: true });
      vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(2.0);

      // ResizeObserver/마운트 시점 줌 변경 -> 폴백 OPFS PDF 발견 후 재렌더
      useSessions.getState().patch(noteId, { zoom: 2.4 });
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(PDF_ZOOM_RERENDER_DEBOUNCE_MS + 30);
      await Promise.resolve();

      expect(domEl!.dataset.pdfSrc).toBe('attachments/legacy-source.pdf');
      expect(renderSpy).toHaveBeenCalledTimes(1);
    } finally {
      session.destroy();
    }
  });
});
