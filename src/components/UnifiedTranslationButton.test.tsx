// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { UnifiedTranslationButton } from './UnifiedTranslationButton';

describe('UnifiedTranslationButton (Zero-Config + Gemini 하이브리드 UX)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('Tier 1 로컬 매칭 단어는 네트워크 없이 즉시 onApplyRuby를 호출한다', async () => {
    const onApplyRuby = vi.fn();

    render(
      <UnifiedTranslationButton
        selectedText="ring"
        surroundingSentence="In abstract algebra, a ring is a set with two operations."
        apiKey={null}
        onApplyRuby={onApplyRuby}
      />
    );

    const btn = screen.getByTestId('unified-translate-btn');
    fireEvent.click(btn);

    await waitFor(() => {
      expect(onApplyRuby).toHaveBeenCalledWith('ring', '환(環)');
    });
  });

  it('Zero-Config: API Key가 없어도 번역 버튼 클릭 시 공개 무키 엔진으로 즉시 번역한다', async () => {
    const onApplyRuby = vi.fn();

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [[['사과', 'apple', null, null]]],
    });

    render(
      <UnifiedTranslationButton
        selectedText="apple"
        surroundingSentence="He gave me a fresh apple."
        apiKey={null}
        onApplyRuby={onApplyRuby}
      />
    );

    const btn = screen.getByTestId('unified-translate-btn');
    fireEvent.click(btn);

    await waitFor(() => {
      expect(onApplyRuby).toHaveBeenCalledWith('apple', '사과');
    });
  });

  it('⚙️ 설정 버튼 클릭 시 GeminiKeyModal이 열려 무료 키를 등록할 수 있다', async () => {
    const onApplyRuby = vi.fn();
    const onApiKeySaved = vi.fn();

    render(
      <UnifiedTranslationButton
        selectedText="test"
        surroundingSentence="This is a test."
        apiKey={null}
        onApiKeySaved={onApiKeySaved}
        onApplyRuby={onApplyRuby}
      />
    );

    const configBtn = screen.getByTestId('unified-translate-config-btn');
    fireEvent.click(configBtn);

    expect(screen.getByTestId('gemini-key-modal')).toBeDefined();
    expect(screen.getByText(/신용카드 필요 없는 무료 키/)).toBeDefined();

    const input = screen.getByTestId('gemini-key-input');
    fireEvent.change(input, { target: { value: 'AIzaSyMyFreeKey' } });

    const saveBtn = screen.getByTestId('gemini-key-save-btn');
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(onApiKeySaved).toHaveBeenCalledWith('AIzaSyMyFreeKey');
    });
  });

  it('Gemini API Key가 등록되어 있으면 Tier 2 Gemini Flash 번역을 수행한다', async () => {
    const onApplyRuby = vi.fn();

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: '위상 공간' }] } }],
      }),
    });

    render(
      <UnifiedTranslationButton
        selectedText="topological space"
        surroundingSentence="A topological space is a set endowed with a topology."
        apiKey="my-gemini-key"
        onApplyRuby={onApplyRuby}
      />
    );

    const btn = screen.getByTestId('unified-translate-btn');
    fireEvent.click(btn);

    await waitFor(() => {
      expect(onApplyRuby).toHaveBeenCalledWith('topological space', '위상 공간');
    });
  });
});
