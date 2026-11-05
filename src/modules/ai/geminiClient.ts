import { GoogleGenAI, type Content, type Part, type ThinkingLevel } from '@google/genai';
import type { ModelMessage } from 'ai';
import { loadApiKey } from '../../storage/secureStore';
import { sanitizeEnvApiKey } from '../../core/android/androidDeployment';
import {
  BUBBLE_MAX_OUTPUT_TOKENS,
  buildAcademicSystemInstruction,
  GEMINI_FALLBACK_CHAIN,
  GEMINI_FALLBACK_MODEL,
  GEMINI_PRIMARY_MODEL,
  GEMINI_TEMPERATURE,
  GEMINI_THINKING_CONFIG,
  resolveMaxOutputTokens,
  SIDEBAR_MAX_OUTPUT_TOKENS,
  type GeminiTutorTarget,
} from './constants';

export interface GeminiAttachmentPart {
  type: 'file';
  mediaType: string;
  data: string;
}

export interface GeminiTextPart {
  type: 'text';
  text: string;
}

export type GeminiMessagePart = GeminiTextPart | GeminiAttachmentPart | Part;

export interface GeminiTutorMessage {
  role: 'user' | 'assistant' | 'model';
  content: string | GeminiMessagePart[];
}

export interface GeminiStreamChunkLike {
  text?: string;
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string; thought?: boolean }>;
    };
  }>;
}

export interface GeminiClientLike {
  models: {
    generateContentStream: (params: {
      model: string;
      contents: Content[];
      config: {
        systemInstruction: string;
        temperature: number;
        thinkingConfig?: { thinkingLevel?: ThinkingLevel; thinkingBudget?: number };
        maxOutputTokens: number;
        abortSignal?: AbortSignal;
      };
    }) => Promise<AsyncIterable<GeminiStreamChunkLike>>;
  };
}

export interface GeminiTutorRequest {
  /** 단일 질문 텍스트 (messages 미지정 시 사용) */
  prompt?: string;
  /** 대화 히스토리 또는 멀티모달 메시지 목록 */
  messages?: Array<ModelMessage | GeminiTutorMessage>;
  /** 추가 문맥(현재 노트 본문, 말풍선 선택 원문 등). 학술 튜터 시스템 프롬프트 하단에 결합됨 */
  systemContext?: string;
  /** 호출 영역: 말풍선('bubble' -> 800 토큰) | 사이드바('sidebar' -> 1500 토큰) */
  target?: GeminiTutorTarget;
  /** 출력 토큰 수 (지정 시에도 target별 상한 800/1500으로 클램핑됨) */
  maxOutputTokens?: number;
  /** 사용할 Gemini 모델 ID (기본값: 'gemini-3.8-flash', 실패 시 대안 모델 자동 폴백) */
  model?: string;
  /** API Key 직접 주입 (미지정 시 VITE_GEMINI_API_KEY 또는 로컬 암호화 키 자동 로드) */
  apiKey?: string;
  /** 스트리밍 중단 시그널 */
  signal?: AbortSignal;
  /** 기본 모델(gemini-3.8-flash) 호출 불가 시 대안 모델 자동 폴백 여부 (기본 true) */
  enableFallback?: boolean;
  /** 테스트용 커스텀 GoogleGenAI 클라이언트 주입 */
  client?: GeminiClientLike;
  /** 각 청크 수신 시 호출할 콜백 (TTFT 측정 및 UI 즉시 반영용) */
  onChunk?: (delta: string, accumulated: string) => void;
}

/**
 * 클라이언트 인스턴스 캐시.
 * 주의: @google/genai의 httpOptions.timeout을 설정하면 내부 createAttemptSignal이
 * setTimeout(() => controller.abort())를 걸어 스트리밍 도중 "AbortError: signal is aborted without reason"을
 * 발생시키므로 timeout은 설정하지 않고 retryOptions({ attempts: 1 })만 지정한다.
 */
const clientCache = new Map<string, GoogleGenAI>();

