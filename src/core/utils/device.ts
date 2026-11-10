/**
 * 디바이스 및 입력 환경 판별 유틸
 * - 데스크톱 PC(Windows, macOS, Linux) 환경과 모바일/태블릿 가상 키보드 환경을 정밀하게 격리합니다.
 * - 터치 모니터가 연결된 데스크톱 PC가 가상 키보드 모드로 오인되지 않도록 User Agent 및 플랫폼을 종합 판정합니다.
 */

let testDeviceOverride: boolean | null = null;

/** 테스트 목적으로 디바이스 모드를 강제 오버라이드합니다. (null 전달 시 실제 환경 감지로 복원) */
export function setDeviceOverrideForTest(isTouch: boolean | null): void {
  testDeviceOverride = isTouch;
}

/**
 * 모바일/태블릿 터치 가상 키보드 환경인지 판별합니다.
 * - 데스크톱 PC(Windows/Mac/Linux 물리 키보드 환경)에서는 false를 반환합니다.
 * - Android, iPadOS, iOS, Capacitor 모바일 등 가상 키보드 IME 환경에서만 true를 반환합니다.
 */
export function isTouchDevice(): boolean {
  if (testDeviceOverride !== null) {
    return testDeviceOverride;
  }

  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return false;
  }

  const ua = navigator.userAgent || '';
  const platform = (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.platform || '';

  // 1. Android 환경 (Capacitor WebView, Chrome Android, Samsung Internet 등)
  const isAndroid = /Android/i.test(ua);
  if (isAndroid) return true;

  // 2. iOS / iPadOS 환경 (iPadOS 13+의 데스크톱 모드 UA 대응: Macintosh + maxTouchPoints > 1)
  const isIOS = /iPhone|iPod/i.test(ua);
  const isIPad = /iPad/i.test(ua) || (platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (isIOS || isIPad) return true;

  // 3. 기타 모바일/임베디드 터치 기기
  const isMobileUa = /webOS|BlackBerry|IEMobile|Opera Mini|Mobile/i.test(ua);
  const hasTouchCapability = 'ontouchstart' in window || (navigator.maxTouchPoints && navigator.maxTouchPoints > 0);

  if (isMobileUa && hasTouchCapability) {
    return true;
  }

  // 데스크톱 Windows / macOS / Linux (터치스크린 노트북 포함)는 물리 키보드를 사용하므로 false
  return false;
}
