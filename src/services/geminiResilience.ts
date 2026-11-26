import {
  GEMINI_FALLBACK_CHAIN,
  GEMINI_FALLBACK_MODEL,
  GEMINI_PRIMARY_MODEL,
  MAX_RETRY_ATTEMPTS,
  TOTAL_REQUEST_BUDGET_MS,
} from '../modules/ai/constants';
import {
  AllModelsFailedError,
  TimeoutError,
  classifyGeminiError,
  diagnoseGeminiFailureReason,
  extractHttpStatus,
  extractRetryDelayMs,
  getUserFacingErrorMessage,
  sanitizeLogMessage,
  type ModelAttemptFailure,
} from '../modules/ai/errorMessages';

/** 재시도 단계별 지수 백오프 기본 대기 시간(ms): 1초 -> 2.5초 -> 5초 */
export const GEMINI_BACKOFF_SCHEDULE_MS = [1000, 2500, 5000] as const;
/** 지터 최대 범위(ms): 0 ~ 300ms */
export const GEMINI_BACKOFF_JITTER_MAX_MS = 300;

export type GeminiResiliencePhase =
  | 'queued'
  | 'connecting'
  | 'retrying'
  | 'fallback'
  | 'streaming'
  | 'done'
  | 'error'
  | 'cancelled';

export interface GeminiResilienceStatus {
  phase: GeminiResiliencePhase;
  model?: string;
  fromModel?: string;
  requestedModel?: string;
  usedFallback?: boolean;
  attempt?: number;
  maxRetries?: number;
  delayMs?: number;
  message: string;
}

export interface GeminiResilienceOptions {
  /** 사용자가 설정에서 선택한 기본 모델 ID */
  primaryModel?: string;
  /** 실패 시 경량 모델 폴백 체인 활성화 여부 (기본 true) */
  enableFallback?: boolean;
  /** 최대 자동 재시도 횟수 (기본 3회) */
  maxRetries?: number;
  /** 테스트용 기본 대기 시간 오버라이드(ms). 미지정 시 [1000, 2500, 5000] + 0~300ms 지터 적용 */
  retryDelayMs?: number;
  /** 전체 재시도·폴백 시간 예산(ms) */
  totalBudgetMs?: number;
  /** 취소 시그널 */
  signal?: AbortSignal;
  /** 내부 직렬 큐 사용 여부 (기본 true) */
  useQueue?: boolean;
  /** 작업 레이블 (로그용) */
  label?: string;
  /** 상태 변경 콜백 (UI 버튼/배지 실시간 반영용) */
  onStatusChange?: (status: GeminiResilienceStatus) => void;
  /** 재시도 콜백 */
  onRetry?: (model: string, attempt: number, delayMs: number, nextModel?: string) => void;
  /** 폴백 모델 전환 콜백 */
  onFallback?: (fromModel: string, toModel: string) => void;
  /** 최종 응답 모델 확정 콜백 */
  onModelResolved?: (model: string, info: { requestedModel: string; usedFallback: boolean }) => void;
}

export interface GeminiResilienceResult<T> {
  value: T;
  model: string;
  requestedModel: string;
  usedFallback: boolean;
  attempts: number;
}

/**
 * 선택된 기본 모델에 따라 가용성이 높은 현행 GA 모델 폴백 체인을 구성한다.
 * 신규 API 키에서 HTTP 404를 유발하는 레거시 2.5 계열은 3.x/4.x 폴백 체인에서 배제한다.
 */
export function buildGeminiFallbackChain(primaryModel?: string, enableFallback = true): string[] {
  const primary = primaryModel?.trim() || GEMINI_PRIMARY_MODEL;
  const chain: string[] = [primary];
  if (!enableFallback) return chain;

  let fallbacks: readonly string[];
  if (primary === 'gemini-2.5-pro') {
    fallbacks = ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite'];
  } else if (primary === 'gemini-2.5-flash' || primary === 'gemini-2.5-flash-lite') {
    fallbacks = ['gemini-3.5-flash-lite', 'gemini-3.8-flash', 'gemini-3.6-flash'];
  } else if (primary === 'gemini-1.5-flash') {
    fallbacks = ['gemini-3.5-flash-lite', 'gemini-3.8-flash'];
  } else if (primary === GEMINI_PRIMARY_MODEL) {
    fallbacks = GEMINI_FALLBACK_CHAIN;
  } else {
    fallbacks = [
      GEMINI_PRIMARY_MODEL,
      GEMINI_FALLBACK_MODEL,
      ...GEMINI_FALLBACK_CHAIN,
    ];
  }

  for (const candidate of fallbacks) {
    if (candidate && !chain.includes(candidate)) {
      chain.push(candidate);
    }
  }
  return chain;
}