export function getOrCreateGeminiClient(apiKey: string): GoogleGenAI {
  let client = clientCache.get(apiKey);
  if (!client) {
    client = new GoogleGenAI({
      apiKey,
      httpOptions: {
        retryOptions: { attempts: 1 },
      },
    });
    clientCache.set(apiKey, client);
  }
  return client;
}

export function clearGeminiClientCache(): void {
  clientCache.clear();
}

/**
 * 클라이언트 환경변수(import.meta.env.VITE_GEMINI_API_KEY) 읽기 및 앞 4자리 확인 로그 출력
 */
export function getEnvGeminiApiKey(): string | null {
  try {
    const trimmed = sanitizeEnvApiKey(import.meta.env?.VITE_GEMINI_API_KEY, import.meta.env) ?? '';
    console.log(
      '[Gemini Env Check] import.meta.env.VITE_GEMINI_API_KEY:',
      trimmed ? `${trimmed.slice(0, 4)}****` : 'NOT_SET',
    );
    if (trimmed.length > 0) {
      return trimmed;
    }
  } catch {
    console.log('[Gemini Env Check] import.meta.env.VITE_GEMINI_API_KEY: UNAVAILABLE');
  }
  return null;
}

/**
 * 로컬 스토리지에 저장된 평문/보조 Gemini API 키 확인 (폴백용)
 */
function getLocalStorageGeminiKey(): string | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw =
      localStorage.getItem('VITE_GEMINI_API_KEY') ??
      localStorage.getItem('eduink-gemini-api-key');
    return raw?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * CLAUDE.md §6.1:
 * API 키는 클라이언트 측 환경변수(import.meta.env.VITE_GEMINI_API_KEY) 또는
 * 사용자가 입력한 로컬 스토리지 암호화 키를 우선 주입한다.
 */
export async function resolveGeminiApiKey(explicitKey?: string): Promise<string> {
  // Vite 환경변수 주입 상태 확인 로그 (앞 4자리만 출력)
  const envKey = getEnvGeminiApiKey();

  if (explicitKey && explicitKey.trim().length > 0) {
    const trimmed = explicitKey.trim();
    console.log('[Gemini API Key] Resolved explicit key:', `${trimmed.slice(0, 4)}****`);
    return trimmed;
  }

  // 사용자가 입력한 로컬 암호화 키 (IndexedDB AES-GCM) 확인
  let storedKey: string | null = null;
  if (typeof indexedDB !== 'undefined') {
    try {
      storedKey = await loadApiKey('google');
    } catch {
      storedKey = null;
    }
  }

  const resolved = storedKey?.trim() || envKey || getLocalStorageGeminiKey();
  if (!resolved) {
    throw new Error(
      'Gemini API Key가 설정되지 않았습니다. 환경변수(VITE_GEMINI_API_KEY)를 설정하거나 우측 사이드바에서 Gemini API Key를 등록하세요.',
    );
  }
  console.log('[Gemini API Key] Active key prefix:', `${resolved.slice(0, 4)}****`);
  return resolved;
}

/**
 * 입력 메시지(문자열, Vercel AI ModelMessage[], GeminiTutorMessage[])를
 * @google/genai 의 Content[] 포맷으로 변환한다.
 */
export function toGeminiContents(req: Pick<GeminiTutorRequest, 'prompt' | 'messages'>): Content[] {
  if (req.messages && req.messages.length > 0) {
    return req.messages.map((msg): Content => {
      const role = msg.role === 'assistant' || msg.role === 'model' ? 'model' : 'user';
      if (typeof msg.content === 'string') {
        return { role, parts: [{ text: msg.content }] };
      }
      if (Array.isArray(msg.content)) {
        const parts: Part[] = [];
        for (const item of msg.content) {
          if (!item || typeof item !== 'object') continue;
          if ('type' in item) {
            if (item.type === 'text' && typeof item.text === 'string') {
              parts.push({ text: item.text });
            } else if (item.type === 'file' && 'data' in item && typeof item.data === 'string') {
              const mimeType =
                'mediaType' in item && typeof item.mediaType === 'string'
                  ? item.mediaType
                  : 'image/png';
              parts.push({ inlineData: { mimeType, data: item.data } });
            }
          } else if ('text' in item || 'inlineData' in item) {
            parts.push(item as Part);
          }
        }
        return { role, parts: parts.length > 0 ? parts : [{ text: '' }] };
      }
      return { role, parts: [{ text: String(msg.content ?? '') }] };
    });
  }

  const promptText = req.prompt?.trim() ?? '';
  if (!promptText) {
    throw new Error('질문 내용(prompt 또는 messages)이 비어 있습니다.');
  }
  return [{ role: 'user', parts: [{ text: promptText }] }];
}

