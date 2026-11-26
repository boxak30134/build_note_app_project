/**
 * errorMessages.ts — HTTP 상태 및 에러 분류별 사용자 안내 메시지 매핑과 API 키 마스킹
 */

export type GeminiErrorClassification =
  | 'retryable'
  | 'fatal-model'
  | 'fatal-request'
  | 'fatal-auth'
  | 'fatal-permission'
  | 'fatal-safety'
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

export type GeminiFailureCategory =
  | 'input-too-long'
  | 'rate-limit-rpm'
  | 'timeout'
  | 'server-overload'
  | 'model-unavailable'
  | 'auth'
  | 'permission'
  | 'safety'
  | 'unknown';

export function diagnoseGeminiFailureReason(err: unknown): {
  category: GeminiFailureCategory;
  detailKo: string;
} {
  if (err instanceof TimeoutError) {
    if (err.stage === 'first-chunk') {
      return {
        category: 'timeout',
        detailKo: '첫 토큰 스트리밍 응답 대기 시간 초과 (네트워크 지연 또는 긴 입력 처리 지연)',
      };
    }
    if (err.stage === 'chunk-gap') {
      return {
        category: 'timeout',
        detailKo: '스트리밍 청크 간 무응답 시간 초과',
      };
    }
    return {
      category: 'timeout',
      detailKo: '전체 요청·재시도 시간 예산 초과',
    };
  }

  const status = extractHttpStatus(err);
  const rawMsg = err instanceof Error ? err.message : String(err ?? '');
  const sanitized = sanitizeLogMessage(rawMsg);

  if (
    /token|context[\s_-]*length|too[\s_-]*long|payload|exceeds?\s+the\s+maximum|input_token|max_tokens/i.test(sanitized) &&
    (status === 400 || status === 429 || status === 413 || !status)
  ) {
    return {
      category: 'input-too-long',
      detailKo: '입력 길이(대화 히스토리/노트 문맥 토큰 수)가 모델 상한을 초과했습니다',
    };
  }

  if (status === 429 || /rate[\s_-]*limit|requests?\s+per\s+minute|\bRPM\b|\bTPM\b|quota|RESOURCE_EXHAUSTED/i.test(sanitized)) {
    return {
      category: 'rate-limit-rpm',
      detailKo: '분당 요청·토큰 한도(429, RPM/TPM 또는 무료 티어 쿼터)를 초과했습니다',
    };
  }

  if (/timeout|timed?\s*out/i.test(sanitized)) {
    return {
      category: 'timeout',
      detailKo: '서버 응답 대기 시간 초과',
    };
  }

  if (status === 503 || /unavailable|high demand|overloaded/i.test(sanitized)) {
    return {
      category: 'server-overload',
      detailKo: 'Gemini 서버 일시 혼잡(503)',
    };
  }

  if (status === 404 || /not[\s_-]*found|does not exist|no longer available|unsupported model/i.test(sanitized)) {
    return {
      category: 'model-unavailable',
      detailKo: '요청한 모델 ID를 현재 엔드포인트에서 사용할 수 없음(404)',
    };
  }

  if (status === 401 || /api_key_invalid|invalid api key|unauthenticated/i.test(sanitized)) {
    return {
      category: 'auth',
      detailKo: 'API Key 인증 실패(401)',
    };
  }

  if (status === 403 || /permission denied|free tier|billing/i.test(sanitized)) {
    return {
      category: 'permission',
      detailKo: 'API 접근 권한 또는 결제/무료 티어 제한(403)',
    };
  }

  if (/safety|prohibited_content|recitation|blocklist|harm_category|안전 정책/i.test(sanitized)) {
    return {
      category: 'safety',
      detailKo: '안전 정책 차단',
    };
  }

  return {
    category: 'unknown',
    detailKo: sanitized || '알 수 없는 오류',
  };
}

export interface ModelAttemptFailure {
  model: string;
  status: number | null;
  summary: string;
  stage?: 'primary' | 'fallback-trimmed';
  reasonKo?: string;
}

export class AllModelsFailedError extends Error {
  readonly lastError: unknown;
  readonly triedModels: string[];
  readonly lastStatusCode: number | null;
  readonly attemptFailures: ModelAttemptFailure[];
  readonly diagnosedCause: { category: GeminiFailureCategory; detailKo: string };

  constructor(
    lastError: unknown,
    triedModels: string[],
    attemptFailures: ModelAttemptFailure[] = [],
  ) {
    const status = extractHttpStatus(lastError);
    const statusText = status ? ` [HTTP ${status}]` : '';
    const lastMsg = lastError instanceof Error ? lastError.message : String(lastError ?? '알 수 없는 오류');
    const diagnosed = diagnoseGeminiFailureReason(lastError);
    const breakdownText =
      attemptFailures.length > 0
        ? ` 실패 내역: ${attemptFailures
            .map((f) => {
              const stagePrefix = f.stage === 'fallback-trimmed' ? '폴백경량:' : f.stage === 'primary' ? '1차:' : '';
              return `${stagePrefix}${f.model}(${f.status ?? f.summary})`;
            })
            .join(' → ')} |`
        : '';
    super(
      `모든 Gemini 모델 호출에 실패했습니다${statusText}. (시도된 모델: ${triedModels.join(', ')})${breakdownText} [원인 안내: ${diagnosed.detailKo}] 마지막 오류: ${sanitizeLogMessage(lastMsg)}`,
    );
    this.name = 'AllModelsFailedError';
    this.lastError = lastError;
    this.triedModels = triedModels;
    this.lastStatusCode = status;
    this.attemptFailures = attemptFailures;
    this.diagnosedCause = diagnosed;
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
  if (/safety|prohibited_content|recitation|blocklist|harm_category|안전 정책/i.test(msg)) {
    return 'fatal-safety';
  }
  if (/unavailable|high demand|overloaded|rate limit|quota|failed to fetch|network\s*error|econnreset|etimedout|socket hang up/i.test(msg)) {
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
  if (err instanceof AllModelsFailedError) {
    return `${err.diagnosedCause.detailKo}. (${err.message})`;
  }
  const classification = classifyGeminiError(err);
  const status = extractHttpStatus(err);
  const statusText = status ? ` (${status})` : '';
  const rawMsg = err instanceof Error ? err.message : String(err);
  const sanitized = sanitizeLogMessage(rawMsg);
  const diagnosed = diagnoseGeminiFailureReason(err);

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
      return diagnosed.category === 'input-too-long'
        ? `${diagnosed.detailKo}${statusText}. 대화 내역이나 문맥 길이를 줄인 뒤 다시 시도해주세요.`
        : `요청 형식이 올바르지 않습니다${statusText}.`;
    case 'fatal-safety':
      return '안전 정책에 의해 응답이 차단되었습니다. 표현을 수정한 뒤 다시 질문해주세요.';
    case 'timeout':
      return `${diagnosed.detailKo}. 잠시 후 다시 시도해주세요.`;
    case 'retryable':
      if (status === 503) {
        return 'Gemini 서버가 일시적으로 혼잡합니다(503). 잠시 후 다시 시도해주세요.';
      }
      if (status === 429) {
        return `${diagnosed.detailKo}. 잠시 후 다시 시도해주세요.`;
      }
      return `서버 일시 오류가 발생했습니다${statusText}. 잠시 후 다시 시도해주세요.`;
    default:
      return sanitized || 'Gemini API 호출 중 알 수 없는 오류가 발생했습니다.';
  }
}
