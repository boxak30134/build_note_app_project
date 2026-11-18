// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import handler, {
  buildIssuePayload,
  resolveIssueLabels,
  type VercelLikeResponse,
} from '../api/feedback';
import { Header } from '../src/components/Header';
import { useTabs } from '../src/store/tabsStore';

function createMockRes() {
  const state: { statusCode: number; body: unknown; headers: Record<string, string> } = {
    statusCode: 200,
    body: null,
    headers: {},
  };
  const res: VercelLikeResponse = {
    setHeader(name, value) {
      state.headers[name] = value;
    },
    status(code) {
      state.statusCode = code;
      return res;
    },
    json(data) {
      state.body = data;
    },
  };
  return { res, state };
}

describe('REQ_feedback_popup_to_github: 피드백 API 및 모달 UI', () => {
  const originalToken = process.env.GITHUB_FEEDBACK_TOKEN;

  beforeEach(() => {
    cleanup();
    vi.restoreAllMocks();
    useTabs.setState({ activeTabId: null, openDocTabs: [] });
  });

  afterEach(() => {
    if (originalToken === undefined) {
      delete process.env.GITHUB_FEEDBACK_TOKEN;
    } else {
      process.env.GITHUB_FEEDBACK_TOKEN = originalToken;
    }
    cleanup();
    vi.restoreAllMocks();
  });

  it('1. resolveIssueLabels 및 buildIssuePayload가 카테고리별 라벨과 익명 사용자 기본값을 생성한다', () => {
    expect(resolveIssueLabels('버그 제보')).toEqual(['bug', 'feedback']);
    expect(resolveIssueLabels('불편사항')).toEqual(['feedback']);
    expect(resolveIssueLabels('기능 제안')).toEqual(['enhancement', 'feedback']);

    const payload = buildIssuePayload({
      category: '기능 제안',
      title: '다크 모드 지원',
      description: '야간 필기 시 눈이 부십니다.',
      author: '   ',
      envInfo: {
        userAgent: 'TestAgent/1.0',
        resolution: '1920x1080',
        pwaStandalone: true,
      },
    });

    expect(payload.title).toBe('[기능 제안] 다크 모드 지원');
    expect(payload.labels).toEqual(['enhancement', 'feedback']);
    expect(payload.body).toContain('익명 사용자');
    expect(payload.body).toContain('야간 필기 시 눈이 부십니다.');
    expect(payload.body).toContain('TestAgent/1.0');
    expect(payload.body).toContain('1920x1080');
    expect(payload.body).toContain('예 (PWA)');
  });

  it('2. api/feedback 핸들러가 GITHUB_FEEDBACK_TOKEN으로 GitHub Issues API에 이슈를 생성한다', async () => {
    process.env.GITHUB_FEEDBACK_TOKEN = 'ghp_secret_test_token';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ number: 42, html_url: 'https://github.com/boxak30134/build_note_app_project/issues/42' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const { res, state } = createMockRes();
    await handler(
      {
        method: 'POST',
        body: {
          category: '버그 제보',
          title: 'PDF 저장 오류',
          description: '내보내기 버튼을 누르면 멈춥니다.',
          envInfo: { userAgent: 'Chrome', resolution: '1280x800', pwaStandalone: false },
        },
      },
      res,
    );

    expect(state.statusCode).toBe(201);
    expect(state.body).toEqual({
      ok: true,
      issueNumber: 42,
      issueUrl: 'https://github.com/boxak30134/build_note_app_project/issues/42',
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/boxak30134/build_note_app_project/issues');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer ghp_secret_test_token');
    const sent = JSON.parse(String(init?.body)) as { title: string; labels: string[]; body: string };
    expect(sent.title).toBe('[버그 제보] PDF 저장 오류');
    expect(sent.labels).toEqual(['bug', 'feedback']);
    expect(sent.body).toContain('익명 사용자');
  });

  it('3. api/feedback 핸들러가 메서드 오류(405), 토큰 누락(500), 필수값 누락(400)을 처리한다', async () => {
    const getRes = createMockRes();
    await handler({ method: 'GET' }, getRes.res);
    expect(getRes.state.statusCode).toBe(405);

    delete process.env.GITHUB_FEEDBACK_TOKEN;
    const noTokenRes = createMockRes();
    await handler({ method: 'POST', body: { title: 'a', description: 'b' } }, noTokenRes.res);
    expect(noTokenRes.state.statusCode).toBe(500);

    process.env.GITHUB_FEEDBACK_TOKEN = 'ghp_test';
    const badBodyRes = createMockRes();
    await handler({ method: 'POST', body: { category: '불편사항', title: '  ', description: '' } }, badBodyRes.res);
    expect(badBodyRes.state.statusCode).toBe(400);
  });

  it('4. Header [피드백] 버튼 클릭 후 제출 시 envInfo가 자동 첨부되고 완료 후 모달이 닫힌다', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true, issueNumber: 99 }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    render(<Header />);

    fireEvent.click(screen.getByTestId('header-feedback-btn'));
    expect(screen.getByTestId('feedback-modal')).toBeDefined();

    fireEvent.click(screen.getByTestId('feedback-category-기능 제안'));
    fireEvent.change(screen.getByTestId('feedback-title-input'), { target: { value: '검색 단축키 추가' } });
    fireEvent.change(screen.getByTestId('feedback-description-input'), {
      target: { value: 'Ctrl+K로 빠른 검색을 열고 싶습니다.' },
    });
    fireEvent.click(screen.getByTestId('feedback-submit-btn'));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId('feedback-modal')).toBeNull();
    });

    const [, init] = fetchSpy.mock.calls[0];
    const reqJson = JSON.parse(String(init?.body)) as {
      category: string;
      title: string;
      author: string;
      envInfo: { userAgent: string; resolution: string; pwaStandalone: boolean };
    };
    expect(reqJson.category).toBe('기능 제안');
    expect(reqJson.title).toBe('검색 단축키 추가');
    expect(reqJson.author).toBe('익명 사용자');
    expect(typeof reqJson.envInfo.userAgent).toBe('string');
    expect(reqJson.envInfo.resolution).toMatch(/\d+x\d+/);
    expect(typeof reqJson.envInfo.pwaStandalone).toBe('boolean');
  });

  it('5. 피드백 전송 실패 시 모달을 닫지 않고 오류 메시지를 표시하며 입력값을 유지한다', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: '서버에 GITHUB_FEEDBACK_TOKEN이 설정되지 않았습니다.' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    render(<Header />);

    fireEvent.click(screen.getByTestId('header-feedback-btn'));
    fireEvent.change(screen.getByTestId('feedback-title-input'), { target: { value: '전송 실패 테스트' } });
    fireEvent.change(screen.getByTestId('feedback-description-input'), { target: { value: '내용이 보존되어야 함' } });
    fireEvent.click(screen.getByTestId('feedback-submit-btn'));

    const errBox = await screen.findByTestId('feedback-error-msg');
    expect(errBox.textContent).toContain('GITHUB_FEEDBACK_TOKEN');
    expect((screen.getByTestId('feedback-title-input') as HTMLInputElement).value).toBe('전송 실패 테스트');
  });
});