/**
 * CLAUDE.md §6.1 & §6.2 규격에 맞춘 generateContentStream 요청 파라미터 생성기
 */
export function buildGeminiStreamParams(
  req: GeminiTutorRequest,
  modelOverride?: string,
  includeThinkingConfig = true,
) {
  const target: GeminiTutorTarget = req.target ?? 'sidebar';
  const requestedModel = (modelOverride ?? req.model)?.trim();
  const model = requestedModel || GEMINI_PRIMARY_MODEL;
  const maxOutputTokens = resolveMaxOutputTokens(
    target,
    req.maxOutputTokens ?? (target === 'bubble' ? BUBBLE_MAX_OUTPUT_TOKENS : SIDEBAR_MAX_OUTPUT_TOKENS),
  );
  const systemInstruction = buildAcademicSystemInstruction(req.systemContext);
  const contents = toGeminiContents(req);

  return {
    model,
    contents,
    config: {
      systemInstruction,
      temperature: GEMINI_TEMPERATURE, // 1.0 고정 (임의 감소 금지)
      ...(includeThinkingConfig
        ? {
            thinkingConfig: {
              thinkingLevel: GEMINI_THINKING_CONFIG.thinkingLevel as ThinkingLevel, // 'low'
            },
          }
        : {}),
      maxOutputTokens,
      ...(req.signal ? { abortSignal: req.signal } : {}),
    },
  };
}

function extractChunkText(chunk: GeminiStreamChunkLike): string {
  if (typeof chunk.text === 'string' && chunk.text.length > 0) {
    return chunk.text;
  }
  const parts = chunk.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  let out = '';
  for (const part of parts) {
    if (part && !part.thought && typeof part.text === 'string') {
      out += part.text;
    }
  }
  return out;
}

function shouldFallbackModel(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (status === 404 || status === 503 || status === 429 || status === 500 || status === 502 || status === 504) {
    return true;
  }
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return /not[\s_-]*found|404|503|429|unavailable|high demand|overloaded|does not exist|no longer available|unsupported model|is not supported|models\/gemini/i.test(
    msg,
  );
}

function isThinkingConfigError(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return (
    /thinking_?level|thinkingConfig|thinking_?config|thinkingBudget/i.test(msg) ||
    (status === 400 && /thinking|invalid argument/i.test(msg))
  );
}

export function formatGeminiError(err: unknown): string {
  if (!err) return 'Gemini API 호출 중 알 수 없는 오류가 발생했습니다.';
  const raw = err instanceof Error ? err.message : String(err);
  try {
    const jsonMatch = /\{[\s\S]*\}/.exec(raw);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as {
        error?: { message?: string; code?: number; status?: string };
      };
      const innerMsg = parsed?.error?.message;
      if (typeof innerMsg === 'string') {
        if (innerMsg.trim().startsWith('{')) {
          const nested = JSON.parse(innerMsg) as { error?: { message?: string; code?: number } };
          if (nested?.error?.message) {
            return `Gemini 오류 (${nested.error.code ?? parsed.error?.code ?? 'API'}): ${nested.error.message}`;
          }
        }
        return `Gemini 오류 (${parsed.error?.code ?? 'API'}): ${innerMsg}`;
      }
    }
  } catch {
    // JSON 파싱 실패 시 원문 반환
  }
  return raw;
}

