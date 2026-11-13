import type { ModelMessage } from 'ai';
import type { AiProviderId } from '../store/settingsStore';
import type { GeminiTutorTarget } from '../modules/ai';
import {
  PROVIDER_KEY_GUIDE,
  PROVIDER_KEY_URL,
  PROVIDER_LABEL,
  MissingApiKeyError,
  isValidKeyFormat,
  streamWithProviderAdapter,
} from './aiProviderAdapter';

export { PROVIDER_KEY_GUIDE, PROVIDER_KEY_URL, PROVIDER_LABEL, MissingApiKeyError, isValidKeyFormat };

export interface AiRequest {
  provider: AiProviderId;
  modelId?: string;
  system?: string;
  messages: ModelMessage[];
  target?: GeminiTutorTarget;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

/** 사용자 토큰(BYOK) 또는 VITE_GEMINI_API_KEY로 스트리밍 호출. 텍스트 델타를 비동기로 산출한다. */
export async function* streamAi(req: AiRequest): AsyncGenerator<string> {
  yield* streamWithProviderAdapter(req);
}

export function dataUrlToBase64(dataUrl: string): { base64: string; mediaType: string } {
  const m = /^data:([^;]+);base64,(.*)$/.exec(dataUrl);
  return m ? { mediaType: m[1], base64: m[2] } : { mediaType: 'image/png', base64: dataUrl };
}
