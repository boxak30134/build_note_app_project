/**
 * FRIENDLY_TRANSLATION_GUIDE.md: 사용자 친화적 무설정 번역 및 경량 AI 연동 모듈
 * Tier 1: 로컬 적응형 사전 (오프라인, 0ms)
 * Tier 2: Google AI Studio (Gemini Flash) 카드 불필요 무료 개인 키 (원클릭 발급)
 * Tier 3: 클라이언트 공개 무키(No-Key) 엔드포인트 (Zero-Config, 기본 모드)
 */

import { callGeminiWithResilience, type GeminiResilienceStatus } from './geminiResilience';
import { getUserFacingErrorMessage } from '../modules/ai/errorMessages';
import { FALLBACK_NOTE_CONTEXT_CHARS } from '../modules/ai/constants';

export type TranslationEngine = 'local' | 'gemini' | 'public_free';

export interface FriendlyTranslationResult {
  success: boolean;
  translatedText?: string;
  engine: TranslationEngine;
  confidence: number;
  model?: string;
  requestedModel?: string;
  usedFallback?: boolean;
  errorMessage?: string;
}

export interface GeminiTranslationCallOptions {
  model?: string;
  signal?: AbortSignal;
  retryDelayMs?: number;
  onStatusChange?: (status: GeminiResilienceStatus) => void;
  onChunk?: (delta: string, accumulated: string) => void;
}

function extractTextAndCheckSafety(payload: any): string {
  const finishReason = payload?.candidates?.[0]?.finishReason;
  if (finishReason === 'SAFETY' || finishReason === 'PROHIBITED_CONTENT' || finishReason === 'RECITATION') {
    throw new Error(`SAFETY: 안전 정책에 의해 번역이 차단되었습니다 (${finishReason}).`);
  }
  const parts = payload?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts
    .map((p: any) => (p && !p.thought && typeof p.text === 'string' ? p.text : ''))
    .join('');
}

async function readSseOrJsonTranslationResponse(
  response: Response,
  onChunk?: (delta: string, accumulated: string) => void,
): Promise<string> {
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let accumulated = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith('data:')) continue;
        const jsonStr = line.slice(5).trim();
        if (!jsonStr || jsonStr === '[DONE]') continue;
        try {
          const chunk = JSON.parse(jsonStr);
          const delta = extractTextAndCheckSafety(chunk);
          if (delta) {
            accumulated += delta;
            onChunk?.(delta, accumulated);
          }
        } catch (err) {
          if (err instanceof Error && err.message.startsWith('SAFETY:')) throw err;
        }
      }
    }
    const tail = buffer.trim();
    if (tail.startsWith('data:')) {
      const jsonStr = tail.slice(5).trim();
      if (jsonStr && jsonStr !== '[DONE]') {
        try {
          const delta = extractTextAndCheckSafety(JSON.parse(jsonStr));
          if (delta) {
            accumulated += delta;
            onChunk?.(delta, accumulated);
          }
        } catch (err) {
          if (err instanceof Error && err.message.startsWith('SAFETY:')) throw err;
        }
      }
    }
    if (accumulated.trim()) return accumulated.trim();
  }

  if (typeof response.json === 'function') {
    const data = await response.json();
    const candidate = extractTextAndCheckSafety(data);
    if (candidate.trim()) return candidate.trim();
  }
  throw new Error('번역 결과를 생성하지 못했습니다.');
}

/**
 * 1. 공개 무키(No-Key) 엔드포인트를 통한 기본 번역 (설정 없이 즉시 작동)
 */
export async function translateViaPublicEndpoint(text: string): Promise<string> {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=ko&dt=t&q=${encodeURIComponent(text)}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`공개 번역 서버 응답 실패 (${response.status})`);
  }

  const data = await response.json();
  // gtx 응답 포맷: [[["번역문", "원문", null, null, ...]], ...]
  if (Array.isArray(data) && Array.isArray(data[0])) {
    const fullText = data[0].map((item: any) => (Array.isArray(item) ? item[0] : '')).join('');
    if (fullText.trim()) return fullText.trim();
  }
  throw new Error('응답 데이터를 파싱할 수 없습니다.');
}

/**
 * 2. Google AI Studio (Gemini Flash) API 호출 — 단일 callGeminiWithResilience 레이어 통과
 * - 직렬 큐 + 503/429 지수 백오프 재시도 + 현행 GA 모델(gemini-3.5-flash-lite -> gemini-3.8-flash) 자동 폴백 적용
 */
