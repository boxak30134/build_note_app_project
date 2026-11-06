/**
 * Android 실기기 테스트 & Google Play Store 배포 구성 및 태블릿(S-Pen/Palm Rejection/BYOK 보안) 유틸리티
 * Reference: requirements/android_deployment_guide.md
 */
export { isEraserPointer, type EraserPointerEventLike } from '../geometry/geometry';

export interface CapacitorServerConfig {
  url?: string;
  androidScheme: 'https' | 'http';
  cleartext: boolean;
}

export interface EduInkCapacitorConfig {
  appId: string;
  appName: string;
  webDir: string;
  server: CapacitorServerConfig;
  android: {
    allowMixedContent: boolean;
    captureInput: boolean;
    webContentsDebuggingEnabled: boolean;
  };
}

export interface BuildCapacitorConfigOptions {
  /** §4.B Live-Reload 디버깅용 개발 서버 URL (예: 'http://192.168.0.15:5173') */
  liveReloadUrl?: string;
  /** 실기기 Chrome 인스펙터(chrome://inspect/#devices) 디버깅 활성화 여부 (기본값: true) */
  webContentsDebuggingEnabled?: boolean;
}

/**
 * §2.1 & §4.B & §6.1 Capacitor 설정 생성기
 * - 기본값(§2.1, §6.1): 로컬 `dist` 번들 바라봄 (`androidScheme: 'https'`, `cleartext: false`)
 * - Live-Reload(§4.B): `liveReloadUrl` 지정 시 `server.url` 및 `cleartext: true` 활성화
 */
export function buildCapacitorConfig(options: BuildCapacitorConfigOptions = {}): EduInkCapacitorConfig {
  const trimmedUrl = options.liveReloadUrl?.trim();
  const server: CapacitorServerConfig = trimmedUrl
    ? {
        url: trimmedUrl,
        androidScheme: 'https',
        cleartext: true,
      }
    : {
        androidScheme: 'https',
        cleartext: false,
      };

  return {
    appId: 'com.eduink.studio',
    appName: 'EduInk Studio',
    webDir: 'dist',
    server,
    android: {
      allowMixedContent: false,
      captureInput: false,
      webContentsDebuggingEnabled: options.webContentsDebuggingEnabled ?? true,
    },
  };
}

/**
 * §3. 태블릿 & S-Pen 전용 설정이 반영된 표준 AndroidManifest.xml 템플릿
 */
export const ANDROID_MANIFEST_XML = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">

    <!-- 하드웨어 가속 필수: 2D 캔버스 S-Pen 드로잉 렉 방지 -->
    <application
        android:allowBackup="true"
        android:icon="@mipmap/ic_launcher"
        android:label="@string/app_name"
        android:roundIcon="@mipmap/ic_launcher_round"
        android:supportsRtl="true"
        android:theme="@style/AppTheme"
        android:hardwareAccelerated="true">

        <activity
            android:configChanges="orientation|keyboardHidden|keyboard|screenSize|locale|smallestScreenSize|screenLayout|uiMode"
            android:name=".MainActivity"
            android:label="@string/title_activity_main"
            android:theme="@style/AppTheme.NoActionBarLaunch"
            android:launchMode="singleTask"
            android:exported="true"
            android:windowSoftInputMode="adjustResize">

            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>

    <!-- 네트워크 및 터치스크린 권한 -->
    <uses-permission android:name="android.permission.INTERNET" />
    <uses-feature android:name="android.hardware.touchscreen" android:required="true" />
    <uses-feature android:name="android.hardware.touchscreen.multitouch" android:required="false" />
