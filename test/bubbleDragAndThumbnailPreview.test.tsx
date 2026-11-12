// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { OverlayLayer } from '../src/components/OverlayLayer';
import { PagePreviewCanvas, extractPageItems, PageThumbnailList } from '../src/components/PageThumbnailList';
import type { NoteSession } from '../src/session/NoteSession';
import type { Annotation } from '../src/features/annotations/types';
import type { Stroke } from '../src/core/strokes/StrokeStore';
import { createPage } from '../src/core/page/pageTypes';
import { setDeviceOverrideForTest } from '../src/core/utils/device';
import { resetGlobalPalmState } from '../src/core/android/androidDeployment';

describe('REQ_BUBBLE_DRAG_AND_PAGE_THUMBNAIL_PREVIEW: 말풍선 주석 드래그 및 페이지 썸네일 실시간 미리보기', () => {
  beforeEach(() => {
    cleanup();
    resetGlobalPalmState();
    setDeviceOverrideForTest(null);
    vi.restoreAllMocks();
  });

  afterEach(() => {
    cleanup();
    resetGlobalPalmState();
    setDeviceOverrideForTest(null);
  });

  describe('1. 말풍선 주석 아이콘(💬 Pin) 드래그 이동 & 클릭 분리', () => {
    function createMockSessionForOverlay(initialAnnotations: Annotation[]) {
      let annotations = [...initialAnnotations];
      let openAnnotationId: string | null = null;
      const EMPTY_STROKES_ARRAY: any[] = [];

      const mockSession = {
        id: 'overlay-test-note',
        ui: {
          zoom: 1.0,
          annotations,
          openAnnotationId,
          lassoIds: [],
          citations: [],
        },
        pageEl: {
          getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 1000, width: 800, height: 1000 }),
          querySelectorAll: vi.fn().mockReturnValue([]),
        } as unknown as HTMLElement,
        scrollEl: null,
        editor: {
          on: vi.fn(),
          off: vi.fn(),
        },
        strokes: {
          subscribe: () => () => {},
          getAll: () => EMPTY_STROKES_ARRAY,
          boundsOf: () => null,
        },
        updateAnnotation: vi.fn((id: string, partial: Partial<Annotation>) => {
          annotations = annotations.map((a) => (a.id === id ? { ...a, ...partial } : a));
          mockSession.ui.annotations = annotations;
        }),
        patch: vi.fn((p: Record<string, unknown>) => {
          if ('openAnnotationId' in p) {
            openAnnotationId = p.openAnnotationId as string | null;
            mockSession.ui.openAnnotationId = openAnnotationId;
          }
        }),
      } as unknown as NoteSession;

      return mockSession;
    }

    it('말풍선 핀을 4px 미만으로 클릭/탭하면 이동하지 않고 팝오버를 열거나 닫는다', () => {
      const ann: Annotation = {
        id: 'ann-1',
        anchor: { type: 'point', x: 100, y: 150 },
        body: '테스트 주석',
        turns: [],
        createdAt: Date.now(),
      };
      const session = createMockSessionForOverlay([ann]);

      render(<OverlayLayer session={session} />);

      const pinBtn = screen.getByTestId ? screen.getByText('💬') : screen.getByRole('button');
      expect(pinBtn).toBeDefined();

      // 단순 클릭 (이동 없음)
      act(() => {
        pinBtn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 100, clientY: 150, pointerId: 1 }));
        pinBtn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 101, clientY: 151, pointerId: 1 }));
        pinBtn.click();
      });

      // customPosition은 갱신되지 않고 openAnnotationId 토글 패치가 호출됨
      expect(session.updateAnnotation).not.toHaveBeenCalled();
      expect(session.patch).toHaveBeenCalledWith({ openAnnotationId: 'ann-1' });
    });

    it('말풍선 핀을 마우스/터치로 50px 드래그하면 customPosition이 새 위치로 저장되고 클릭 토글은 무시된다', () => {
      const ann: Annotation = {
        id: 'ann-drag',
        anchor: { type: 'point', x: 200, y: 300 },
        body: '드래그할 주석',
        turns: [],
        createdAt: Date.now(),
      };
      const session = createMockSessionForOverlay([ann]);

      render(<OverlayLayer session={session} />);

      const pinBtn = screen.getByText('💬');

      // pointerdown -> 50px 오른쪽, 30px 아래로 드래그 -> pointerup
      act(() => {
        pinBtn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 200, clientY: 300, pointerId: 1 }));
        pinBtn.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 250, clientY: 330, pointerId: 1 }));
        pinBtn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 250, clientY: 330, pointerId: 1 }));
        pinBtn.click(); // 드래그 종료 후 브라우저 click 이벤트 발생 모의
      });

      // 이동량 dx=50, dy=30이 반영되어 initial (x: 200, y: 300 - 14 = 286) -> (250, 316)
      expect(session.updateAnnotation).toHaveBeenCalledWith('ann-drag', {
        customPosition: { x: 250, y: 316 },
      });
      // 드래그 완료 시에는 팝오버 토글이 실행되지 않음
      expect(session.patch).not.toHaveBeenCalled();
    });

    it('customPosition이 설정된 주석은 앵커 재계산 없이 customPosition 위치에 핀을 렌더링한다', () => {
      const annWithCustom: Annotation = {
        id: 'ann-custom',
        anchor: { type: 'point', x: 0, y: 0 },
        customPosition: { x: 450, y: 550 },
        body: '커스텀 위치 주석',
        turns: [],
        createdAt: Date.now(),
      };
      const session = createMockSessionForOverlay([annWithCustom]);

      render(<OverlayLayer session={session} />);

      const pinBtn = screen.getByText('💬');
      expect(pinBtn.style.left).toBe('450px');
      expect(pinBtn.style.top).toBe('550px');
    });
  });

  describe('2. 사용자 생성 일반 페이지 실시간 미리보기 (PagePreviewCanvas)', () => {
    function createMockSessionForPreview(options?: {
      html?: string;
      strokes?: Stroke[];
      pagesCount?: number;
    }) {
      const pages = Array.from({ length: options?.pagesCount ?? 2 }, (_, i) =>
        createPage({ size: 'A4', style: i === 0 ? 'ruled' : 'grid' })
      );

      const fakeStrokes = options?.strokes ?? [
        {
          id: 'stroke-1',
          penType: 'pencil',
          color: '#000000',
          width: 3,
          points: [
            [100, 200, 0.5],
            [120, 250, 0.6],
            [150, 300, 0.5],
          ],
          createdAt: Date.now(),
        } as Stroke,
        {
          id: 'stroke-p2',
          penType: 'highlighter',
          color: '#facc15',
          width: 12,
          points: [
            [100, 1300, 0.5],
            [200, 1300, 0.5],
          ],
          createdAt: Date.now(),
        } as Stroke,
      ];

      const html = options?.html ?? '<h2>제목 1</h2><p>본문 내용 첫 번째 줄</p>';

      const session = {
        id: 'preview-test-note',
        record: {
          id: 'preview-test-note',
          title: '일반 사용자 페이지',
          content: { type: 'doc', content: [] },
        },
        ui: {
          pages,
          currentPageIndex: 0,
        },
        editor: {
          getHTML: () => html,
          on: vi.fn(),
          off: vi.fn(),
        },
        strokes: {
          subscribe: vi.fn(() => () => {}),
          getAll: vi.fn(() => fakeStrokes),
        },
      } as unknown as NoteSession;

      return session;
    }

    it('일반 페이지에서 텍스트 및 용지 스타일이 PagePreviewCanvas에 정상 반영된다', () => {
      const session = createMockSessionForPreview({
        html: '<h3>강의 노트 요약</h3><p>중요한 수식 유도</p>',
      });
      const items = extractPageItems(session);

      render(<PagePreviewCanvas session={session} pageIndex={0} item={items[0]} />);

      const previewContainer = screen.getByTestId('page-preview-canvas-1');
      expect(previewContainer).toBeDefined();
      expect(previewContainer.className).toContain('page-style-ruled');

      // 텍스트 축소 레이어에 HTML 내용이 포함되어 렌더링됨
      expect(previewContainer.innerHTML).toContain('강의 노트 요약');
      expect(previewContainer.innerHTML).toContain('중요한 수식 유도');
    });

    it('2페이지 썸네일에서는 Y축 오프셋이 적용되고 2페이지 스타일(grid)이 반영된다', () => {
      const session = createMockSessionForPreview();
      const items = extractPageItems(session);

      render(<PagePreviewCanvas session={session} pageIndex={1} item={items[1]} />);

      const previewContainer = screen.getByTestId('page-preview-canvas-2');
      expect(previewContainer).toBeDefined();
      expect(previewContainer.className).toContain('page-style-grid');

      // A4 portrait 높이(1188px)만큼 translateY(-1188px)로 오프셋 이동됨
      const textWrapper = previewContainer.querySelector('.prose') as HTMLElement;
      expect(textWrapper?.style.transform).toContain('translateY(-1188px)');
    });

    it('PageThumbnailList에서 일반 생성 페이지들이 PagePreviewCanvas로 렌더링된다', () => {
      const session = createMockSessionForPreview({ pagesCount: 2 });

      render(<PageThumbnailList session={session} />);

      // 1페이지와 2페이지 모두 canvas 미리보기가 정상 렌더링됨
      expect(screen.getByTestId('page-preview-canvas-1')).toBeDefined();
      expect(screen.getByTestId('page-preview-canvas-2')).toBeDefined();
    });
  });
});
