export type TranslationSource = 'local_seed' | 'local_learned' | 'google_api' | 'gemini_api' | 'public_free';

export type TranslationErrorCode =
  | 'NO_KEY'
  | 'INVALID_KEY'
  | 'EXPIRED_KEY'
  | 'QUOTA_EXCEEDED'
  | 'NETWORK_ERROR'
  | 'UNKNOWN';

export interface UnifiedTranslationRequest {
  targetText: string;
  surroundingSentence: string;
  documentTags?: string[];
  apiKey?: string | null;
}

export interface UnifiedTranslationResponse {
  success: boolean;
  translatedText?: string;
  source?: TranslationSource;
  confidence: number; // 0 ~ 100 (%)
  matchedTrigger?: string;
  errorCode?: TranslationErrorCode;
  errorMessage?: string;
}

export interface LocalGlossaryRecord {
  word: string;
  meaning: string;
  contextTriggers: string[];
  selectionCount: number;
  lastUpdated: number;
}

