# ANDROID_DEPLOYMENT.md: EduInk Studio Android 실기기 테스트 & 마켓 배포 가이드

본 문서는 Vite + React 기반의 하이브리드 노트 앱을 Capacitor를 통해 **안드로이드 태블릿(Galaxy Tab 등) 실기기에서 직접 구동·테스트(S-Pen 필압, 제스처, AI 스트리밍 검증)**하고, 검증 완료 후 **Google Play Store 정식 릴리스(AAB)**까지 이어지는 전체 워크플로우를 정리한 지침서입니다.

---

## 1. 사전 환경 요건 (Prerequisites)

* **Node.js**: v18.x 이상
* **JDK**: Java Development Kit 17 또는 21 (LTS)
* **Android Studio**: Ladybug / Koala 이상 최신 안정 버전
* **Android SDK**: API 레벨 34 이상 (`Platform 34`, `Build-Tools 34.0.0`)
* **환경변수 설정 (Windows)**:
  * `JAVA_HOME`: `C:\Program Files\Java\jdk-17`
  * `ANDROID_HOME`: `%LOCALAPPDATA%\Android\Sdk`
  * `Path`에 `%ANDROID_HOME%\platform-tools` 추가 (`adb` 명령어 구동용)

---

## 2. Capacitor 안드로이드 초기화

Antigravity 터미널(프로젝트 루트)에서 실행합니다.

```bash
# 1. Capacitor Android 패키지 설치
npm install @capacitor/android

# 2. 안드로이드 네이티브 프로젝트 폴더 생성 (최초 1회)
npx cap add android
```

### 2.1 `capacitor.config.ts` 설정
태블릿 WebView 디버깅 활성화 및 로컬 스키마 설정을 확인합니다.

```typescript
import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.eduink.studio',
  appName: 'EduInk Studio',
  webDir: 'dist',
  server: {
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
```

---

## 3. 태블릿 & S-Pen 전용 설정 (`AndroidManifest.xml`)

`android/app/src/main/AndroidManifest.xml`에서 하드웨어 가속과 터치 필터링을 구성합니다:

```xml
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
```

---

## 4. 안드로이드 태블릿 사전 테스트 파이프라인 (Pre-Market Testing)

마켓에 올리기 전, 실제 태블릿에서 **S-Pen 필기 지연, KaTeX 렌더링, Gemini 스트리밍, 팜 리젝션**을 검증하는 2가지 방법입니다.

### 방법 A. 빠른 검증용 디버그 APK 빌드 (Android Studio 없이 실행)

1. **태블릿 개발자 모드 설정**:
   * 태블릿 `설정` $\rightarrow$ `태블릿 정보` $\rightarrow$ `소프트웨어 정보` $\rightarrow$ **빌드번호 7회 터치**.
   * `설정` $\rightarrow$ `개발자 옵션` $\rightarrow$ **USB 디버깅 ON**.
2. **웹 빌드 및 동기화**:
   ```bash
   npm run build
   npx cap sync android
   ```
3. **Antigravity 터미널에서 즉시 APK 컴파일**:
   ```powershell
   cd android
   .\gradlew assembleDebug
   cd ..
   ```
4. **결과물 위치**: `android/app/build/outputs/apk/debug/app-debug.apk`
5. **기기 설치**:
   * PC와 태블릿 연결 후 터미널에서 바로 설치:
     ```bash
     adb install -r android/app/build/outputs/apk/debug/app-debug.apk
     ```
   * 또는 Quick Share / Google Drive로 `app-debug.apk`를 태블릿으로 보내 파일 관리자에서 설치합니다.

---

### 방법 B. 코드 수정 즉시 태블릿 반영 (Live-Reload 디버깅)

PC와 태블릿이 동일한 Wi-Fi에 연결되어 있다면 코드를 수정할 때마다 태블릿 화면이 실시간 새로고침되도록 설정할 수 있습니다.

1. **PC 로컬 IP 확인**: 터미널에 `ipconfig` 입력 $\rightarrow$ IPv4 주소 확인 (예: `192.168.0.15`).
2. **`capacitor.config.ts` 임시 수정**:
   ```typescript
   server: {
     url: 'http://192.168.0.15:5173', // 내 PC 로컬 개발 서버 IP
     cleartext: true
   }
   ```
3. **Vite 개발 서버 호스트 오픈**:
   ```bash
   npm run dev -- --host
   ```
4. **Android Studio에서 태블릿으로 앱 구동**:
   ```bash
   npx cap run android -l --target="기기ID"
   ```
