import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import capacitorConfig from '../../../capacitor.config';
import {
  ANDROID_MANIFEST_XML,
  buildCapacitorConfig,
  isByokReleaseMode,
  normalizePenPressure,
  PALM_REJECTION_WINDOW_MS,
  sanitizeEnvApiKey,
  shouldRejectPalmTouch,
  validateAndroidManifest,
} from './androidDeployment';

describe('Android Deployment & Tablet S-Pen Configuration (android_deployment_guide.md)', () => {
  it('§2.1 & §6.1: capacitor.config.ts 기본 설정이 EduInk Studio 스펙과 일치한다', () => {
    expect(capacitorConfig.appId).toBe('com.eduink.studio');
    expect(capacitorConfig.appName).toBe('EduInk Studio');
    expect(capacitorConfig.webDir).toBe('dist');
    expect(capacitorConfig.server).toEqual({
      androidScheme: 'https',
      cleartext: false,
    });
    expect(capacitorConfig.android).toEqual({
      allowMixedContent: false,
      captureInput: false,
      webContentsDebuggingEnabled: true,
    });
  });

  it('§4.B & §6.1: Live-Reload URL 설정 및 출시용 로컬 번들 설정 원복이 정상 동작한다', () => {
    const liveConfig = buildCapacitorConfig({
      liveReloadUrl: 'http://192.168.0.15:5173',
    });
    expect(liveConfig.server).toEqual({
      url: 'http://192.168.0.15:5173',
      androidScheme: 'https',
      cleartext: true,
    });

    const releaseConfig = buildCapacitorConfig();
    expect(releaseConfig.server).toEqual({
      androidScheme: 'https',
      cleartext: false,
    });
    expect(releaseConfig.server.url).toBeUndefined();
  });

  it('§3: 실제 android/app/src/main/AndroidManifest.xml 파일이 하드웨어 가속 및 S-Pen·터치스크린 요건을 충족한다', () => {
    const templateResult = validateAndroidManifest(ANDROID_MANIFEST_XML);
    expect(templateResult.valid).toBe(true);
    expect(templateResult.missingRequirements).toEqual([]);

    const manifestPath = resolve(process.cwd(), 'android/app/src/main/AndroidManifest.xml');
    if (existsSync(manifestPath)) {
      const actualXml = readFileSync(manifestPath, 'utf-8');
      const actualResult = validateAndroidManifest(actualXml);
      expect(actualResult.valid).toBe(true);
      expect(actualResult.missingRequirements).toEqual([]);
    }
  });

  it('§5: S-Pen 필압(pressure) 정규화 및 Palm Rejection(손바닥 터치 차단)이 정상 동작한다', () => {
    // S-Pen 필압 정규화
    expect(normalizePenPressure(0.25, 'pen')).toBeCloseTo(0.25);
    expect(normalizePenPressure(0.88, 'pen')).toBeCloseTo(0.88);
    expect(normalizePenPressure(0, 'pen')).toBe(0.5);
    expect(normalizePenPressure(0.9, 'touch')).toBe(0.5);

    const now = 10_000;
    // 1. S-Pen 드로잉 중에는 손바닥 touch 차단
    expect(
      shouldRejectPalmTouch('touch', { isPenDrawing: true, lastPenTimestamp: now - 1000 }, now),
    ).toBe(true);

    // 2. S-Pen 호버/필기 직후(PALM_REJECTION_WINDOW_MS 이내) 손바닥 touch 차단
    expect(
      shouldRejectPalmTouch(
        'touch',
        { isPenDrawing: false, lastPenTimestamp: now - (PALM_REJECTION_WINDOW_MS - 50) },
        now,
      ),
    ).toBe(true);

    // 3. S-Pen 입력 자체는 절대 차단하지 않음
    expect(
      shouldRejectPalmTouch('pen', { isPenDrawing: true, lastPenTimestamp: now }, now),
    ).toBe(false);

    // 4. S-Pen 비활성 후 시간 창이 지나면 일반 손가락 터치 스크롤 허용
    expect(
      shouldRejectPalmTouch(
        'touch',
        { isPenDrawing: false, lastPenTimestamp: now - (PALM_REJECTION_WINDOW_MS + 100) },
        now,
      ),
    ).toBe(false);
  });

  it('§8: 마켓 출시(Release / BYOK-Only) 모드에서 환경변수 API 키 번들링 노출을 차단한다', () => {
    expect(isByokReleaseMode({ MODE: 'development' })).toBe(false);
    expect(isByokReleaseMode({ MODE: 'release' })).toBe(true);
    expect(isByokReleaseMode({ VITE_BYOK_ONLY: 'true' })).toBe(true);

    expect(sanitizeEnvApiKey('AIzaSyDevPersonalKey1234', { MODE: 'development' })).toBe(
      'AIzaSyDevPersonalKey1234',
    );
    expect(sanitizeEnvApiKey('AIzaSyDevPersonalKey1234', { MODE: 'release' })).toBeNull();
    expect(sanitizeEnvApiKey('AIzaSyDevPersonalKey1234', { VITE_BYOK_ONLY: 'true' })).toBeNull();
  });
});
