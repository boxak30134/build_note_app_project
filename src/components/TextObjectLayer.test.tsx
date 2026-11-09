// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { TextObjectLayer, resolvePageAndLocalCoords } from './TextObjectLayer';
import type { NoteSession } from '../session/NoteSession';
import { createPage } from '../core/page/pageTypes';

describe('TextObjectLayer Component & Direct-to-Note UX', () => {
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
      recordTextAdd: vi.fn(),
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

    expect(updateTextObjectMock).toHaveBeenCalledWith(
      'txt-comp-1',
      { text: '화학 반응식 (수정완료)' },
      true
    );
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
      recordTextAdd: vi.fn(),
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
      recordTextAdd: vi.fn(),
    } as unknown as NoteSession;

    render(<TextObjectLayer session={mockSession} activeTool="none" />);
    const textEl = screen.getByTestId('text-object-txt-comp-del');
    fireEvent.click(textEl);

    const textarea = screen.getByTestId('text-object-input-txt-comp-del');
    fireEvent.change(textarea, { target: { value: '   ' } }); // 공백만 입력
    fireEvent.blur(textarea);

    expect(deleteTextObjectMock).toHaveBeenCalledWith('txt-comp-del', true);
  });

  describe('resolvePageAndLocalCoords 좌표 변환 정밀도', () => {
    it('다중 페이지 및 줌(1.5x) 상태에서 터치한 clientX, clientY로부터 정확한 pageId와 로컬 좌표를 역산한다', () => {
      const container = document.createElement('div');
      container.dataset.zoom = '1.5';

      // 1페이지 (Y: 0 ~ 500)
      const page1El = document.createElement('div');
      page1El.dataset.inkTemplate = '';
      page1El.dataset.page = '1';
      vi.spyOn(page1El, 'getBoundingClientRect').mockReturnValue({
        left: 100,
        top: 0,
        right: 700,
        bottom: 500,
        width: 600,
        height: 500,
        x: 100,
        y: 0,
        toJSON: () => {},
      });

      // 2페이지 (Y: 520 ~ 1020)
      const page2El = document.createElement('div');
      page2El.dataset.inkTemplate = '';
      page2El.dataset.page = '2';
      vi.spyOn(page2El, 'getBoundingClientRect').mockReturnValue({
        left: 100,
        top: 520,
        right: 700,
        bottom: 1020,
        width: 600,
        height: 500,
        x: 100,
        y: 520,
        toJSON: () => {},
      });

      container.appendChild(page1El);
      container.appendChild(page2El);

      const p1 = createPage({ size: 'A4' });
      const p2 = createPage({ size: 'A4' });

      // 2페이지 중앙 터치 (clientX: 250, clientY: 700)
      const resolved = resolvePageAndLocalCoords(container, [p1, p2], 250, 700, 0);
      expect(resolved).not.toBeNull();
      expect(resolved!.page.id).toBe(p2.id);

      // 로컬 X = (250 - 100) / 1.5 = 100px
      expect(resolved!.localX).toBe(100);
      // 로컬 Y = (700 - 520) / 1.5 = 120px
      expect(resolved!.localY).toBe(120);
    });
  });

  describe('PDF Import 문서 1순위 Direct Hit-Test 및 [PDF_TEXT_CLICK] 진단 로그', () => {
    it('PDF 1페이지, 2페이지, 마지막 페이지 각각 상단과 중앙 클릭 시 targetEl로부터 정확한 pageId와 로컬 좌표가 1순위로 식별된다', () => {
      const container = document.createElement('div');
      container.dataset.zoom = '1';
      vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({
        left: 50,
        top: 0,
        right: 890,
        bottom: 3000,
        width: 840,
        height: 3000,
        x: 50,
        y: 0,
        toJSON: () => {},
      });

      const p1 = createPage({ size: 'A4' });
      const p2 = createPage({ size: 'A4' });
      const p3 = createPage({ size: 'A4' });

      // 1페이지 템플릿 (Y: 0 ~ 842)
      const page1El = document.createElement('div');
      page1El.id = 'pdf-page-1';
      page1El.className = 'ink-template';
      page1El.dataset.page = '1';
      const img1 = document.createElement('img');
      page1El.appendChild(img1);
      vi.spyOn(page1El, 'getBoundingClientRect').mockReturnValue({
        left: 50,
        top: 0,
        right: 890,
        bottom: 842,
        width: 840,
        height: 842,
        x: 50,
        y: 0,
        toJSON: () => {},
      });

      // 2페이지 템플릿 (Y: 866 ~ 1708)
      const page2El = document.createElement('div');
      page2El.id = 'pdf-page-2';
      page2El.className = 'ink-template';
      page2El.dataset.page = '2';
      const img2 = document.createElement('img');
      page2El.appendChild(img2);
      vi.spyOn(page2El, 'getBoundingClientRect').mockReturnValue({
        left: 50,
        top: 866,
        right: 890,
        bottom: 1708,
        width: 840,
        height: 842,
        x: 50,
        y: 866,
        toJSON: () => {},
      });

      // 3페이지(마지막) 템플릿 (Y: 1732 ~ 2574)
      const page3El = document.createElement('div');
      page3El.id = 'pdf-page-3';
      page3El.className = 'ink-template';
      page3El.dataset.page = '3';
      const img3 = document.createElement('img');
      page3El.appendChild(img3);
      vi.spyOn(page3El, 'getBoundingClientRect').mockReturnValue({
        left: 50,
        top: 1732,
        right: 890,
        bottom: 2574,
        width: 840,
        height: 842,
        x: 50,
        y: 1732,
        toJSON: () => {},
      });

      container.appendChild(page1El);
      container.appendChild(page2El);
      container.appendChild(page3El);

      // 1. 1페이지 상단 클릭 (clientY: 50, img1 터치)
      const r1Top = resolvePageAndLocalCoords(container, [p1, p2, p3], 150, 50, 0, img1);
      expect(r1Top).not.toBeNull();
      expect(r1Top!.page.id).toBe(p1.id);
      expect(r1Top!.pageIndex).toBe(0);
      expect(r1Top!.localX).toBe(100); // 150 - 50
      expect(r1Top!.localY).toBe(50); // 50 - 0
      expect(r1Top!.pageOffsetTop).toBe(0);

      // 2. 2페이지 중앙 클릭 (clientY: 1287, img2 터치)
      const r2Center = resolvePageAndLocalCoords(container, [p1, p2, p3], 470, 1287, 0, img2);
      expect(r2Center).not.toBeNull();
      expect(r2Center!.page.id).toBe(p2.id);
      expect(r2Center!.pageIndex).toBe(1);
      expect(r2Center!.localX).toBe(420); // 470 - 50
      expect(r2Center!.localY).toBe(421); // 1287 - 866 = 421
      expect(r2Center!.pageOffsetTop).toBe(866);

      // 3. 3페이지(마지막) 상단 클릭 (clientY: 1782, img3 터치)
      const r3Top = resolvePageAndLocalCoords(container, [p1, p2, p3], 200, 1782, 0, img3);
      expect(r3Top).not.toBeNull();
      expect(r3Top!.page.id).toBe(p3.id);
      expect(r3Top!.pageIndex).toBe(2);
      expect(r3Top!.localX).toBe(150); // 200 - 50
      expect(r3Top!.localY).toBe(50); // 1782 - 1732 = 50
      expect(r3Top!.pageOffsetTop).toBe(1732);
    });

    it('페이지 식별이 완전히 불가능한 경우 [PDF_PAGE_RESOLUTION_FAILED] 경고를 출력하고 null을 반환한다', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const container = document.createElement('div');
      container.dataset.zoom = '1';

      const res = resolvePageAndLocalCoords(container, [], 100, 100);
      expect(res).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(
        '[PDF_PAGE_RESOLUTION_FAILED]',
        expect.objectContaining({ reason: 'pages array is empty' })
      );
    });

    it('PDF 페이지 터치 시 14대 필수 진단 로그 [PDF_TEXT_CLICK]가 출력된다', () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const p1 = createPage({ size: 'A4' });

      const mockSession = {
        id: 'note-pdf-log-test',
        pageEl: mockPageEl,
        scrollEl: document.createElement('div'),
        editor: { on: vi.fn(), off: vi.fn() },
        ui: {
          pages: [p1],
          currentPageIndex: 0,
          textObjects: [],
        },
        addTextObject: vi.fn().mockReturnValue({ id: 'txt-log-1', pageId: p1.id, text: '' }),
        updateTextObject: vi.fn(),
        recordTextAdd: vi.fn(),
        deleteTextObject: vi.fn(),
      } as unknown as NoteSession;

      render(<TextObjectLayer session={mockSession} activeTool="none" />);

      const pdfPageEl = mockPageEl.querySelector('#pdf-page-1')!;
      fireEvent.pointerDown(pdfPageEl, { clientX: 200, clientY: 300 });

      expect(logSpy).toHaveBeenCalledWith(
        '[PDF_TEXT_CLICK]',
        expect.objectContaining({
          eventTarget: pdfPageEl,
          clientX: 200,
          clientY: 300,
          resolvedPageId: p1.id,
          pageIndex: 0,
          calculatedLocalX: expect.any(Number),
          calculatedLocalY: expect.any(Number),
          finalTextInputTop: expect.any(Number),
          finalTextInputLeft: expect.any(Number),
        })
      );
    });
  });

  describe('Direct-to-Note 인라인 타이핑 및 상자형 UI 제거', () => {
    it('텍스트 도구 상태에서 노트를 터치하면 별도 상자 없이 즉시 투명 textarea가 활성화되고 입력 완료 시 단일 Undo 트랜잭션이 등록된다', () => {
      const p1 = createPage({ size: 'A4' });
      const addTextObjectMock = vi.fn().mockImplementation((obj) => ({
        ...obj,
        id: 'txt-direct-1',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }));
      const updateTextObjectMock = vi.fn();
      const recordTextAddMock = vi.fn();
      const deleteTextObjectMock = vi.fn();

      const mockSession = {
        id: 'note-text-direct',
        pageEl: mockPageEl,
        scrollEl: document.createElement('div'),
        editor: { on: vi.fn(), off: vi.fn() },
        ui: {
          pages: [p1],
          currentPageIndex: 0,
          textObjects: [],
        },
        addTextObject: addTextObjectMock,
        updateTextObject: updateTextObjectMock,
        recordTextAdd: recordTextAddMock,
        deleteTextObject: deleteTextObjectMock,
      } as unknown as NoteSession;

      const { rerender } = render(<TextObjectLayer session={mockSession} activeTool="none" />);

      // 노트 영역 pointerdown 터치
      fireEvent.pointerDown(mockPageEl, { clientX: 200, clientY: 300 });

      // 1. addTextObject 가 recordHistory = false 로 즉시 호출되었는지 확인
      expect(addTextObjectMock).toHaveBeenCalledWith(
        expect.objectContaining({
          pageId: p1.id,
          text: '',
        }),
        false
      );

      // 세션 UI에 새로 생성된 텍스트 객체 반영 시뮬레이션
      const createdObj = {
        id: 'txt-direct-1',
        pageId: p1.id,
        x: 200,
        y: 300,
        text: '',
        fontSize: 16,
        color: '#1e293b',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      (mockSession.ui as { textObjects: unknown[] }).textObjects = [createdObj];
      rerender(<TextObjectLayer session={mockSession} activeTool="none" />);

      // 2. 렌더링된 textarea 스타일 확인 (박스형 테두리나 배경 없음)
      const textarea = screen.getByTestId('text-object-input-txt-direct-1') as HTMLTextAreaElement;
      expect(textarea).toBeDefined();
      expect(textarea.className).toContain('bg-transparent');
      expect(textarea.className).toContain('border-none');
      expect(textarea.className).not.toContain('shadow-md');
      expect(textarea.className).not.toContain('border-indigo-400');

      // 3. 텍스트 입력 및 blur
      fireEvent.change(textarea, { target: { value: '한글 Direct 인라인 타이핑' } });
      fireEvent.blur(textarea);

      // 4. 단일 text-add 히스토리 푸시 확인
      expect(recordTextAddMock).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'txt-direct-1',
          text: '한글 Direct 인라인 타이핑',
        })
      );
    });

    it('터치 후 텍스트를 입력하지 않고 다른 곳을 탭(blur)하면 빈 객체는 히스토리 없이 무음 삭제된다', () => {
      const p1 = createPage({ size: 'A4' });
      const addTextObjectMock = vi.fn().mockImplementation((obj) => ({
        ...obj,
        id: 'txt-cancel-1',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }));
      const deleteTextObjectMock = vi.fn();
      const recordTextAddMock = vi.fn();

      const mockSession = {
        id: 'note-text-cancel',
        pageEl: mockPageEl,
        scrollEl: document.createElement('div'),
        editor: { on: vi.fn(), off: vi.fn() },
        ui: {
          pages: [p1],
          currentPageIndex: 0,
          textObjects: [],
        },
        addTextObject: addTextObjectMock,
        updateTextObject: vi.fn(),
        recordTextAdd: recordTextAddMock,
        deleteTextObject: deleteTextObjectMock,
      } as unknown as NoteSession;

      const { rerender } = render(<TextObjectLayer session={mockSession} activeTool="none" />);

      fireEvent.pointerDown(mockPageEl, { clientX: 150, clientY: 250 });

      const createdObj = {
        id: 'txt-cancel-1',
        pageId: p1.id,
        x: 150,
        y: 250,
        text: '',
        fontSize: 16,
        color: '#1e293b',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      (mockSession.ui as { textObjects: unknown[] }).textObjects = [createdObj];
      rerender(<TextObjectLayer session={mockSession} activeTool="none" />);

      const textarea = screen.getByTestId('text-object-input-txt-cancel-1');
      // 아무것도 입력하지 않고 blur
      fireEvent.blur(textarea);

      // deleteTextObject 가 recordHistory = false 로 호출되어 무음 삭제
      expect(deleteTextObjectMock).toHaveBeenCalledWith('txt-cancel-1', false);
      expect(recordTextAddMock).not.toHaveBeenCalled();
    });
  });
});
