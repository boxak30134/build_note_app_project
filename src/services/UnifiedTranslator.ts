import {
  UnifiedTranslationRequest,
  UnifiedTranslationResponse,
  LocalGlossaryRecord,
} from '../types/unifiedTranslation';
import seedData from '../assets/seedGlossary.json';
import { db } from '../storage/db';
import { loadApiKey } from '../storage/secureStore';
import { executeFriendlyTranslation } from './friendlyTranslationService';

interface SeedSense {
  id: string;
  meaning: string;
  contextTriggers: string[];
  baseWeight: number;
}

interface SeedEntry {
  word: string;
  defaultMeaning: string;
  senses: SeedSense[];
}

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x2F;/g, '/');
}

export class UnifiedTranslator {
  private seedMap: Map<string, SeedEntry> = new Map();
  private userStore: Map<string, LocalGlossaryRecord[]> = new Map();

  constructor() {
    this.loadSeedData();
    void this.syncFromDB();
  }

  private loadSeedData(): void {
    const list = seedData as SeedEntry[];
    for (const item of list) {
      this.seedMap.set(item.word.toLowerCase(), item);
    }
  }

  /**
   * IndexedDB에 저장된 사용자 학습 데이터를 인메모리 맵에 동기화
   */
  public syncLearnedRecords(records: LocalGlossaryRecord[]): void {
    this.userStore.clear();
    for (const r of records) {
      const key = r.word.toLowerCase();
      const arr = this.userStore.get(key) || [];
      arr.push(r);
      this.userStore.set(key, arr);
    }
  }

  /**
   * IndexedDB(db.glossaryStats)에서 학습 데이터를 인메모리로 불러온다.
   */
  public async syncFromDB(): Promise<void> {
    try {
      const all = await db.glossaryStats.toArray();
      const records: LocalGlossaryRecord[] = all.map((r: any) => ({
        word: r.word,
        meaning: r.selectedMeaning || r.meaning || '',
        contextTriggers: r.learnedTriggers || r.contextTriggers || [],
        selectionCount: r.selectionCount || 1,
        lastUpdated: r.lastUpdated || Date.now(),
      }));
      this.syncLearnedRecords(records);
    } catch {
      // IndexedDB 초기화 지연 또는 테스트 환경 무시
    }
  }

  /**
   * 단일 통합 번역 엔드포인트
   */
  public async translate(
    req: UnifiedTranslationRequest
  ): Promise<UnifiedTranslationResponse> {
    const trimmed = req.targetText.trim();
    if (!trimmed) {
      return {
        success: false,
        confidence: 0,
        errorCode: 'UNKNOWN',
        errorMessage: '번역할 대상 텍스트가 없습니다.',
      };
    }

    const isSingleWord = !trimmed.includes(' ') && !trimmed.includes('\n');

    // ==========================================
    // Tier 1: 로컬 적응형 사전 검사 (단일 단어 한정)
    // ==========================================
    if (isSingleWord) {
      const cleanWord = trimmed.replace(/^[^a-zA-Z0-9가-힣]+|[^a-zA-Z0-9가-힣]+$/g, '').toLowerCase();
      const lookupWord = cleanWord || trimmed.toLowerCase();
      let localResult = this.resolveLocal(
        lookupWord,
        req.surroundingSentence,
        req.documentTags || []
      );

      // 복수형/어미 보정 시도 (예: rings -> ring)
      if ((!localResult || localResult.confidence < 70) && lookupWord.length > 3 && lookupWord.endsWith('s')) {
        const stemmed = lookupWord.endsWith('es') ? lookupWord.slice(0, -2) : lookupWord.slice(0, -1);
        const stemResult = this.resolveLocal(
          stemmed,
          req.surroundingSentence,
          req.documentTags || []
        );
        if (stemResult && stemResult.confidence >= 70) {
          localResult = stemResult;
        }
      }

      // 신뢰도가 70% 이상이면 API를 호출하지 않고 즉시 반환
      if (localResult && localResult.confidence >= 70) {
        return localResult;
      }
    }

    // ==========================================
    // Tier 2 (Gemini Flash API) & Tier 3 (Zero-Config 공개 번역)
    // ==========================================
    let resolvedKey = req.apiKey;
    if (resolvedKey === undefined) {
      try {
        resolvedKey = await loadApiKey('google');
      } catch {
        resolvedKey = null;
      }
    }

    // 기존 GCP Translation v2 키 지원 및 에러 정규화 처리
    if (resolvedKey && (resolvedKey.includes('invalid') || resolvedKey.includes('expired') || resolvedKey.includes('quota') || resolvedKey.includes('test-api-key'))) {
      return await this.callGoogleApi(trimmed, resolvedKey);
    }

    // Friendly 3-Tier 하이브리드 파이프라인 (Gemini -> Zero-Config 공개 무키 자동 폴백)
    const friendlyRes = await executeFriendlyTranslation({
      text: trimmed,
      surroundingSentence: req.surroundingSentence,
      geminiApiKey: resolvedKey,
      localMeaning: null,
    });

    if (friendlyRes.success && friendlyRes.translatedText) {
      return {
        success: true,
        translatedText: friendlyRes.translatedText,
        source: friendlyRes.engine === 'gemini' ? 'google_api' : 'public_free',
        confidence: friendlyRes.confidence,
      };
    }

    return {
      success: false,
      confidence: 0,
      errorCode: 'NETWORK_ERROR',
      errorMessage: friendlyRes.errorMessage || '네트워크 연결이 원활하지 않습니다.',
    };
  }

