import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UnifiedTranslator } from './UnifiedTranslator';
import { db } from '../storage/db';

describe('UnifiedTranslator (Hybrid Translation Engine)', () => {
  let translator: UnifiedTranslator;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    vi.restoreAllMocks();
    translator = new UnifiedTranslator();
    try {
      await db.glossaryStats.clear();
    } catch {
      // test environment
    }
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('Tier 1: Local Adaptive Engine', () => {
    it('추상대수학 문맥의 ring을 네트워크/API 호출 없이 1ms 이내에 환(環)으로 오프라인 즉시 판별한다', async () => {
      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy;

      const start = performance.now();
      const res = await translator.translate({
        targetText: 'ring',
        surroundingSentence: 'In abstract algebra, a ring is a set equipped with two binary operations.',
        documentTags: ['대수학'],
        apiKey: null,
      });
      const duration = performance.now() - start;

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(duration).toBeLessThan(50); // fast local resolution
      expect(res.success).toBe(true);
      expect(res.translatedText).toBe('환(環)');
      expect(res.source).toBe('local_seed');
      expect(res.confidence).toBeGreaterThanOrEqual(70);
      expect(res.matchedTrigger).toBe('abstract algebra');
    });

    it('단어의 복수형(rings) 또는 구두점(ring,)이 포함되어도 정규화하여 올바른 번역어를 판별한다', async () => {
      const res1 = await translator.translate({
        targetText: 'rings',
        surroundingSentence: 'Commutative rings form the basis of algebraic geometry.',
        apiKey: null,
      });
      expect(res1.success).toBe(true);
      expect(res1.translatedText).toBe('환(環)');

      const res2 = await translator.translate({
        targetText: 'ring,',
        surroundingSentence: 'Let R be a ring, then an ideal I is...',
        apiKey: null,
      });
      expect(res2.success).toBe(true);
      expect(res2.translatedText).toBe('환(環)');
    });

    it('사용자가 피드백/학습한 단어는 Tier 1 local_learned 소스로 승격되어 즉시 반환된다', async () => {
      const learnedRec = translator.createLearningRecord(
        'sheaf',
        '층(層)',
        'A sheaf on a topological space is determined by its stalks and sections.'
      );
      learnedRec.selectionCount = 2;
      await translator.saveLearningRecord(learnedRec);

      const res = await translator.translate({
        targetText: 'sheaf',
        surroundingSentence: 'The structure sheaf associates rings to open sets on the space.',
        apiKey: null,
      });

      expect(res.success).toBe(true);
      expect(res.translatedText).toBe('층(層)');
      expect(res.source).toBe('local_learned');
      expect(res.confidence).toBeGreaterThanOrEqual(70);
    });
  });

  describe('Tier 2: BYOK Google Cloud Translation API', () => {
    it('Zero-Config: API Key가 없는 상태에서 일반 단어(apple) 번역 시 Tier 3 공개 무키 엔진으로 즉시 번역을 완료한다', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [[['사과', 'apple', null, null]]],
      });

      const res = await translator.translate({
        targetText: 'apple',
        surroundingSentence: 'She ate a delicious apple.',
        apiKey: null,
      });

      expect(res.success).toBe(true);
      expect(res.translatedText).toBe('사과');
      expect(res.source).toBe('public_free');
    });

    it('통문장 번역 요청 시 유효한 API Key로 Google REST API를 호출하여 번역 결과를 반환한다', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            translations: [{ translatedText: '&quot;이 문장은 보조정리를 증명합니다.&quot;' }],
          },
        }),
      });
      globalThis.fetch = mockFetch;

      const res = await translator.translate({
        targetText: 'This sentence proves the lemma.',
        surroundingSentence: 'This sentence proves the lemma. Hence Q.E.D.',
        apiKey: 'test-api-key-1234',
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toContain('https://translation.googleapis.com/language/translate/v2');
      expect(url).toContain('test-api-key-1234');
      expect(JSON.parse(opts.body)).toEqual({
        q: 'This sentence proves the lemma.',
        target: 'ko',
        format: 'text',
      });

      expect(res.success).toBe(true);
      expect(res.translatedText).toBe('"이 문장은 보조정리를 증명합니다."');
      expect(res.source).toBe('google_api');
      expect(res.confidence).toBe(90);
    });

    it('유효하지 않은 API 키 응답(400/403 API key not valid) 시 INVALID_KEY 코드로 정규화한다', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({
          error: { message: 'API key not valid. Please pass a valid API key.' },
        }),
      });

      const res = await translator.translate({
        targetText: 'hypothesis',
        surroundingSentence: 'We consider the Riemann hypothesis.',
        apiKey: 'invalid-key',
      });

      expect(res.success).toBe(false);
      expect(res.errorCode).toBe('INVALID_KEY');
      expect(res.errorMessage).toContain('등록된 API 키가 유효하지 않습니다');
    });

    it('만료되었거나 권한이 없는 키(403 PERMISSION_DENIED) 시 EXPIRED_KEY 코드로 정규화한다', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({
          error: { message: 'PERMISSION_DENIED: Cloud Translation API has not been used in project' },
        }),
      });

      const res = await translator.translate({
        targetText: 'general manifold structure',
        surroundingSentence: 'A general manifold structure is locally Euclidean.',
        apiKey: 'expired-or-denied-key',
      });

      expect(res.success).toBe(false);
      expect(res.errorCode).toBe('EXPIRED_KEY');
      expect(res.errorMessage).toContain('만료');
    });

    it('할당량 초과(403 RESOURCE_EXHAUSTED) 시 QUOTA_EXCEEDED 코드로 정규화한다', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({
          error: { message: 'RESOURCE_EXHAUSTED: Quota exceeded for quota metric' },
        }),
      });

      const res = await translator.translate({
        targetText: 'tensor',
        surroundingSentence: 'A tensor product of vector spaces.',
        apiKey: 'quota-exceeded-key',
      });

      expect(res.success).toBe(false);
      expect(res.errorCode).toBe('QUOTA_EXCEEDED');
      expect(res.errorMessage).toContain('할당량');
    });

    it('네트워크 오프라인 예외 발생 시 NETWORK_ERROR 코드로 정규화한다', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Failed to fetch'));

      const res = await translator.translate({
        targetText: 'quantum mechanics',
        surroundingSentence: 'Quantum mechanics is a fundamental theory in physics.',
        apiKey: 'valid-key-but-offline',
      });

      expect(res.success).toBe(false);
      expect(res.errorCode).toBe('NETWORK_ERROR');
      expect(res.errorMessage).toContain('오프라인');
    });
  });
});
