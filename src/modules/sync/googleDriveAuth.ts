import { Capacitor } from '@capacitor/core';
import {
  loadDriveToken,
  removeDriveToken,
  saveDriveToken,
  type DriveOAuthToken,
} from '../../storage/secureStore';
import { useSettings } from '../../store/settingsStore';
import {
  assertMinimalDriveScope,
  DRIVE_FILE_SCOPE,
  DRIVE_PROFILE_SCOPE,
  DRIVE_USERINFO_SCOPE,
} from './driveFolderGuard';

export interface GoogleOAuthUrlOptions {
  clientId: string;
  redirectUri: string;
  state?: string;
  codeChallenge?: string;
  includeEmailScope?: boolean;
  loginHint?: string;
  prompt?: '' | 'select_account' | 'consent';
}

export const DEFAULT_GOOGLE_CLIENT_ID =
  '779568357105-1bv1t4br3tkgekksmu6enu1blhghvkps.apps.googleusercontent.com';

export function resolveGoogleClientId(overrideClientId?: string): string {
  const fromOverride = overrideClientId?.trim();
  if (fromOverride) return fromOverride;
  const fromSettings = useSettings.getState().driveSyncConfig.clientId?.trim();
  if (fromSettings) return fromSettings;
  try {
    const fromMeta = (import.meta.env?.VITE_GOOGLE_CLIENT_ID as string | undefined)?.trim();
    if (fromMeta) return fromMeta;
  } catch {
    // ignore
  }
  try {
    const fromProcess =
      typeof process !== 'undefined' ? process.env?.VITE_GOOGLE_CLIENT_ID?.trim() : undefined;
    if (fromProcess) return fromProcess;
  } catch {
    // ignore
  }
  return DEFAULT_GOOGLE_CLIENT_ID;
}

/**
 * Android WebView / Capacitor 네이티브 환경 여부를 감지한다.
 * 인앱 웹뷰에서는 Google OAuth disallowed_useragent 차단을 피하기 위해 외부 브라우저로 위임해야 한다.
 */
export function isNativeWebViewEnvironment(): boolean {
  try {
    if (Capacitor.isNativePlatform()) return true;
  } catch {
    // ignore
  }
  if (typeof navigator !== 'undefined') {
    const ua = navigator.userAgent || '';
    if (/;\s*wv\)/i.test(ua) || /\bAndroid\b.*\bVersion\/[\d.]+/i.test(ua)) {
      return true;
    }
  }
  return false;
}

/**
 * 최소 권한(drive.file)만 요청하는 Google OAuth 2.0 인증 URL을 생성한다.
 * `assertMinimalDriveScope` 검증을 거쳐 상위 drive / drive.readonly 권한 유입을 원천 차단한다.
 */
export function buildGoogleOAuthUrl(opts: GoogleOAuthUrlOptions): string {
  const clientId = opts.clientId.trim();
  if (!clientId) {
    throw new Error('Google OAuth Client ID가 설정되지 않았습니다.');
  }

  const rawScope = opts.includeEmailScope
    ? `${DRIVE_FILE_SCOPE} ${DRIVE_USERINFO_SCOPE} ${DRIVE_PROFILE_SCOPE}`
    : DRIVE_FILE_SCOPE;
  const verifiedScopes = assertMinimalDriveScope(rawScope);

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: opts.redirectUri,
    response_type: opts.codeChallenge ? 'code' : 'token',
    scope: verifiedScopes.join(' '),
    include_granted_scopes: 'false',
    prompt: opts.prompt ?? 'select_account',
  });

  if (opts.loginHint?.trim()) params.set('login_hint', opts.loginHint.trim());
  if (opts.state) params.set('state', opts.state);
  if (opts.codeChallenge) {
    params.set('code_challenge', opts.codeChallenge);
    params.set('code_challenge_method', 'S256');
    params.set('access_type', 'offline');
  }

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export interface TokenRefreshHandler {
  refresh: (currentToken: DriveOAuthToken | null) => Promise<DriveOAuthToken>;
}

let customRefreshHandler: TokenRefreshHandler | null = null;

export function setDriveTokenRefreshHandler(handler: TokenRefreshHandler | null): void {
  customRefreshHandler = handler;
}

/**
 * 웹 환경에서 Google Identity Services(GIS) 스크립트가 아직 로드되지 않았다면 동적으로 주입하고 대기한다.
 */
