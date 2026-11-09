import { describe, it, expect, vi } from 'vitest';
import {
  buildGeminiStreamParams,
  formatGeminiError,
  isFatalHttpError,
  isRetryableHttpError,
  streamGeminiTutor,
  askGeminiTutor,
  type GeminiClientLike,
  type GeminiStreamChunkLike,
} from '../src/modules/ai/geminiClient';
import {
  GEMINI_PRIMARY_MODEL,
  GEMINI_FALLBACK_MODEL,
  ACADEMIC_TUTOR_SYSTEM_PROMPT,
} from '../src/modules/ai/constants';
import {
  AllModelsFailedError,
  classifyGeminiError,
} from '../src/modules/ai/errorMessages';

function createAsyncStream(chunks: GeminiStreamChunkLike[]): AsyncIterable<GeminiStreamChunkLike> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  };
}

describe('Gemini 503 재시도, Fallback 체인 및 스트림 브라우저 호환성 검증 스위트 (GEMINIAIPANELNORESPONSE_FIX §3)', () => {
  // 1. 주 모델 정상 → 첫 청크 통과, 본문 onChunk 순서 보장
  it('1. 주 모델 정상: 첫 청크 통과 및 본문 onChunk 순서 보장', async () => {
    const generateContentStream = vi.fn().mockResolvedValue(
      createAsyncStream([
        { text: '정상 ' },
        { text: '답변입니다.' },
      ]),
    );
    const mockClient: GeminiClientLike = { models: { generateContentStream } };
    const chunksCaptured: string[] = [];

    const output: string[] = [];
    for await (const chunk of streamGeminiTutor({
      prompt: '질문',
      apiKey: 'test-key',
      client: mockClient,
      retryDelayMs: 1,
      onChunk: (delta) => chunksCaptured.push(delta),
    })) {
      output.push(chunk);
    }

    expect(generateContentStream).toHaveBeenCalledTimes(1);
    expect(generateContentStream.mock.calls[0][0].model).toBe(GEMINI_PRIMARY_MODEL);
    expect(output.join('')).toBe('정상 답변입니다.');
    expect(chunksCaptured).toEqual(['정상 ', '답변입니다.']);
  });

  // 2. 주 모델 503 × 3 → 지수 백오프 재시도 후 다음 모델로 폴백
  it('2. 주 모델 503 × 3: 동일 모델 3회 재시도 소진 후 다음 모델로 폴백', async () => {
    const err503 = Object.assign(new Error('503 Server Unavailable: high demand'), { status: 503 });
    const generateContentStream = vi
      .fn()
      // Primary 모델: attempt 0, 1, 2 = 총 3회 실패
      .mockRejectedValueOnce(err503)
      .mockRejectedValueOnce(err503)
      .mockRejectedValueOnce(err503)
      // Fallback 모델: 1회차 성공
      .mockResolvedValueOnce(createAsyncStream([{ text: 'Fallback 모델 응답' }]));

    const mockClient: GeminiClientLike = { models: { generateContentStream } };

    const output: string[] = [];
    for await (const chunk of streamGeminiTutor({
      prompt: '질문',
      apiKey: 'test-key',
      client: mockClient,
      retryDelayMs: 1,
    })) {
      output.push(chunk);
    }

    expect(generateContentStream).toHaveBeenCalledTimes(4);
    expect(generateContentStream.mock.calls[0][0].model).toBe(GEMINI_PRIMARY_MODEL);
    expect(generateContentStream.mock.calls[1][0].model).toBe(GEMINI_PRIMARY_MODEL);
    expect(generateContentStream.mock.calls[2][0].model).toBe(GEMINI_PRIMARY_MODEL);
    expect(generateContentStream.mock.calls[3][0].model).toBe(GEMINI_FALLBACK_MODEL);
    expect(output.join('')).toBe('Fallback 모델 응답');
  });

  // 3. 주 모델 404 → 재시도 없이 즉시 다음 모델
  it('3. 주 모델 404: 재시도 없이 즉시 다음 Fallback 모델로 전환', async () => {
    const err404 = Object.assign(new Error('404 Model not found'), { status: 404 });
    const generateContentStream = vi
      .fn()
      .mockRejectedValueOnce(err404)
      .mockResolvedValueOnce(createAsyncStream([{ text: '즉시 폴백 성공' }]));

    const mockClient: GeminiClientLike = { models: { generateContentStream } };

    const output: string[] = [];
    for await (const chunk of streamGeminiTutor({
      prompt: '질문',
      apiKey: 'test-key',
      client: mockClient,
      retryDelayMs: 1,
    })) {
      output.push(chunk);
    }

    expect(generateContentStream).toHaveBeenCalledTimes(2);
    expect(generateContentStream.mock.calls[0][0].model).toBe(GEMINI_PRIMARY_MODEL);
    expect(generateContentStream.mock.calls[1][0].model).toBe(GEMINI_FALLBACK_MODEL);
    expect(output.join('')).toBe('즉시 폴백 성공');
  });

  // 4. 주 모델 400 → 재시도·폴백 없이 즉시 throw
  it('4. 주 모델 400: 재시도나 폴백 없이 즉시 fatal-request로 throw', async () => {
    const err400 = Object.assign(new Error('400 Bad Request: malformed JSON payload'), { status: 400 });
    const generateContentStream = vi.fn().mockRejectedValue(err400);
    const mockClient: GeminiClientLike = { models: { generateContentStream } };

    await expect(
      askGeminiTutor({
        prompt: '질문',
        apiKey: 'test-key',
        client: mockClient,
        retryDelayMs: 1,
      }),
    ).rejects.toThrow(/400/);

    expect(generateContentStream).toHaveBeenCalledTimes(1);
    expect(classifyGeminiError(err400)).toBe('fatal-request');
  });

  // 5. 401 / 403(free tier 문구) → 즉시 throw, 분류 결과 각각 fatal-auth / fatal-permission
  it('5. 401 및 403: 즉시 throw되며 각각 fatal-auth 및 fatal-permission으로 분류', async () => {
    const err401 = Object.assign(new Error('401 API_KEY_INVALID'), { status: 401 });
    const err403 = Object.assign(new Error('403 PERMISSION_DENIED: free tier unavailable'), { status: 403 });

    expect(classifyGeminiError(err401)).toBe('fatal-auth');
    expect(classifyGeminiError(err403)).toBe('fatal-permission');

    const mockClient401: GeminiClientLike = { models: { generateContentStream: vi.fn().mockRejectedValue(err401) } };
    await expect(
      askGeminiTutor({
        prompt: '질문',
        apiKey: 'test-key',
        client: mockClient401,
        retryDelayMs: 1,
      }),
    ).rejects.toThrow(/401/);

    expect(mockClient401.models.generateContentStream).toHaveBeenCalledTimes(1);
  });

  // 6. 모든 모델 실패 → AllModelsFailedError에 마지막 상태 코드·메시지·시도 모델 목록 포함
  it('6. 모든 모델 실패: AllModelsFailedError에 상태 코드, 메시지, 시도 모델 목록이 포함된다', async () => {
    const err503 = Object.assign(new Error('503 High Demand'), { status: 503 });
    const generateContentStream = vi.fn().mockRejectedValue(err503);
    const mockClient: GeminiClientLike = { models: { generateContentStream } };

    try {
      await askGeminiTutor({
        prompt: '질문',
        apiKey: 'test-key',
        client: mockClient,
        retryDelayMs: 1,
      });
      expect.fail('AllModelsFailedError가 발생해야 합니다.');
    } catch (e) {
      expect(e).toBeInstanceOf(AllModelsFailedError);
      const allErr = e as AllModelsFailedError;
      expect(allErr.lastStatusCode).toBe(503);
      expect(allErr.triedModels.length).toBeGreaterThanOrEqual(2);
      expect(allErr.triedModels).toContain(GEMINI_PRIMARY_MODEL);
    }
  });

  // 7. 첫 청크가 thought === true만 포함 → 성공 판정 후 본문 청크 수신
  it('7. 첫 청크가 thought === true만 포함: 성공 판정 후 본문 청크 정상 수신', async () => {
    const chunksWithThought: GeminiStreamChunkLike[] = [
      {
        candidates: [
          { content: { parts: [{ text: '깊이 생각하는 중...', thought: true }], role: 'model' } },
        ],
      },
      {
        text: '최종 본문 응답입니다.',
        candidates: [
          { content: { parts: [{ text: '최종 본문 응답입니다.' }], role: 'model' } },
        ],
      },
    ];

    const generateContentStream = vi.fn().mockResolvedValue(createAsyncStream(chunksWithThought));
    const mockClient: GeminiClientLike = { models: { generateContentStream } };

    const output: string[] = [];
    for await (const chunk of streamGeminiTutor({
      prompt: '질문',
      apiKey: 'test-key',
      client: mockClient,
      retryDelayMs: 1,
    })) {
      output.push(chunk);
    }

    expect(output.join('')).toBe('최종 본문 응답입니다.');
  });

  // 8. 스트림 생성은 성공하지만 첫 next()에서 503 throw(Lazy Throw) → 재시도 루프 안에서 처리됨
  it('8. Lazy Throw: 스트림 객체 생성 후 첫 next()에서 503이 발생해도 재시도 루프 안에서 처리된다', async () => {
    let callCount = 0;
    const generateContentStream = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // 첫 번째 호출: stream 객체는 반환하지만 첫 next()에서 503 throw
        return Promise.resolve({
          async *[Symbol.asyncIterator]() {
            throw Object.assign(new Error('503 Lazy Throw on first chunk'), { status: 503 });
          },
        });
      }
      // 재시도 호출: 정상 청크 반환
      return Promise.resolve(createAsyncStream([{ text: 'Lazy Throw 복구 성공' }]));
    });

    const mockClient: GeminiClientLike = { models: { generateContentStream } };

    const output: string[] = [];
    for await (const chunk of streamGeminiTutor({
      prompt: '질문',
      apiKey: 'test-key',
      client: mockClient,
      retryDelayMs: 1,
    })) {
      output.push(chunk);
    }

    expect(generateContentStream).toHaveBeenCalledTimes(2);
    expect(output.join('')).toBe('Lazy Throw 복구 성공');
  });
});