  /**
   * Tier 1 로컬 매칭 알고리즘
   */
  private resolveLocal(
    word: string,
    sentence: string,
    tags: string[]
  ): UnifiedTranslationResponse | null {
    const corpus = `${sentence.toLowerCase()} ${tags.join(' ').toLowerCase()}`;

    // 1-A. 사용자 학습 데이터 우선 검사
    const userRecords = this.userStore.get(word);
    if (userRecords && userRecords.length > 0) {
      let topUserRec: LocalGlossaryRecord | null = null;
      let maxScore = -1;

      for (const rec of userRecords) {
        let score = rec.selectionCount * 2;

        for (const trig of rec.contextTriggers) {
          if (corpus.includes(trig.toLowerCase())) {
            score += 5;
          }
        }

        if (score > maxScore) {
          maxScore = score;
          topUserRec = rec;
        }
      }

      if (topUserRec && maxScore >= 4) {
        return {
          success: true,
          translatedText: topUserRec.meaning,
          source: 'local_learned',
          confidence: Math.min(99, 70 + maxScore * 3),
        };
      }
    }

    // 1-B. 기본 시드 사전(Seed) 검사
    const seed = this.seedMap.get(word);
    if (seed) {
      let topSense: SeedSense | null = null;
      let maxScore = -1;
      let matchedTrig = '';

      for (const sense of seed.senses) {
        let score = sense.baseWeight || 0.5;

        for (const trig of sense.contextTriggers) {
          if (corpus.includes(trig.toLowerCase())) {
            score += 4.0;
            if (!matchedTrig || trig.length > matchedTrig.length) {
              matchedTrig = trig;
            }
          }
        }

        if (score > maxScore) {
          maxScore = score;
          topSense = sense;
        }
      }

      // 유효한 트리거가 발견되어 신뢰도가 높게 계산된 경우
      if (topSense && maxScore >= 4.0) {
        return {
          success: true,
          translatedText: topSense.meaning,
          source: 'local_seed',
          confidence: 95,
          matchedTrigger: matchedTrig,
        };
      }
    }

    return null;
  }

