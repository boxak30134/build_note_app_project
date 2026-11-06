export interface SenseDefinition {
  id: string;               // 의미 식별자 (예: "math-algebra-ring")
  meaning: string;          // 한국어 번역어 (예: "환(環)")
  contextTriggers: string[]; // 함께 등장 시 가산점 부여할 단어들
  baseWeight: number;       // 기본 가중치 (0.0 ~ 1.0)
  domain: string;           // 도메인 (예: "algebra", "general", "topology")
}

export interface SeedWordEntry {
  word: string;             // 원문 영단어 (소문자 표준화)
  defaultMeaning: string;   // 트리거 미발견 시 기본 번역어
  senses: SenseDefinition[];
}

export interface UserWordStat {
  word: string;
  contextTag: string;       // 문서 태그 또는 'default'
  selectedMeaning: string;  // 사용자가 채택/수정한 번역어
  selectionCount: number;   // 누적 채택 횟수
  learnedTriggers: string[];// 해당 문장에 함께 있던 명사 키워드들
  lastUpdated: number;
}

export interface TranslationResolution {
  targetWord: string;
  selectedMeaning: string;
  confidence: number; // 0 ~ 100 (%)
  source: 'user_learned' | 'seed_context' | 'default_fallback';
  matchedTrigger?: string;
  alternatives: { meaning: string; confidence: number }[];
}

