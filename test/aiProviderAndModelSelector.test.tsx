// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { AiModelSelector } from '../src/components/AiModelSelector';
import {
  estimateInputTokens,
  estimateTurnTokenPreview,
  PROVIDER_GROUPS,
} from '../src/ai/modelCatalog';
import {
  isValidKeyFormat,
  MissingApiKeyError,
  PROVIDER_KEY_URL,
  streamWithProviderAdapter,
} from '../src/ai/aiProviderAdapter';

describe('REQ_AI_PROVIDER_MODEL_SELECTOR: BYOK 멀티 프로바이더 모델 선택 UI 및 통합 어댑터', () => {
  beforeEach(() => {
    cleanup();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  describe('1. AiModelSelector 커스텀 셀렉트 박스 UI', () => {
    it('3개 제공자 그룹(Gemini, ChatGPT, Claude), 용도 설명, 토큰 뱃지, 선택 체크(✓)를 렌더링한다', () => {
      const onChange = vi.fn();
      render(
        <AiModelSelector
          provider="google"
          modelId="gemini-3.8-flash"
          onChange={onChange}
          testId="selector"
        />,
      );

      // 드롭다운 열기
      fireEvent.click(screen.getByTestId('selector-trigger'));

      const dropdown = screen.getByTestId('selector-dropdown');
      expect(dropdown.textContent).toContain('Google Gemini');
      expect(dropdown.textContent).toContain('OpenAI ChatGPT');
      expect(dropdown.textContent).toContain('Anthropic Claude');

      // 각 모델의 표시명, 용도 설명, 토큰 뱃지 확인
      expect(dropdown.textContent).toContain('Gemini 3.8 Flash');
      expect(dropdown.textContent).toContain('빠른 요약·일상 번역·학술 튜터 기본');
      expect(dropdown.textContent).toContain('~900–1,800 tok');
      expect(dropdown.textContent).toContain('Claude Sonnet 4.5');
      expect(dropdown.textContent).toContain('GPT-4.1 mini');

      // 현재 선택된 모델 우측 체크 아이콘 확인
      expect(screen.getByTestId('selector-check-gemini-3.8-flash')).toBeTruthy();

      // 다른 제공자 모델 선택 시 (modelId, provider) 전달
      fireEvent.click(screen.getByTestId('selector-option-claude-sonnet-4-5'));
      expect(onChange).toHaveBeenCalledWith('claude-sonnet-4-5', 'anthropic');
    });

    it('최하단 "기타 모델 ID 직접 입력" 옵션으로 신규 모델 ID를 입력해 적용할 수 있다', () => {
      const onChange = vi.fn();
      render(
        <AiModelSelector
          provider="openai"
          modelId="gpt-4.1-mini"
          onChange={onChange}
          testId="selector"
        />,
      );

      fireEvent.click(screen.getByTestId('selector-trigger'));
      fireEvent.click(screen.getByTestId('selector-custom-trigger'));

      const input = screen.getByTestId('selector-custom-input') as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'gpt-5-preview' } });
      fireEvent.click(screen.getByTestId('selector-custom-apply'));

      expect(onChange).toHaveBeenCalledWith('gpt-5-preview', 'openai');
    });
  });

  describe('2. 런타임 토큰 정책 기반 예상 소진 토큰 계산 (modelCatalog)', () => {
    it('선택 텍스트는 최대 1,000자로 클리핑되고 최근 4턴 슬라이딩 윈도우만 합산된다', () => {
      const longText = '가'.repeat(2500);
      const previewClipped = estimateTurnTokenPreview({
        selectedText: longText,
        draftText: '요약해줘',
        recentTurnTexts: ['t1', 't2', 't3', 't4', 't5', 't6'],
        modelId: 'gemini-3.8-flash',
        provider: 'google',
        target: 'sidebar',
      });

      const exact1000 = estimateTurnTokenPreview({
        selectedText: '가'.repeat(1000),
        draftText: '요약해줘',
        recentTurnTexts: ['t3', 't4', 't5', 't6'],
        modelId: 'gemini-3.8-flash',
        provider: 'google',
        target: 'sidebar',
      });

      expect(previewClipped.clippedSelectedChars).toBe(1000);
      expect(previewClipped.estimatedInputTokens).toBe(exact1000.estimatedInputTokens);
      expect(previewClipped.maxOutputTokens).toBe(1500);
    });

    it('모델 및 타깃에 따라 최대 출력 토큰 상한이 올바르게 산출된다', () => {
      const proPreview = estimateTurnTokenPreview({
        modelId: 'gemini-2.5-pro',
        provider: 'google',
        target: 'sidebar',
      });
      const bubblePreview = estimateTurnTokenPreview({
        modelId: 'gemini-2.5-pro',
        provider: 'google',
        target: 'bubble',
      });

      expect(proPreview.maxOutputTokens).toBe(2048);
      expect(bubblePreview.maxOutputTokens).toBe(800);
      expect(estimateInputTokens('hello world')).toBeGreaterThan(0);
      expect(PROVIDER_GROUPS).toHaveLength(3);
    });
  });

  describe('3. 멀티 프로바이더 BYOK 키 검증 및 통합 어댑터 (aiProviderAdapter)', () => {
    it('isValidKeyFormat이 제공자별 키 형식 및 무효/플레이스홀더 문자열을 정확히 판별한다', () => {
      expect(isValidKeyFormat('google', 'AIzaSyDummyKey1234567890abcd')).toBe(true);
      expect(isValidKeyFormat('openai', 'sk-proj-DummyKey1234567890abcd')).toBe(true);
      expect(isValidKeyFormat('anthropic', 'sk-ant-api03-DummyKey1234567890')).toBe(true);

      // 교차/무효 키 차단
      expect(isValidKeyFormat('openai', 'sk-ant-api03-DummyKey1234567890')).toBe(false);
      expect(isValidKeyFormat('google', 'undefined')).toBe(false);
      expect(isValidKeyFormat('google', '   ')).toBe(false);
      expect(isValidKeyFormat('google', 'AIza_short')).toBe(false);
      expect(isValidKeyFormat('anthropic', null)).toBe(false);
    });

    it('선택한 제공자의 API 키가 미입력 상태이면 크래시 대신 MissingApiKeyError와 발급 URL을 반환한다', async () => {
      const gen = streamWithProviderAdapter({
        provider: 'anthropic',
        modelId: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: '안녕' }],
        apiKeyOverride: '',
      });

      await expect(gen.next()).rejects.toMatchObject({
        name: 'MissingApiKeyError',
        provider: 'anthropic',
        keyUrl: PROVIDER_KEY_URL.anthropic,
      });

      const err = new MissingApiKeyError('google');
      expect(err.keyUrl).toBe(PROVIDER_KEY_URL.google);
    });
  });
});

