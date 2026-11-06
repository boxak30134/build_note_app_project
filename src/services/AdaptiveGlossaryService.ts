import seedData from '../assets/seedGlossary.json';
import type { SeedWordEntry, TranslationResolution, UserWordStat } from '../types/adaptiveGlossary';
import { db } from '../storage/db';

function normalizeWordKey(raw: string): string {
  return raw.toLowerCase().trim().replace(/^[.,;:!?'"([{]+|[.,;:!?'"\])}]+$/g, '');
}

export class AdaptiveGlossaryService {
  private seedMap: Map<string, SeedWordEntry> = new Map();
  private userStatsMap: Map<string, UserWordStat[]> = new Map(); // key: word

  constructor() {
    this.initSeedData();
  }

  private initSeedData(): void {
    const list = seedData as SeedWordEntry[];
    for (const item of list) {
      this.seedMap.set(item.word.toLowerCase(), item);
    }
  }

  private lookupKey(wordKey: string): string {
    if (this.seedMap.has(wordKey) || this.userStatsMap.has(wordKey)) return wordKey;
    if (wordKey.endsWith('ies') && wordKey.length > 4) {
      const singular = `${wordKey.slice(0, -3)}y`;
      if (this.seedMap.has(singular) || this.userStatsMap.has(singular)) return singular;
    }
    if (wordKey.endsWith('es') && wordKey.length > 3) {
      const singular = wordKey.slice(0, -2);
      if (this.seedMap.has(singular) || this.userStatsMap.has(singular)) return singular;
    }
    if (wordKey.endsWith('s') && wordKey.length > 2) {
      const singular = wordKey.slice(0, -1);
      if (this.seedMap.has(singular) || this.userStatsMap.has(singular)) return singular;
    }
    return wordKey;
  }

  /**
   * IndexedDB에서 사용자의 적응형 학습 데이터 로드
   */
  public loadUserStats(records: UserWordStat[]): void {
    this.userStatsMap.clear();
    for (const rec of records) {
      const key = normalizeWordKey(rec.word);
      const existing = this.userStatsMap.get(key) || [];
      existing.push({ ...rec, word: key });
      this.userStatsMap.set(key, existing);
    }
  }

  /**
   * IndexedDB 테이블에서 사용자 학습 기록을 비동기 로드하여 메모리에 동기화
   */
  public async syncFromDB(): Promise<void> {
    try {
      const rows = await db.glossaryStats.toArray();
      this.loadUserStats(rows);
    } catch {
      /* IndexedDB 비활성 환경 폴백 */
    }
  }

  /**
   * 문맥 기반 최적 번역어 판별 (0.001초 이내)
   */
  public resolveMeaning(
    targetWord: string,
    surroundingSentence: string,
    activeDocumentTags: string[] = [],
  ): TranslationResolution {
    const rawKey = normalizeWordKey(targetWord);
    const wordKey = this.lookupKey(rawKey);
    const entry = this.seedMap.get(wordKey);

    // 검색 대상 풀(주변 문장 + 문서 태그)
    const corpus = `${surroundingSentence.toLowerCase()} ${activeDocumentTags.join(' ').toLowerCase()}`;

    // 1. 사용자 학습 데이터 우선 평가
    const userRecords = this.userStatsMap.get(wordKey) || [];
    let bestUserMeaning: string | null = null;
    let maxUserScore = -1;
    let totalSelections = 0;
    let matchedUserTrigger: string | undefined;

    for (const rec of userRecords) {
      totalSelections += rec.selectionCount;
      let score = rec.selectionCount * 2;
      let hitTrigger: string | undefined;

      // 사용자가 함께 썼던 키워드가 현재 문장에도 있는지 확인
      for (const trig of rec.learnedTriggers) {
        if (corpus.includes(trig.toLowerCase())) {
          score += 4.0;
          if (!hitTrigger) hitTrigger = trig;
        }
      }

      if (rec.contextTag && rec.contextTag !== 'default') {
        if (activeDocumentTags.some((t) => t.toLowerCase() === rec.contextTag.toLowerCase())) {
          score += 3.0;
        }
      }

      if (score > maxUserScore) {
        maxUserScore = score;
        bestUserMeaning = rec.selectedMeaning;
        matchedUserTrigger = hitTrigger;
      }
    }

    // 사용자 데이터에서 확실한 우위가 검출된 경우
    if (bestUserMeaning && maxUserScore >= 4.0 && totalSelections > 0) {
      const conf = Math.min(99, Math.round((maxUserScore / (totalSelections * 2 + 4)) * 100));
      const seedAlts = entry
        ? entry.senses
            .filter((s) => s.meaning !== bestUserMeaning)
            .map((s) => ({ meaning: s.meaning, confidence: 50 }))
        : [];
      return {
        targetWord,
        selectedMeaning: bestUserMeaning,
        confidence: Math.max(85, conf),
        source: 'user_learned',
        matchedTrigger: matchedUserTrigger,
        alternatives: seedAlts,
      };
    }

    // 2. 시드 사전(Seed) 문맥 트리거 평가
    if (entry) {
      let topSense = entry.senses[0];
      let maxSenseScore = -1;
      let matchedTrigger = '';

      const scoredSenses = entry.senses.map((sense) => {
        let score = sense.baseWeight || 0.5;
        let matched = '';

        for (const trig of sense.contextTriggers) {
          if (corpus.includes(trig.toLowerCase())) {
            score += 3.5;
            matched = trig;
          }
        }

        if (score > maxSenseScore) {
          maxSenseScore = score;
          topSense = sense;
          matchedTrigger = matched;
        }

        return { sense, score };
      });

      if (maxSenseScore >= 3.5) {
        return {
          targetWord,
          selectedMeaning: topSense.meaning,
          confidence: 95,
          source: 'seed_context',
          matchedTrigger,
          alternatives: scoredSenses
            .filter((s) => s.sense.id !== topSense.id)
            .map((s) => ({ meaning: s.sense.meaning, confidence: Math.min(90, Math.round(s.score * 15)) })),
        };
      }

      // 트리거 미발견 시 기본값
      return {
        targetWord,
        selectedMeaning: entry.defaultMeaning,
        confidence: 60,
        source: 'default_fallback',
        alternatives: entry.senses.map((s) => ({ meaning: s.meaning, confidence: 50 })),
      };
    }

    // 3. 시드 사전에 없는 단어인 경우 그대로 반환
    return {
      targetWord,
      selectedMeaning: targetWord,
      confidence: 10,
      source: 'default_fallback',
      alternatives: [],
    };
  }

  /**
   * Day 2+: 사용자가 번역어를 선택/교정했을 때 학습 트리거 축적 (메모리 즉시 반영)
   */
  public recordUserFeedback(
    targetWord: string,
    chosenMeaning: string,
    surroundingSentence: string,
    currentTag: string = 'default',
  ): UserWordStat {
    const rawKey = normalizeWordKey(targetWord);
    const wordKey = this.lookupKey(rawKey);
    const trimmedMeaning = chosenMeaning.trim();

    // 문장에서 주요 공기어(명사/키워드 후보) 추출 (단순 공백/특수문자 정제)
    const candidateWords = surroundingSentence
      .toLowerCase()
      .replace(/[^\w\s가-힣]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3 && w !== wordKey && w !== rawKey);

    const learnedTriggers = Array.from(new Set(candidateWords)).slice(0, 5);

    const existingList = this.userStatsMap.get(wordKey) || [];
    const existingIdx = existingList.findIndex(
      (r) => r.selectedMeaning === trimmedMeaning && r.contextTag === currentTag,
    );

    let updatedStat: UserWordStat;
    if (existingIdx >= 0) {
      const prev = existingList[existingIdx];
      const mergedTriggers = Array.from(new Set([...learnedTriggers, ...prev.learnedTriggers])).slice(0, 8);
      updatedStat = {
        ...prev,
        selectionCount: prev.selectionCount + 1,
        learnedTriggers: mergedTriggers,
        lastUpdated: Date.now(),
      };
      existingList[existingIdx] = updatedStat;
    } else {
      updatedStat = {
        word: wordKey,
        contextTag: currentTag,
        selectedMeaning: trimmedMeaning,
        selectionCount: 1,
        learnedTriggers,
        lastUpdated: Date.now(),
      };
      existingList.push(updatedStat);
    }

    this.userStatsMap.set(wordKey, existingList);
    return updatedStat;
  }

  /**
   * 사용자 피드백을 메모리에 즉시 반영하고 IndexedDB에 영구 저장
   */
  public async saveUserFeedback(
    targetWord: string,
    chosenMeaning: string,
    surroundingSentence: string,
    currentTag: string = 'default',
  ): Promise<UserWordStat> {
    const stat = this.recordUserFeedback(targetWord, chosenMeaning, surroundingSentence, currentTag);
    const id = `${stat.word}::${stat.contextTag}::${stat.selectedMeaning}`;
    try {
      await db.glossaryStats.put({ ...stat, id });
    } catch {
      /* IndexedDB 비활성 환경 폴백 */
    }
    return stat;
  }
}

export const adaptiveGlossary = new AdaptiveGlossaryService();
void adaptiveGlossary.syncFromDB();

