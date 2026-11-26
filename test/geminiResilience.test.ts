// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildGeminiFallbackChain,
  callGeminiWithResilience,
  GEMINI_BACKOFF_JITTER_MAX_MS,
  GEMINI_BACKOFF_SCHEDULE_MS,
  waitWithExponentialBackoff,
  type GeminiResilienceStatus,
} from '../src/services/geminiResilience';
import { executeFriendlyTranslation } from '../src/services/friendlyTranslationService';
import { getUserFacingErrorMessage } from '../src/modules/ai/errorMessages';

describe('Gemini 단일 회복탄력성 레이어 (직렬 큐 · 백오프 · 모델 폴백)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('1. 기본 모델별 현행 GA 폴백 체인을 생성하며 3.x 기본 체인에 2.5 레거시를 포함하지 않는다', () => {
    expect(buildGeminiFallbackChain('gemini-3.8-flash')).toEqual([
      'gemini-3.8-flash',
      'gemini-3.6-flash',
      'gemini-3.5-flash-lite',
      'gemini-4-hydrogen',
      'gemini-flash-lite-latest',
    ]);
    expect(buildGeminiFallbackChain('gemini-3.6-flash')).toEqual([
      'gemini-3.6-flash',
      'gemini-3.8-flash',
      'gemini-3.5-flash-lite',
      'gemini-4-hydrogen',
      'gemini-flash-lite-latest',
    ]);
    expect(buildGeminiFallbackChain('gemini-2.5-flash')).toEqual([
      'gemini-2.5-flash',
      'gemini-3.5-flash-lite',
      'gemini-3.8-flash',
      'gemini-3.6-flash',
    ]);
    expect(buildGeminiFallbackChain('gemini-3.8-flash', false)).toEqual(['gemini-3.8-flash']);
  });

  it('2. 503/429 발생 시 다음 재시도부터 현행 GA 폴백 모델로 자동 전환하고 상태 콜백을 전달한다', async () => {
    const triedModels: string[] = [];
    const statuses: GeminiResilienceStatus[] = [];

    const err503 = Object.assign(new Error('503 Service Unavailable'), { status: 503 });
    const err429 = Object.assign(new Error('429 RESOURCE_EXHAUSTED'), { status: 429 });

    const res = await callGeminiWithResilience(
      async (model) => {
        triedModels.push(model);
        if (triedModels.length === 1) throw err503;
        if (triedModels.length === 2) throw err429;
        return '최종 폴백 성공';
      },
      {
        primaryModel: 'gemini-3.8-flash',
        retryDelayMs: 1,
        onStatusChange: (s) => statuses.push(s),
      },
    );

    expect(triedModels).toEqual(['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite']);
    expect(res.value).toBe('최종 폴백 성공');
    expect(res.model).toBe('gemini-3.5-flash-lite');
    expect(res.requestedModel).toBe('gemini-3.8-flash');
    expect(res.usedFallback).toBe(true);
    expect(res.attempts).toBe(3);

    expect(statuses.some((s) => s.phase === 'retrying' && s.attempt === 1 && s.message.includes('1/3'))).toBe(true);
    expect(statuses.some((s) => s.phase === 'retrying' && s.attempt === 2 && s.message.includes('2/3'))).toBe(true);
    expect(statuses.some((s) => s.phase === 'fallback' && s.model === 'gemini-3.6-flash')).toBe(true);
    expect(statuses.some((s) => s.phase === 'fallback' && s.model === 'gemini-3.5-flash-lite')).toBe(true);
  });

  it('3. 지수 백오프 + 지터 스케줄(1s -> 2.5s -> 5s + 0~300ms)을 정확히 준수한다', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // 150ms jitter

    const resolvedDelays: number[] = [];
    for (let idx = 0; idx < GEMINI_BACKOFF_SCHEDULE_MS.length; idx++) {
      const p = waitWithExponentialBackoff(idx);
      await vi.runAllTimersAsync();
      resolvedDelays.push(await p);
    }

    expect(GEMINI_BACKOFF_JITTER_MAX_MS).toBe(300);
    expect(resolvedDelays).toEqual([1150, 2650, 5150]);
  });

  it('4. 401/403 API 키 오류 및 안전 정책 차단 등 영구 오류는 재시도/폴백 없이 즉시 중단한다', async () => {
    const err401 = Object.assign(new Error('401 API_KEY_INVALID'), { status: 401 });
    const execAuth = vi.fn().mockRejectedValue(err401);
    await expect(
      callGeminiWithResilience(execAuth, { primaryModel: 'gemini-2.5-pro', retryDelayMs: 1 }),
    ).rejects.toThrow();
    expect(execAuth).toHaveBeenCalledTimes(1);
    expect(getUserFacingErrorMessage(err401)).toContain('API Key가 유효하지 않습니다');

    const safetyErr = new Error('SAFETY: Blocked by policy');
    const execSafety = vi.fn().mockRejectedValue(safetyErr);
    await expect(
      callGeminiWithResilience(execSafety, { primaryModel: 'gemini-2.5-pro', retryDelayMs: 1 }),
    ).rejects.toThrow();
    expect(execSafety).toHaveBeenCalledTimes(1);
    expect(getUserFacingErrorMessage(safetyErr)).toContain('안전 정책');
  });

  it('5. 동시 요청을 내부 FIFO 직렬 큐에 넣어 순차 처리하여 RPM 초과를 방지한다', async () => {
    let active = 0;
    let maxActive = 0;
    const order: number[] = [];

    const makeJob = (id: number, delayMs: number) =>
      callGeminiWithResilience(
        async () => {
          active++;
          maxActive = Math.max(maxActive, active);
          await new Promise((r) => setTimeout(r, delayMs));
          order.push(id);
          active--;
          return id;
        },
        { primaryModel: 'gemini-2.5-flash', retryDelayMs: 1 },
      );

    const results = await Promise.all([makeJob(1, 25), makeJob(2, 10), makeJob(3, 5)]);
    expect(maxActive).toBe(1);
    expect(order).toEqual([1, 2, 3]);
    expect(results.map((r) => r.value)).toEqual([1, 2, 3]);
  });

  it('6. 인앱 번역(executeFriendlyTranslation)도 callGeminiWithResilience를 거쳐 503 시 현행 GA 모델로 폴백 성공한다', async () => {
    const calledUrls: string[] = [];
    const statuses: GeminiResilienceStatus[] = [];

    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      calledUrls.push(url);
      if (url.includes('gemini-3.5-flash-lite:')) {
        return {
          ok: false,
          status: 503,
          json: async () => ({ error: { message: 'overloaded' } }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: '위상수학' }] } }],
        }),
      };
    });

    const res = await executeFriendlyTranslation({
      text: 'topology',
      surroundingSentence: 'Topology studies continuous deformations.',
      geminiApiKey: 'AIzaSyValidTestKey123456',
      retryDelayMs: 1,
      onStatusChange: (s) => statuses.push(s),
    });

    expect(res.success).toBe(true);
    expect(res.engine).toBe('gemini');
    expect(res.translatedText).toBe('위상수학');
    expect(res.model).toBe('gemini-3.8-flash');
    expect(res.usedFallback).toBe(true);
    expect(calledUrls.some((u) => u.includes('gemini-3.5-flash-lite:streamGenerateContent'))).toBe(true);
    expect(calledUrls.some((u) => u.includes('gemini-3.8-flash:streamGenerateContent'))).toBe(true);
    expect(statuses.some((s) => s.phase === 'retrying')).toBe(true);
  });

  it('7. 모든 모델 실패 시 AllModelsFailedError가 모델별 상태 코드 요약을 보존한다', async () => {
    await expect(
      callGeminiWithResilience(
        async (model) => {
          if (model === 'gemini-3.6-flash') {
            throw Object.assign(new Error('503 overloaded'), { status: 503 });
          }
          throw Object.assign(new Error(`404 ${model} not found`), { status: 404 });
        },
        {
          primaryModel: 'gemini-3.6-flash',
          retryDelayMs: 1,
        },
      ),
    ).rejects.toMatchObject({
      name: 'AllModelsFailedError',
      message: expect.stringContaining('gemini-3.6-flash(503)'),
      attemptFailures: expect.arrayContaining([
        expect.objectContaining({ model: 'gemini-3.6-flash', status: 503 }),
        expect.objectContaining({ model: 'gemini-3.8-flash', status: 404 }),
      ]),
    });
  });
});
