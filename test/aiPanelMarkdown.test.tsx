// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { RightSidebar } from '../src/components/RightSidebar';
import { useAiChatStore } from '../src/store/aiChatStore';
import { useSettings } from '../src/store/settingsStore';
import { useTabs } from '../src/store/tabsStore';

vi.mock('../src/ai/useConnectedProviders', () => ({
  useConnectedProviders: () => ['google'],
  useProvidersLoaded: () => true,
  refreshProviders: vi.fn().mockResolvedValue(['google']),
}));

vi.mock('../src/search/searchClient', () => ({
  indexNote: vi.fn(),
  unindexNote: vi.fn(),
  searchRelated: vi.fn().mockResolvedValue([]),
}));

describe('REQ_markdown_rendering_ai_and_bubble: AI 패널 마크다운 렌더링', () => {
  beforeEach(() => {
    cleanup();
    useSettings.setState({ aiProvider: 'google' });
    useTabs.setState({ activeTabId: null, openDocTabs: [] });
    useAiChatStore.setState({
      messages: [],
      inputDraft: '',
      busy: false,
      statusInfo: { status: 'idle', message: '' },
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('AI 패널 assistant 응답의 제목·강조·코드블록·목록·표·체크리스트·KaTeX가 렌더링되고 위험 링크는 차단된다', () => {
    useAiChatStore.setState({
      messages: [
        { role: 'user', content: '**라그랑주 정리** 설명해줘' },
        {
          role: 'assistant',
          model: 'gemini-2.5-flash',
          content: [
            '## 라그랑주 정리',
            '**핵심 결론**: 유한군 $G$ 의 부분군 $H$ 의 위수는 $|G|$ 를 나눕니다.',
            '',
            '- 조건: $H \\le G$',
            '- [x] 정리 이해 완료',
            '',
            '> 참고: $\\text{역은 일반적으로 성립하지 않음}$',
            '',
            '| 기호 | 의미 |',
            '| --- | --- |',
            '| $|G:H|$ | **지수** |',
            '',
            '```ts',
            'const index = orderG / orderH;',
            '```',
            '',
            '[공식 문서](https://example.com) / [위험 링크](javascript:alert(1))',
          ].join('\n'),
        },
      ],
    });

    render(<RightSidebar />);

    const assistantMd = screen.getByTestId('ai-chat-assistant-markdown');
    expect(assistantMd.querySelector('h2')?.textContent).toBe('라그랑주 정리');
    expect(assistantMd.querySelector('strong')?.textContent).toBe('핵심 결론');
    expect(assistantMd.querySelectorAll('li').length).toBe(2);
    expect(assistantMd.querySelector('input[type="checkbox"]')).not.toBeNull();
    expect(assistantMd.querySelector('blockquote')?.textContent).toContain('참고:');
    expect(assistantMd.querySelector('table')).not.toBeNull();
    expect(assistantMd.querySelector('pre code')?.textContent).toContain('const index = orderG / orderH;');
    expect(assistantMd.querySelector('.katex')).not.toBeNull();

    const safeAnchor = assistantMd.querySelector('a[href="https://example.com"]');
    expect(safeAnchor?.textContent).toBe('공식 문서');
    expect(assistantMd.querySelector('a[href^="javascript:"]')).toBeNull();

    // user 메시지는 기존 원문/줄바꿈 보존
    const userMsg = screen.getByTestId('ai-chat-msg-user');
    expect(userMsg.textContent).toBe('**라그랑주 정리** 설명해줘');
  });
});