// ============================================================================
// 전역 FIFO 직렬 큐 (무료 티어 RPM 한도 보호)
// ============================================================================
let queueTail: Promise<void> = Promise.resolve();
let queuedCount = 0;

export function getGeminiQueuePendingCount(): number {
  return queuedCount;
}

export async function acquireGeminiQueueSlot(signal?: AbortSignal): Promise<() => void> {
  if (signal?.aborted) {
    throw new DOMException('The operation was aborted', 'AbortError');
  }

  queuedCount++;
  const prev = queueTail;
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = () => {
      queuedCount = Math.max(0, queuedCount - 1);
      resolve();
    };
  });
  queueTail = prev.then(
    () => next,
    () => next,
  );

  try {
    if (signal) {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          reject(new DOMException('The operation was aborted', 'AbortError'));
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
        prev.then(
          () => {
            signal.removeEventListener('abort', onAbort);
            resolve();
          },
          () => {
            signal.removeEventListener('abort', onAbort);
            resolve();
          },
        );
      });
    } else {
      await prev;
    }
  } catch (err) {
    release();
    throw err;
  }

  return release;
}

export async function enqueueGeminiTask<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const release = await acquireGeminiQueueSlot(signal);
  try {
    return await task();
  } finally {
    release();
  }
}

/**
 * 지수 백오프 + 0~300ms 지터 대기 시간 계산 및 대기
 */
export async function waitWithExponentialBackoff(
  retryIndex: number,
  retryDelayOverrideMs?: number,
  signal?: AbortSignal,
  serverRetryDelayMs?: number | null,
): Promise<number> {
  if (signal?.aborted) {
    throw new DOMException('The operation was aborted', 'AbortError');
  }

  let delayMs: number;
  if (typeof retryDelayOverrideMs === 'number' && retryDelayOverrideMs >= 0) {
    const multipliers = [1, 2.5, 5];
    const mult = multipliers[Math.min(retryIndex, multipliers.length - 1)] ?? 5;
    const jitter = retryDelayOverrideMs >= 50 ? Math.floor(Math.random() * Math.min(300, retryDelayOverrideMs * 0.3)) : 0;
    delayMs = Math.max(0, Math.round(retryDelayOverrideMs * mult + jitter));
  } else if (typeof serverRetryDelayMs === 'number' && serverRetryDelayMs > 0) {
    const jitter = Math.floor(Math.random() * (GEMINI_BACKOFF_JITTER_MAX_MS + 1));
    delayMs = Math.min(10000, serverRetryDelayMs + jitter);
  } else {
    const base = GEMINI_BACKOFF_SCHEDULE_MS[Math.min(retryIndex, GEMINI_BACKOFF_SCHEDULE_MS.length - 1)] ?? 5000;
    const jitter = Math.floor(Math.random() * (GEMINI_BACKOFF_JITTER_MAX_MS + 1));
    delayMs = base + jitter;
  }

  if (delayMs <= 0) return 0;

  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new DOMException('The operation was aborted', 'AbortError'));
    };

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);

    signal?.addEventListener('abort', onAbort, { once: true });
  });

  return delayMs;
}

/**
 * 단일 Gemini API 회복탄력성 호출 래퍼:
 * - 전역 직렬 큐로 동시 요청 RPM 충돌(429) 방지
 * - 503/429/일시적 네트워크 오류 시 지수 백오프(1s -> 2.5s -> 5s + 0~300ms 지터)로 최대 3회 재시도
 * - 첫 호출이 503/429/404로 실패 시 다음 재시도부터 경량 폴백 모델(2.5-flash -> 2.5-flash-lite)로 자동 전환
 * - 400/401/403 API 키 오류 및 안전 정책 차단은 즉시 중단하고 명확한 한국어 안내 반환
 */
