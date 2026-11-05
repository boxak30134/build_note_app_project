/** 말풍선 주석 성능 가드레일 */

export const MAX_AI_TURNS_PER_BUBBLE = 5;
export const MAX_BUBBLE_CHAR_LENGTH = 2500;
export const MAX_OUTPUT_TOKENS = 800;
export const AI_TURN_LIMIT_MESSAGE = '말풍선 당 AI 질문은 최대 5회까지 가능합니다.';

export class BubbleTurnLimitError extends Error {
  constructor() {
    super(AI_TURN_LIMIT_MESSAGE);
    this.name = 'BubbleTurnLimitError';
  }
}

export function canAskAi(turns: number): boolean {
  return turns < MAX_AI_TURNS_PER_BUBBLE;
}

/** 질문 시작 전 호출. 5회 초과 시 예외. 새 턴 수를 반환 */
export function consumeAiTurn(turns: number): number {
  if (!canAskAi(turns)) throw new BubbleTurnLimitError();
  return turns + 1;
}

/** 2,500자 초과분 절삭 (서로게이트 쌍이 깨지지 않도록 코드포인트 단위) */
export function clampBubbleText(text: string): string {
  if (text.length <= MAX_BUBBLE_CHAR_LENGTH) return text;
  let out = text.slice(0, MAX_BUBBLE_CHAR_LENGTH);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out;
}

/** 기존 텍스트에 추가분을 붙이되 총량 2,500자 제한. truncated=true 면 한도 도달 */
export function appendBubbleText(current: string, addition: string): { text: string; truncated: boolean } {
  const joined = current + addition;
  const text = clampBubbleText(joined);
  return { text, truncated: text.length < joined.length };
}
