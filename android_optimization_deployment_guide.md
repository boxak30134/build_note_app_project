# ANDROID_DEPLOYMENT.md: EduInk Studio 웹 런타임 최적화 및 Android 실기기 테스트·배포 가이드

본 문서는 Vite + React 19 기반 하이브리드 노트 웹앱의 **프론트엔드·캔버스 극한 최적화(HTML/CSS/JS/React)** 전략부터, Capacitor를 통한 **안드로이드 태블릿(Galaxy Tab 등) 실기기 테스트**, 그리고 Google Play Store 정식 릴리스(AAB)까지 이어지는 통합 기술 지침서입니다.

## 파트 1. 웹앱 런타임 및 프론트엔드 성능 최적화 (Web & Hybrid Optimization)

태블릿 WebView 및 데스크톱 브라우저에서 $120\text{ Hz}$ 주사율의 부드러운 S-Pen 필기감과 즉각적인 UI 반응성을 확보하기 위한 4대 영역 최적화 방안입니다.

### 1.1 JavaScript 엔진(V8) 및 메모리 최적화

1. **가비지 컬렉션(GC) 회피를 위한 객체 풀링 및 `TypedArray` 활용**

   * **문제**: S-Pen 입력 시 초당 수백 번 발생하는 `pointermove` 이벤트마다 `{ x, y, pressure }` 객체를 새로 생성하면 힙(Heap) 메모리 단편화와 GC Pause(미세한 화면 끊김)가 발생합니다.

   * **해결**: 사전 할당된 `Float32Array` 고정 길이 버퍼에 $(x, y, \text{pressure})$ 값을 순차 기록하고 인덱스로만 참조하여 런타임 중 객체 할당을 $0$에 가깝게 유지합니다.

   ```
   // 고정 크기 스트로크 버퍼 사전 할당 (최대 10,000 포인트 * 3채널)
   const strokeBuffer = new Float32Array(10000 * 3);
   let pointCount = 0;
   
   function recordPoint(x: number, y: number, pressure: number) {
     const offset = pointCount * 3;
     strokeBuffer[offset] = x;
     strokeBuffer[offset + 1] = y;
     strokeBuffer[offset + 2] = pressure;
     pointCount++;
   }
   
   
   ```

2. **`requestAnimationFrame` (rAF) 기반 렌더링 스케줄링**

   * **문제**: 스타일러스 디지타이저 샘플링 속도($240\text{ Hz}$ 이상)가 화면 주사율($60\text{ Hz} \sim 120\text{ Hz}$)보다 빨라 매 이벤트마다 캔버스를 다시 그리면 메인 스레드가 과부하됩니다.

   * **해결**: `pointermove`에서는 좌표 버퍼만 적재하고, 실제 `<canvas>` 드로잉은 `requestAnimationFrame` 루프 내부에서 프레임당 단 $1$회만 수행합니다.

3. **무거운 연산의 Web Worker 오프로딩**

   * **원칙**: 단일 프레임 예산($60\text{ FPS}$ 기준 $16.6\text{ ms}$, $120\text{ FPS}$ 기준 $8.3\text{ ms}$)을 초과하는 모든 연산은 UI 스레드에서 분리합니다.

   * **적용 대상**: `MiniSearch` 전문 검색 인덱싱, 대규모 마크다운 파싱, ZIP 압축/해제(`jszip`), 로컬 데이터 백업 직렬화는 별도 Web Worker 스레드에서 비동기 처리합니다.

4. **연산 병목(Hotspot) 구간의 선택적 WebAssembly(Wasm) 분리**

   * 수만 개의 필기 획에 대한 올가미(Lasso) 다각형 충돌 판정(Ray-Casting)이나 대규모 행렬/벡터 내적 연산 등 극단적 수치 계산이 필요한 단일 함수만 Wasm(또는 SIMD) 모듈로 분리해 `TypedArray` 포인터를 직접 참조하게 합니다.

### 1.2 React 19 및 컴포넌트 렌더링 최적화

1. **고주파 상태 분리 및 격리 (State Colocation)**

   * 밀리초 단위로 변하는 펜 좌표, 스크롤 오프셋, 드래그 위치를 상위 공통 스토어(Zustand 전역 상태나 상위 부모 `useState`)에 두면 전체 3-Pane 레이아웃이 리렌더링됩니다.

   * 실시간 드로잉 상태는 반드시 캔버스 컴포넌트 내부의 `useRef`에 격리하고, 획이 끝나는 시점(`pointerup`)에만 최종 스트로크 데이터를 상태 스토어에 커밋합니다.

2. **스트리밍 응답 렌더링 및 메모이제이션**

   * Gemini AI 토큰 스트리밍 수신 시 전체 메시지 배열을 매번 새로 복제하지 않고, 현재 스트리밍 중인 마지막 메시지 버블 컴포넌트만 구독하도록 상태를 세분화합니다.

   * 툴바 버튼, 사이드바 문서 트리 아이템, 완료된 채팅 말풍선에는 `React.memo`를 적용해 불필요한 Virtual DOM Diff 비용을 차단합니다.

