import { GoogleGenAI, type Content, type Part, type ThinkingLevel } from '@google/genai/web';
import type { ModelMessage } from 'ai';
import { loadApiKey } from '../../storage/secureStore';
import { sanitizeEnvApiKey } from '../../core/android/androidDeployment';
import {
  BUBBLE_MAX_OUTPUT_TOKENS,
  buildAcademicSystemInstruction,
  CHUNK_GAP_TIMEOUT_MS,
  FIRST_CHUNK_TIMEOUT_MS,
  GEMINI_FALLBACK_CHAIN,
  GEMINI_FALLBACK_MODEL,
  GEMINI_PRIMARY_MODEL,
  GEMINI_TEMPERATURE,
  GEMINI_THINKING_CONFIG,
  MAX_RETRY_ATTEMPTS,
  RETRY_BASE_DELAY_MS,
  RETRY_JITTER_RATIO,
  resolveMaxOutputTokens,
  SIDEBAR_MAX_OUTPUT_TOKENS,
  TOTAL_REQUEST_BUDGET_MS,
  type GeminiTutorTarget,
} from './constants';
import {
  AllModelsFailedError,
  EmptyStreamError,
  TimeoutError,
  classifyGeminiError,
  extractHttpStatus,
  extractRetryDelayMs,
  sanitizeLogMessage,
} from './errorMessages';

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
      role?: string;
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
  /** 재시도 기본 대기 시간(ms). 테스트 시 단축 주입용 (기본값: RETRY_BASE_DELAY_MS = 1000) */
  retryDelayMs?: number;
  /** 첫 청크 타임아웃(ms) (기본값: FIRST_CHUNK_TIMEOUT_MS = 12000) */
  firstChunkTimeoutMs?: number;
  /** 청크 간 무응답 타임아웃(ms) (기본값: CHUNK_GAP_TIMEOUT_MS = 20000) */
  chunkGapTimeoutMs?: number;
  /** 전체 요청 예산(ms) (기본값: TOTAL_REQUEST_BUDGET_MS = 90000) */
  totalBudgetMs?: number;
  /** 실제 스트리밍 응답을 개시한 모델 확정 콜백 */
  onModelResolved?: (model: string) => void;
  /** 재시도 시 UI 알림 콜백 (모델명, 시도 횟수, 대기 시간 ms) */
  onRetry?: (model: string, attempt: number, delayMs: number) => void;
  /** 폴백 전환 시 UI 알림 콜백 (이전 모델명, 전환될 모델명) */
  onFallback?: (fromModel: string, toModel: string) => void;
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

export function isRetryableHttpError(err: unknown): boolean {
  const cls = classifyGeminiError(err);
  return cls === 'retryable' || cls === 'timeout';
}

export function isFatalHttpError(err: unknown): boolean {
  const cls = classifyGeminiError(err);
  return cls === 'fatal-auth' || cls === 'fatal-permission' || cls === 'fatal-request' || cls === 'fatal-model';
}

export function shouldFallbackModel(err: unknown): boolean {
  const cls = classifyGeminiError(err);
  return cls === 'retryable' || cls === 'timeout' || cls === 'fatal-model';
}

/**
 * 타임아웃 및 AbortSignal을 결합한 비동기 작업 래퍼
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
  stage: 'first-chunk' | 'chunk-gap' | 'budget' = 'first-chunk',
): Promise<T> {
  if (signal?.aborted) {
    throw new DOMException('The operation was aborted', 'AbortError');
  }

  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new TimeoutError(stage, `응답 대기 시간(${timeoutMs}ms)이 초과되었습니다.`));
    }, timeoutMs);
  });

  const abortPromise = new Promise<never>((_, reject) => {
    if (!signal) return;
    const onAbort = () => {
      reject(new DOMException('The operation was aborted', 'AbortError'));
    };
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });

  try {
    return await Promise.race([promise, timeoutPromise, abortPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 지수형 Backoff + ±20% Jitter 대기 함수. (429 Retry-After 우선 반영 및 AbortSignal 즉시 취소)
 */
