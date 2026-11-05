import { streamText, type ModelMessage } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { loadApiKey } from '../storage/secureStore';
import { useSettings, type AiProviderId } from '../store/settingsStore';
import {
  BUBBLE_MAX_OUTPUT_TOKENS,
  buildAcademicSystemInstruction,
  GEMINI_PRIMARY_MODEL,
  resolveMaxOutputTokens,
  streamGeminiTutor,
  type GeminiTutorTarget,
} from '../modules/ai';

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

function modelFor(provider: Exclude<AiProviderId, 'google'>, apiKey: string, modelId: string) {
  switch (provider) {
    case 'anthropic':
      // 브라우저 직접 호출(BYOK) 허용 헤더
      return createAnthropic({ apiKey, headers: { 'anthropic-dangerous-direct-browser-access': 'true' } })(modelId);
    case 'openai':
    default:
      return createOpenAI({ apiKey })(modelId);
  }
}

export interface AiRequest {
  provider: AiProviderId;
  system?: string;
  messages: ModelMessage[];
  target?: GeminiTutorTarget;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

/** 사용자 토큰(BYOK) 또는 VITE_GEMINI_API_KEY로 스트리밍 호출. 텍스트 델타를 비동기로 산출한다. */
export async function* streamAi(req: AiRequest): AsyncGenerator<string> {
  const target: GeminiTutorTarget =
    req.target ?? (req.maxOutputTokens !== undefined && req.maxOutputTokens <= BUBBLE_MAX_OUTPUT_TOKENS ? 'bubble' : 'sidebar');
  const maxOutputTokens = resolveMaxOutputTokens(target, req.maxOutputTokens);

  if (req.provider === 'google') {
    const modelId = useSettings.getState().aiModels.google || GEMINI_PRIMARY_MODEL;
    yield* streamGeminiTutor({
      messages: req.messages,
      systemContext: req.system,
      target,
      maxOutputTokens,
      model: modelId,
      signal: req.signal,
    });
    return;
  }

  const apiKey = await loadApiKey(req.provider);
  if (!apiKey) throw new Error(`${PROVIDER_LABEL[req.provider]} API Key가 등록되지 않았습니다. 우측 사이드바에서 연결하세요.`);
  const modelId = useSettings.getState().aiModels[req.provider];
  const result = streamText({
    model: modelFor(req.provider, apiKey, modelId),
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

export function dataUrlToBase64(dataUrl: string): { base64: string; mediaType: string } {
  const m = /^data:([^;]+);base64,(.*)$/.exec(dataUrl);
  return m ? { mediaType: m[1], base64: m[2] } : { mediaType: 'image/png', base64: dataUrl };
}
