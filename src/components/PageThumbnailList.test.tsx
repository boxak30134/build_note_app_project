// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { extractPageItems, PageThumbnailList } from './PageThumbnailList';
import type { NoteSession } from '../session/NoteSession';
import { createPage } from '../core/page/pageTypes';

describe('PageThumbnailList & Page Navigation', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('40페이지의 inkTemplate 노드를 가진 PDF 문서에서 40개의 페이지 항목을 정확히 추출한다', () => {
    const fakeContent = {
      type: 'doc',
      content: Array.from({ length: 40 }, (_, i) => ({
        type: 'inkTemplate',
        attrs: {
          src: `test-pdf-p${i + 1}.png`,
          width: 595,
          height: 842,
          page: i + 1,
        },
      })),
    };

    const mockSession = {
      id: 'note-pdf-40',
      record: {
        id: 'note-pdf-40',
        title: '대수학 강의록 40p.pdf',
        content: fakeContent,
      },
      ui: {
        pages: [],
        currentPageIndex: 0,
      },
    } as unknown as NoteSession;

    const items = extractPageItems(mockSession);
    expect(items.length).toBe(40);
    expect(items[0].pageNumber).toBe(1);
    expect(items[0].templateSrc).toBe('test-pdf-p1.png');
    expect(items[39].pageNumber).toBe(40);
    expect(items[39].templateSrc).toBe('test-pdf-p40.png');
  });

  it('PDF가 아닌 일반 멀티페이지 문서에서는 ui.pages 기준으로 페이지 항목을 추출한다', () => {
    const mockSession = {
      id: 'note-regular',
      record: {
        id: 'note-regular',
        title: '수학 노트',
        content: { type: 'doc', content: [{ type: 'paragraph' }] },
      },
      ui: {
        pages: [
          createPage({ size: 'A4', style: 'grid' }),
          createPage({ size: 'A3', style: 'lined' }),
          createPage({ size: 'A4', style: 'plain' }),
        ],
        currentPageIndex: 1,
      },
    } as unknown as NoteSession;

    const items = extractPageItems(mockSession);
    expect(items.length).toBe(3);
    expect(items[0].pageNumber).toBe(1);
    expect(items[0].style).toBe('grid');
    expect(items[1].pageNumber).toBe(2);
    expect(items[1].style).toBe('lined');
  });

  it('PageThumbnailList 렌더링 시 40페이지 썸네일과 총 40페이지 카운터를 표시하고, 클릭 시 scrollToPage를 즉시 호출한다', () => {
    const scrollToPageMock = vi.fn();
    const fakeContent = {
      type: 'doc',
      content: Array.from({ length: 40 }, (_, i) => ({
        type: 'inkTemplate',
        attrs: {
          src: `lecture-p${i + 1}.png`,
          width: 595,
          height: 842,
          page: i + 1,
        },
      })),
    };

    const mockSession = {
      id: 'note-pdf-40',
      record: {
        id: 'note-pdf-40',
        title: '미적분학 40p.pdf',
        content: fakeContent,
      },
      ui: {
        pages: Array.from({ length: 40 }, () => createPage()),
        currentPageIndex: 4, // 5번째 페이지 활성
      },
      scrollToPage: scrollToPageMock,
    } as unknown as NoteSession;

    render(<PageThumbnailList session={mockSession} />);

    // 총 40페이지 카운터 확인
    expect(screen.getByText('총 40페이지')).toBeDefined();

    // 1페이지 및 40페이지 썸네일 확인
    const thumb1 = screen.getByTestId('page-thumbnail-1');
    const thumb25 = screen.getByTestId('page-thumbnail-25');
    const thumb40 = screen.getByTestId('page-thumbnail-40');
    expect(thumb1).toBeDefined();
    expect(thumb25).toBeDefined();
    expect(thumb40).toBeDefined();

    // 5번째 페이지(pageNumber 5) 활성 상태 확인
    const thumb5 = screen.getByTestId('page-thumbnail-5');
    expect(thumb5.getAttribute('data-active')).toBe('true');
    expect(thumb1.getAttribute('data-active')).toBe('false');

    // 25페이지 클릭 시 scrollToPage(24) 호출 확인 (스크롤 없이 바로 이동)
    fireEvent.click(thumb25);
    expect(scrollToPageMock).toHaveBeenCalledWith(24);
  });

  it('헤더의 [+ 추가] 버튼 클릭 시 현재 페이지 아래에 새 페이지를 추가한다', () => {
    const addPageBelowMock = vi.fn().mockReturnValue({ size: 'A4' });
    const mockSession = {
      id: 'note-regular',
      record: {
        id: 'note-regular',
        title: '테스트 노트',
        content: { type: 'doc', content: [] },
      },
      ui: {
        pages: [createPage(), createPage()],
        currentPageIndex: 0,
      },
      addPageBelow: addPageBelowMock,
    } as unknown as NoteSession;

    render(<PageThumbnailList session={mockSession} />);
    const addHeaderBtn = screen.getByTestId('add-page-header-btn');
    fireEvent.click(addHeaderBtn);
    expect(addPageBelowMock).toHaveBeenCalledWith(0);
  });

  it('썸네일 카드의 [+ 아래에 추가] 및 [삭제] 확인 오버레이를 통해 페이지를 생성/삭제할 수 있다', () => {
    const addPageBelowMock = vi.fn().mockReturnValue({ size: 'A4' });
    const deletePageMock = vi.fn().mockReturnValue(true);
    const mockSession = {
      id: 'note-multi',
      record: {
        id: 'note-multi',
        title: '다중 페이지 노트',
        content: { type: 'doc', content: [] },
      },
      ui: {
        pages: [createPage(), createPage(), createPage()],
        currentPageIndex: 1,
      },
      addPageBelow: addPageBelowMock,
      deletePage: deletePageMock,
    } as unknown as NoteSession;

    render(<PageThumbnailList session={mockSession} />);

    // 2쪽 아래에 페이지 추가 버튼 클릭
    const addBtn2 = screen.getByTestId('add-page-below-thumb-2');
    fireEvent.click(addBtn2);
    expect(addPageBelowMock).toHaveBeenCalledWith(1);

    // 2쪽 삭제 버튼 클릭 -> 확인 오버레이 노출
    const deleteBtn2 = screen.getByTestId('delete-page-2');
    fireEvent.click(deleteBtn2);
    const confirmOverlay = screen.getByTestId('delete-confirm-overlay-2');
    expect(confirmOverlay).toBeDefined();

    // 확인 오버레이에서 삭제 확정
    const confirmBtn = screen.getByTestId('confirm-delete-page-2');
    fireEvent.click(confirmBtn);
    expect(deletePageMock).toHaveBeenCalledWith(1);
  });

  it('단 1개의 페이지만 있는 경우 삭제 버튼이 비활성화(disabled)된다', () => {
    const mockSession = {
      id: 'note-single',
      record: {
        id: 'note-single',
        title: '단일 페이지 노트',
        content: { type: 'doc', content: [] },
      },
      ui: {
        pages: [createPage()],
        currentPageIndex: 0,
      },
    } as unknown as NoteSession;

    render(<PageThumbnailList session={mockSession} />);
    const deleteBtn1 = screen.getByTestId('delete-page-1') as HTMLButtonElement;
    expect(deleteBtn1.disabled).toBe(true);
    // 하단 바의 중복 휴지통 버튼은 완전히 제거되었음을 검증
    expect(screen.queryByTestId('delete-page-bar-1')).toBeNull();
  });

  it('상단 퀵 액션 삭제 버튼 클릭 시 삭제 확인 오버레이가 정상 노출되고 하단 바에는 중복 삭제 버튼이 없다', () => {
    const mockSession = {
      id: 'note-multi-bar',
      record: {
        id: 'note-multi-bar',
        title: '다중 페이지 노트',
        content: { type: 'doc', content: [] },
      },
      ui: {
        pages: [createPage(), createPage()],
        currentPageIndex: 0,
      },
      deletePage: vi.fn(),
    } as unknown as NoteSession;

    render(<PageThumbnailList session={mockSession} />);
    // 하단 바에는 휴지통이 존재하지 않음
    expect(screen.queryByTestId('delete-page-bar-2')).toBeNull();

    // 상단 퀵 액션 삭제 버튼 클릭
    const deleteBtn2 = screen.getByTestId('delete-page-2');
    fireEvent.click(deleteBtn2);

    expect(screen.getByTestId('delete-confirm-overlay-2')).toBeDefined();
  });

  it('3쪽 클릭 시 navigateToPage(2)를 1회 호출하고 하이라이트가 즉시 3쪽으로 반영된다', () => {
    const navigateToPageMock = vi.fn();
    const mockSession = {
      id: 'note-nav-test',
      record: {
        id: 'note-nav-test',
        title: '3페이지 테스트',
        content: { type: 'doc', content: [] },
      },
      ui: {
        pages: [createPage(), createPage(), createPage()],
        currentPageIndex: 2, // navigateToPage 호출 시 2로 변경
      },
      navigateToPage: navigateToPageMock,
    } as unknown as NoteSession;

    render(<PageThumbnailList session={mockSession} />);
    const thumb3 = screen.getByTestId('page-thumbnail-3');
    fireEvent.click(thumb3);

    expect(navigateToPageMock).toHaveBeenCalledTimes(1);
    expect(navigateToPageMock).toHaveBeenCalledWith(2);
    expect(thumb3.getAttribute('data-active')).toBe('true');
  });
});