</manifest>
`;

export interface ManifestValidationResult {
  valid: boolean;
  missingRequirements: string[];
}

/**
 * §3. AndroidManifest.xml 필수 속성 검증
 * - hardwareAccelerated="true"
 * - orientation|...|screenSize|smallestScreenSize|screenLayout configChanges
 * - windowSoftInputMode="adjustResize"
 * - INTERNET 권한 및 touchscreen / multitouch feature 선언
 */
export function validateAndroidManifest(xmlContent: string): ManifestValidationResult {
  const checks: Array<{ key: string; pattern: RegExp }> = [
    {
      key: 'android:hardwareAccelerated="true"',
      pattern: /android:hardwareAccelerated\s*=\s*"true"/,
    },
    {
      key: 'android:windowSoftInputMode="adjustResize"',
      pattern: /android:windowSoftInputMode\s*=\s*"adjustResize"/,
    },
    {
      key: 'android:launchMode="singleTask"',
      pattern: /android:launchMode\s*=\s*"singleTask"/,
    },
    {
      key: 'android:configChanges (orientation|screenSize|smallestScreenSize|screenLayout)',
      pattern: /android:configChanges\s*=\s*"[^"]*orientation[^"]*screenSize[^"]*smallestScreenSize[^"]*screenLayout[^"]*"/,
    },
    {
      key: 'android.permission.INTERNET',
      pattern: /<uses-permission\s+android:name\s*=\s*"android\.permission\.INTERNET"\s*\/>/,
    },
    {
      key: 'android.hardware.touchscreen (required="true")',
      pattern: /<uses-feature\s+android:name\s*=\s*"android\.hardware\.touchscreen"\s+android:required\s*=\s*"true"\s*\/>/,
    },
    {
      key: 'android.hardware.touchscreen.multitouch (required="false")',
      pattern: /<uses-feature\s+android:name\s*=\s*"android\.hardware\.touchscreen\.multitouch"\s+android:required\s*=\s*"false"\s*\/>/,
    },
  ];

  const missingRequirements = checks
    .filter((check) => !check.pattern.test(xmlContent))
    .map((check) => check.key);

  return {
    valid: missingRequirements.length === 0,
    missingRequirements,
  };
}

/**
 * §5. S-Pen Palm Rejection (손바닥 터치 거부) 시간 창 (ms)
 * S-Pen 호버/필기 감지 직후 일정 시간 동안 들어오는 손바닥(touch) 이벤트를 차단한다.
 */
export const PALM_REJECTION_WINDOW_MS = 450;

export interface PalmRejectionState {
  isPenDrawing: boolean;
  lastPenTimestamp: number;
}

/**
 * §5. 손바닥(Palm) 터치 차단 판별 함수
 * - 현재 S-Pen 필기 중(`isPenDrawing === true`)이거나
 * - 최근 `PALM_REJECTION_WINDOW_MS` 이내에 S-Pen 입력/호버가 감지된 경우
 * `'touch'` 포인터 이벤트를 차단하여 의도치 않은 스크롤, 롱프레스 메뉴, 낙서를 방지한다.
 */
export function shouldRejectPalmTouch(
  pointerType: string,
  state: PalmRejectionState,
  nowMs: number = Date.now(),
  windowMs: number = PALM_REJECTION_WINDOW_MS,
): boolean {
  if (pointerType !== 'touch') return false;
  if (state.isPenDrawing) return true;
  if (state.lastPenTimestamp > 0 && nowMs - state.lastPenTimestamp <= windowMs) {
    return true;
  }
  return false;
}

/**
 * §5. S-Pen 필압(`e.pressure`) 정규화 (0.0 ~ 1.0)
 * - 펜 입력 시 유효한 필압(0 < p <= 1)을 그대로 전달하고, 미보고(0) 시 기본 필압(0.5)으로 폴백.
 */
export function normalizePenPressure(pressure: number | undefined, pointerType: string): number {
  if (pointerType !== 'pen') return 0.5;
  if (typeof pressure !== 'number' || Number.isNaN(pressure) || pressure <= 0) {
    return 0.5;
  }
  return Math.min(1, Math.max(0.05, pressure));
}

/**
 * §8. 보안 가이드 (BYOK 배포 필수 수칙)
 * 마켓 출시 빌드(`mode === 'release'` 또는 `VITE_BYOK_ONLY === 'true'`)에서는
 * `.env.local`의 개인 `VITE_GEMINI_API_KEY`가 번들에 포함되거나 읽히지 않도록 차단한다.
 */
export function isByokReleaseMode(env?: {
  MODE?: string;
  VITE_BYOK_ONLY?: string;
  VITE_RELEASE_BUILD?: string;
}): boolean {
  if (!env) return false;
  return (
    env.MODE === 'release' ||
    env.VITE_BYOK_ONLY === 'true' ||
    env.VITE_RELEASE_BUILD === 'true'
  );
}

export function sanitizeEnvApiKey(
  rawKey: string | undefined | null,
  env?: { MODE?: string; VITE_BYOK_ONLY?: string; VITE_RELEASE_BUILD?: string },
): string | null {
  if (isByokReleaseMode(env)) {
    return null;
  }
  if (typeof rawKey === 'string' && rawKey.trim().length > 0) {
    return rawKey.trim();
  }
  return null;
}