export async function waitWithBackoffAndJitter(
  attempt: number,
  baseDelayMs = RETRY_BASE_DELAY_MS,
  signal?: AbortSignal,
  customDelayMs?: number | null,
): Promise<number> {
  if (signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError');

  let delayMs: number;
  if (typeof customDelayMs === 'number' && customDelayMs > 0) {
    delayMs = Math.min(10000, customDelayMs);
  } else {
    const exponential = baseDelayMs * Math.pow(2, attempt);
    const jitter = (Math.random() * (RETRY_JITTER_RATIO * 2) - RETRY_JITTER_RATIO) * exponential;
    delayMs = Math.max(10, Math.round(exponential + jitter));
  }

  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const onAbort = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new DOMException('The operation was aborted', 'AbortError'));
    };

    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);

    signal?.addEventListener('abort', onAbort);
  });

  return delayMs;
}

function isThinkingConfigError(err: unknown): boolean {
  const status = extractHttpStatus(err);
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return (
    /thinking_?level|thinkingConfig|thinking_?config|thinkingBudget/i.test(msg) ||
    (status === 400 && /thinking|invalid argument/i.test(msg))
  );
}

export function formatGeminiError(err: unknown): string {
  if (!err) return 'Gemini API 호출 중 알 수 없는 오류가 발생했습니다.';
  const raw =
    err instanceof Error
      ? err.message
      : typeof err === 'object' && err && 'message' in err
        ? String((err as any).message)
        : String(err);

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
    // JSON 파싱 실패 시 원문 진행
  }

  const status = extractHttpStatus(err);
  if (status && raw && !raw.includes(`(${status})`)) {
    return `Gemini 오류 (${status}): ${raw}`;
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

export interface ProbedStream {
  iterator: AsyncIterator<GeminiStreamChunkLike>;
  firstResult: IteratorResult<GeminiStreamChunkLike>;
  model: string;
}

/**
 * Lazy Throw 문제를 방지하기 위해 스트림을 열고 첫 번째 청크를 사전에 읽어(probe) 검증한다.
 * FIRST_CHUNK_TIMEOUT_MS(기본 12초) 타임아웃을 적용하며, 첫 청크 fetch 중 thinkingConfig 오류 발생 시 안전하게 복구한다.
 */
export async function probeStreamFirstChunk(
  ai: GeminiClientLike,
  req: GeminiTutorRequest,
  model: string,
  timeoutMs = FIRST_CHUNK_TIMEOUT_MS,
): Promise<ProbedStream> {
  const stream = await openStreamWithThinkingFallback(ai, req, model);
  const iterator = (stream as AsyncIterable<GeminiStreamChunkLike>)[Symbol.asyncIterator]();
  try {
    const firstResult = await withTimeout(iterator.next(), timeoutMs, req.signal, 'first-chunk');
    if (firstResult.done) {
      throw new EmptyStreamError();
    }
    return { iterator, firstResult, model };
  } catch (firstErr) {
    if (req.signal?.aborted) throw firstErr;
    if (isThinkingConfigError(firstErr)) {
      console.warn(
        `[Gemini Thinking Fallback on First Chunk] model=${model} failed with thinkingConfig:`,
        firstErr,
      );
      const paramsWithoutThinking = buildGeminiStreamParams(req, model, false);
      const fallbackStream = await ai.models.generateContentStream(paramsWithoutThinking);
      const fallbackIter = (fallbackStream as AsyncIterable<GeminiStreamChunkLike>)[Symbol.asyncIterator]();
      const firstResult = await withTimeout(fallbackIter.next(), timeoutMs, req.signal, 'first-chunk');
      if (firstResult.done) {
        throw new EmptyStreamError();
      }
      return { iterator: fallbackIter, firstResult, model };
    }
    throw firstErr;
  }
}

/**
 * Gemini 학술 튜터 스트리밍 호출 (GEMINIAIPANELNORESPONSE_FIX 명세 준수)
 * - 503(과부하), 429(속도제한), 타임아웃 오류 시 동일 모델에 대해 지수 백오프+Jitter로 최대 3회 재시도.
 * - 404 발생 시 즉시 대안 모델로 폴백. 400/401/403은 즉시 throw.
 * - 첫 청크 12초, 청크 간 20초, 전체 예산 90초 타임아웃 엄격 적용.
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

  const startTime = Date.now();
  const totalBudgetMs = req.totalBudgetMs ?? TOTAL_REQUEST_BUDGET_MS;
  const firstChunkTimeoutMs = req.firstChunkTimeoutMs ?? FIRST_CHUNK_TIMEOUT_MS;
  const chunkGapTimeoutMs = req.chunkGapTimeoutMs ?? CHUNK_GAP_TIMEOUT_MS;
  const retryBaseDelayMs = req.retryDelayMs ?? RETRY_BASE_DELAY_MS;

  let probed: ProbedStream | null = null;
  let lastError: unknown = null;
  const triedModels: string[] = [];

  for (let i = 0; i < candidateModels.length; i++) {
    const model = candidateModels[i];
    triedModels.push(model);
    let modelSucceeded = false;

    for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
      if (req.signal?.aborted) return;
      if (Date.now() - startTime >= totalBudgetMs) {
        throw new TimeoutError('budget', `전체 요청 시간 상한(${totalBudgetMs}ms)을 초과했습니다.`);
      }

      try {
        probed = await probeStreamFirstChunk(ai, req, model, firstChunkTimeoutMs);
        lastError = null;
        modelSucceeded = true;
        req.onModelResolved?.(model);
        break;
      } catch (err) {
        lastError = err;
        console.error(
          `[Gemini generateContentStream Error] model=${model} (attempt ${attempt + 1}/${MAX_RETRY_ATTEMPTS}):`,
          sanitizeLogMessage(err instanceof Error ? err.message : String(err)),
        );

        const classification = classifyGeminiError(err);
        if (classification === 'cancelled') {
          return;
        }

        // 치명적 요청/인증/권한 에러는 재시도나 폴백 없이 즉시 중단
        if (
          classification === 'fatal-request' ||
          classification === 'fatal-auth' ||
          classification === 'fatal-permission'
        ) {
          throw err;
        }

        // 404 모델 미지원은 재시도 없이 즉시 다음 모델로 이동
        if (classification === 'fatal-model') {
          break;
        }

        // 503, 429, 타임아웃 등 재시도 가능 오류
        if (attempt < MAX_RETRY_ATTEMPTS - 1) {
          const customDelay = extractRetryDelayMs(err);
          const actualDelay = await waitWithBackoffAndJitter(
            attempt,
            retryBaseDelayMs,
            req.signal,
            customDelay,
          );
          req.onRetry?.(model, attempt + 2, actualDelay);
          continue;
        }

        // 이 모델의 재시도 횟수를 모두 소진함
        break;
      }
    }

    if (modelSucceeded) {
      break;
    }

    const hasMoreCandidates = i < candidateModels.length - 1;
    if (hasMoreCandidates) {
      req.onFallback?.(model, candidateModels[i + 1]);
      console.warn(
        `[Gemini Model Fallback] ${model} failed, falling back to ${candidateModels[i + 1]}...`,
      );
    }
  }

  if (!probed) {
    throw new AllModelsFailedError(lastError, triedModels);
  }

  let accumulated = '';
  const { iterator, firstResult } = probed;

  try {
    if (!firstResult.done && firstResult.value) {
      console.log('Chunk received:', firstResult.value);
      const delta = extractChunkText(firstResult.value);
      if (delta) {
        accumulated += delta;
        req.onChunk?.(delta, accumulated);
        yield delta;
      }
    }

    while (!req.signal?.aborted) {
      let nextResult: IteratorResult<GeminiStreamChunkLike>;
      try {
        nextResult = await withTimeout(iterator.next(), chunkGapTimeoutMs, req.signal, 'chunk-gap');
      } catch (gapErr) {
        if (gapErr instanceof TimeoutError && gapErr.stage === 'chunk-gap') {
          console.warn('[Gemini Stream Gap Timeout] Response truncated by gap timeout');
          const notice = '\n\n[알림: 응답이 중간에 끊어졌습니다]';
          accumulated += notice;
          req.onChunk?.(notice, accumulated);
          yield notice;
          break;
        }
        throw gapErr;
      }

      if (nextResult.done) break;
      console.log('Chunk received:', nextResult.value);
      const delta = extractChunkText(nextResult.value);
      if (delta) {
        accumulated += delta;
        req.onChunk?.(delta, accumulated);
        yield delta;
      }
    }
  } catch (streamErr) {
    if (req.signal?.aborted || (streamErr instanceof DOMException && streamErr.name === 'AbortError')) {
      return;
    }
    console.error('[Gemini Stream Iteration Error]:', sanitizeLogMessage(streamErr instanceof Error ? streamErr.message : String(streamErr)));
    throw streamErr;
  }
}

/**
 * API Key 사전 검증 (설정 화면 저장 시 1회 호출)
 * 1) models.list 호출 확인 (401/403 감지)
 * 2) gemini-flash-lite-latest 로 'ping' 1회 호출하여 활성 상태 점검
 */
export async function validateGeminiApiKey(
  apiKey: string,
): Promise<{ valid: boolean; status: 'ok' | 'busy' | 'invalid' | 'permission_denied'; message: string }> {
  const trimmed = apiKey.trim();
  if (!trimmed) {
    return { valid: false, status: 'invalid', message: 'API Key를 입력해주세요.' };
  }
  const ai = getOrCreateGeminiClient(trimmed);

  try {
    // 1. models.list 가용성 확인
    if (typeof (ai.models as any).list === 'function') {
      await withTimeout((ai.models as any).list(), 5000, undefined, 'first-chunk');
    }
  } catch (listErr) {
    const cls = classifyGeminiError(listErr);
    if (cls === 'fatal-auth') {
      return { valid: false, status: 'invalid', message: 'API Key가 유효하지 않습니다.' };
    }
    if (cls === 'fatal-permission') {
      return {
        valid: false,
        status: 'permission_denied',
        message: '이 프로젝트는 무료 티어를 사용할 수 없거나 API 권한이 없습니다.',
      };
    }
  }

  try {
    // 2. 가장 가벼운 모델로 ping (1 토큰)
    await withTimeout(
      ai.models.generateContent({
        model: 'gemini-flash-lite-latest',
        contents: 'ping',
        config: { maxOutputTokens: 1 },
      }),
      7000,
      undefined,
      'first-chunk',
    );
    return { valid: true, status: 'ok', message: '사용 가능한 정상 API Key입니다.' };
  } catch (pingErr) {
    const cls = classifyGeminiError(pingErr);
    if (cls === 'fatal-auth') {
      return { valid: false, status: 'invalid', message: 'API Key가 유효하지 않습니다.' };
    }
    if (cls === 'fatal-permission') {
      return {
        valid: false,
        status: 'permission_denied',
        message: '이 프로젝트는 무료 티어를 사용할 수 없습니다. Google AI Studio에서 결제/프로젝트 설정을 확인하세요.',
      };
    }
    if (cls === 'retryable') {
      return {
        valid: true,
        status: 'busy',
        message: '키는 정상이나 현재 Gemini 서버가 혼잡합니다. 키 저장은 완료되었습니다.',
      };
    }
    return { valid: true, status: 'ok', message: '키가 정상적으로 등록되었습니다.' };
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
