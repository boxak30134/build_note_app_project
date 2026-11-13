import type { AiProviderId } from '../store/settingsStore';
import {
  BUBBLE_MAX_OUTPUT_TOKENS,
  GEMINI_FALLBACK_MODEL,
  GEMINI_PRIMARY_MODEL,
  SIDEBAR_MAX_OUTPUT_TOKENS,
  type GeminiTutorTarget,
} from '../modules/ai/constants';

export interface AiModelMeta {
  id: string;
  provider: AiProviderId;
  displayName: string;
  description: string;
  estimatedTokenRange: string;
  defaultMaxOutputTokens: number;
}

export interface AiProviderGroup {
  provider: AiProviderId;
  label: string;
  badgeText: string;
  models: AiModelMeta[];
}

export const PROVIDER_GROUPS: AiProviderGroup[] = [
  {
    provider: 'google',
    label: 'Google Gemini',
    badgeText: '무료 티어 지원',
    models: [
      {
        id: GEMINI_PRIMARY_MODEL,
        provider: 'google',
        displayName: 'Gemini 3.8 Flash',
        description: '빠른 요약·일상 번역·학술 튜터 기본',
        estimatedTokenRange: '~900–1,800 tok',
        defaultMaxOutputTokens: SIDEBAR_MAX_OUTPUT_TOKENS,
      },
      {
        id: GEMINI_FALLBACK_MODEL,
        provider: 'google',
        displayName: 'Gemini 3.6 Flash',
        description: '가벼운 개념 정리·고속 응답',
        estimatedTokenRange: '~850–1,600 tok',
        defaultMaxOutputTokens: SIDEBAR_MAX_OUTPUT_TOKENS,
      },
      {
        id: 'gemini-2.5-flash',
        provider: 'google',
        displayName: 'Gemini 2.5 Flash',
        description: '안정적인 범용 노트 질의·수식 풀이',
        estimatedTokenRange: '~850–1,650 tok',
        defaultMaxOutputTokens: SIDEBAR_MAX_OUTPUT_TOKENS,
      },
      {
        id: 'gemini-2.5-pro',
        provider: 'google',
        displayName: 'Gemini 2.5 Pro',
        description: '복잡한 추론·심층 분석·정밀 코드',
        estimatedTokenRange: '~1,200–2,400 tok',
        defaultMaxOutputTokens: 2048,
      },
    ],
  },
  {
    provider: 'openai',
    label: 'OpenAI ChatGPT',
    badgeText: 'OpenAI BYOK',
    models: [
      {
        id: 'gpt-4.1-mini',
        provider: 'openai',
        displayName: 'GPT-4.1 mini',
        description: '빠른 요약·일상 번역·가성비 우수',
        estimatedTokenRange: '~850–1,600 tok',
        defaultMaxOutputTokens: SIDEBAR_MAX_OUTPUT_TOKENS,
      },
      {
        id: 'gpt-4.1',
        provider: 'openai',
        displayName: 'GPT-4.1',
        description: '정교한 논리 전개·학술 문서 분석',
        estimatedTokenRange: '~1,100–2,200 tok',
        defaultMaxOutputTokens: 2000,
      },
      {
        id: 'o4-mini',
        provider: 'openai',
        displayName: 'o4-mini',
        description: '고난도 추론·논리 검증·문제 해결',
        estimatedTokenRange: '~1,300–2,600 tok',
        defaultMaxOutputTokens: 2400,
      },
    ],
  },
  {
    provider: 'anthropic',
    label: 'Anthropic Claude',
    badgeText: 'Claude BYOK',
    models: [
      {
        id: 'claude-sonnet-4-5',
        provider: 'anthropic',
        displayName: 'Claude Sonnet 4.5',
        description: '심층 추론·논문 분석·자연스러운 한국어',
        estimatedTokenRange: '~1,100–2,300 tok',
        defaultMaxOutputTokens: 2000,
      },
      {
        id: 'claude-haiku-4-5',
        provider: 'anthropic',
        displayName: 'Claude Haiku 4.5',
        description: '빠른 요약·일상 번역·저지연 응답',
        estimatedTokenRange: '~850–1,550 tok',
        defaultMaxOutputTokens: SIDEBAR_MAX_OUTPUT_TOKENS,
      },
    ],
  },
];

export const ALL_PRESET_MODELS: AiModelMeta[] = PROVIDER_GROUPS.flatMap((g) => g.models);

export function findModelMeta(modelId: string, provider?: AiProviderId): AiModelMeta | undefined {
  return ALL_PRESET_MODELS.find(
    (m) => m.id === modelId && (provider ? m.provider === provider : true),
  );
}

/** 런타임 정책: 주변 문맥 최대 클리핑 길이 (token_optimization_guide.md §B.3) */
export const MAX_CONTEXT_CLIP_CHARS = 1000;
/** 런타임 정책: 최근 4턴 슬라이딩 윈도우 (token_optimization_guide.md §B.2) */
export const SLIDING_WINDOW_TURNS = 4;
/** 고정 시스템 프롬프트 기본 오버헤드 추정치 */
const BASE_SYSTEM_OVERHEAD_TOKENS = 160;

/**
 * 문자 수 기반 입력 토큰 근사치 계산.
 * - 한글(가-힣/자모)은 평균 ~1.4 tokens/char
 * - 영문/숫자/공백/LaTeX 기호는 평균 ~0.28 tokens/char (약 3.5~4자당 1토큰)
 */
export function estimateInputTokens(text: string): number {
  if (!text) return 0;
  let koreanCount = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if ((code >= 0xac00 && code <= 0xd7a3) || (code >= 0x3131 && code <= 0x318e)) {
      koreanCount++;
    }
  }
  const otherCount = text.length - koreanCount;
  return Math.max(1, Math.ceil(koreanCount * 1.4 + otherCount * 0.28));
}

export interface TurnTokenPreview {
  clippedSelectedChars: number;
  estimatedInputTokens: number;
  maxOutputTokens: number;
  estimatedTotalUpperTokens: number;
}

/**
 * 현재 선택된 텍스트/영역 및 활성 모델 기준으로 1회 질문 시 예상 입력/출력 상한 토큰을 계산한다.
 */
export function estimateTurnTokenPreview(params: {
  selectedText?: string;
  draftText?: string;
  recentTurnTexts?: string[];
  modelId: string;
  provider?: AiProviderId;
  target?: GeminiTutorTarget;
}): TurnTokenPreview {
  const rawSelected = (params.selectedText ?? '').trim();
  const clippedSelected = rawSelected.slice(0, MAX_CONTEXT_CLIP_CHARS);
  const selectedTokens = estimateInputTokens(clippedSelected);
  const draftTokens = estimateInputTokens((params.draftText ?? '').trim());
  const recentWindow = (params.recentTurnTexts ?? []).slice(-SLIDING_WINDOW_TURNS);
  const historyTokens = recentWindow.reduce((sum, t) => sum + estimateInputTokens(t), 0);

  const meta = findModelMeta(params.modelId, params.provider);
  const targetMax =
    params.target === 'bubble'
      ? BUBBLE_MAX_OUTPUT_TOKENS
      : meta?.defaultMaxOutputTokens ?? SIDEBAR_MAX_OUTPUT_TOKENS;

  const estimatedInputTokens = BASE_SYSTEM_OVERHEAD_TOKENS + selectedTokens + draftTokens + historyTokens;

  return {
    clippedSelectedChars: clippedSelected.length,
    estimatedInputTokens,
    maxOutputTokens: targetMax,
    estimatedTotalUpperTokens: estimatedInputTokens + targetMax,
  };
}

