// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_TEMPLATE_PX, TEMPLATE_SCALE } from '../src/features/import/pdfImport';
import { assemblePdfImportResult } from '../src/features/import/importer';
import type { PdfImportResult } from '../src/features/import/pdfImport';
import {
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

  it('2. zoom × DPR 기반 목표 배율 계산(GPU 4096px 상한) 및 15% 임계값 판정이 정확하다', () => {
    // 1.0x zoom, 1.0 DPR -> 840 / 595 = 1.41 -> MIN 1.5x (초기 2.0x PNG로 충분)
    const lowScale = computeTargetPdfScale(595, 842, 840, 1.0, 1.0);
    expect(lowScale).toBeCloseTo(1.5, 2);
    expect(shouldRerenderForZoom(0, lowScale, false)).toBe(false);

    // 2.0x zoom, 2.0 DPR -> 840 * 2 * 2 / 595 = 5.64 -> MAX_PDF_RERENDER_DIM / 842 = 4.864x 로 GPU 상한 클램프
    const zoomedScale = computeTargetPdfScale(595, 842, 840, 2.0, 2.0);
    expect(zoomedScale).toBeCloseTo(MAX_PDF_RERENDER_DIM / 842, 2);
    expect(shouldRerenderForZoom(0, zoomedScale, false)).toBe(true);

    // 이미 3.0x로 렌더된 상태에서 미세 변화(3.1x, ~3%)는 재렌더 생략, 3.6x(+20%)는 재렌더 트리거
    expect(shouldRerenderForZoom(3.0, 3.1, true)).toBe(false);
    expect(shouldRerenderForZoom(3.0, 3.6, true)).toBe(true);
  });

  it('3. 동일 페이지 연속 줌 변경 시 이전 renderTask를 즉시 취소하고, 6페이지 초과 시 LRU로 캔버스 메모리를 해제한다', async () => {
    const cancelSpy = vi.fn();
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
        render: ({ canvas }: { canvas: HTMLCanvasElement }) => {
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
    // page.render()가 실제로 시작된 뒤 새 줌 배율로 재요청 -> 이전 renderTask.cancel() 보장
    await firstRenderStarted;
    const p2 = renderer.renderPageHiRes({
      key: 'n1::doc.pdf::1',
      noteId: 'n1',
      pdfSrc: 'doc.pdf',
      pageNumber: 1,
      canvas: c1,
      targetScale: 3.5,
    });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(cancelSpy).toHaveBeenCalledTimes(1);
    expect(r1.rendered).toBe(false);
    expect(r2).toEqual({ rendered: true, scale: 3.5 });

    // LRU 상한(6페이지) 초과 검증: 7개 페이지 렌더 시 가장 오래된 c1 캔버스가 width=0, height=0 으로 해제
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

  it('4. InkTemplate NodeView가 확대(zoom) 150ms 디바운스 후 고해상도 캔버스를 활성화하고 destroy 시 정리한다', async () => {
    vi.useFakeTimers();

    const noteId = 'note-pdf-nodeview-zoom';
    useSessions.getState().patch(noteId, { zoom: 1.0 });

    const renderSpy = vi.spyOn(pdfZoomRenderer, 'renderPageHiRes').mockImplementation(async ({ canvas, targetScale }) => {
      canvas.width = 1800;
      canvas.height = 2500;
      return { rendered: true, scale: targetScale };
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

      // 줌을 2.2x로 확대 -> 150ms 디바운스 후 renderPageHiRes 호출 및 hiResCanvas 표시
      useSessions.getState().patch(noteId, { zoom: 2.2 });
      expect(renderSpy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(PDF_ZOOM_RERENDER_DEBOUNCE_MS + 20);
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
    } finally {
      session.destroy();
    }

    expect(releaseSpy).toHaveBeenCalled();
  });
});