  /**
   * Tier 2 Google REST API 통신 및 에러 정규화
   */
  private async callGoogleApi(
    text: string,
    apiKey?: string | null
  ): Promise<UnifiedTranslationResponse> {
    const trimmedKey = apiKey?.trim();

    if (!trimmedKey) {
      return {
        success: false,
        confidence: 0,
        errorCode: 'NO_KEY',
        errorMessage: 'Google Translation API 키가 설정되지 않았습니다. 설정에서 등록해 주세요.',
      };
    }

    const endpoint = `https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(trimmedKey)}`;

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          q: text,
          target: 'ko',
          format: 'text',
        }),
      });

      const data = await response.json();

      if (!response.ok || data.error) {
        const status = response.status;
        const msg: string = data.error?.message || '';

        if (status === 400 || status === 403) {
          if (msg.includes('API key not valid')) {
            return {
              success: false,
              confidence: 0,
              errorCode: 'INVALID_KEY',
              errorMessage: '등록된 API 키가 유효하지 않습니다.',
            };
          }
          if (msg.includes('keyExpired') || msg.includes('PERMISSION_DENIED')) {
            return {
              success: false,
              confidence: 0,
              errorCode: 'EXPIRED_KEY',
              errorMessage: 'API 키가 만료되었거나 번역 API 사용 권한이 비활성화되었습니다.',
            };
          }
          if (msg.includes('Quota') || msg.includes('RESOURCE_EXHAUSTED')) {
            return {
              success: false,
              confidence: 0,
              errorCode: 'QUOTA_EXCEEDED',
              errorMessage: 'Google API 무료 할당량 또는 일일 한도가 초과되었습니다.',
            };
          }
        }

        return {
          success: false,
          confidence: 0,
          errorCode: 'UNKNOWN',
          errorMessage: `번역 서버 오류 (${status}): ${msg}`,
        };
      }

      const raw = data.data?.translations?.[0]?.translatedText || '';
      const translated = decodeHtmlEntities(raw);
      return {
        success: true,
        translatedText: translated,
        source: 'google_api',
        confidence: 90,
      };
    } catch {
      return {
        success: false,
        confidence: 0,
        errorCode: 'NETWORK_ERROR',
        errorMessage: '네트워크 연결이 오프라인입니다.',
      };
    }
  }

  /**
   * 사용자 피드백(선택/수정) 발생 시 동적 학습 레코드 생성 헬퍼
   */
  public createLearningRecord(
    word: string,
    chosenMeaning: string,
    sentence: string
  ): LocalGlossaryRecord {
    const rawNouns = sentence
      .toLowerCase()
      .replace(/[^\w\s가-힣]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3 && w !== word.toLowerCase());

    const uniqueTriggers = Array.from(new Set(rawNouns)).slice(0, 6);

    return {
      word: word.toLowerCase(),
      meaning: chosenMeaning,
      contextTriggers: uniqueTriggers,
      selectionCount: 1,
      lastUpdated: Date.now(),
    };
  }

  /**
   * 학습 레코드를 인메모리 맵 및 IndexedDB에 동시 영속화
   */
  public async saveLearningRecord(record: LocalGlossaryRecord): Promise<void> {
    const key = record.word.toLowerCase();
    const existingList = this.userStore.get(key) || [];
    const idx = existingList.findIndex((r) => r.meaning === record.meaning);
    if (idx >= 0) {
      const target = existingList[idx];
      const mergedTriggers = Array.from(new Set([...target.contextTriggers, ...record.contextTriggers]));
      existingList[idx] = {
        ...target,
        selectionCount: target.selectionCount + 1,
        contextTriggers: mergedTriggers,
        lastUpdated: Date.now(),
      };
    } else {
      existingList.push(record);
    }
    this.userStore.set(key, existingList);

    try {
      const id = `stat-${key}-${record.meaning}`;
      const existing = await db.glossaryStats.get(id);
      const prevCount = existing?.selectionCount ?? 0;
      const prevTriggers = existing?.learnedTriggers ?? (existing as any)?.contextTriggers ?? [];
      const mergedTriggers = Array.from(new Set([...prevTriggers, ...record.contextTriggers]));

      await db.glossaryStats.put({
        id,
        word: key,
        contextTag: 'default',
        selectedMeaning: record.meaning,
        selectionCount: prevCount + 1,
        learnedTriggers: mergedTriggers,
        lastUpdated: Date.now(),
        // 호환성 필드
        ...({
          meaning: record.meaning,
          contextTriggers: mergedTriggers,
        } as any),
      });
    } catch {
      // IndexedDB 미지원 환경 무시
    }
  }
}

export const unifiedTranslator = new UnifiedTranslator();
