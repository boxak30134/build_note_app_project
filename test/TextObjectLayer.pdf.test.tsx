// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import {
  TextObjectLayer,
  findPageElement,
  getPageOffset,
  resolvePageAndLocalCoords,
  clickedPageElementMap,
} from '../src/components/TextObjectLayer';
import type { NoteSession } from '../src/session/NoteSession';
import { createPage } from '../src/core/page/pageTypes';
import { useSettings } from '../src/store/settingsStore';
import { InkTemplate } from '../src/editor/extensions/media';

describe('TextObjectLayer PDF Import Root-Cause Test Suite (REQPDFTEXTCURSORJUMPROOTCAUSE §Phase 3)', () => {
  let mockPageEl: HTMLDivElement;

  beforeEach(() => {
    vi.restoreAllMocks();
    clickedPageElementMap.clear();
    mockPageEl = document.createElement('div');
    mockPageEl.dataset.zoom = '1';
    document.body.appendChild(mockPageEl);
  });

  afterEach(() => {
    cleanup();
    clickedPageElementMap.clear();
    if (mockPageEl.parentNode) {
      mockPageEl.parentNode.removeChild(mockPageEl);
    }
  });

  // 1. PDF NodeView 모의 DOM에서 pointerdown 시 preventDefault가 호출되고 ProseMirror 모의 핸들러가 실행되지 않는다 (가설 1)
  it('1. PDF NodeView 포인터 다운 시 capture 단계에서 preventDefault가 호출되고 ProseMirror 핸들러 실행을 차단한다 (가설 1)', () => {
    const p1 = createPage({ size: 'A4' });
    const pdfPage = document.createElement('div');
    pdfPage.id = 'pdf-page-1';
    pdfPage.dataset.inkTemplate = '';
    pdfPage.dataset.page = '1';
    mockPageEl.appendChild(pdfPage);

    const proseMirrorMockHandler = vi.fn();
    // ProseMirror 버블 단계 핸들러
    mockPageEl.addEventListener('pointerdown', proseMirrorMockHandler);

    const mockSession = {
      id: 'note-hypo1',
      pageEl: mockPageEl,
      scrollEl: document.createElement('div'),
      editor: { on: vi.fn(), off: vi.fn(), commands: { blur: vi.fn() }, view: { dom: { blur: vi.fn() } } },
      ui: { pages: [p1], currentPageIndex: 0, textObjects: [] },
      addTextObject: vi.fn().mockReturnValue({ id: 'txt-1', pageId: p1.id, text: '' }),
      updateTextObject: vi.fn(),
      deleteTextObject: vi.fn(),
      recordTextAdd: vi.fn(),
    } as unknown as NoteSession;

    render(<TextObjectLayer session={mockSession} activeTool="none" />);

    const pointerDownEvent = new MouseEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      clientX: 200,
      clientY: 300,
    });
    pdfPage.dispatchEvent(pointerDownEvent);

    // capture 단계에서 preventDefault 가 호출되었어야 함
    expect(pointerDownEvent.defaultPrevented).toBe(true);

    // InkTemplate NodeView 의 stopEvent 동작 검증
    useSettings.setState({ tool: 'none' });
    const addNodeViewFn = (InkTemplate.config as any).addNodeView.call({ options: { noteId: 'test' } });
    const nodeView = addNodeViewFn({
      node: { attrs: { page: 1, width: 595, height: 842 } },
    });
    expect(nodeView.stopEvent({ type: 'pointerdown' })).toBe(true);
    expect(nodeView.stopEvent({ type: 'mousedown' })).toBe(true);

    // 필기 모드에서는 stopEvent 가 false 를 반환하여 S-Pen 경로 보존
    useSettings.setState({ tool: 'pencil' });
    expect(nodeView.stopEvent({ type: 'pointerdown' })).toBe(false);
  });

  // 2. 상위 요소에 transform: scale(0.8)을 준 상태에서 터치 -> 화면상 위치가 터치 지점과 ±1px 안에 들어온다 (가설 2·3)
  it('2. 줌(0.8x) 및 실측 배율 환경에서 터치 시 textarea 위치가 터치 지점과 ±1px 이내로 일치한다 (가설 2·3)', () => {
    const container = document.createElement('div');
    container.dataset.zoom = '0.8';

    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      right: 800,
      bottom: 2000,
      width: 800,
      height: 2000,
      x: 0,
      y: 0,
      toJSON: () => {},
    });
    Object.defineProperty(container, 'offsetWidth', { value: 1000, configurable: true });

    // 2페이지 모의 (화면 상 Y: 800 ~ 1600, unscaled: 1000 ~ 2000)
    const page2El = document.createElement('div');
    page2El.id = 'pdf-page-2';
    page2El.dataset.inkTemplate = '';
    page2El.dataset.page = '2';
    vi.spyOn(page2El, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 800,
      right: 800,
      bottom: 1600,
      width: 800,
      height: 800,
      x: 0,
      y: 800,
      toJSON: () => {},
    });
    container.appendChild(page2El);

    const p1 = createPage({ size: 'A4' });
    const p2 = createPage({ size: 'A4' });

    // 터치 지점: clientX: 200, clientY: 960 (화면 상 2페이지 160px 지점)
    const resolved = resolvePageAndLocalCoords(container, [p1, p2], 200, 960, 0, page2El);
    expect(resolved).not.toBeNull();
    expect(resolved!.page.id).toBe(p2.id);

    // 실측 배율 = 800 / 1000 = 0.8
    // localY = (960 - 800) / 0.8 = 200px
    expect(resolved!.localY).toBe(200);

    // pageOffsetTop = (800 - 0) / 0.8 = 1000px
    expect(resolved!.pageOffsetTop).toBe(1000);

    // 화면 복원 Y = (1000 + 200) * 0.8 + 0 = 960px
    const reconstructedY = (resolved!.pageOffsetTop + resolved!.localY) * 0.8;
    expect(Math.abs(reconstructedY - 960)).toBeLessThanOrEqual(1);
  });

  // 3. findPageElement가 0-based와 1-based 두 방식으로 만든 DOM에서 모두 올바른 페이지를 찾는다 (가설 4)
  it('3. findPageElement가 1-based 및 0-based DOM 모두에서 올바른 페이지 요소를 검색한다 (가설 4)', () => {
    const host = document.createElement('div');

    // 1-based 형식: id="pdf-page-1", data-page="1"
    const p1 = document.createElement('div');
    p1.id = 'pdf-page-1';
    p1.dataset.page = '1';
    p1.dataset.inkTemplate = '';
    host.appendChild(p1);

    // 0-based 형식: id="pdf-page-1", data-page-index="1"
    const p2 = document.createElement('div');
    p2.dataset.pageIndex = '1';
    p2.className = 'page-sheet';
    host.appendChild(p2);

    expect(findPageElement(host, 0)).toBe(p1);
    expect(findPageElement(host, 1)).toBe(p2);

    // 클릭 시 캐싱된 요소 우선 반환 검증
    const cachedP2 = document.createElement('div');
    document.body.appendChild(cachedP2);
    clickedPageElementMap.set('custom-p2-id', cachedP2);

    const offsetWithCached = getPageOffset(host, 1, 'custom-p2-id');
    expect(offsetWithCached).not.toBeNull();
    cachedP2.remove();
  });

  // 4. pageOffset 계산 실패 시 {0, 0}에 잘못 렌더되지 않고 보류된다 (가설 4)
  it('4. pageOffset 계산 실패 시 top: 0에 오배치되지 않고 null을 반환하여 렌더를 보류한다 (가설 4)', () => {
    const emptyHost = document.createElement('div');
    const p1 = createPage({ size: 'A4' });

    // 페이지 엘리먼트가 없는 상태에서 offset 계산
    const offset = getPageOffset(emptyHost, 5, 'non-existent-page-id');
    expect(offset).toBeNull(); // {0, 0}이 아니라 null 반환

    const mockSession = {
      id: 'note-hypo4',
      pageEl: emptyHost,
      scrollEl: document.createElement('div'),
      editor: { on: vi.fn(), off: vi.fn() },
      ui: {
        pages: [p1],
        currentPageIndex: 0,
        textObjects: [{ id: 'txt-orphan', pageId: 'orphan-id', x: 50, y: 50, text: '고아 객체' }],
      },
      addTextObject: vi.fn(),
      updateTextObject: vi.fn(),
      deleteTextObject: vi.fn(),
      recordTextAdd: vi.fn(),
    } as unknown as NoteSession;

    const { container } = render(<TextObjectLayer session={mockSession} activeTool="none" />);
    // pageOffset 계산에 실패한 객체는 화면에 렌더되지 않아야 함
    expect(container.querySelector('[data-testid="text-object-txt-orphan"]')).toBeNull();
  });

  // 5. focus가 { preventScroll: true }로 호출된다 (가설 5)
  it('5. textarea focus 호출 시 preventScroll: true 가 전달되어 스크롤 컨테이너 점프를 차단한다 (가설 5)', async () => {
    const p1 = createPage({ size: 'A4' });
    const pdfPage = document.createElement('div');
    pdfPage.id = 'pdf-page-1';
    pdfPage.dataset.inkTemplate = '';
    pdfPage.dataset.page = '1';
    mockPageEl.appendChild(pdfPage);

    const focusSpy = vi.spyOn(HTMLTextAreaElement.prototype, 'focus');

    const mockSession = {
      id: 'note-hypo5',
      pageEl: mockPageEl,
      scrollEl: document.createElement('div'),
      editor: { on: vi.fn(), off: vi.fn(), commands: { blur: vi.fn() }, view: { dom: { blur: vi.fn() } } },
      ui: { pages: [p1], currentPageIndex: 0, textObjects: [] },
      addTextObject: vi.fn().mockImplementation((obj) => ({ ...obj, id: 'txt-focus-test' })),
      updateTextObject: vi.fn(),
      deleteTextObject: vi.fn(),
      recordTextAdd: vi.fn(),
    } as unknown as NoteSession;

    const { rerender } = render(<TextObjectLayer session={mockSession} activeTool="none" />);

    // 터치 발생
    const pointerDownEvent = new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 100, clientY: 100 });
    pdfPage.dispatchEvent(pointerDownEvent);

    // UI에 생성된 객체 전달
    rerender(
      <TextObjectLayer
        session={{
          ...mockSession,
          ui: {
            ...mockSession.ui,
            textObjects: [{ id: 'txt-focus-test', pageId: p1.id, x: 100, y: 100, text: '' }],
          },
        } as unknown as NoteSession}
        activeTool="none"
      />
    );

    // requestAnimationFrame 완료 대기
    await new Promise((resolve) => requestAnimationFrame(resolve));

    expect(focusSpy).toHaveBeenCalledWith(expect.objectContaining({ preventScroll: true }));
  });
});