3. **대규모 리스트 및 노트 가상화 (Virtualization)**

   * 수백 개의 노트 목록이나 긴 채팅 히스토리를 모두 DOM에 마운트하지 않고, 뷰포트(Viewport)에 노출되는 $10 \sim 20$개 항목만 렌더링하는 윈도윙(Windowing) 기법을 적용합니다.

### 1.3 브라우저 렌더링 파이프라인(DOM/CSS) 및 리플로우 방지

1. **강제 동기 레이아웃(Forced Synchronous Layout) 차단**

   * `getBoundingClientRect()`, `offsetWidth`, `scrollTop` 등 레이아웃 값을 읽는 코드와 `style.width = ...`처럼 스타일을 쓰는 코드를 교차 실행하면 브라우저가 레이아웃을 즉시 재계산(Reflow)합니다.

   * **해결**: DOM 측정(Read) 단계를 먼저 일괄 수행한 뒤, DOM 변경(Write) 단계를 `requestAnimationFrame` 안에서 일괄 반영합니다.

2. **GPU 컴포지팅(Compositing) 가속 활용**

   * 사이드바 개폐, 플로팅 버블 이동, 팝오버 애니메이션에는 레이아웃 재계산을 유발하는 `top`, `left`, `width`, `height` 대신 오직 GPU 합성 단계만 거치는 `transform: translate3d(x, y, 0)`와 `opacity`만 사용합니다.

3. **CSS 레이아웃 격리 (`contain` & `will-change`)**

   * 캔버스 영역과 에디터 패널 컨테이너에 `contain: layout paint style;`을 선언하여, 패널 내부의 DOM 변화가 외부 전체 페이지의 레이아웃 재계산으로 전파되지 않도록 차단합니다.

   * 드래그 중인 플로팅 요소에만 일시적으로 `will-change: transform;`을 부여합니다.

### 1.4 번들 사이즈 및 로딩 최적화 (Vite)

1. **대형 라이브러리 동적 임포트 (Code Splitting)**

   * 초기 앱 구동 속도를 높이기 위해 `pdfjs-dist`, `katex`, `jszip` 등 무거운 패키지는 초기 번들에서 제외하고, 사용자가 실제로 PDF를 열거나 수식을 렌더링할 때 `await import(...)`로 지연 로딩(Lazy Loading)합니다.

2. **아이콘 및 유틸리티 트리 쉐이킹(Tree Shaking)**

   * 필요한 모듈만 명시적으로 임포트하여 최종 `dist` 에셋 크기를 최소화합니다.

## 파트 2. Capacitor 안드로이드 환경 구축 및 빌드 트러블슈팅

### 2.1 사전 환경 요건 (Prerequisites)

* **Node.js**: v18.x 이상

* **JDK**: **Java Development Kit 21 (LTS)** 필수 (Capacitor 8 및 최신 Android Gradle Plugin 규격)

* **Android Studio**: 최신 안정 버전 (내장 JBR 21 및 Android SDK API 34+ 포함)

### 2.2 `package.json` 권장 스크립트 구성

```
  "scripts": {
    "dev": "vite",
    "dev:host": "vite --host",
    "build": "tsc --noEmit && vite build",
    "build:release": "tsc --noEmit && vite build --mode release",
    "android:sync": "npm run build && npx cap sync android",
    "android:sync:release": "npm run build:release && npx cap sync android",
    "android:open": "npx cap open android",
    "android:build:apk": "npm run android:sync && cd android && gradlew.bat assembleDebug"
  }


```

### 2.3 태블릿 & S-Pen 전용 설정 (`AndroidManifest.xml`)

`android/app/src/main/AndroidManifest.xml`에서 하드웨어 가속(`android:hardwareAccelerated="true"`)을 반드시 활성화합니다:

```
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
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

    <uses-permission android:name="android.permission.INTERNET" />
    <uses-feature android:name="android.hardware.touchscreen" android:required="true" />
</manifest>


```

### 2.4 자주 발생하는 Gradle 빌드 에러 해결 (`gradle.properties`)

Windows 환경에서 빌드 시 발생하는 대표적인 2가지 에러와 해결 설정입니다. `android/gradle.properties` 파일 하단에 아래 설정을 추가하여 해결합니다.

1. **에러 1: 한글 경로(`바탕 화면` 등 Non-ASCII 문자)로 인한 빌드 차단**

   * **증상**: `Your project path contains non-ASCII characters.`

   * **근본 해결**: 프로젝트를 `C:\dev\build_note_app_project`처럼 순수 영문 경로로 이동하는 것이 가장 안전합니다.

   * **빠른 우회**: `android/gradle.properties`에 아래 옵션을 추가합니다.

     ```
     android.overridePathCheck=true
     
     
     ```

