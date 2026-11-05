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
    captureInput: true,
    webContentsDebuggingEnabled: true, // 실기기 Chrome 인스펙터 디버깅 활성화
  },
};

export default config;
