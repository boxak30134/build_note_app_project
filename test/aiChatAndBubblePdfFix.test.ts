// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { useAiChatStore, aiChatAbortManager } from '../src/store/aiChatStore';
import { NoteSession } from '../src/session/NoteSession';
import { emptyNote } from '../src/storage/db';
import { createPage } from '../src/core/page/pageTypes';

describe('REQ_AI_CHAT_AND_PDF_BUBBLE_FIX: AI 패널 대화 내역 영구 보존 및 PDF 문서 말풍선 주석 스크롤 튐 방지', () => {
  beforeEach(() => {
    localStorage.clear();
    useAiChatStore.getState().clearMessages();
    useAiChatStore.setState({ inputDraft: '', busy: false, statusInfo: { status: 'idle' } });
  });

  describe('1. AI 패널 대화 내역 영구 보존 및 명시적 초기화 (useAiChatStore)', () => {
    it('메시지를 추가하면 store에 누적되고 localStorage에 persist 된다', () => {
      const store = useAiChatStore.getState();
      store.appendMessage({ role: 'user', content: '선형대수 고유값 질문' });
      store.appendMessage({ role: 'assistant', content: '고유값은 Ax = λx 를 만족하는 스칼라 λ 입니다.' });

      expect(useAiChatStore.getState().messages).toHaveLength(2);
      expect(useAiChatStore.getState().messages[0].content).toBe('선형대수 고유값 질문');
      expect(useAiChatStore.getState().messages[1].content).toContain('Ax = λx');

      // localStorage persist 확인
      const rawStored = localStorage.getItem('eduink-ai-chat-history');
      expect(rawStored).toBeTruthy();
      const parsed = JSON.parse(rawStored!);
      expect(parsed.state.messages).toHaveLength(2);
      expect(parsed.state.messages[0].content).toBe('선형대수 고유값 질문');
    });

    it('clearMessages()를 호출하기 전까지는 새로고침/재조회 시에도 유지되며, 호출 시에만 초기화된다', () => {
      const store = useAiChatStore.getState();
      store.appendMessage({ role: 'user', content: '유지되어야 하는 메시지' });
      store.setInputDraft('작성 중이던 프롬프트');

      expect(useAiChatStore.getState().messages).toHaveLength(1);
      expect(useAiChatStore.getState().inputDraft).toBe('작성 중이던 프롬프트');

      // 사용자가 명시적으로 [대화 지우기] 클릭 시 초기화
      store.clearMessages();
      expect(useAiChatStore.getState().messages).toEqual([]);
      expect(useAiChatStore.getState().statusInfo.status).toBe('idle');
    });

    it('메시지가 200개를 초과하면 최근 200개로 안전하게 슬라이딩 제한된다', () => {
      const store = useAiChatStore.getState();
      for (let i = 1; i <= 210; i++) {
        store.appendMessage({ role: 'user', content: `메시지 ${i}` });
      }

      const msgs = useAiChatStore.getState().messages;
      expect(msgs).toHaveLength(200);
      expect(msgs[0].content).toBe('메시지 11');
      expect(msgs[msgs.length - 1].content).toBe('메시지 210');
    });

    it('aiChatAbortManager 싱글톤이 중단 컨트롤러를 정상 관리한다', () => {
      const c1 = aiChatAbortManager.create();
      expect(c1.signal.aborted).toBe(false);

      aiChatAbortManager.abort();
      expect(c1.signal.aborted).toBe(true);
      expect(aiChatAbortManager.get()).toBeNull();
    });
  });

  describe('2. PDF 문서 말풍선 주석 스크롤 튐 방지 및 클릭 위치 생성 (NoteSession)', () => {
    function createMockPdfSession(): { session: NoteSession; scrollEl: HTMLDivElement } {
      const pages = Array.from({ length: 5 }, (_, i) =>
        createPage({ size: 'A4', orientation: 'portrait' }),
      );

      const content = {
        type: 'doc',
        content: pages.map((p, i) => ({
          type: 'inkTemplate',
          attrs: {
            src: `attachments/page_${i + 1}.png`,
            width: 595,
            height: 842,
            page: i + 1,
            pageId: p.id,
            style: 'plain',
          },
        })),
      };

      const note = emptyNote({
        id: `pdf-bubble-test-${Date.now()}`,
        title: 'PDF 말풍선 주석 테스트',
        content,
        pages,
      });

      const session = new NoteSession(note);

      // 모의 스크롤 컨테이너 및 뷰포트 설정
      const scrollEl = document.createElement('div');
      Object.defineProperty(scrollEl, 'scrollTop', { value: 600, writable: true });
      Object.defineProperty(scrollEl, 'scrollLeft', { value: 0, writable: true });
      Object.defineProperty(scrollEl, 'clientHeight', { value: 800, writable: true });
      Object.defineProperty(scrollEl, 'clientWidth', { value: 600, writable: true });
      session.scrollEl = scrollEl;

      return { session, scrollEl };
    }

    it('마우스 클릭 좌표(point)가 전달되면 해당 위치에 정확히 핀이 생성되고 스크롤이 변조되지 않는다', () => {
      const { session, scrollEl } = createMockPdfSession();
      try {
        const initialScrollTop = scrollEl.scrollTop;

        const clickPoint = { x: 250, y: 480 };
        const annId = session.createAnnotation(clickPoint);

        expect(annId).toBeTruthy();
        const ann = session.ui.annotations.find((a) => a.id === annId);
        expect(ann).toBeDefined();
        expect(ann?.anchor.type).toBe('point');
        if (ann?.anchor.type === 'point') {
          expect(ann.anchor.x).toBe(250);
          expect(ann.anchor.y).toBe(480);
        }

        // 스크롤이 문서 맨 끝으로 튀지 않고 기존 뷰포트 스크롤 유지
        expect(scrollEl.scrollTop).toBe(initialScrollTop);
      } finally {
        session.destroy();
      }
    });

    it('point가 미전달되고 텍스트 선택이 없을 때 문서 맨 끝이 아닌 현재 뷰포트 중앙에 안전하게 생성된다', () => {
      const { session, scrollEl } = createMockPdfSession();
      try {
        scrollEl.scrollTop = 1200; // 2~3번째 페이지 뷰포트 위치

        const annId = session.createAnnotation();
        const ann = session.ui.annotations.find((a) => a.id === annId);

        expect(ann).toBeDefined();
        expect(ann?.anchor.type).toBe('point');
        if (ann?.anchor.type === 'point') {
          // viewportCenterPoint: scrollTop(1200) + clientHeight(800)/2 = 1600 (zoom 1.0 기준)
          expect(ann.anchor.y).toBe(1600);
          // 문서 맨 끝 (약 4200px 이상)으로 튀지 않음
          expect(ann.anchor.y).toBeLessThan(2000);
        }

        // 스크롤 유지 확인
        expect(scrollEl.scrollTop).toBe(1200);
      } finally {
        session.destroy();
      }
    });

    it('말풍선 주석 생성 후 실행 취소(Undo) 및 다시 실행(Redo)이 정상 동작한다', () => {
      const { session } = createMockPdfSession();
      try {
        expect(session.ui.annotations).toHaveLength(0);

        const annId = session.createAnnotation({ x: 100, y: 150 });
        expect(session.ui.annotations).toHaveLength(1);

        // Undo
        session.undo();
        expect(session.ui.annotations).toHaveLength(0);

        // Redo
        session.redo();
        expect(session.ui.annotations).toHaveLength(1);
        expect(session.ui.annotations[0].id).toBe(annId);
      } finally {
        session.destroy();
      }
    });

    it('텍스트 드래그가 없는 상태(빈 문자열)에서는 hasTextSel이 false로 판별되어 클릭 위치 앵커로 안전 분기된다', () => {
      const { session } = createMockPdfSession();
      try {
        // selection이 empty가 아니어도 텍스트 내용이 없는 상황
        const selText = !session.editor.state.selection.empty
          ? session.editor.state.doc.textBetween(session.editor.state.selection.from, session.editor.state.selection.to, ' ').trim()
          : '';
        const hasTextSel = selText.length > 0;
        expect(hasTextSel).toBe(false);

        // pagePoint가 존재할 때 createAnnotation(pagePoint) 호출
        const pagePoint = { x: 340, y: 520 };
        const annId = session.createAnnotation(pagePoint);
        const ann = session.ui.annotations.find((a) => a.id === annId);
        expect(ann?.anchor).toEqual({ type: 'point', x: 340, y: 520 });
      } finally {
        session.destroy();
      }
    });
  });
});
