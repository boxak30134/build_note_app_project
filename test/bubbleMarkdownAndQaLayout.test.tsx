// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { NoteSession } from '../src/session/NoteSession';
import { emptyNote } from '../src/storage/db';
import { Bubble } from '../src/features/annotations/Bubble';
import { parseBubbleBlocks } from '../src/features/annotations/bubbleMarkdownParser';
import * as aiModule from '../src/modules/ai';

vi.mock('../src/ai/useConnectedProviders', () => ({
  useConnectedProviders: () => ['google'],
}));

describe('REQ_BUBBLE_MARKDOWN_AND_QA_LAYOUT: 말풍선 마크다운 렌더링 및 다중 Q&A 구분 UI', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it('1. 말풍선 본문의 마크다운 문법과 KaTeX 수식이 함께 렌더링되고 위험 링크는 차단된다', () => {
    const note = emptyNote({ id: 'note-md-1', title: '마크다운 테스트' });
    const session = new NoteSession(note);
    session.createAnnotation({ x: 50, y: 50 });
    const annId = session.ui.annotations[0].id;
    session.updateAnnotation(annId, {
      body: [
        '### 핵심 정리',
        '**굵은 개념**과 *기울임*, ~~취소선~~, `inlineCode()` 및 $x^2 + y^2 = r^2$ 입니다.',
        '',
        '- 첫 번째 항목',
        '- 두 번째 항목',
        '',
        '> 인용문 메모',
        '',
        '```ts',
        'const sum = (a: number, b: number) => a + b;',
        '```',
        '',
        '[안전 링크](https://example.com) / [차단 링크](javascript:alert(1))',
      ].join('\n'),
    });

    const ann = session.ui.annotations.find((a) => a.id === annId)!;
    render(<Bubble session={session} annotation={ann} reference={null} onClose={vi.fn()} />);

    expect(document.body.querySelector('h3')?.textContent).toContain('핵심 정리');
    expect(document.body.querySelector('strong')?.textContent).toBe('굵은 개념');
    expect(document.body.querySelector('em')?.textContent).toBe('기울임');
    expect(document.body.querySelector('del')?.textContent).toBe('취소선');
    expect(document.body.querySelector('code')?.textContent).toBe('inlineCode()');
    expect(document.body.querySelector('pre code')?.textContent).toContain('const sum');
    expect(document.body.querySelectorAll('li').length).toBe(2);
    expect(document.body.querySelector('blockquote')?.textContent).toContain('인용문 메모');
    expect(document.body.querySelector('.katex')).not.toBeNull();

    const safeAnchor = document.body.querySelector('a[href="https://example.com"]');
    expect(safeAnchor?.textContent).toBe('안전 링크');
    expect(document.body.querySelector('a[href^="javascript:"]')).toBeNull();

    session.destroy();
  });

  it('2. 질문(Q)과 AI 답변(A)을 별도 카드로 분리하고 2번째·3번째 질문 배지 및 퀵 점프를 제공한다', () => {
    const note = emptyNote({ id: 'note-qa-1', title: 'Q&A 분리 테스트' });
    const session = new NoteSession(note);
    session.createAnnotation({ x: 80, y: 120 });
    const annId = session.ui.annotations[0].id;
    session.updateAnnotation(annId, {
      body: [
        '참고 메모: 시험 범위',
        '',
        '**Q.** 첫 번째 질문은 무엇인가요?',
        '**A(Gemini).** **결론**: 첫 번째 답변입니다.',
        '',
        '---',
        '',
        '**Q.** 두 번째 질문 위치가 보이나요?',
        '**A(Gemini).** 두 번째 답변입니다.',
        '',
        '**Q.** 세 번째 질문도 구분되나요?',
        '**A(Claude).** 세 번째 답변입니다.',
      ].join('\n'),
    });

    const parsed = parseBubbleBlocks(session.ui.annotations[0].body);
    expect(parsed.map((b) => b.kind)).toEqual(['memo', 'question', 'answer', 'question', 'answer', 'question', 'answer']);
    // 1번 답변 끝의 턴 구분선(---)은 답변 카드 내부에 남지 않아야 함
    const firstAnswer = parsed[2];
    expect(firstAnswer.kind === 'answer' && firstAnswer.content).toBe('**결론**: 첫 번째 답변입니다.');

    const ann = session.ui.annotations.find((a) => a.id === annId)!;
    render(<Bubble session={session} annotation={ann} reference={null} onClose={vi.fn()} />);

    const qCards = document.body.querySelectorAll('[data-bubble-role="question"]');
    const aCards = document.body.querySelectorAll('[data-bubble-role="answer"]');
    expect(qCards.length).toBe(3);
    expect(aCards.length).toBe(3);
    expect(qCards[1].getAttribute('data-question-index')).toBe('2');
    expect(qCards[2].getAttribute('data-question-index')).toBe('3');
    expect(aCards[2].textContent).toContain('Claude');

    const nav = screen.getByTestId('bubble-question-nav');
    expect(nav.textContent).toContain('질문 3개');
    const jumpQ2 = screen.getByRole('button', { name: 'Q2' });
    const scrollSpy = vi.fn();
    (qCards[1] as HTMLElement).scrollIntoView = scrollSpy;
    fireEvent.click(jumpQ2);
    expect(scrollSpy).toHaveBeenCalledTimes(1);

    session.destroy();
  });

  it('3. 빈 말풍선은 편집 모드로 시작하고 [보기]/[편집] 토글과 다중 AI 질문 구분선 삽입이 동작한다', async () => {
    vi.spyOn(aiModule, 'streamGeminiTutor').mockImplementation(() => {
      return (async function* () {
        yield 'AI **응답**입니다.';
      })();
    });

    const note = emptyNote({ id: 'note-toggle-1', title: '편집 토글 테스트' });
    const session = new NoteSession(note);
    session.createAnnotation({ x: 40, y: 40 });
    const annId = session.ui.annotations[0].id;

    const { rerender } = render(
      <Bubble session={session} annotation={session.ui.annotations[0]} reference={null} onClose={vi.fn()} />,
    );

    // 빈 말풍선은 바로 편집 가능
    expect(screen.getByPlaceholderText(/메모를 입력하거나/)).toBeTruthy();

    // 질문 1 전송 시 보기 모드로 전환
    const input = screen.getByPlaceholderText('AI에게 질문…');
    fireEvent.change(input, { target: { value: '첫 질문' } });
    await act(async () => {
      fireEvent.submit(input.closest('form')!);
      await Promise.resolve();
    });

    rerender(<Bubble session={session} annotation={session.ui.annotations[0]} reference={null} onClose={vi.fn()} />);
    expect(screen.getByTestId('bubble-preview')).toBeTruthy();

    // 질문 2 추가 전송 -> 원문에 --- 구분선이 포함되어 저장됨
    fireEvent.change(screen.getByPlaceholderText('AI에게 질문…'), { target: { value: '둘째 질문' } });
    await act(async () => {
      fireEvent.submit(screen.getByPlaceholderText('AI에게 질문…').closest('form')!);
      await Promise.resolve();
    });

    const updated = session.ui.annotations.find((a) => a.id === annId)!;
    expect(updated.body).toContain('\n\n---\n\n**Q.** 둘째 질문');

    rerender(<Bubble session={session} annotation={updated} reference={null} onClose={vi.fn()} />);
    expect(screen.getByTestId('bubble-question-nav').textContent).toContain('질문 2개');

    // [편집] 클릭 시 textarea로 전환
    fireEvent.click(screen.getByRole('button', { name: '편집' }));
    expect(screen.getByPlaceholderText(/메모를 입력하거나/)).toBeTruthy();

    session.destroy();
  });

  it('4. 사용자가 말풍선 편집 중 입력한 마크다운이 실시간 미리보기로 렌더링되고 blur 시 보기 모드로 자동 전환된다', () => {
    const note = emptyNote({ id: 'note-user-md-1', title: '사용자 메모 마크다운' });
    const session = new NoteSession(note);
    session.createAnnotation({ x: 30, y: 30 });
    const annId = session.ui.annotations[0].id;

    const { rerender } = render(
      <Bubble session={session} annotation={session.ui.annotations[0]} reference={null} onClose={vi.fn()} />,
    );

    const textarea = screen.getByPlaceholderText(/메모를 입력하거나/) as HTMLTextAreaElement;
    const typedMd = [
      '## 내 학습 메모',
      '__굵은 핵심__과 *강조*',
      '- [x] 복습 완료',
      '- [ ] 문제 풀이',
      '~~~ts',
      'const ok = true;',
      '~~~',
    ].join('\n');

    fireEvent.change(textarea, { target: { value: typedMd } });
    const updated = session.ui.annotations.find((a) => a.id === annId)!;
    rerender(<Bubble session={session} annotation={updated} reference={null} onClose={vi.fn()} />);

    // 편집 중 실시간 미리보기에 마크다운 DOM이 바로 렌더링됨
    const livePreview = screen.getByTestId('bubble-live-preview');
    expect(livePreview.querySelector('h2')?.textContent).toBe('내 학습 메모');
    expect(livePreview.querySelector('strong')?.textContent).toBe('굵은 핵심');
    expect(livePreview.querySelectorAll('input[type="checkbox"]').length).toBe(2);
    expect(livePreview.querySelector('pre code')?.textContent).toContain('const ok = true;');

    // 포커스 이탈(blur) 시 자동으로 보기 모드(bubble-preview)로 전환됨
    fireEvent.blur(textarea);
    const preview = screen.getByTestId('bubble-preview');
    expect(preview.querySelector('h2')?.textContent).toBe('내 학습 메모');
    expect(preview.querySelector('em')?.textContent).toBe('강조');

    session.destroy();
  });

  it('5. AI 답변 첫 줄/다중 줄에 포함된 마크다운(헤딩·목록·표·수식)도 정상 렌더링된다', () => {
    const note = emptyNote({ id: 'note-ai-md-1', title: 'AI 답변 마크다운' });
    const session = new NoteSession(note);
    session.createAnnotation({ x: 60, y: 60 });
    const annId = session.ui.annotations[0].id;
    session.updateAnnotation(annId, {
      body: [
        '**Q.** **군(Group)** 의 정의를 알려줘',
        '**A(Gemini).** ### 핵심 정의',
        '- 항등원 $e$ 존재',
        '- 결합법칙 성립',
        '',
        '| 공리 | 의미 |',
        '| --- | --- |',
        '| 결합법칙 | $(ab)c = a(bc)$ |',
      ].join('\n'),
    });

    const ann = session.ui.annotations.find((a) => a.id === annId)!;
    render(<Bubble session={session} annotation={ann} reference={null} onClose={vi.fn()} />);

    const qCard = document.body.querySelector('[data-bubble-role="question"]')!;
    const aCard = document.body.querySelector('[data-bubble-role="answer"]')!;
    expect(qCard.querySelector('strong')?.textContent).toBe('군(Group)');
    expect(aCard.querySelector('h3')?.textContent).toBe('핵심 정의');
    expect(aCard.querySelectorAll('li').length).toBe(2);
    expect(aCard.querySelector('table')).not.toBeNull();
    expect(aCard.querySelector('.katex')).not.toBeNull();

    session.destroy();
  });
});