export async function ensureGoogleGisLoaded(timeoutMs = 6000): Promise<boolean> {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
  const g = (window as unknown as Record<string, any>).google;
  if (g?.accounts?.oauth2?.initTokenClient) return true;
  if (import.meta.env?.VITEST || (typeof process !== 'undefined' && process.env?.VITEST)) {
    return false;
  }

  return await new Promise<boolean>((resolve) => {
    const existing = document.querySelector<HTMLScriptElement>(
      'script[src^="https://accounts.google.com/gsi/client"]',
    );
    const timer = window.setTimeout(() => resolve(false), timeoutMs);
    const finish = () => {
      window.clearTimeout(timer);
      const loaded = Boolean(
        (window as unknown as Record<string, any>).google?.accounts?.oauth2?.initTokenClient,
      );
      resolve(loaded);
    };

    if (existing) {
      if (existing.dataset.loaded === 'true') {
        finish();
        return;
      }
      existing.addEventListener('load', finish, { once: true });
      existing.addEventListener('error', () => {
        window.clearTimeout(timer);
        resolve(false);
      }, { once: true });
      return;
    }

    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.onload = () => {
      script.dataset.loaded = 'true';
      finish();
    };
    script.onerror = () => {
      window.clearTimeout(timer);
      resolve(false);
    };
    document.head.appendChild(script);
  });
}

/**
 * Google Identity Services(GIS) 또는 외부 브라우저 콜백으로 Google Drive 인증을 수행한다.
 */
export async function authenticateGoogleDrive(options?: {
  clientId?: string;
  redirectUri?: string;
  loginHint?: string;
  openExternalBrowser?: (url: string) => Promise<void> | void;
}): Promise<DriveOAuthToken> {
  const clientId = resolveGoogleClientId(options?.clientId);
  if (!clientId) {
    throw new Error('앱 기본 Google OAuth Client ID(VITE_GOOGLE_CLIENT_ID)가 설정되지 않았습니다. 고급 설정에서 입력하거나 환경 변수를 확인하세요.');
  }

  const savedToken = await loadDriveToken();
  const loginHint =
    options?.loginHint?.trim() ||
    savedToken?.email?.trim() ||
    useSettings.getState().driveSyncConfig.accountEmail?.trim() ||
    undefined;

  // Android WebView / Capacitor 네이티브 컨테이너인 경우 외부 시스템 브라우저로 OAuth 위임
  if (isNativeWebViewEnvironment()) {
    const redirectUri =
      options?.redirectUri ?? (typeof window !== 'undefined' ? window.location.origin : 'eduink://oauth/callback');
    const authUrl = buildGoogleOAuthUrl({
      clientId,
      redirectUri,
      includeEmailScope: true,
      loginHint,
      prompt: 'select_account',
    });
    if (options?.openExternalBrowser) {
      await options.openExternalBrowser(authUrl);
    } else if (typeof window !== 'undefined') {
      window.open(authUrl, '_system');
    }
    throw new Error('EXTERNAL_BROWSER_AUTH_REDIRECT');
  }

  // 웹 환경: Google Identity Services (google.accounts.oauth2.initTokenClient) 사용
  // 이미 로그인된 브라우저 Google 계정이 있으면 Account Chooser / 기존 세션 힌트(login_hint)로 연결
  await ensureGoogleGisLoaded();
  const g = (typeof window !== 'undefined' ? (window as unknown as Record<string, any>).google : null);
  if (g?.accounts?.oauth2?.initTokenClient) {
    const verifiedScopes = assertMinimalDriveScope(
      `${DRIVE_FILE_SCOPE} ${DRIVE_USERINFO_SCOPE} ${DRIVE_PROFILE_SCOPE}`,
    );
    const token = await new Promise<DriveOAuthToken>((resolve, reject) => {
      const client = g.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: verifiedScopes.join(' '),
        ...(loginHint ? { hint: loginHint } : {}),
        callback: async (resp: { access_token?: string; expires_in?: number; error?: string; scope?: string }) => {
          if (resp.error || !resp.access_token) {
            reject(new Error(resp.error || 'Google Drive OAuth 인증이 취소되었거나 실패했습니다.'));
            return;
          }
          const expiresIn = Number(resp.expires_in || 3600);
          let email: string | undefined;
          let name: string | undefined;
          try {
            const u = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
              headers: { Authorization: `Bearer ${resp.access_token}` },
            });
            if (u.ok) {
              const info = (await u.json()) as { email?: string; name?: string };
              email = info.email;
              name = info.name;
            }
          } catch {
            // 프로필 조회 실패 시 무시
          }
          resolve({
            accessToken: resp.access_token,
            expiresAt: Date.now() + expiresIn * 1000,
            email,
            name,
            scope: resp.scope ?? DRIVE_FILE_SCOPE,
          });
        },
      });
      client.requestAccessToken({
        prompt: loginHint ? '' : 'select_account',
        ...(loginHint ? { hint: loginHint, login_hint: loginHint } : {}),
      });
    });
    await saveDriveToken(token);
    useSettings.getState().setDriveSyncConfig({
      accountEmail: token.email ?? null,
      accountName: token.name ?? null,
      lastError: null,
    });
    return token;
  }

  // GIS 스크립트 미로드 시 팝업/리다이렉트 OAuth URL 안내
  const redirectUri =
    options?.redirectUri ?? (typeof window !== 'undefined' ? `${window.location.origin}/oauth/callback` : '');
  const authUrl = buildGoogleOAuthUrl({
    clientId,
    redirectUri,
    includeEmailScope: true,
    loginHint,
    prompt: 'select_account',
  });
  if (typeof window !== 'undefined' && typeof window.open === 'function') {
    window.open(authUrl, '_blank', 'noopener,noreferrer');
  }
  throw new Error('Google Identity Services SDK가 로드되지 않아 새 창 OAuth 인증 흐름을 열었습니다.');
}

