// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { TextObjectLayer } from './TextObjectLayer';
import type { NoteSession } from '../session/NoteSession';
import { createPage } from '../core/page/pageTypes';

describe('TextObjectLayer Component', () => {
  let mockPageEl: HTMLDivElement;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockPageEl = document.createElement('div');
    mockPageEl.dataset.zoom = '1';
    // 모의 PDF 템플릿 페이지 노드 추가
    const pdfPage = document.createElement('div');
    pdfPage.id = 'pdf-page-1';
    pdfPage.dataset.inkTemplate = '';
    pdfPage.dataset.page = '1';
    mockPageEl.appendChild(pdfPage);
    document.body.appendChild(mockPageEl);
  });

  afterEach(() => {
    cleanup();
    if (mockPageEl.parentNode) {
      mockPageEl.parentNode.removeChild(mockPageEl);
    }
  });

  it('activeTool이 none일 때 텍스트 객체를 탭하면 인라인 textarea가 노출되고 편집 완료 시 updateTextObject를 호출한다', () => {
    const updateTextObjectMock = vi.fn();
    const deleteTextObjectMock = vi.fn();
    const page1 = createPage({ size: 'A4' });

    const mockSession = {
      id: 'note-text-comp',
      pageEl: mockPageEl,
      scrollEl: document.createElement('div'),
      editor: {
        on: vi.fn(),
        off: vi.fn(),
      },
      ui: {
        pages: [page1],
        currentPageIndex: 0,
        textObjects: [
          {
            id: 'txt-comp-1',
            pageId: page1.id,
            x: 80,
            y: 120,
            text: '화학 반응식: 2H2 + O2 -> 2H2O',
            fontSize: 16,
            color: '#1e293b',
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        ],
      },
      updateTextObject: updateTextObjectMock,
      deleteTextObject: deleteTextObjectMock,
      addTextObject: vi.fn(),
    } as unknown as NoteSession;

    render(<TextObjectLayer session={mockSession} activeTool="none" />);

    // 1. 텍스트 요소가 렌더링되었는지 확인
    const textEl = screen.getByTestId('text-object-txt-comp-1');
    expect(textEl).toBeDefined();
    expect(textEl.className).toContain('pointer-events-auto');
    expect(screen.getByText('화학 반응식: 2H2 + O2 -> 2H2O')).toBeDefined();

    // 2. 클릭하여 편집 시작
    fireEvent.click(textEl);
    const textarea = screen.getByTestId('text-object-input-txt-comp-1') as HTMLTextAreaElement;
    expect(textarea).toBeDefined();
    expect(textarea.value).toBe('화학 반응식: 2H2 + O2 -> 2H2O');

    // 3. 내용 수정 후 blur
    fireEvent.change(textarea, { target: { value: '화학 반응식 (수정완료)' } });
    fireEvent.blur(textarea);

    expect(updateTextObjectMock).toHaveBeenCalledWith('txt-comp-1', {
      text: '화학 반응식 (수정완료)',
    });
  });

  it('activeTool이 pencil/highlighter/eraser/lasso일 때는 pointer-events-none이 적용되어 필기를 방해하지 않는다', () => {
    const page1 = createPage({ size: 'A4' });
    const mockSession = {
      id: 'note-text-comp-pen',
      pageEl: mockPageEl,
      scrollEl: document.createElement('div'),
      editor: { on: vi.fn(), off: vi.fn() },
      ui: {
        pages: [page1],
        currentPageIndex: 0,
        textObjects: [
          {
            id: 'txt-comp-pen',
            pageId: page1.id,
            x: 50,
            y: 50,
            text: '방해받지 않는 텍스트',
            fontSize: 16,
            color: '#000000',
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        ],
      },
      updateTextObject: vi.fn(),
      deleteTextObject: vi.fn(),
      addTextObject: vi.fn(),
    } as unknown as NoteSession;

    render(<TextObjectLayer session={mockSession} activeTool="pencil" />);
    const textEl = screen.getByTestId('text-object-txt-comp-pen');
    expect(textEl.className).toContain('pointer-events-none');
    expect(textEl.className).not.toContain('pointer-events-auto');
  });

  it('내용을 모두 지우고 blur할 경우 빈 텍스트 객체는 deleteTextObject로 자동 정리된다', () => {
    const deleteTextObjectMock = vi.fn();
    const page1 = createPage({ size: 'A4' });

    const mockSession = {
      id: 'note-text-comp-empty',
      pageEl: mockPageEl,
      scrollEl: document.createElement('div'),
      editor: { on: vi.fn(), off: vi.fn() },
      ui: {
        pages: [page1],
        currentPageIndex: 0,
        textObjects: [
          {
            id: 'txt-comp-del',
            pageId: page1.id,
            x: 30,
            y: 40,
            text: '삭제 대상 텍스트',
            fontSize: 14,
            color: '#000000',
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        ],
      },
      updateTextObject: vi.fn(),
      deleteTextObject: deleteTextObjectMock,
      addTextObject: vi.fn(),
    } as unknown as NoteSession;

    render(<TextObjectLayer session={mockSession} activeTool="none" />);
    const textEl = screen.getByTestId('text-object-txt-comp-del');
    fireEvent.click(textEl);

    const textarea = screen.getByTestId('text-object-input-txt-comp-del');
    fireEvent.change(textarea, { target: { value: '   ' } }); // 공백만 입력
    fireEvent.blur(textarea);

    expect(deleteTextObjectMock).toHaveBeenCalledWith('txt-comp-del');
  });
});