2. **에러 2: Java 21 (JDK 21) 미감지 오류**

   * **증상**: `Cannot find a Java installation on your machine matching: {languageVersion=21}`

   * **해결**: PC에 설치된 Android Studio의 내장 JDK 21(JBR) 경로를 `android/gradle.properties`에 직접 연결하거나 Adoptium JDK 21을 설치합니다.

     ```
     org.gradle.java.home=C:\\Program Files\\Android\\Android Studio\\jbr
     
     
     ```

## 파트 3. 안드로이드 태블릿 실기기 사전 테스트 (Pre-Market Testing)

마켓 정식 출시 전, 실제 갤럭시 탭에서 S-Pen 필압과 레이아웃을 검증하는 2가지 방법입니다.

### 방법 A. 디버그 APK 추출 후 태블릿에 설치 (가장 간편)

1. **웹 빌드 및 APK 생성**:

   ```
   npm run android:sync
   cd android
   .\gradlew.bat assembleDebug
   cd ..
   
   
   ```

2. **생성된 APK 파일 위치**:
   `android/app/build/outputs/apk/debug/app-debug.apk`

3. **태블릿으로 전송 및 설치**:

   * **무선 전송**: Quick Share, 카카오톡, 구글 드라이브 등으로 `app-debug.apk`를 태블릿에 보낸 뒤 '내 파일' 앱에서 실행하여 설치합니다(출처를 알 수 없는 앱 허용 및 Play 프로텍트 '무시하고 설치' 선택).

   * **USB 케이블(ADB) 설치**: 태블릿 개발자 옵션에서 `USB 디버깅`을 켜고 PC와 연결한 뒤 아래 명령어를 실행합니다.

     ```
     adb install -r android/app/build/outputs/apk/debug/app-debug.apk
     
     
     ```

### 방법 B. 실시간 Live-Reload 및 원격 콘솔 디버깅

1. PC와 태블릿을 같은 Wi-Fi에 연결하고 PC의 내부 IP(예: `192.168.0.15`)를 확인합니다.

2. `capacitor.config.ts`에 개발 서버 주소를 임시 등록합니다:

   ```
   server: {
     url: 'http://192.168.0.15:5173',
     cleartext: true,
   }
   
   
   ```

3. `npm run dev:host` 실행 후 앱을 구동하면 코드 수정 즉시 태블릿 화면이 갱신됩니다.

4. PC 크롬 주소창에 `chrome://inspect/#devices`를 입력하면 태블릿 WebView의 콘솔 에러, 네트워크 스트리밍 상태, FPS 프로파일러를 PC에서 실시간으로 검사할 수 있습니다.

## 파트 4. 실기기 집중 검증 체크리스트

* \[ \] **S-Pen 필압 및** $120\text{ Hz}$ **반응성**: 빠르게 필기할 때 프레임 드랍 없이 선 굵기(`perfect-freehand`)가 부드럽게 이어지는가?

* \[ \] **팜 리젝션(Palm Rejection)**: 손바닥을 화면에 대고 S-Pen으로 필기할 때 화면이 밀리거나 오작동하지 않는가?

* \[ \] **KaTeX 학술 수식 렌더링**: 인라인($f: [a, b] \rightarrow \mathbb{R}$) 및 블록 수식($\int_{a}^{b} f(x)\,dx$)이 깨짐 없이 출력되는가?

* \[ \] **Gemini AI 스트리밍**: 질문 전송 시 `AbortError` 없이 실시간으로 답변 토큰이 렌더링되는가?

* \[ \] **화면 회전 대응**: 가로(Landscape) $\leftrightarrow$ 세로(Portrait) 전환 시 3-Pane 비율과 캔버스 좌표계가 유지되는가?

## 파트 5. Google Play Store 정식 배포 (Release AAB)

1. **`capacitor.config.ts` 원복**: 테스트용 `server.url`을 제거하고 로컬 `dist`를 바라보도록 되돌립니다.

2. **릴리스 동기화 및 Android Studio 실행**:

   ```
   npm run android:sync:release
   npm run android:open
   
   
   ```

3. **서명된 AAB 번들 생성**:

   * Android Studio 상단 메뉴: **Build** $\rightarrow$ **Generate Signed Bundle / APK...** $\rightarrow$ **Android App Bundle** 선택.

   * 신규 Keystore(`.jks`)를 생성하여 서명한 뒤 `release` 모드로 빌드합니다.

   * 산출물 위치: `android/app/release/app-release.aab`

4. **Google Play Console 등록 및 보안 점검**:

   * **내부 테스트 트랙**에 먼저 `.aab`를 업로드하여 마켓 설치 프로세스를 검증한 뒤 **프로덕션 심사**로 승급합니다.

   * **BYOK 보안 원칙**: 스토어 공개 배포판에는 개발자 개인의 `.env.local` API 키가 포함되지 않도록 비워두고, 사용자가 앱 설정 UI에서 본인의 Gemini API 키를 직접 입력해 로컬 스토리지에 저장하도록 구성합니다.