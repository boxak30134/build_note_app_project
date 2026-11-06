// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { GeminiKeyModal } from './GeminiKeyModal';
import { useSettings } from '../store/settingsStore';

describe('Translation Settings UI (GeminiKeyModal & SettingsStore)', () => {
  beforeEach(() => {
    useSettings.setState({ translationInsertMode: 'parentheses' });
  });

  afterEach(() => {
    cleanup();
  });

  it('GeminiKeyModal에 3가지 번역 삽입 형식 라디오 버튼이 렌더링된다', () => {
    render(
      <GeminiKeyModal
        isOpen={true}
        onClose={vi.fn()}
        currentKey=""
        onSaveKey={vi.fn()}
      />
    );

    const parenthesesRadio = screen.getByTestId('mode-parentheses-radio') as HTMLInputElement;
    const rubyRadio = screen.getByTestId('mode-ruby-radio') as HTMLInputElement;
    const replaceRadio = screen.getByTestId('mode-replace-radio') as HTMLInputElement;

    expect(parenthesesRadio.checked).toBe(true);
    expect(rubyRadio.checked).toBe(false);
    expect(replaceRadio.checked).toBe(false);
  });

  it('라디오 버튼 선택 시 settingsStore의 translationInsertMode가 즉시 동기화된다', () => {
    render(
      <GeminiKeyModal
        isOpen={true}
        onClose={vi.fn()}
        currentKey=""
        onSaveKey={vi.fn()}
      />
    );

    const rubyRadio = screen.getByTestId('mode-ruby-radio') as HTMLInputElement;
    fireEvent.click(rubyRadio);
    expect(useSettings.getState().translationInsertMode).toBe('ruby');

    const replaceRadio = screen.getByTestId('mode-replace-radio') as HTMLInputElement;
    fireEvent.click(replaceRadio);
    expect(useSettings.getState().translationInsertMode).toBe('replace');

    const parenthesesRadio = screen.getByTestId('mode-parentheses-radio') as HTMLInputElement;
    fireEvent.click(parenthesesRadio);
    expect(useSettings.getState().translationInsertMode).toBe('parentheses');
  });
});

