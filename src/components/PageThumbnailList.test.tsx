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
});
