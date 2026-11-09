/**
 * errorMessages.ts — HTTP 상태 및 에러 분류별 사용자 안내 메시지 매핑과 API 키 마스킹
 */

export type GeminiErrorClassification =
  | 'retryable'
  | 'fatal-model'
  | 'fatal-request'
  | 'fatal-auth'
  | 'fatal-permission'
  | 'timeout'
  | 'cancelled'
  | 'unknown';

export class TimeoutError extends Error {
  readonly stage: 'first-chunk' | 'chunk-gap' | 'budget';
  constructor(stage: 'first-chunk' | 'chunk-gap' | 'budget', message?: string) {
    super(message ?? `타임아웃 발생 (단계: ${stage})`);
    this.name = 'TimeoutError';
    this.stage = stage;
  }
}

export class EmptyStreamError extends Error {
  constructor(message = '스트림이 빈 상태로 종료되었습니다.') {
    super(message);
    this.name = 'EmptyStreamError';
  }
}

export class AllModelsFailedError extends Error {
  readonly lastError: unknown;
  readonly triedModels: string[];
  readonly lastStatusCode: number | null;

  constructor(lastError: unknown, triedModels: string[]) {
    const status = extractHttpStatus(lastError);
    const statusText = status ? ` [HTTP ${status}]` : '';
    const lastMsg = lastError instanceof Error ? lastError.message : String(lastError ?? '알 수 없는 오류');
    super(
      `모든 Gemini 모델 호출에 실패했습니다${statusText}. (시도된 모델: ${triedModels.join(', ')}) 마지막 오류: ${sanitizeLogMessage(lastMsg)}`,
    );
    this.name = 'AllModelsFailedError';
    this.lastError = lastError;
    this.triedModels = triedModels;
    this.lastStatusCode = status;
  }
}

/** API Key 마스킹 (앞 5자, 뒤 4자만 노출, 9자 이하이면 '***') */
export function maskApiKey(key?: string): string {
  if (!key) return '(empty)';
  const trimmed = key.trim();
  if (trimmed.length <= 9) return '***';
  return `${trimmed.slice(0, 5)}...${trimmed.slice(-4)}`;
}

/** 메시지 내 혹시 포함될 수 있는 API Key 패턴 마스킹 */
export function sanitizeLogMessage(message: string): string {
  if (!message) return '';
  // Google API Key 일반 패턴: AIza... (35~45자) 또는 AQ.Ab8...
  return message
    .replace(/(AIza[0-9A-Za-z-_]{20,45})/g, (match) => maskApiKey(match))
    .replace(/(AQ\.[0-9A-Za-z-_]{20,})/g, (match) => maskApiKey(match));
}

/**
 * SDK 에러의 다양한 형태에서 HTTP 상태 코드를 추출한다.
 * 1) { status: 503, message }
 * 2) { error: { code: 503, message, status: 'UNAVAILABLE' } }
 * 3) 메시지 문자열에 "code":503 또는 [503 ...] 또는 503 포함된 Error
 */
export function extractHttpStatus(err: unknown): number | null {
  if (!err) return null;

  if (typeof err === 'object') {
    const errObj = err as Record<string, unknown>;
    if (typeof errObj.status === 'number' && errObj.status >= 100 && errObj.status < 600) {
      return errObj.status;
    }
    const nestedError = errObj.error as Record<string, unknown> | undefined;
    if (nestedError && typeof nestedError.code === 'number' && nestedError.code >= 100 && nestedError.code < 600) {
      return nestedError.code;
    }
  }

  const raw = err instanceof Error ? err.message : String(err);
  if (!raw) return null;

  const jsonCodeMatch = /"code"\s*:\s*(\d{3})/i.exec(raw);
  if (jsonCodeMatch) {
    const parsed = Number(jsonCodeMatch[1]);
    if (parsed >= 100 && parsed < 600) return parsed;
  }

  const bracketMatch = /\[\s*(\d{3})\s*[^\]]*\]/i.exec(raw);
  if (bracketMatch) {
    const parsed = Number(bracketMatch[1]);
    if (parsed >= 100 && parsed < 600) return parsed;
  }

  const standaloneMatch = /\b(400|401|403|404|429|500|502|503|504)\b/.exec(raw);
  if (standaloneMatch) {
    return Number(standaloneMatch[1]);
  }

  return null;
}

/**
 * 에러를 분류 규칙에 따라 체계적으로 분류한다.
 */
