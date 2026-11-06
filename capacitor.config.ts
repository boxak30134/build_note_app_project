import type { CapacitorConfig } from '@capacitor/cli';

const liveReloadUrl =
  typeof process !== 'undefined' && process.env?.CAP_SERVER_URL
    ? process.env.CAP_SERVER_URL.trim()
    : '';

const config: CapacitorConfig = {
  appId: 'com.eduink.studio',
  appName: 'EduInk Studio',
  webDir: 'dist',
  server: liveReloadUrl
    ? {
        url: liveReloadUrl,
        androidScheme: 'https',
        cleartext: true,
      }
    : {
        androidScheme: 'https',
        cleartext: false,
      },
  android: {
    allowMixedContent: false,
    captureInput: false, // 태블릿 한글 IME 조합 및 언어 전환 보장 (true 시 BaseInputConnection 강제로 영문 고정 버그 발생)
    webContentsDebuggingEnabled: true, // 실기기 Chrome 인스펙터 디버깅 활성화
  },
};

export default config;
