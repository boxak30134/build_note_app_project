// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AllModelsFailedError,
  applySlidingWindowAndSummary,
  buildGeminiStreamParams,
  extractFocusedNoteContext,
  FALLBACK_NOTE_CONTEXT_CHARS,
  getUserFacingErrorMessage,
  MAX_NOTE_CONTEXT_CHARS,
  MAX_RECENT_CHAT_MESSAGES,
  streamGeminiTutor,
  TimeoutError,
  type GeminiClientLike,
  type GeminiStreamChunkLike,
} from '../src/modules/ai';
import { translateViaGeminiWithMeta } from '../src/services/friendlyTranslationService';
import type { NoteSession } from '../src/session/NoteSession';

function createAsyncStream(chunks: GeminiStreamChunkLike[]): AsyncIterable<GeminiStreamChunkLike> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  };
}

describe('REQ_gemini_context_trim_streaming: 슬라이딩 윈도우·롤링 요약·SSE·폴백 페이로드 경량화', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1. 10개 대화 히스토리를 최근 6개 원문 + 3~5줄 롤링 요약으로 압축하고, 노트 본문을 활성 위치 기준 12,000자 이내로 추출한다', () => {
    const messages = Array.from({ length: 10 }, (_, idx) => ({
      role: (idx % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `메시지-${idx + 1} 선형대수 고유값과 고유벡터 정리 내용`,
    }));

    const longContext = `${'앞부분 '.repeat(5000)}[핵심 선택 구간]${'뒷부분 '.repeat(5000)}`;
    const windowed = applySlidingWindowAndSummary(messages, longContext);

    expect(windowed.recentMessages).toHaveLength(MAX_RECENT_CHAT_MESSAGES);
    expect(windowed.recentMessages[0].content).toContain('메시지-5');
    expect(windowed.recentMessages[5].content).toContain('메시지-10');

    const summaryLines = windowed.olderSummary.split('\n').filter(Boolean);
    expect(summaryLines.length).toBeGreaterThanOrEqual(3);
    expect(summaryLines.length).toBeLessThanOrEqual(5);
    expect(windowed.systemContext).toContain('[이전 대화 핵심 요약]');
    expect(windowed.systemContext.length).toBeLessThanOrEqual(MAX_NOTE_CONTEXT_CHARS);

    const params = buildGeminiStreamParams({
      messages,
      systemContext: longContext,
      target: 'sidebar',
    });
    expect(params.contents).toHaveLength(MAX_RECENT_CHAT_MESSAGES);
    expect(params.config.systemInstruction).toContain('[이전 대화 핵심 요약]');

    const mockSession = {
      record: { title: '긴 학술 노트' },
      ui: { pages: [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }], currentPageIndex: 1 },
      editor: {
        getMarkdown: () => `${'A'.repeat(10000)}\nTARGET_FORMULA_BLOCK\n${'B'.repeat(10000)}`,
        state: {
          selection: { from: 10, to: 30 },
          doc: {
            content: { size: 20030 },
            textBetween: () => 'TARGET_FORMULA_BLOCK',
          },
        },
      },
    } as unknown as NoteSession;

    const focused = extractFocusedNoteContext(mockSession, MAX_NOTE_CONTEXT_CHARS);
    expect(focused).toContain('[현재 선택 영역]');
    expect(focused).toContain('TARGET_FORMULA_BLOCK');
    expect(focused.length).toBeLessThanOrEqual(MAX_NOTE_CONTEXT_CHARS + 1400);
  });

  it('2. 번역 호출이 :streamGenerateContent?alt=sse SSE 스트림을 청크 단위로 수신해 첫 토큰부터 누적한다', async () => {
    const encoder = new TextEncoder();
    const sseBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'data: {"candidates":[{"content":{"parts":[{"text":"사영 "}]}}]}\n\n',
          ),
        );
        controller.enqueue(
          encoder.encode(
            'data: {"candidates":[{"content":{"parts":[{"text":"작용소"}],"finishReason":"STOP"}}]}\n\n',
          ),
        );
        controller.close();
      },
    });

    const fetchSpy = vi.fn().mockResolvedValue(new Response(sseBody, { status: 200 }));
    globalThis.fetch = fetchSpy;

    const deltas: string[] = [];
    const res = await translateViaGeminiWithMeta(
      'projection operator',
      'AIzaSyValidKey123456',
      'In functional analysis, a projection operator P satisfies P^2 = P.',
      {
        onChunk: (d) => deltas.push(d),
      },
    );

    expect(fetchSpy.mock.calls[0][0]).toContain(':streamGenerateContent?alt=sse');
    expect(res.translatedText).toBe('사영 작용소');
    expect(deltas).toEqual(['사영 ', '작용소']);
  });

  it('3. 1차 모델이 429(토큰/한도 초과) 또는 타임아웃 실패 시 폴백 모델 호출에는 과거 히스토리를 제거하고 최신 질문 + 핵심 문맥만 전송한다', async () => {
    const err429 = Object.assign(new Error('429 RESOURCE_EXHAUSTED: input token count exceeds limit'), {
      status: 429,
    });
    const capturedCalls: Array<{ model: string; contentsLen: number; systemLen: number }> = [];

    const generateContentStream = vi.fn().mockImplementation(async (params: any) => {
      capturedCalls.push({
        model: params.model,
        contentsLen: params.contents.length,
        systemLen: params.config.systemInstruction.length,
      });
      if (capturedCalls.length === 1) {
        throw err429;
      }
      return createAsyncStream([{ text: '경량화 폴백 응답 성공' }]);
    });

    const mockClient: GeminiClientLike = {
      models: { generateContentStream },
    };

    const messages = [
      { role: 'user' as const, content: '오래된 질문 1' },
      { role: 'assistant' as const, content: '오래된 답변 1' },
      { role: 'user' as const, content: '오래된 질문 2' },
      { role: 'assistant' as const, content: '오래된 답변 2' },
      { role: 'user' as const, content: '오래된 질문 3' },
      { role: 'user' as const, content: '최신 핵심 질문입니다' },
    ];
    const hugeNoteCtx = '노트본문_'.repeat(1500); // ~7,500자

    const chunks: string[] = [];
    for await (const c of streamGeminiTutor({
      apiKey: 'test-key',
      client: mockClient,
      messages,
      systemContext: hugeNoteCtx,
      retryDelayMs: 1,
    })) {
      chunks.push(c);
    }

    expect(chunks.join('')).toBe('경량화 폴백 응답 성공');
    expect(capturedCalls).toHaveLength(2);
    // 1차 호출: 6개 대화 + 전체 문맥
    expect(capturedCalls[0].contentsLen).toBe(6);
    expect(capturedCalls[0].systemLen).toBeGreaterThan(6000);
    // 2차 폴백 호출: 최신 1개 질문 + 3,000자 이하 경량 문맥
    expect(capturedCalls[1].contentsLen).toBe(1);
    expect(capturedCalls[1].systemLen).toBeLessThan(capturedCalls[0].systemLen);
    expect(capturedCalls[1].systemLen).toBeLessThanOrEqual(FALLBACK_NOTE_CONTEXT_CHARS + 1200);
  });

  it('4. 최종 실패 시 입력 토큰 초과 vs 분당 한도(RPM) 초과 vs 타임아웃 및 단계별 내역을 구체적으로 구분해 안내한다', () => {
    const tokenErr = Object.assign(new Error('400 Invalid argument: input token length exceeds maximum context length'), {
      status: 400,
    });
    const rpmErr = Object.assign(new Error('429 RESOURCE_EXHAUSTED: Quota exceeded for requests per minute (RPM)'), {
      status: 429,
    });
    const timeoutErr = new TimeoutError('first-chunk');

    const allTokenErr = new AllModelsFailedError(
      tokenErr,
      ['gemini-3.8-flash', 'gemini-3.6-flash'],
      [
        { model: 'gemini-3.8-flash', status: 400, summary: 'token limit', stage: 'primary' },
        { model: 'gemini-3.6-flash', status: 400, summary: 'token limit', stage: 'fallback-trimmed' },
      ],
    );

    expect(allTokenErr.diagnosedCause.category).toBe('input-too-long');
    expect(allTokenErr.message).toContain('1차:gemini-3.8-flash(400)');
    expect(allTokenErr.message).toContain('폴백경량:gemini-3.6-flash(400)');
    expect(allTokenErr.message).toContain('입력 길이');

    expect(getUserFacingErrorMessage(rpmErr)).toContain('분당 요청·토큰 한도');
    expect(getUserFacingErrorMessage(timeoutErr)).toContain('첫 토큰 스트리밍 응답 대기 시간 초과');
  });
});