5. **태블릿 화면 실시간 디버깅 (Chrome DevTools)**:
   * PC 크롬 브라우저에서 `chrome://inspect/#devices` 접속.
   * 연결된 태블릿의 `EduInk Studio` WebView 항목 아래 **inspect** 클릭.
   * PC 브라우저 개발자 도구(F12)로 태블릿의 Console 로그, Network 호출, `AbortError` 발생 여부를 실시간 추적 가능.

---

## 5. 실기기 집중 체크리스트 (태블릿 검증 항목)

배포 전 태블릿에서 다음 항목을 직접 테스트합니다:

* [ ] **S-Pen 필압 인식**: 가볍게 그었을 때와 세게 눌렀을 때 선 굵기 변화(`perfect-freehand`)가 정상인가?
* [ ] **Palm Rejection**: 손바닥을 캔버스 화면에 대고 S-Pen으로 쓸 때 원치 않는 터치 스크롤이나 낙서가 발생하지 않는가?
* [ ] **KaTeX 수식 렌더링**: 학술 수식($\int, \sum, \mathbb{R}$)이 깨지거나 네모 상자(tofu) 없이 깔끔하게 표시되는가?
* [ ] **AI 스트리밍 지연시간**: 말풍선/사이드바 질문 시 1초 이내에 첫 글자가 찍히며, 네트워크 끊김 없이 끝까지 출력되는가?
* [ ] **화면 회전**: 가로 모드(Landscape)와 세로 모드(Portrait) 전환 시 캔버스 좌표와 툴바 레이아웃이 어긋나지 않는가?

---

## 6. Google Play Store 출시용 AAB 빌드 (Release Build)

실기기 테스트를 마친 후 마켓 등록용 정식 번들을 생성합니다.

### 6.1 `capacitor.config.ts` 원복
Live-Reload를 위해 설정했던 `server.url`을 제거하고 `dist` 로컬 번들을 가리키도록 복원합니다:
```typescript
server: {
  androidScheme: 'https',
  cleartext: false,
}
```

### 6.2 최종 프로덕션 빌드 & 동기화
```bash
npm run build
npx cap sync android
npx cap open android
```

### 6.3 Android Studio에서 서명된 번들 생성 (Signed AAB)
1. Android Studio 메뉴: **Build** $\rightarrow$ **Generate Signed Bundle / APK...**
2. **Android App Bundle** 선택 $\rightarrow$ **Next**.
3. **Key store path**:
   * **Create new...** 클릭하여 릴리스 키(`.jks`) 생성.
   * 키 저장 위치, 비밀번호, Alias(`eduink-release`) 입력 및 유효기간(25년 이상) 설정.
   * ⚠️ *`.jks` 키 파일과 패스워드는 절대 분실하지 않도록 오프라인 백업 필수.*
4. **Build Variants**: `release` 선택 $\rightarrow$ **Finish**.
5. 완료 후 생성된 `android/app/release/app-release.aab` 파일을 확인합니다.

---

## 7. Google Play Console 배포 절차

1. **개발자 콘솔 접속**: [Google Play Console](https://play.google.com/console) 로그인.
2. **새 앱 생성**:
   * 앱 이름: `EduInk Studio` (또는 프로젝트명)
   * 기본 언어: 한국어 | 구분: 앱 | 무료/유료: 무료
3. **내부 테스트(Internal Test) 트랙 등록 권장**:
   * 프로덕션 직행 전에 **테스트 $\rightarrow$ 내부 테스트** 트랙에 `app-release.aab`를 먼저 업로드합니다.
   * 테스터 이메일에 본인 구글 계정을 등록하면, 플레이스토어 링크를 통해 태블릿에 실제 마켓 다운로드 형태로 설치하여 최종 인스톨 과정을 검증할 수 있습니다.
4. **프로덕션 심사 제출**:
   * 태블릿 스크린샷(7인치/10인치 각 최소 4장), 앱 설명, 개인정보처리방침 URL 작성.
   * 프로덕션 트랙으로 승급 후 **검토를 위해 전송(Submit for Review)**.

---

## 8. 보안 가이드 (BYOK 배포 필수 수칙)

* **API Key 번들링 금지**:
  * 마켓 배포용 번들(`app-release.aab`) 빌드 시 `.env.local`의 개인 `VITE_GEMINI_API_KEY`는 디컴파일 시 유출될 수 있습니다.
  * 플레이스토어 출시 빌드에서는 기본 API 키를 비워두고, 사용자가 앱 설정/사이드바 화면에서 **본인의 Google AI Studio API 키를 직접 입력(BYOK)하여 로컬 암호화 저장소에 보관**하도록 유도하십시오.