/**
 * 단일 모델에 대해 `{ thinkingConfig: { thinkingLevel: 'low' } }`로 호출하고,
 * 만약 thinkingConfig로 인해 400 에러가 발생하면 thinkingConfig를 제거한 기본값으로 즉시 폴백한다.
 */
async function openStreamWithThinkingFallback(
  ai: GeminiClientLike,
  req: GeminiTutorRequest,
  model: string,
): Promise<AsyncIterable<GeminiStreamChunkLike>> {
  const paramsWithThinking = buildGeminiStreamParams(req, model, true);
  try {
    return await ai.models.generateContentStream(paramsWithThinking);
  } catch (err) {
    if (req.signal?.aborted) throw err;
    if (isThinkingConfigError(err)) {
      console.warn(
        `[Gemini Thinking Fallback] thinkingConfig rejected on ${model}, retrying with default config:`,
        err,
      );
      const paramsWithoutThinking = buildGeminiStreamParams(req, model, false);
      return await ai.models.generateContentStream(paramsWithoutThinking);
    }
    throw err;
  }
}

/**
 * Gemini 학술 튜터 스트리밍 호출 (CLAUDE.md §9)
 * - 반드시 `ai.models.generateContentStream`을 사용해 청크 단위로 텍스트를 산출한다.
 * - 기본 모델 `gemini-3.8-flash` 호출 시 503(과부하)/404(미지원) 등이 발생하면 대안 모델 체인(`gemini-2.5-flash` -> `gemini-3.6-flash` -> `gemini-3.5-flash-lite`)으로 자동 폴백한다.
 */
export async function* streamGeminiTutor(req: GeminiTutorRequest): AsyncGenerator<string> {
  const apiKey = await resolveGeminiApiKey(req.apiKey);
  const ai: GeminiClientLike = req.client ?? getOrCreateGeminiClient(apiKey);
  const primaryModel = req.model?.trim() || GEMINI_PRIMARY_MODEL;
  const allowFallback = req.enableFallback !== false;

  const candidateModels: string[] = [primaryModel];
  if (allowFallback) {
    for (const fallback of [GEMINI_FALLBACK_MODEL, ...GEMINI_FALLBACK_CHAIN]) {
      if (!candidateModels.includes(fallback)) {
        candidateModels.push(fallback);
      }
    }
  }

  let stream: AsyncIterable<GeminiStreamChunkLike> | null = null;
  let lastError: unknown = null;

  for (let i = 0; i < candidateModels.length; i++) {
    const model = candidateModels[i];
    try {
      stream = await openStreamWithThinkingFallback(ai, req, model);
      lastError = null;
      break;
    } catch (err) {
      lastError = err;
      console.error(`[Gemini generateContentStream Error] model=${model}:`, err);
      if (req.signal?.aborted) {
        throw err;
      }
      const hasMoreCandidates = i < candidateModels.length - 1;
      if (!hasMoreCandidates || !shouldFallbackModel(err)) {
        throw new Error(formatGeminiError(err));
      }
      console.warn(`[Gemini Model Fallback] ${model} failed, falling back to ${candidateModels[i + 1]}...`);
    }
  }

  if (!stream) {
    throw new Error(formatGeminiError(lastError));
  }

  let accumulated = '';
  try {
    for await (const chunk of stream) {
      if (req.signal?.aborted) break;
      console.log('Chunk received:', chunk);
      const delta = extractChunkText(chunk);
      if (delta) {
        accumulated += delta;
        req.onChunk?.(delta, accumulated);
        yield delta;
      }
    }
  } catch (streamErr) {
    console.error('[Gemini Stream Iteration Error]:', streamErr);
    if (req.signal?.aborted) return;
    throw new Error(formatGeminiError(streamErr));
  }
}

/**
 * 질문에 대응하여 스트리밍으로 청크를 수집하면서 최종 답변 문자열을 반환하는 헬퍼 함수
 */
export async function askGeminiTutor(req: GeminiTutorRequest): Promise<string> {
  let fullText = '';
  for await (const chunk of streamGeminiTutor(req)) {
    fullText += chunk;
  }
  return fullText;
}
