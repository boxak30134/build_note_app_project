import { describe, expect, it } from 'vitest';
import {
  AI_TURN_LIMIT_MESSAGE,
  appendBubbleText,
  BubbleTurnLimitError,
  canAskAi,
  clampBubbleText,
  consumeAiTurn,
  MAX_AI_TURNS_PER_BUBBLE,
  MAX_BUBBLE_CHAR_LENGTH,
} from './limits';

describe('말풍선 AI 턴 제한', () => {
  it('5회까지 허용, 6번째는 예외', () => {
    let turns = 0;
    for (let i = 0; i < MAX_AI_TURNS_PER_BUBBLE; i++) turns = consumeAiTurn(turns);
    expect(turns).toBe(5);
    expect(canAskAi(turns)).toBe(false);
    expect(() => consumeAiTurn(turns)).toThrow(BubbleTurnLimitError);
    expect(() => consumeAiTurn(turns)).toThrow(AI_TURN_LIMIT_MESSAGE);
  });
});

describe('말풍선 2,500자 제한', () => {
  it('초과분 절삭', () => {
    const long = 'a'.repeat(3000);
    expect(clampBubbleText(long)).toHaveLength(MAX_BUBBLE_CHAR_LENGTH);
    expect(clampBubbleText('short')).toBe('short');
  });

  it('append 시 한도 도달 여부 보고', () => {
    const r1 = appendBubbleText('a'.repeat(2400), 'b'.repeat(50));
    expect(r1.truncated).toBe(false);
    const r2 = appendBubbleText(r1.text, 'c'.repeat(100));
    expect(r2.truncated).toBe(true);
    expect(r2.text).toHaveLength(2500);
    expect(r2.text.endsWith('c'.repeat(50))).toBe(true);
  });

  it('서로게이트 쌍을 반으로 자르지 않는다', () => {
    const s = 'a'.repeat(2499) + '😀';
    const out = clampBubbleText(s);
    expect(out).toHaveLength(2499);
  });
});