/**
 * URL Hash / Query 콜백에서 Access Token을 파싱해 암호화 저장한다.
 */
export async function handleOAuthRedirectCallback(callbackUrl: string): Promise<DriveOAuthToken | null> {
  const url = new URL(callbackUrl);
  const hashParams = new URLSearchParams(url.hash.replace(/^#/, ''));
  const accessToken = hashParams.get('access_token') ?? url.searchParams.get('access_token');
  if (!accessToken) return null;
  const expiresIn = Number(hashParams.get('expires_in') ?? url.searchParams.get('expires_in') ?? 3600);
  const scope = hashParams.get('scope') ?? DRIVE_FILE_SCOPE;
  assertMinimalDriveScope(scope);

  const token: DriveOAuthToken = {
    accessToken,
    expiresAt: Date.now() + expiresIn * 1000,
    scope,
  };
  await saveDriveToken(token);
  return token;
}

/**
 * 유효한 Access Token을 반환하고, 만료 임박/만료 시 1회 자동 갱신(Refresh)을 시도한다.
 */
export async function getValidDriveAccessToken(forceRefresh = false): Promise<string> {
  const current = await loadDriveToken();
  const isExpired = !current || Date.now() >= current.expiresAt - 60_000;

  if (!forceRefresh && current && !isExpired) {
    return current.accessToken;
  }

  if (customRefreshHandler) {
    const refreshed = await customRefreshHandler.refresh(current);
    await saveDriveToken(refreshed);
    return refreshed.accessToken;
  }

  // 웹 GIS silent refresh 시도 (저장된 login_hint 활용)
  const g = (typeof window !== 'undefined' ? (window as unknown as Record<string, any>).google : null);
  const clientId = resolveGoogleClientId();
  if (g?.accounts?.oauth2?.initTokenClient && clientId) {
    const verifiedScopes = assertMinimalDriveScope(DRIVE_FILE_SCOPE);
    const loginHint = current?.email || useSettings.getState().driveSyncConfig.accountEmail || undefined;
    const refreshed = await new Promise<DriveOAuthToken>((resolve, reject) => {
      const client = g.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: verifiedScopes.join(' '),
        ...(loginHint ? { hint: loginHint } : {}),
        callback: (resp: { access_token?: string; expires_in?: number; error?: string }) => {
          if (resp.error || !resp.access_token) {
            reject(new Error(resp.error || 'Access Token 자동 갱신에 실패했습니다.'));
            return;
          }
          resolve({
            accessToken: resp.access_token,
            expiresAt: Date.now() + Number(resp.expires_in || 3600) * 1000,
            email: current?.email,
            name: current?.name,
            scope: DRIVE_FILE_SCOPE,
          });
        },
      });
      client.requestAccessToken({
        prompt: '',
        ...(loginHint ? { hint: loginHint, login_hint: loginHint } : {}),
      });
    });
    await saveDriveToken(refreshed);
    return refreshed.accessToken;
  }

  throw new Error('Google Drive 인증 토큰이 없거나 만료되었습니다. 다시 연결하세요.');
}

/**
 * Google Drive 연동을 해제하고 로컬 토큰을 파기한다. (로컬 노트 데이터는 보존)
 */
export async function disconnectGoogleDrive(): Promise<void> {
  await removeDriveToken();
  useSettings.getState().setDriveSyncConfig({
    enabled: false,
    targetFolderId: null,
    targetFolderName: null,
    targetImagesFolderId: null,
    syncStatus: 'idle',
    accountEmail: null,
    accountName: null,
    lastError: null,
  });
}

