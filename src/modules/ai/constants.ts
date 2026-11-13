/**
 * CLAUDE.md §9: Gemini 기반 학술 튜터 및 AI 연계 모듈 상수 및 시스템 프롬프트 명세
 */

export type GeminiTutorTarget = 'bubble' | 'sidebar';

/** 기본 모델 ID 및 폴백 대안 모델 ID (§6.1) */
export const GEMINI_PRIMARY_MODEL = 'gemini-3.8-flash';
export const GEMINI_FALLBACK_MODEL = 'gemini-3.6-flash';
export const GEMINI_FALLBACK_CHAIN = [
  GEMINI_FALLBACK_MODEL,
  'gemini-flash-lite-latest',
  'gemini-3.5-flash-lite',
] as const;

/** 503 및 429 일시적 오류에 대한 지수형 Backoff + Jitter 재시도 설정 */
export const MAX_RETRY_ATTEMPTS = 3;
export const RETRY_BASE_DELAY_MS = 1000;
export const RETRY_JITTER_RATIO = 0.2; // ±20%

/** 타임아웃 제한 상수 */
export const FIRST_CHUNK_TIMEOUT_MS = 12000; // 첫 청크(thought 포함) 도착 제한 (12초)
export const CHUNK_GAP_TIMEOUT_MS = 20000; // 청크 간 무응답 제한 (20초)
export const TOTAL_REQUEST_BUDGET_MS = 90000; // 전체 재시도·폴백 합산 상한 (90초)

/** 3.x 세대 기본값 유지, 임의 감소 금지 (§6.1) */
export const GEMINI_TEMPERATURE = 1.0;

/** 불필요한 추론 딜레이 제거를 위한 thinkingConfig (§6.1) */
export const GEMINI_THINKING_CONFIG = {
  thinkingLevel: 'low',
} as const;

/** 호출 영역별 최대 출력 토큰 제한 (§6.1) */
export const BUBBLE_MAX_OUTPUT_TOKENS = 800;
export const SIDEBAR_MAX_OUTPUT_TOKENS = 1500;

export const GEMINI_MAX_OUTPUT_TOKENS: Record<GeminiTutorTarget, number> = {
  bubble: BUBBLE_MAX_OUTPUT_TOKENS,
  sidebar: SIDEBAR_MAX_OUTPUT_TOKENS,
};

/**
 * 학술 튜터 시스템 프롬프트 (§6.2 systemInstruction)
 * Gemini 인스턴스를 초기화하거나 요청을 생성할 때 반드시 주입한다.
 */
export const ACADEMIC_TUTOR_SYSTEM_PROMPT = `너는 인문·사회·자연과학·공학 등 모든 학문 분야의 학습·리서치 노트를 지원하는 엄밀하고 간결한 범용 학술 튜터이다.
사용자의 질문과 노트 맥락에 대해 다음 규칙을 철저히 준수하여 응답하라.

1. 학술적 엄밀성과 구조화 요약:
   - 질문의 맥락과 전공 분야에 부합하는 정확한 핵심 정의(Definition), 논리적 근거, 구조화된 요약 및 사례를 제공한다.
   - 직관적 결론을 첫 문장에 명시(두괄식)한 뒤 핵심 논거와 세부 설명으로 들어간다.
   - 일반 텍스트·개념 정리 질문에는 간결한 구조화 요약으로 응답하고, 증명이나 정량적 추론이 필요한 경우에만 논리적 비약 없이 전제 조건과 단계를 명확히 짚는다.

2. KaTeX 렌더링 무결성 (수식 포함 시 조건부 적용):
   - 수식이 포함된 질문이거나 수식 전개가 필요한 경우에만 아래 LaTeX 규칙을 적용한다.
   - 인라인 수식은 단일 달러 기호($...$)로 감싼다. (예: $f \\in C^1([a, b])$)
   - 독립 블록 수식은 이중 달러 기호($$...$$)로 감싼다.
   - 유니코드 특수문자(≤, ≥, ×, ÷, ℝ, ℂ, ℤ, ∈, ∀, ∃ 등)를 직접 출력하지 말고 KaTeX 호환 LaTeX 문법(\\le, \\ge, \\times, \\div, \\mathbb{R}, \\mathbb{C}, \\mathbb{Z}, \\in, \\forall, \\exists 등)으로 작성한다.
   - 한국어 조사 연결 시 수식 뒤에 반드시 공백을 둔다. (예: $x$ 는, $T(v)$ 의)
   - 렌더링 에러를 유발하는 \`\\begin{align*}\` 대신 \`\\begin{aligned} ... \\end{aligned}\`를 블록 수식($$...$$) 내부에서 사용한다.

3. 인지 부하 최소화 및 서식:
   - "안녕하세요", "좋은 질문입니다", "도움이 되었길 바랍니다" 등의 형식적 미사여구를 완전히 배제하고 즉시 본론으로 들어간다.
   - 말풍선 UI 폭에 맞춰 단락은 2~3문장 이내로 끊고, 글머리 기호(-, *)와 번호 매기기를 활용해 시각적 가독성을 확보한다.`;

/**
 * 학술 튜터 기본 시스템 프롬프트에 노트/말풍선 컨텍스트를 결합하여 최종 systemInstruction을 생성한다.
 */
export function buildAcademicSystemInstruction(additionalContext?: string): string {
  const trimmed = additionalContext?.trim();
  if (!trimmed) return ACADEMIC_TUTOR_SYSTEM_PROMPT;
  if (trimmed.startsWith(ACADEMIC_TUTOR_SYSTEM_PROMPT)) return trimmed;
  return `${ACADEMIC_TUTOR_SYSTEM_PROMPT}\n\n${trimmed}`;
}

/**
 * 호출 대상(말풍선 800 / 사이드바 1500)에 맞춰 maxOutputTokens 상한을 강제한다.
 */
export function resolveMaxOutputTokens(target: GeminiTutorTarget = 'sidebar', requested?: number): number {
  const limit = GEMINI_MAX_OUTPUT_TOKENS[target];
  if (typeof requested !== 'number' || Number.isNaN(requested) || requested <= 0) {
    return limit;
  }
  return Math.min(requested, limit);
}
