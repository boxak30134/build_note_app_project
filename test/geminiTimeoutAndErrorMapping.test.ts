import { describe, it, expect, vi } from 'vitest';
import {
  extractHttpStatus,
  classifyGeminiError,
  extractRetryDelayMs,
  getUserFacingErrorMessage,
  maskApiKey,
  sanitizeLogMessage,
  TimeoutError,
} from '../src/modules/ai/errorMessages';
import {
  streamGeminiTutor,
  waitWithBackoffAndJitter,
  withTimeout,
  type GeminiClientLike,
  type GeminiStreamChunkLike,
} from '../src/modules/ai/geminiClient';
import { GEMINI_PRIMARY_MODEL, GEMINI_FALLBACK_MODEL } from '../src/modules/ai/constants';

function createAsyncStream(chunks: GeminiStreamChunkLike[]): AsyncIterable<GeminiStreamChunkLike> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  };
}

describe('Gemini 타임아웃, 에러 매핑 및 취소 제어 검증 스위트 (GEMINIAIPANELNORESPONSE_FIX §3)', () => {
  // 1. 첫 next()가 영원히 pending → FIRST_CHUNK_TIMEOUT_MS 후 timeout 분류 → 재시도 진행
  it('1. 첫 next()가 무응답 pending 상태이면 firstChunkTimeoutMs 후 timeout 분류되어 재시도한다', async () => {
    let attempts = 0;
    const generateContentStream = vi.fn().mockImplementation(() => {
      attempts++;
      if (attempts === 1) {
        // 첫 번째 시도: 영원히 완료되지 않는 pending 스트림
        return Promise.resolve({
          [Symbol.asyncIterator]() {
            return {
              next: () => new Promise<IteratorResult<GeminiStreamChunkLike>>(() => {}),
            };
          },
        });
      }
      // 재시도: 성공 응답 반환
      return Promise.resolve(createAsyncStream([{ text: '타임아웃 후 재시도 성공' }]));
    });

    const mockClient: GeminiClientLike = { models: { generateContentStream } };

    const output: string[] = [];
    for await (const chunk of streamGeminiTutor({
      prompt: '질문',
      apiKey: 'test-key',
      client: mockClient,
      firstChunkTimeoutMs: 50, // 테스트용 단축 50ms
      retryDelayMs: 1,
    })) {
      output.push(chunk);
    }

    expect(attempts).toBe(2);
    expect(output.join('')).toBe('타임아웃 후 재시도 성공');
  });

  // 2. 본문 2청크 수신 후 pending → CHUNK_GAP_TIMEOUT_MS 후 중간 끊김 처리, 재시도 없음, 받은 텍스트 유지
  it('2. 본문 수신 중 청크 간 무응답 발생 시 중간 끊김 처리하고 기수신 텍스트를 온전히 유지한다', async () => {
    const generateContentStream = vi.fn().mockImplementation(() => {
      let chunkIdx = 0;
      return Promise.resolve({
        [Symbol.asyncIterator]() {
          return {
            next: () => {
              chunkIdx++;
              if (chunkIdx === 1) {
                return Promise.resolve({ value: { text: '첫 번째 단락 ' }, done: false });
              }
              if (chunkIdx === 2) {
                return Promise.resolve({ value: { text: '두 번째 단락 ' }, done: false });
              }
              // 3번째 청크는 영원히 pending
              return new Promise<IteratorResult<GeminiStreamChunkLike>>(() => {});
            },
          };
        },
      });
    });

    const mockClient: GeminiClientLike = { models: { generateContentStream } };

    const output: string[] = [];
    for await (const chunk of streamGeminiTutor({
      prompt: '질문',
      apiKey: 'test-key',
      client: mockClient,
      chunkGapTimeoutMs: 50, // 테스트용 50ms
      retryDelayMs: 1,
    })) {
      output.push(chunk);
    }

    // 재시도 없이 1회만 호출되어야 함 (이미 본문이 나갔으므로)
    expect(generateContentStream).toHaveBeenCalledTimes(1);
    const combined = output.join('');
    expect(combined).toContain('첫 번째 단락');
    expect(combined).toContain('두 번째 단락');
    expect(combined).toContain('[알림: 응답이 중간에 끊어졌습니다]');
  });

  // 3. 백오프 대기 중 abort() → 타이머 해제, 50ms 이내 reject, 후속 요청 없음
  it('3. 백오프 대기 중 abort() 발생 시 타이머가 즉시 해제되고 신속히 중단된다', async () => {
    const controller = new AbortController();
    const t0 = Date.now();

    const waitPromise = waitWithBackoffAndJitter(2, 5000, controller.signal);
    // 10ms 후 즉시 abort
    setTimeout(() => controller.abort(), 10);

    await expect(waitPromise).rejects.toThrow();
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(100); // 5000ms가 아닌 100ms 이내에 즉시 중단되어야 함
  });

  // 4. 스트리밍 중 abort() → 이터레이션 중단, 상태 cancelled, 에러 throw 없음
  it('4. 스트리밍 중 abort() 발생 시 에러 throw 없이 정상적으로 스트림이 중단된다', async () => {
    const controller = new AbortController();
    let chunkCount = 0;

    const generateContentStream = vi.fn().mockImplementation(() => {
      return Promise.resolve({
        async *[Symbol.asyncIterator]() {
          yield { text: '1' };
          yield { text: '2' };
          controller.abort(); // 스트리밍 도중 중단 트리거
          yield { text: '3' };
        },
      });
    });

    const mockClient: GeminiClientLike = { models: { generateContentStream } };
    const output: string[] = [];

    // 스트림이 throw하지 않고 완료되어야 함
    for await (const chunk of streamGeminiTutor({
      prompt: '질문',
      apiKey: 'test-key',
      client: mockClient,
      signal: controller.signal,
    })) {
      output.push(chunk);
      chunkCount++;
    }

    expect(chunkCount).toBeLessThan(3);
  });

  // 5. extractHttpStatus가 세 가지 에러 형태 모두에서 올바른 코드 반환
  it('5. extractHttpStatus가 세 가지 형태({ status }, { error: { code } }, 문자열)에서 올바른 상태 코드를 반환한다', () => {
    // 형태 1: { status: 503 }
    expect(extractHttpStatus({ status: 503, message: 'High demand' })).toBe(503);

    // 형태 2: { error: { code: 429, message: 'Quota exceeded' } }
    expect(extractHttpStatus({ error: { code: 429, message: 'Resource exhausted' } })).toBe(429);

    // 형태 3: 문자열에 code: 503 또는 [404]
    expect(extractHttpStatus(new Error('API error {"code": 503, "status": "UNAVAILABLE"}'))).toBe(503);
    expect(extractHttpStatus(new Error('[404 Not Found] Model models/gemini-2.5-flash is not found'))).toBe(404);
    expect(extractHttpStatus(new Error('503 Service Unavailable'))).toBe(503);

    expect(extractHttpStatus(null)).toBeNull();
    expect(extractHttpStatus('단순 텍스트 오류')).toBeNull();
  });

  // 6. 429 + retryDelay: '5s' → 5초 대기(백오프 계산값 무시)
  it('6. 429 응답의 retryDelay 필드를 올바르게 파싱한다 (상한 10초 적용)', () => {
    expect(extractRetryDelayMs(new Error('429 Quota exceeded, retryDelay: "5s"'))).toBe(5000);
    expect(extractRetryDelayMs(new Error('429 Quota exceeded, retryDelay: "2.5s"'))).toBe(2500);
    expect(extractRetryDelayMs(new Error('429 Quota exceeded, retryDelay: "15s"'))).toBe(10000); // 10초 상한
    expect(extractRetryDelayMs(new Error('Retry-After: 4'))).toBe(4000);
    expect(extractRetryDelayMs(new Error('일반 429 에러'))).toBeNull();
  });

  // 7. 에러 메시지와 콘솔 로그 어디에도 원문 API Key가 없음(정규식 검사)
  it('7. 에러 메시지 및 로그에서 원문 API Key가 전수 마스킹된다', () => {
    const mockApiKey1 = 'AIzaSyMockTestKeyForMaskingVerification12345';
    const mockApiKey2 = 'AQ.MockTestKeyForMaskingVerification12345';

    expect(maskApiKey(mockApiKey1)).not.toBe(mockApiKey1);
    expect(maskApiKey(mockApiKey1)).toBe('AIzaS...2345');

    const errorMsgWithKey = `Failed to authenticate with key ${mockApiKey1} at endpoint https://... key=${mockApiKey2}`;
    const sanitized = sanitizeLogMessage(errorMsgWithKey);

    expect(sanitized).not.toContain(mockApiKey1);
    expect(sanitized).not.toContain(mockApiKey2);
    expect(sanitized).toContain('AIzaS...2345');
    expect(sanitized).toContain('AQ.Mo...2345');
  });

  // 8. 전체 예산 90초 초과 시 남은 모델을 시도하지 않고 종료
  it('8. 전체 요청 예산(totalBudgetMs)을 초과하면 남은 모델과 재시도를 중단하고 TimeoutError를 던진다', async () => {
    const err503 = Object.assign(new Error('503 High demand'), { status: 503 });
    const generateContentStream = vi.fn().mockImplementation(async () => {
      // 30ms 소요되도록 지연
      await new Promise((r) => setTimeout(r, 30));
      throw err503;
    });

    const mockClient: GeminiClientLike = { models: { generateContentStream } };

    await expect(
      streamGeminiTutor({
        prompt: '질문',
        apiKey: 'test-key',
        client: mockClient,
        totalBudgetMs: 50, // 50ms 예산
        retryDelayMs: 10,
      }).next(),
    ).rejects.toThrow(TimeoutError);
  });
});