export async function callGeminiWithResilience<T>(
  executor: (
    model: string,
    context: { attempt: number; usedFallback: boolean; trimContext: boolean; lastError: unknown },
  ) => Promise<T>,
  options: GeminiResilienceOptions = {},
): Promise<GeminiResilienceResult<T>> {
  const {
    primaryModel = GEMINI_PRIMARY_MODEL,
    enableFallback = true,
    maxRetries = MAX_RETRY_ATTEMPTS,
    retryDelayMs,
    totalBudgetMs = TOTAL_REQUEST_BUDGET_MS,
    signal,
    useQueue = true,
    label = 'gemini',
    onStatusChange,
    onRetry,
    onFallback,
    onModelResolved,
  } = options;

  const requestedModel = primaryModel?.trim() || GEMINI_PRIMARY_MODEL;
  const candidateModels = buildGeminiFallbackChain(requestedModel, enableFallback);

  const run = async (): Promise<GeminiResilienceResult<T>> => {
    const startTime = Date.now();
    let modelIdx = 0;
    let retryCount = 0;
    let totalAttempts = 0;
    let lastError: unknown = null;
    const triedModels: string[] = [];
    const attemptFailures: ModelAttemptFailure[] = [];

    while (true) {
      if (signal?.aborted) {
        throw new DOMException('The operation was aborted', 'AbortError');
      }
      if (Date.now() - startTime >= totalBudgetMs) {
        throw new TimeoutError('budget', `전체 요청 시간 상한(${totalBudgetMs}ms)을 초과했습니다.`);
      }

      const currentModel = candidateModels[modelIdx] ?? requestedModel;
      if (!triedModels.includes(currentModel)) {
        triedModels.push(currentModel);
      }
      const usedFallback = currentModel !== requestedModel;
      const trimContext = usedFallback || totalAttempts > 0;
      totalAttempts++;

      if (totalAttempts === 1) {
        onStatusChange?.({
          phase: 'connecting',
          model: currentModel,
          requestedModel,
          usedFallback,
          message: `${currentModel}에 연결 중…`,
        });
      }

      try {
        const value = await executor(currentModel, {
          attempt: totalAttempts,
          usedFallback,
          trimContext: usedFallback || totalAttempts > 1,
          lastError,
        });
        onModelResolved?.(currentModel, { requestedModel, usedFallback });
        return {
          value,
          model: currentModel,
          requestedModel,
          usedFallback,
          attempts: totalAttempts,
        };
      } catch (err) {
        lastError = err;
        const classification = classifyGeminiError(err);

        if (classification === 'cancelled' || signal?.aborted) {
          onStatusChange?.({
            phase: 'cancelled',
            model: currentModel,
            requestedModel,
            usedFallback,
            message: '취소됨',
          });
          throw err;
        }

        console.error(
          `[Gemini Resilience:${label}] model=${currentModel} attempt=${totalAttempts} (${classification}):`,
          sanitizeLogMessage(err instanceof Error ? err.message : String(err)),
        );

        const errStatus = extractHttpStatus(err);
        const rawErrSummary = sanitizeLogMessage(err instanceof Error ? err.message : String(err ?? ''));
        const diagnosed = diagnoseGeminiFailureReason(err);
        attemptFailures.push({
          model: currentModel,
          status: errStatus,
          summary: classification === 'timeout' ? 'timeout' : rawErrSummary.slice(0, 60) || classification,
          stage: trimContext && totalAttempts > 1 ? 'fallback-trimmed' : 'primary',
          reasonKo: diagnosed.detailKo,
        });

        // 영구 오류(인증/권한/요청형식/안전차단)는 재시도·폴백 없이 즉시 중단
        if (
          classification === 'fatal-request' ||
          classification === 'fatal-auth' ||
          classification === 'fatal-permission' ||
          classification === 'fatal-safety'
        ) {
          const userMsg = getUserFacingErrorMessage(err);
          onStatusChange?.({
            phase: 'error',
            model: currentModel,
            requestedModel,
            usedFallback,
            message: userMsg,
          });
          throw err;
        }

        // 404 모델 미지원은 백오프 없이 즉시 다음 폴백 모델로 전환
        if (classification === 'fatal-model') {
          if (modelIdx < candidateModels.length - 1) {
            const prevModel = currentModel;
            modelIdx++;
            const nextModel = candidateModels[modelIdx];
            onFallback?.(prevModel, nextModel);
            onStatusChange?.({
              phase: 'fallback',
              fromModel: prevModel,
              model: nextModel,
              requestedModel,
              usedFallback: nextModel !== requestedModel,
              message: `${prevModel} 미지원으로 ${nextModel} 전환 중…`,
            });
            continue;
          }
          const finalErr = new AllModelsFailedError(lastError, triedModels, attemptFailures);
          onStatusChange?.({
            phase: 'error',
            model: currentModel,
            requestedModel,
            usedFallback,
            message: getUserFacingErrorMessage(lastError),
          });
          throw finalErr;
        }

        // 오프라인 상태가 명확한 경우 백오프 대기 없이 즉시 오류 전파
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
          onStatusChange?.({
            phase: 'error',
            model: currentModel,
            requestedModel,
            usedFallback,
            message: '네트워크 연결(오프라인) 상태를 확인해주세요.',
          });
          throw err;
        }

        // 일시적 오류(503/429/5xx/타임아웃/네트워크): 최대 3회 백오프 재시도 + 경량 폴백 모델 즉시 전환
        if (retryCount < maxRetries) {
          const prevModel = currentModel;
          const nextModelIdx = modelIdx < candidateModels.length - 1 ? modelIdx + 1 : modelIdx;
          const nextModel = candidateModels[nextModelIdx];
          const nextRetryNumber = retryCount + 1;
          const status = extractHttpStatus(err);
          const customDelay = extractRetryDelayMs(err);

          const statusReason =
            status === 429
              ? '요청 한도 초과(429)'
              : status === 503
                ? '서버 혼잡(503)'
                : classification === 'timeout'
                  ? '응답 지연'
                  : '서버 일시 오류';

          const previewDelayMs =
            typeof retryDelayMs === 'number'
              ? retryDelayMs
              : (GEMINI_BACKOFF_SCHEDULE_MS[Math.min(retryCount, GEMINI_BACKOFF_SCHEDULE_MS.length - 1)] ?? 5000);

          onRetry?.(prevModel, nextRetryNumber, previewDelayMs, nextModel);
          onStatusChange?.({
            phase: 'retrying',
            model: nextModel,
            fromModel: prevModel,
            requestedModel,
            usedFallback: nextModel !== requestedModel,
            attempt: nextRetryNumber,
            maxRetries,
            delayMs: previewDelayMs,
            message: `${statusReason}로 재시도 중... (${nextRetryNumber}/${maxRetries})`,
          });

          await waitWithExponentialBackoff(retryCount, retryDelayMs, signal, customDelay);

          retryCount++;
          if (nextModelIdx !== modelIdx) {
            modelIdx = nextModelIdx;
            onFallback?.(prevModel, nextModel);
            onStatusChange?.({
              phase: 'fallback',
              fromModel: prevModel,
              model: nextModel,
              requestedModel,
              usedFallback: nextModel !== requestedModel,
              attempt: retryCount,
              maxRetries,
              message: `${prevModel} 혼잡으로 ${nextModel} 전환 중… (${retryCount}/${maxRetries})`,
            });
          }
          continue;
        }

        // 최대 재시도 소진
        const exhaustedErr = new AllModelsFailedError(lastError, triedModels, attemptFailures);
        onStatusChange?.({
          phase: 'error',
          model: currentModel,
          requestedModel,
          usedFallback,
          message: getUserFacingErrorMessage(lastError),
        });
        throw exhaustedErr;
      }
    }
  };

  if (useQueue) {
    if (queuedCount > 0) {
      onStatusChange?.({
        phase: 'queued',
        model: requestedModel,
        requestedModel,
        message: `이전 AI 요청 완료 대기 중… (대기열 ${queuedCount}건)`,
      });
    }
    return enqueueGeminiTask(run, signal);
  }

  return run();
}