export async function translateViaGeminiWithMeta(
  text: string,
  apiKey: string,
  contextSentence?: string,
  options: GeminiTranslationCallOptions = {},
): Promise<{ translatedText: string; model: string; requestedModel: string; usedFallback: boolean }> {
  const cleanKey = apiKey.trim();
  const res = await callGeminiWithResilience<string>(
    async (model, ctx) => {
      const effectiveText = ctx.trimContext ? text.slice(0, FALLBACK_NOTE_CONTEXT_CHARS) : text;
      const effectiveContext = ctx.trimContext
        ? (contextSentence || '').slice(0, 200)
        : (contextSentence || '').slice(0, 1200);
      const prompt = `You are a professional academic translator specializing in mathematics and computer science.
Translate the following English text to Korean accurately, maintaining academic terminology (e.g., ring -> 환, field -> 체).
Surrounding Context: "${effectiveContext}"
Text to translate: "${effectiveText}"

Output ONLY the translated Korean text without explanation or markdown quotes.`;

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(cleanKey)}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: options.signal,
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 200,
          },
        }),
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        const msg = errData.error?.message || `HTTP ${response.status}`;
        const err = Object.assign(
          new Error(
            response.status === 400 || response.status === 401 || response.status === 403
              ? `Gemini 키 오류 (${response.status}): ${msg}`
              : `Gemini 번역 실패 (${response.status}): ${msg}`,
          ),
          { status: response.status },
        );
        throw err;
      }

      return readSseOrJsonTranslationResponse(response, options.onChunk);
    },
    {
      primaryModel: options.model || 'gemini-3.5-flash-lite',
      enableFallback: true,
      retryDelayMs: options.retryDelayMs,
      signal: options.signal,
      label: 'translate',
      onStatusChange: options.onStatusChange,
    },
  );

  return {
    translatedText: res.value,
    model: res.model,
    requestedModel: res.requestedModel,
    usedFallback: res.usedFallback,
  };
}

export async function translateViaGemini(
  text: string,
  apiKey: string,
  contextSentence?: string,
  options?: GeminiTranslationCallOptions,
): Promise<string> {
  const res = await translateViaGeminiWithMeta(text, apiKey, contextSentence, options);
  return res.translatedText;
}

/**
 * 메인 통합 실행 함수
 */
export async function executeFriendlyTranslation({
  text,
  surroundingSentence,
  geminiApiKey,
  localMeaning,
  model,
  signal,
  retryDelayMs,
  onStatusChange,
}: {
  text: string;
  surroundingSentence: string;
  geminiApiKey?: string | null;
  localMeaning?: string | null;
  model?: string;
  signal?: AbortSignal;
  retryDelayMs?: number;
  onStatusChange?: (status: GeminiResilienceStatus) => void;
}): Promise<FriendlyTranslationResult> {
  const trimmed = text.trim();
  if (!trimmed) {
    return {
      success: false,
      engine: 'public_free',
      confidence: 0,
      errorMessage: '번역할 내용이 비어있습니다.',
    };
  }

  // Tier 1: 로컬 적응형 다의어(문맥·사용자 학습) 매칭이 유효한 경우
  if (localMeaning) {
    return {
      success: true,
      translatedText: localMeaning,
      engine: 'local',
      confidence: 98,
    };
  }

  // Tier 2: 사용자가 등록한 Gemini 키가 있는 경우 단일 회복탄력성 레이어 사용
  if (geminiApiKey && geminiApiKey.trim() !== '') {
    try {
      const geminiRes = await translateViaGeminiWithMeta(trimmed, geminiApiKey, surroundingSentence, {
        model,
        signal,
        retryDelayMs,
        onStatusChange,
      });
      onStatusChange?.({
        phase: 'done',
        model: geminiRes.model,
        requestedModel: geminiRes.requestedModel,
        usedFallback: geminiRes.usedFallback,
        message: geminiRes.usedFallback ? `폴백 응답 (${geminiRes.model})` : '완료',
      });
      return {
        success: true,
        translatedText: geminiRes.translatedText,
        engine: 'gemini',
        confidence: 95,
        model: geminiRes.model,
        requestedModel: geminiRes.requestedModel,
        usedFallback: geminiRes.usedFallback,
      };
    } catch (err: unknown) {
      if (signal?.aborted) {
        return {
          success: false,
          engine: 'gemini',
          confidence: 0,
          errorMessage: '번역이 취소되었습니다.',
        };
      }
      const friendlyErr = getUserFacingErrorMessage(err);
      console.warn('Gemini 번역 실패, 기본 공개 엔진으로 자동 폴백합니다:', friendlyErr);
      // Gemini 키/서버 에러 발생 시 사용자 작업이 중단되지 않도록 Tier 3로 자동 폴백
    }
  }

  // Tier 3: 별도 설정 없는 기본 공개 엔진 (Zero-Config)
  try {
    const publicResult = await translateViaPublicEndpoint(trimmed);
    return {
      success: true,
      translatedText: publicResult,
      engine: 'public_free',
      confidence: 85,
    };
  } catch {
    return {
      success: false,
      engine: 'public_free',
      confidence: 0,
      errorMessage: '오프라인 상태이거나 네트워크 연결이 원활하지 않습니다.',
    };
  }
}

