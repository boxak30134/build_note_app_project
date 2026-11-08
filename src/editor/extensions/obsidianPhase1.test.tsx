// @vitest-environment jsdom
import { createRef } from 'react';
import { render, cleanup, act } from '@testing-library/react';
import { Editor } from '@tiptap/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildExtensions, markdownToJson, jsonToMarkdown } from './index';
import { resolveTransclusionSync, MAX_EMBED_DEPTH, type EmbedTargetDoc } from './blockEmbed';
import { useTabs } from '../../store/tabsStore';
import { useSettings } from '../../store/settingsStore';
import { useSessions } from '../../store/sessionStore';
import { InkCanvas } from '../../canvas/InkCanvas';
import { CompositeHistoryManager } from '../../core/history/CompositeHistoryManager';
import { StrokeStore } from '../../core/strokes/StrokeStore';
import {
  recordGlobalPenDown,
  recordGlobalPenUp,
  resetGlobalPalmState,
  shouldRejectSplitPalmTouch,
  type PalmRejectionState,
} from '../../core/android/androidDeployment';
import type { NoteSession } from '../../session/NoteSession';

function dispatchPointerEvent(
  target: HTMLElement,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  init: {
    pointerId: number;
    pointerType: 'pen' | 'touch' | 'mouse';
    clientX: number;
    clientY: number;
    buttons?: number;
    pressure?: number;
  },
): PointerEvent {
  const ev = new Event(type, { bubbles: true, cancelable: true }) as PointerEvent;
  Object.defineProperties(ev, {
    pointerId: { value: init.pointerId },
    pointerType: { value: init.pointerType },
    clientX: { value: init.clientX },
    clientY: { value: init.clientY },
    button: { value: 0 },
    buttons: { value: init.buttons ?? (type === 'pointerup' ? 0 : 1) },
    pressure: { value: init.pressure ?? 0.5 },
  });
  target.dispatchEvent(ev);
  return ev;
}

