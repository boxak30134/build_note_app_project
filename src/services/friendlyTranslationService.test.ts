// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  executeFriendlyTranslation,
} from './friendlyTranslationService';

describe('friendlyTranslationService (Zero-Config + Gemini Flash 하이브리드)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('Tier 1: localMeaning이 주어지면 네트워크 요청 없이 즉시 로컬 엔진 결과를 반환한다', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const res = await executeFriendlyTranslation({
      text: 'ring',
      surroundingSentence: 'A ring is an abelian group.',
      geminiApiKey: 'some-key',
      localMeaning: '환(環)',
    });

    expect(res.success).toBe(true);
    expect(res.translatedText).toBe('환(環)');
    expect(res.engine).toBe('local');
    expect(res.confidence).toBe(98);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('Tier 2: Gemini API Key가 있으면 Gemini API를 호출하여 번역한다', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [{ text: '다양체' }],
            },
          },
        ],
      }),
    });

    const res = await executeFriendlyTranslation({
      text: 'manifold',
      surroundingSentence: 'In differential geometry, a manifold is a topological space.',
      geminiApiKey: 'valid-gemini-key',
    });

    expect(res.success).toBe(true);
    expect(res.translatedText).toBe('다양체');
    expect(res.engine).toBe('gemini');
    expect(res.confidence).toBe(95);
  });

  it('Tier 2 실패 시 중단되지 않고 Tier 3 공개 무키 엔진으로 자동 폴백한다', async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      callCount++;
      if (typeof url === 'string' && url.includes('generativelanguage.googleapis.com')) {
        // Gemini 호출 실패 (예: 403 Forbidden)
        return {
          ok: false,
          status: 403,
          json: async () => ({ error: { message: 'The provided API key has expired.' } }),
        };
      }
      // Tier 3 공개 gtx 엔드포인트 성공
      return {
        ok: true,
        json: async () => [[['사과', 'apple', null, null]]],
      };
    });

    const res = await executeFriendlyTranslation({
      text: 'apple',
      surroundingSentence: 'I eat an apple.',
      geminiApiKey: 'expired-gemini-key',
    });

    expect(res.success).toBe(true);
    expect(res.translatedText).toBe('사과');
    expect(res.engine).toBe('public_free');
    expect(callCount).toBe(2);
  });

  it('Tier 3: API Key가 전혀 없는 상태(Zero-Config)에서도 공개 엔드포인트로 즉시 번역한다', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [[['바나나', 'banana', null, null]]],
    });

    const res = await executeFriendlyTranslation({
      text: 'banana',
      surroundingSentence: 'A yellow banana.',
      geminiApiKey: null,
    });

    expect(res.success).toBe(true);
    expect(res.translatedText).toBe('바나나');
    expect(res.engine).toBe('public_free');
    expect(res.confidence).toBe(85);
  });
});
