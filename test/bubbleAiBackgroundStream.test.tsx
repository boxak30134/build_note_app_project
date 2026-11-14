// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { NoteSession } from '../src/session/NoteSession';
import { emptyNote } from '../src/storage/db';
import { useSessions } from '../src/store/sessionStore';
import { Bubble } from '../src/features/annotations/Bubble';
import * as aiModule from '../src/modules/ai';

vi.mock('../src/ai/useConnectedProviders', () => ({
  useConnectedProviders: () => ['google'],
}));

describe('REQ_BUBBLE_AI_BACKGROUND_STREAM: 말풍선 닫기 후에도 AI 답변 백그라운드 기록', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  function createDeferredStream() {
    let pushChunk!: (chunk: string) => void;
    let finish!: () => void;
    let capturedSignal: AbortSignal | undefined;

    const spy = vi.spyOn(aiModule, 'streamGeminiTutor').mockImplementation((opts) => {
      capturedSignal = opts.signal;
      return (async function* () {
        const queue: string[] = [];
        let done = false;
        let wake: (() => void) | null = null;

        pushChunk = (chunk: string) => {
          queue.push(chunk);
          wake?.();
          wake = null;
        };
        finish = () => {
          done = true;
          wake?.();
          wake = null;
        };

        while (!done || queue.length > 0) {
          if (opts.signal?.aborted) return;
          if (queue.length === 0) {
            await new Promise<void>((res) => {
              wake = res;
              opts.signal?.addEventListener('abort', () => res(), { once: true });
            });
            continue;
          }
          yield queue.shift()!;
        }
      })();
    });

    return {
      spy,
      getSignal: () => capturedSignal,
      pushChunk: (c: string) => pushChunk(c),
      finish: () => finish(),
    };
  }

  it('1. 말풍선 닫기(언마운트) 후에도 스트림이 중단되지 않고 annotation.body에 끝까지 기록된다', async () => {
    const stream = createDeferredStream();
    const note = emptyNote('note-bg-1', '테스트 노트');
    const session = new NoteSession(note);
    session.createAnnotation({ pageIndex: 0, x: 100, y: 100 });
    const annId = session.ui.annotations[0].id;

    const { unmount } = render(
      <Bubble session={session} annotation={session.ui.annotations[0]} reference={null} onClose={vi.fn()} />,
    );

    const input = screen.getByPlaceholderText('AI에게 질문…');
    fireEvent.change(input, { target: { value: '라그랑주 정리 설명해줘' } });
    fireEvent.submit(input.closest('form')!);

    await act(async () => {
      await Promise.resolve();
    });

    // 첫 번째 청크 수신 후 말풍선 닫기(언마운트)
    await act(async () => {
      stream.pushChunk('라그랑주 정리는 ');
      await Promise.resolve();
    });
    unmount();

    // 언마운트 후에도 signal은 abort되지 않아야 함
    expect(stream.getSignal()?.aborted).toBe(false);

    // 닫힌 상태에서 후속 청크 수신 및 완료
    await act(async () => {
      stream.pushChunk('부분군의 위수가 군의 위수를 나눈다는 정리입니다.');
      await Promise.resolve();
      stream.finish();
      await Promise.resolve();
    });

    const updated = session.ui.annotations.find((a) => a.id === annId)!;
    expect(updated.body).toContain('**Q.** 라그랑주 정리 설명해줘');
    expect(updated.body).toContain('라그랑주 정리는 부분군의 위수가 군의 위수를 나눈다는 정리입니다.');
    expect(useSessions.getState().sessions[session.id]?.streamingAnnotationIds?.[annId]).toBeUndefined();

    session.destroy();
  });

  it('2. 스트리밍 진행 중 말풍선을 닫았다가 다시 열어도 busy 상태가 유지되어 중복 전송이 차단된다', async () => {
    const stream = createDeferredStream();
    const note = emptyNote('note-bg-2', '테스트 노트');
    const session = new NoteSession(note);
    session.createAnnotation({ pageIndex: 0, x: 100, y: 100 });
    const annId = session.ui.annotations[0].id;

    const { unmount } = render(
      <Bubble session={session} annotation={session.ui.annotations[0]} reference={null} onClose={vi.fn()} />,
    );

    const input = screen.getByPlaceholderText('AI에게 질문…');
    fireEvent.change(input, { target: { value: '첫 질문' } });
    fireEvent.submit(input.closest('form')!);

    await act(async () => {
      await Promise.resolve();
    });

    unmount();
    expect(useSessions.getState().sessions[session.id]?.streamingAnnotationIds?.[annId]).toBe(true);

    // 다시 열었을 때 전송 버튼은 disabled 상태여야 함
    const reopenedAnn = session.ui.annotations.find((a) => a.id === annId)!;
    render(<Bubble session={session} annotation={reopenedAnn} reference={null} onClose={vi.fn()} />);

    const submitBtn = screen.getByTitle('AI에게 질문') as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(true);

    await act(async () => {
      stream.finish();
      await Promise.resolve();
    });
    session.destroy();
  });

  it('3. 주석 삭제(deleteAnnotation) 또는 세션 종료(destroy) 시에는 진행 중인 스트림을 즉시 abort한다', async () => {
    const stream1 = createDeferredStream();
    const note = emptyNote('note-bg-3', '테스트 노트');
    const session = new NoteSession(note);
    session.createAnnotation({ pageIndex: 0, x: 100, y: 100 });
    const annId1 = session.ui.annotations[0].id;

    void session.askAnnotationAi({ annotationId: annId1, question: '삭제될 질문', provider: 'google' });
    await act(async () => {
      await Promise.resolve();
    });
    expect(stream1.getSignal()?.aborted).toBe(false);

    session.deleteAnnotation(annId1, false);
    expect(stream1.getSignal()?.aborted).toBe(true);
    expect(useSessions.getState().sessions[session.id]?.streamingAnnotationIds?.[annId1]).toBeUndefined();

    // 세션 destroy 시에도 abort 검증
    const stream2 = createDeferredStream();
    session.createAnnotation({ pageIndex: 0, x: 150, y: 150 });
    const annId2 = session.ui.annotations[0].id;
    void session.askAnnotationAi({ annotationId: annId2, question: '세션 종료 질문', provider: 'google' });
    await act(async () => {
      await Promise.resolve();
    });
    expect(stream2.getSignal()?.aborted).toBe(false);

    session.destroy();
    expect(stream2.getSignal()?.aborted).toBe(true);
  });
});
