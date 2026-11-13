import { streamText, type ModelMessage } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { loadApiKey } from '../storage/secureStore';
import { useSettings, type AiProviderId } from '../store/settingsStore';
import {
  BUBBLE_MAX_OUTPUT_TOKENS,
  buildAcademicSystemInstruction,
  GEMINI_PRIMARY_MODEL,
  getEnvGeminiApiKey,
  resolveMaxOutputTokens,
  streamGeminiTutor,
  type GeminiTutorTarget,
} from '../modules/ai';
import { findModelMeta } from './modelCatalog';

export const PROVIDER_LABEL: Record<AiProviderId, string> = {
  openai: 'ChatGPT',
  google: 'Gemini',
  anthropic: 'Claude',
};

export const PROVIDER_KEY_URL: Record<AiProviderId, string> = {
  openai: 'https://platform.openai.com/api-keys',
  google: 'https://aistudio.google.com/apikey',
  anthropic: 'https://console.anthropic.com/settings/keys',
};

export const PROVIDER_KEY_GUIDE: Record<AiProviderId, string> = {
  google: 'Google AI Studio에서 카드 등록 없이 무료 API 키(AIza...)를 30초 만에 발급받을 수 있습니다.',
  openai: 'OpenAI Platform에서 개인 API 키(sk-...)를 발급받아 입력하세요.',
  anthropic: 'Anthropic Console에서 Claude API 키(sk-ant-...)를 발급받아 입력하세요.',
};

const PLACEHOLDER_KEYS = new Set(['undefined', 'null', 'none', 'your-api-key', 'test-key']);

/**
 * 제공자별 API Key 형식 유효성 검사.
 * 빈 문자열·공백·'undefined'·플레이스홀더를 배제하고 접두사 및 최소 길이를 검증한다.
 */
export function isValidKeyFormat(provider: AiProviderId, key: string | null | undefined): boolean {
  if (typeof key !== 'string') return false;
  const trimmed = key.trim();
  if (!trimmed || PLACEHOLDER_KEYS.has(trimmed.toLowerCase())) return false;
  if (/\s/.test(trimmed)) return false;

  switch (provider) {
    case 'google':
      return trimmed.startsWith('AIza') && trimmed.length >= 20;
    case 'anthropic':
      return trimmed.startsWith('sk-ant-') && trimmed.length >= 20;
    case 'openai':
      return trimmed.startsWith('sk-') && !trimmed.startsWith('sk-ant-') && trimmed.length >= 20;
    default:
      return false;
  }
}

export class MissingApiKeyError extends Error {
  readonly provider: AiProviderId;
  readonly keyUrl: string;

  constructor(provider: AiProviderId, customMessage?: string) {
    super(
      customMessage ??
        `${PROVIDER_LABEL[provider]} API Key가 등록되지 않았거나 형식이 올바르지 않습니다. 키를 입력한 뒤 다시 시도하세요.`,
    );
    this.name = 'MissingApiKeyError';
    this.provider = provider;
    this.keyUrl = PROVIDER_KEY_URL[provider];
  }
}

export interface ProviderAdapterRequest {
  provider: AiProviderId;
  modelId?: string;
  system?: string;
  messages: ModelMessage[];
  target?: GeminiTutorTarget;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  /** 테스트/직접 호출용 API Key 오버라이드 */
  apiKeyOverride?: string;
}

function createVercelModel(provider: Exclude<AiProviderId, 'google'>, apiKey: string, modelId: string) {
  switch (provider) {
    case 'anthropic':
      return createAnthropic({
        apiKey,
        headers: { 'anthropic-dangerous-direct-browser-access': 'true' },
      })(modelId);
    case 'openai':
    default:
      return createOpenAI({ apiKey })(modelId);
  }
}

/**
 * 멀티 프로바이더(Google Gemini / OpenAI ChatGPT / Anthropic Claude) 통합 스트리밍 어댑터.
 * 제공자별 API 키 유효성을 사전 점검하고, 미등록 시 앱 크래시 대신 MissingApiKeyError를 반환한다.
 */
export async function* streamWithProviderAdapter(req: ProviderAdapterRequest): AsyncGenerator<string> {
  const settings = useSettings.getState();
  const modelId = req.modelId || settings.aiModels[req.provider] || (req.provider === 'google' ? GEMINI_PRIMARY_MODEL : '');
  const target: GeminiTutorTarget =
    req.target ?? (req.maxOutputTokens !== undefined && req.maxOutputTokens <= BUBBLE_MAX_OUTPUT_TOKENS ? 'bubble' : 'sidebar');
  const modelMeta = findModelMeta(modelId, req.provider);
  const effectiveMax = req.maxOutputTokens ?? (target === 'sidebar' ? modelMeta?.defaultMaxOutputTokens : undefined);
  const maxOutputTokens = resolveMaxOutputTokens(target, effectiveMax);

  if (req.provider === 'google') {
    const storedKey = req.apiKeyOverride ?? (await loadApiKey('google')) ?? getEnvGeminiApiKey();
    if (!isValidKeyFormat('google', storedKey)) {
      throw new MissingApiKeyError('google');
    }
    yield* streamGeminiTutor({
      apiKey: storedKey!,
      messages: req.messages,
      systemContext: req.system,
      target,
      maxOutputTokens,
      model: modelId || GEMINI_PRIMARY_MODEL,
      signal: req.signal,
    });
    return;
  }

  const apiKey = req.apiKeyOverride ?? (await loadApiKey(req.provider));
  if (!isValidKeyFormat(req.provider, apiKey)) {
    throw new MissingApiKeyError(req.provider);
  }

  const result = streamText({
    model: createVercelModel(req.provider, apiKey!, modelId),
    system: buildAcademicSystemInstruction(req.system),
    messages: req.messages,
    maxOutputTokens,
    abortSignal: req.signal,
    maxRetries: 1,
  });

  for await (const part of result.fullStream) {
    if (part.type === 'text-delta') yield part.text;
    else if (part.type === 'error') {
      const err = part.error as { message?: string } | string;
      throw new Error(typeof err === 'string' ? err : (err?.message ?? 'AI 호출 중 오류가 발생했습니다.'));
    }
  }
}

