import { create } from 'zustand';
import { Capacitor } from '@capacitor/core';
import { useSessions } from '../../store/sessionStore';
import { confirmDialog } from '../../store/uiStore';

export interface AppVersionInfo {
  version: string;
  commit: string;
  builtAt: string;
}

export function getClientVersionInfo(): AppVersionInfo {
  return {
    version: typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.1.0',
    commit: typeof __APP_COMMIT__ !== 'undefined' ? __APP_COMMIT__ : 'dev',
    builtAt: typeof __APP_BUILT_AT__ !== 'undefined' ? __APP_BUILT_AT__ : '',
  };
}

export interface PwaUpdateState extends AppVersionInfo {
  needRefresh: boolean;
  updateAvailable: boolean;
  remoteInfo: AppVersionInfo | null;
  checking: boolean;
  lastCheckedAt: number | null;
}

const initialClient = getClientVersionInfo();

export const usePwaUpdateStore = create<PwaUpdateState>(() => ({
  ...initialClient,
  needRefresh: false,
  updateAvailable: false,
  remoteInfo: null,
  checking: false,
  lastCheckedAt: null,
}));

export function isRemoteVersionNewer(client: AppVersionInfo, remote: Partial<AppVersionInfo> | null | undefined): boolean {
  if (!remote || typeof remote.version !== 'string') return false;
  if (remote.version !== client.version) return true;
  if (
    typeof remote.commit === 'string' &&
    remote.commit &&
    remote.commit !== 'dev' &&
    client.commit !== 'dev' &&
    remote.commit !== client.commit
  ) {
    return true;
  }
  if (
    typeof remote.builtAt === 'string' &&
    remote.builtAt &&
    client.builtAt &&
    remote.builtAt !== client.builtAt
  ) {
    return true;
  }
  return false;
}

let swInitialized = false;
let swRegistration: ServiceWorkerRegistration | null = null;
let updateServiceWorkerFn: ((reloadPage?: boolean) => Promise<void>) | null = null;
let lastAutoCheckMs = 0;

const AUTO_CHECK_COOLDOWN_MS = 60_000;
const PERIODIC_CHECK_INTERVAL_MS = 30 * 60 * 1000;

export function setPwaTestHooks(hooks: {
  updateServiceWorker?: ((reloadPage?: boolean) => Promise<void>) | null;
  registration?: ServiceWorkerRegistration | null;
}) {
  if ('updateServiceWorker' in hooks) updateServiceWorkerFn = hooks.updateServiceWorker ?? null;
  if ('registration' in hooks) swRegistration = hooks.registration ?? null;
}

export function initPwaUpdater(): () => void {
  if (swInitialized) return () => {};
  if (typeof window === 'undefined' || Capacitor.isNativePlatform()) return () => {};
  swInitialized = true;

  if ('serviceWorker' in navigator) {
    void import('virtual:pwa-register')
      .then(({ registerSW }) => {
        updateServiceWorkerFn = registerSW({
          immediate: true,
          onNeedRefresh() {
            usePwaUpdateStore.setState({ needRefresh: true, updateAvailable: true });
          },
          onRegisteredSW(_swUrl, registration) {
            swRegistration = registration ?? null;
          },
        });
      })
      .catch(() => {
        /* dev/test 환경에서 virtual:pwa-register 미지원 시 무시 */
      });
  }

  const onVisibility = () => {
    if (document.visibilityState === 'visible') {
      const now = Date.now();
      if (now - lastAutoCheckMs >= AUTO_CHECK_COOLDOWN_MS) {
        lastAutoCheckMs = now;
        void checkForAppUpdate({ silent: true });
      }
    }
  };

  document.addEventListener('visibilitychange', onVisibility);
  const timer = window.setInterval(() => {
    lastAutoCheckMs = Date.now();
    void checkForAppUpdate({ silent: true });
  }, PERIODIC_CHECK_INTERVAL_MS);

  return () => {
    document.removeEventListener('visibilitychange', onVisibility);
    window.clearInterval(timer);
    swInitialized = false;
  };
}

export async function checkForAppUpdate(options?: {
  silent?: boolean;
  fetcher?: typeof fetch;
}): Promise<{ updateAvailable: boolean; offline: boolean; remoteInfo: AppVersionInfo | null }> {
  const state = usePwaUpdateStore.getState();
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { updateAvailable: state.updateAvailable, offline: true, remoteInfo: state.remoteInfo };
  }

  usePwaUpdateStore.setState({ checking: true });
  try {
    if (swRegistration && typeof swRegistration.update === 'function') {
      try {
        await swRegistration.update();
      } catch {
        /* 오프라인/SW 갱신 실패 무시 */
      }
    }

    const doFetch = options?.fetcher ?? (typeof fetch === 'function' ? fetch : null);
    let remoteInfo: AppVersionInfo | null = null;
    if (doFetch) {
      try {
        const res = await doFetch('/version.json', { cache: 'no-store' });
        const contentType = res.headers?.get?.('content-type') ?? '';
        if (res.ok && (!contentType || contentType.includes('application/json') || contentType.includes('text/json'))) {
          const parsed = (await res.json()) as Partial<AppVersionInfo>;
          if (parsed && typeof parsed.version === 'string') {
            remoteInfo = {
              version: parsed.version,
              commit: typeof parsed.commit === 'string' ? parsed.commit : 'dev',
              builtAt: typeof parsed.builtAt === 'string' ? parsed.builtAt : '',
            };
          }
        }
      } catch {
        /* version.json 미존재 또는 네트워크 오류 시 조용히 폴백 */
      }
    }

    const current = usePwaUpdateStore.getState();
    const client: AppVersionInfo = {
      version: current.version,
      commit: current.commit,
      builtAt: current.builtAt,
    };
    const remoteNewer = isRemoteVersionNewer(client, remoteInfo);
    const updateAvailable = current.needRefresh || remoteNewer;

    usePwaUpdateStore.setState({
      remoteInfo: remoteInfo ?? current.remoteInfo,
      updateAvailable,
      lastCheckedAt: Date.now(),
    });
    return { updateAvailable, offline: false, remoteInfo };
  } finally {
    usePwaUpdateStore.setState({ checking: false });
  }
}

export async function applyAppUpdate(options?: { force?: boolean; reload?: () => void }): Promise<boolean> {
  if (!options?.force) {
    const hasDirty = Object.values(useSessions.getState().sessions).some((s) => s.dirty);
    if (hasDirty) {
      const choice = await confirmDialog(
        '앱 업데이트 및 새로고침',
        '저장하지 않은 변경 사항이 있는 노트가 있습니다. 저장 없이 지금 새로고침하여 최신 버전으로 업데이트할까요?',
        [
          { label: '취소', value: 'cancel' },
          { label: '새로고침 업데이트', value: 'update', variant: 'primary' },
        ],
      );
      if (choice !== 'update') return false;
    }
  }

  if (updateServiceWorkerFn) {
    try {
      await updateServiceWorkerFn(true);
      return true;
    } catch {
      /* 폴백 리로드 진행 */
    }
  }

  if (options?.reload) {
    options.reload();
  } else if (typeof window !== 'undefined' && typeof window.location?.reload === 'function') {
    window.location.reload();
  }
  return true;
}