export function classifyGeminiError(err: unknown): GeminiErrorClassification {
  if (!err) return 'unknown';

  if (
    (err instanceof DOMException && err.name === 'AbortError') ||
    (err instanceof Error && /abort|cancelled|사용자\s*취소/i.test(err.message))
  ) {
    return 'cancelled';
  }

  if (err instanceof TimeoutError || (err instanceof Error && /timeout|timed?\s*out/i.test(err.message))) {
    return 'timeout';
  }

  const status = extractHttpStatus(err);
  if (status === 404) return 'fatal-model';
  if (status === 400) return 'fatal-request';
  if (status === 401) return 'fatal-auth';
  if (status === 403) return 'fatal-permission';
  if (status === 503 || status === 429 || status === 500 || status === 502 || status === 504) {
    return 'retryable';
  }

  const msg = err instanceof Error ? err.message : String(err);
  if (/not[\s_-]*found|does not exist|no longer available|unsupported model/i.test(msg)) {
    return 'fatal-model';
  }
  if (/invalid argument|thinking_?level|thinkingConfig/i.test(msg)) {
    return 'fatal-request';
  }
  if (/api_key_invalid|invalid api key|unauthenticated/i.test(msg)) {
    return 'fatal-auth';
  }
  if (/permission denied|free tier|billing/i.test(msg)) {
    return 'fatal-permission';
  }
  if (/unavailable|high demand|overloaded|rate limit|quota/i.test(msg)) {
    return 'retryable';
  }

  return 'unknown';
}

/**
 * 429 오류 응답에서 Retry-After 또는 retryDelay(초/밀리초)를 추출한다. (상한: 10,000ms)
 */
export function extractRetryDelayMs(err: unknown): number | null {
  if (!err) return null;
  const raw = err instanceof Error ? err.message : String(err);
  // e.g. retryDelay: "5s" or "5000ms"
  const secMatch = /retryDelay["']?\s*:\s*["']?(\d+(?:\.\d+)?)s/i.exec(raw);
  if (secMatch) {
    const sec = parseFloat(secMatch[1]);
    return Math.min(10000, Math.round(sec * 1000));
  }
  const msMatch = /retryDelay["']?\s*:\s*["']?(\d+)ms/i.exec(raw);
  if (msMatch) {
    return Math.min(10000, parseInt(msMatch[1], 10));
  }
  // Retry-After: 5
  const retryAfterMatch = /retry-after["']?\s*:\s*["']?(\d+)/i.exec(raw);
  if (retryAfterMatch) {
    return Math.min(10000, parseInt(retryAfterMatch[1], 10) * 1000);
  }
  return null;
}

/**
 * 사용자 친화적인 에러 메시지를 생성한다.
 */
export function getUserFacingErrorMessage(err: unknown): string {
  if (!err) return 'Gemini 호출 중 알 수 없는 오류가 발생했습니다.';
  const classification = classifyGeminiError(err);
  const status = extractHttpStatus(err);
  const statusText = status ? ` (${status})` : '';
  const rawMsg = err instanceof Error ? err.message : String(err);
  const sanitized = sanitizeLogMessage(rawMsg);

  switch (classification) {
    case 'cancelled':
      return '취소됨';
    case 'fatal-auth':
      return 'API Key가 유효하지 않습니다. 우측 사이드바에서 올바른 키를 다시 등록해주세요.';
    case 'fatal-permission':
      if (/free tier|billing|PERMISSION_DENIED/i.test(sanitized)) {
        return '이 프로젝트는 무료 티어를 사용할 수 없습니다. Google AI Studio에서 결제 계정 또는 프로젝트 상태를 확인하세요.';
      }
      return `API 접근 권한이 없습니다${statusText}. Google AI Studio에서 키 권한을 확인하세요.`;
    case 'fatal-model':
      return `요청한 모델을 사용할 수 없습니다${statusText}.`;
    case 'fatal-request':
      return `요청 형식이 올바르지 않습니다${statusText}.`;
    case 'timeout':
      return '서버 응답 시간이 초과되었습니다. 잠시 후 다시 시도해주세요.';
    case 'retryable':
      if (status === 503) {
        return 'Gemini 서버가 일시적으로 혼잡합니다(503). 잠시 후 다시 시도해주세요.';
      }
      if (status === 429) {
        return 'API 요청 한도를 초과했습니다(429). 잠시 후 다시 시도해주세요.';
      }
      return `서버 일시 오류가 발생했습니다${statusText}. 잠시 후 다시 시도해주세요.`;
    default:
      return sanitized || 'Gemini API 호출 중 알 수 없는 오류가 발생했습니다.';
  }
}
