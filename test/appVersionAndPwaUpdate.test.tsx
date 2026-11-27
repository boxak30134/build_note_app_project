// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { Header } from '../src/components/Header';
import {
  applyAppUpdate,
  checkForAppUpdate,
  isRemoteVersionNewer,
  setPwaTestHooks,
  usePwaUpdateStore,
} from '../src/core/pwa/pwaUpdater';
import { useTabs } from '../src/store/tabsStore';
import { useSessions } from '../src/store/sessionStore';

vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: () => undefined,
}));

describe('헤더 버전 표시 및 PWA 배포 업데이트 감지·새로고침', () => {
  beforeEach(() => {
    cleanup();
    vi.restoreAllMocks();
    useTabs.setState({ activeTabId: null, openDocTabs: [] });
    useSessions.setState({ sessions: {} });
    usePwaUpdateStore.setState({
      version: '0.1.0',
      commit: 'abc1234',
      builtAt: '2026-11-27T00:00:00.000Z',
      needRefresh: false,
      updateAvailable: false,
      remoteInfo: null,
      checking: false,
      lastCheckedAt: null,
    });
    setPwaTestHooks({ updateServiceWorker: null, registration: null });
  });

  afterEach(() => {
    setPwaTestHooks({ updateServiceWorker: null, registration: null });
    cleanup();
  });

  it('1. Header의 EduInk 브랜드 오른쪽에 버전 배지(v0.1.0)와 업데이트 확인 버튼을 표시한다', () => {
    render(<Header />);

    const badge = screen.getByTestId('app-version-badge');
    expect(badge.textContent).toBe('v0.1.0');
    expect(badge.getAttribute('title')).toContain('v0.1.0');
    expect(badge.getAttribute('title')).toContain('abc1234');
    expect(screen.getByTestId('check-update-btn')).toBeDefined();
    expect(screen.queryByTestId('apply-update-btn')).toBeNull();
  });

  it('2. checkForAppUpdate()가 /version.json의 새 커밋·버전을 감지하면 updateAvailable을 true로 전환하고 오프라인·오류는 안전히 무시한다', async () => {
    expect(
      isRemoteVersionNewer(
        { version: '0.1.0', commit: 'abc1234', builtAt: '2026-11-27T00:00:00.000Z' },
        { version: '0.1.0', commit: 'abc1234', builtAt: '2026-11-27T00:00:00.000Z' },
      ),
    ).toBe(false);

    const mockSwUpdate = vi.fn().mockResolvedValue(undefined);
    setPwaTestHooks({
      registration: { update: mockSwUpdate } as unknown as ServiceWorkerRegistration,
    });

    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({
        version: '0.1.0',
        commit: 'def5678',
        builtAt: '2026-11-27T12:00:00.000Z',
      }),
    } as Response);

    const res = await checkForAppUpdate({ fetcher });
    expect(mockSwUpdate).toHaveBeenCalledTimes(1);
    expect(res.offline).toBe(false);
    expect(res.updateAvailable).toBe(true);
    expect(usePwaUpdateStore.getState().updateAvailable).toBe(true);
    expect(usePwaUpdateStore.getState().remoteInfo?.commit).toBe('def5678');

    // 네트워크 실패 시 크래시 없이 폴백
    const failFetcher = vi.fn().mockRejectedValue(new Error('Network error'));
    const failRes = await checkForAppUpdate({ fetcher: failFetcher });
    expect(failRes.offline).toBe(false);
  });

  it('3. updateAvailable이 true이면 헤더에 [업데이트] 버튼이 노출되고 클릭 시 updateServiceWorker(true)를 실행한다', async () => {
    const updateSwMock = vi.fn().mockResolvedValue(undefined);
    setPwaTestHooks({ updateServiceWorker: updateSwMock });

    render(<Header />);

    act(() => {
      usePwaUpdateStore.setState({
        updateAvailable: true,
        needRefresh: true,
        remoteInfo: { version: '0.1.1', commit: 'def5678', builtAt: '2026-11-27T12:00:00.000Z' },
      });
    });

    const applyBtn = screen.getByTestId('apply-update-btn');
    expect(applyBtn.textContent).toContain('업데이트');

    fireEvent.click(applyBtn);
    await Promise.resolve();

    expect(updateSwMock).toHaveBeenCalledWith(true);
  });

  it('4. Service Worker 훅이 없을 때 applyAppUpdate({ force: true })는 안전하게 reload 폴백을 호출한다', async () => {
    const reloadMock = vi.fn();
    const ok = await applyAppUpdate({ force: true, reload: reloadMock });
    expect(ok).toBe(true);
    expect(reloadMock).toHaveBeenCalledTimes(1);
  });
});