describe('REQ_OBSIDIAN_PHASE1: 학술 콜아웃 블록, 인라인 임베드(순환 참조 방어), 좌우 분할 패널 및 S-Pen 격리', () => {
  beforeEach(() => {
    resetGlobalPalmState();
    useTabs.setState({
      openDocTabs: [],
      activeTabId: null,
      splitOpen: false,
      secondaryTabId: null,
      focusedPane: 'primary',
      splitRatio: 0.5,
      pendingScroll: {},
    });
  });

  afterEach(() => {
    cleanup();
    resetGlobalPalmState();
    vi.restoreAllMocks();
  });

  describe('1. 학술 콜아웃 블록 (> [!theorem], > [!proof], > [!definition] 및 접기/펼치기 +/-)', () => {
    it('마크다운 파싱 및 직렬화 왕복: > [!theorem]+, > [!proof]-, > [!definition] 블록과 내부 수식을 보존한다', () => {
      const md = [
        '> [!theorem]+ 피타고라스 정리',
        '> 직각삼각형에서 빗변의 제곱은 $a^2 + b^2 = c^2$ 이다.',
        '',
        '> [!proof]- 대수적 증명',
        '> 한 변의 길이가 $a+b$ 인 정사각형 넓이 비교로 증명된다.',
        '',
        '> [!definition] 위상공간',
        '> 열린집합 공리를 만족하는 순서쌍 $(X, \\mathcal{T})$ 를 위상공간이라 한다.',
      ].join('\n');

      const json = markdownToJson(md) as {
        content: Array<{
          type: string;
          attrs?: Record<string, unknown>;
          content?: Array<{ type: string }>;
        }>;
      };

      expect(json.content).toHaveLength(3);
      expect(json.content[0].type).toBe('callout');
      expect(json.content[0].attrs).toMatchObject({
        calloutType: 'theorem',
        foldMarker: '+',
        collapsed: false,
        title: '피타고라스 정리',
      });

      expect(json.content[1].type).toBe('callout');
      expect(json.content[1].attrs).toMatchObject({
        calloutType: 'proof',
        foldMarker: '-',
        collapsed: true,
        title: '대수적 증명',
      });

      expect(json.content[2].type).toBe('callout');
      expect(json.content[2].attrs).toMatchObject({
        calloutType: 'definition',
        collapsed: false,
        title: '위상공간',
      });

      const out = jsonToMarkdown(json);
      expect(out).toContain('> [!theorem]+ 피타고라스 정리');
      expect(out).toContain('$a^2 + b^2 = c^2$');
      expect(out).toContain('> [!proof]- 대수적 증명');
      expect(out).toContain('> [!definition] 위상공간');
    });

    it('TipTap 에디터 NodeView에서 접기/펼치기(+/-) 버튼 클릭 시 collapsed 상태와 콘텐츠 표시가 실시간 전환된다', () => {
      const host = document.createElement('div');
      document.body.appendChild(host);

      const content = markdownToJson('> [!proof]+ 증명 과정\n> 보조정리 1에 의해 자명하다.') as Record<string, unknown>;
      const editor = new Editor({
        element: host,
        extensions: buildExtensions({ noteId: 'test-callout-note' }),
        content,
      });

      const calloutEl = host.querySelector('[data-callout]') as HTMLElement;
      const toggleBtn = host.querySelector('[data-testid="callout-fold-toggle"]') as HTMLButtonElement;
      const contentEl = host.querySelector('.callout-content') as HTMLElement;

      expect(calloutEl).toBeTruthy();
      expect(calloutEl.getAttribute('data-callout-type')).toBe('proof');
      expect(calloutEl.getAttribute('data-collapsed')).toBe('false');
      expect(toggleBtn.textContent).toBe('-');
      expect(contentEl.style.display).toBe('');

      // 접기(-) 버튼 클릭 -> collapsed=true, 버튼 텍스트는 '+'로 변경되고 본문 숨김
      act(() => {
        toggleBtn.click();
      });
      expect(calloutEl.getAttribute('data-collapsed')).toBe('true');
      expect(toggleBtn.textContent).toBe('+');
      expect(contentEl.style.display).toBe('none');

      // 펼치기(+) 버튼 다시 클릭 -> collapsed=false 복원
      act(() => {
        toggleBtn.click();
      });
      expect(calloutEl.getAttribute('data-collapsed')).toBe('false');
      expect(toggleBtn.textContent).toBe('-');
      expect(contentEl.style.display).toBe('');

      editor.destroy();
      document.body.removeChild(host);
    });
  });

  describe('2. 블록 인라인 임베드 (![[문서제목#단락]]) 및 순환 참조 방어', () => {
    it('![[문서제목#단락]] 문법이 일반 [[위키링크]]와 충돌하지 않고 정확히 파싱·직렬화된다', () => {
      const md = '참고 문헌: [[선형대수학]] 및 인라인 임베드 ![[해석학 노트#볼차노-바이어슈트라스 정리]]';
      const json = markdownToJson(md) as {
        content: Array<{ content?: Array<{ type: string; attrs?: Record<string, unknown> }> }>;
      };

      const inlineNodes = json.content[0].content ?? [];
      const wiki = inlineNodes.find((n) => n.type === 'wikiLink');
      const embed = inlineNodes.find((n) => n.type === 'blockEmbed');

      expect(wiki).toBeTruthy();
      expect(wiki?.attrs).toMatchObject({ targetDocId: '선형대수학', label: '선형대수학' });

      expect(embed).toBeTruthy();
      expect(embed?.attrs).toMatchObject({
        targetDocId: '해석학 노트',
        targetBlockId: '볼차노-바이어슈트라스 정리',
      });

      const roundtrip = jsonToMarkdown(json);
      expect(roundtrip).toContain('![[해석학 노트#볼차노-바이어슈트라스 정리]]');
    });

    it('정상 단락 트랜스클루전 해석 및 자기 참조(A->A), 상호 순환 참조(A->B->A), 최대 깊이 초과를 완벽히 차단한다', () => {
      const mockDocs: EmbedTargetDoc[] = [
        {
          id: 'doc-a',
          title: '노트 A',
          content: markdownToJson('노트 A의 첫 단락입니다.\n\n![[노트 B#단락 1]]'),
        },
        {
          id: 'doc-b',
          title: '노트 B',
          content: markdownToJson('단락 1: 유계 수열은 수렴하는 부분수열을 가진다.\n\n![[노트 A#첫 단락]]'),
        },
        {
          id: 'doc-c',
          title: '해석학 정리',
          content: markdownToJson('보조정리 1: 모든 코시 수열은 유계이다.\n\n정리 2: 완비성 공리'),
        },
      ];

      // 1) 정상 단락 트랜스클루전 (노트 A -> 해석학 정리#보조정리 1)
      const okRes = resolveTransclusionSync('doc-a', '해석학 정리', '보조정리 1', mockDocs);
      expect(okRes.status).toBe('ok');
      expect(okRes.excerpt).toContain('모든 코시 수열은 유계이다');

      // 2) 자기 자신 참조 (노트 A -> 노트 A) 차단
      const selfCycle = resolveTransclusionSync('doc-a', '노트 A', null, mockDocs);
      expect(selfCycle.status).toBe('cycle_blocked');
      expect(selfCycle.warningMessage).toContain('순환 참조 방어');

      // 3) 다중 홉 상호 순환 참조 (노트 A -> 노트 B -> 노트 A) 차단
      const mutualCycle = resolveTransclusionSync('doc-a', '노트 B', '단락 1', mockDocs);
      expect(mutualCycle.status).toBe('cycle_blocked');
      expect(mutualCycle.warningMessage).toContain('노트 A → 노트 B → 노트 A');

      // 4) 최대 깊이(MAX_EMBED_DEPTH = 3) 초과 차단
      const depthRes = resolveTransclusionSync('doc-a', '해석학 정리', null, mockDocs, [], MAX_EMBED_DEPTH);
      expect(depthRes.status).toBe('max_depth_exceeded');
    });
  });

  describe('3. 좌우 화면 분할 (Dual Split Pane) 및 패널 간 S-Pen 독립 드로잉·450ms 팜 리젝션 격리', () => {
    it('듀얼 스플릿 상태 전환 및 좌·우 패널 각각에서 S-Pen 드로잉이 독립된 세션에만 기록된다', () => {
      useTabs.getState().openTab('note-left');
      useTabs.getState().openInSecondary('note-right');

      const tabState = useTabs.getState();
      expect(tabState.splitOpen).toBe(true);
      expect(tabState.activeTabId).toBe('note-left');
      expect(tabState.secondaryTabId).toBe('note-right');
      expect(tabState.focusedPane).toBe('secondary');

      useSettings.setState({ tool: 'pencil', penSize: 4 });
      useSessions.getState().patch('note-left', { loaded: true, readOnly: false, lassoIds: [], moveMode: false, zoom: 1 });
      useSessions.getState().patch('note-right', { loaded: true, readOnly: false, lassoIds: [], moveMode: false, zoom: 1 });

      const leftHistory = new CompositeHistoryManager();
      const leftStrokes = new StrokeStore(leftHistory, []);
      const rightHistory = new CompositeHistoryManager();
      const rightStrokes = new StrokeStore(rightHistory, []);

      const leftViewport = document.createElement('div');
      const leftPage = document.createElement('div');
      leftViewport.appendChild(leftPage);
      document.body.appendChild(leftViewport);

      const rightViewport = document.createElement('div');
      const rightPage = document.createElement('div');
      rightViewport.appendChild(rightPage);
      document.body.appendChild(rightViewport);

      const leftRect = { x: 0, y: 0, left: 0, top: 0, right: 500, bottom: 800, width: 500, height: 800, toJSON: () => ({}) };
      const rightRect = { x: 500, y: 0, left: 500, top: 0, right: 1000, bottom: 800, width: 500, height: 800, toJSON: () => ({}) };
      vi.spyOn(leftViewport, 'getBoundingClientRect').mockReturnValue(leftRect);
      vi.spyOn(leftPage, 'getBoundingClientRect').mockReturnValue(leftRect);
      vi.spyOn(rightViewport, 'getBoundingClientRect').mockReturnValue(rightRect);
      vi.spyOn(rightPage, 'getBoundingClientRect').mockReturnValue(rightRect);

      const leftSession = {
        id: 'note-left',
        history: leftHistory,
        strokes: leftStrokes,
        pageEl: leftPage,
        get ui() {
          return useSessions.getState().sessions['note-left']!;
        },
        patch(p: Parameters<ReturnType<typeof useSessions.getState>['patch']>[1]) {
          useSessions.getState().patch('note-left', p);
        },
      } as unknown as NoteSession;

      const rightSession = {
        id: 'note-right',
        history: rightHistory,
        strokes: rightStrokes,
        pageEl: rightPage,
        get ui() {
          return useSessions.getState().sessions['note-right']!;
        },
        patch(p: Parameters<ReturnType<typeof useSessions.getState>['patch']>[1]) {
          useSessions.getState().patch('note-right', p);
        },
      } as unknown as NoteSession;

      const leftRef = createRef<HTMLDivElement>();
      leftRef.current = leftViewport;
      const rightRef = createRef<HTMLDivElement>();
      rightRef.current = rightViewport;

      render(
        <>
          <InkCanvas session={leftSession} viewportRef={leftRef} active />
          <InkCanvas session={rightSession} viewportRef={rightRef} active />
        </>,
      );

      // 1) 좌측 패널에 S-Pen 필기 시작 -> 우측 패널에 동시에 닿은 손바닥(touch)은 즉시 차단되어야 함
      act(() => {
        dispatchPointerEvent(leftViewport, 'pointerdown', { pointerId: 11, pointerType: 'pen', clientX: 50, clientY: 50 });
        dispatchPointerEvent(leftViewport, 'pointermove', { pointerId: 11, pointerType: 'pen', clientX: 120, clientY: 80 });
      });

      const palmTouchOnRightPane = dispatchPointerEvent(rightViewport, 'pointerdown', {
        pointerId: 99,
        pointerType: 'touch',
        clientX: 600,
        clientY: 200,
      });
      expect(palmTouchOnRightPane.defaultPrevented).toBe(true);

      act(() => {
        dispatchPointerEvent(leftViewport, 'pointerup', { pointerId: 11, pointerType: 'pen', clientX: 120, clientY: 80 });
      });

      expect(leftStrokes.getAll()).toHaveLength(1);
      expect(rightStrokes.getAll()).toHaveLength(0);

      // 2) 우측 패널에 S-Pen 필기 수행 -> 우측 패널에만 기록되고 좌측 패널 스트로크는 불변
      act(() => {
        dispatchPointerEvent(rightViewport, 'pointerdown', { pointerId: 12, pointerType: 'pen', clientX: 550, clientY: 100 });
        dispatchPointerEvent(rightViewport, 'pointermove', { pointerId: 12, pointerType: 'pen', clientX: 650, clientY: 140 });
        dispatchPointerEvent(rightViewport, 'pointerup', { pointerId: 12, pointerType: 'pen', clientX: 650, clientY: 140 });
      });

      expect(leftStrokes.getAll()).toHaveLength(1);
      expect(rightStrokes.getAll()).toHaveLength(1);
      // 우측 패널 로컬 좌표계(rightPage.left = 500) 기준으로 x 좌표가 50 -> 150으로 정확히 정규화됨
      expect(rightStrokes.getAll()[0].points[0][0]).toBe(50);

      document.body.removeChild(leftViewport);
      document.body.removeChild(rightViewport);
    });

    it('교차 패널 450ms 팜 리젝션: 좌측 패널 필기 직후 450ms 이내 우측 패널 손바닥 터치를 거부하고 450ms 경과 후 허용한다', () => {
      const now = 2_000_000;
      const rightPaneLocalState: PalmRejectionState = {
        isPenDrawing: false,
        lastPenTimestamp: 0,
      };

      // 좌측 패널에서 펜 필기 시작
      recordGlobalPenDown(now);
      expect(shouldRejectSplitPalmTouch('touch', rightPaneLocalState, now + 50)).toBe(true);

      // 좌측 패널에서 펜을 뗌
      recordGlobalPenUp(now + 100);

      // 펜을 뗀 후 250ms 경과 (450ms 이내) -> 우측 패널에 들어온 손바닥 터치 차단
      expect(shouldRejectSplitPalmTouch('touch', rightPaneLocalState, now + 350)).toBe(true);

      // 펜을 뗀 후 500ms 경과 (450ms 윈도우 초과) -> 우측 패널 손가락 터치 제스처 정상 허용
      expect(shouldRejectSplitPalmTouch('touch', rightPaneLocalState, now + 600)).toBe(false);
    });
  });
});

