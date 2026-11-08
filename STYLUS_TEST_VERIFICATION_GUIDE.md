# STYLUS_TEST_VERIFICATION_GUIDE.md
# 스타일러스(S-Pen) 요구사항 작성 & 실기기 검증 지침서

> 목적: "Vitest 16 passed"인데 태블릿(`app-debug.apk`)에서는 기대와 다르게 동작하는 문제를 막는다.
> S-Pen / 캔버스 / 제스처 / 네이티브 오버레이 관련 요구사항은 **이 문서의 검증 레벨을 통과해야만 "완료"로 보고**할 수 있다.

---

## 0. 왜 테스트는 통과하는데 태블릿에서는 안 되는가 (현행 한계)

현재 자동 테스트(`test/canvasGestureIsolation.test.ts`, `src/canvas/inkCanvasLowLatency.test.tsx`)는 **jsdom** 위에서 돈다. jsdom은 다음을 **전혀 재현하지 못한다**.

| 실제 태블릿에서 일어나는 것 | jsdom 테스트에서의 실제 상태 | 결과 |
|---|---|---|
| Canvas 2D 픽셀 렌더링 | `getContext()` 미구현 → mock 객체 (`Not implemented: HTMLCanvasElement's getContext()` 로그) | 블러·깜빡임·모양 변형을 **원천적으로 검출 불가** |
| 레이아웃(`offsetHeight`, `getBoundingClientRect`) | 모두 0 또는 테스트가 수동으로 mock | 좌표 압축·페이지 겹침·청크 크기 오류 검출 불가 |
| 실제 `PointerEvent`(pressure, tilt, `getCoalescedEvents`, 240Hz) | `new Event()`에 속성을 덧붙인 가짜 이벤트 | 펜 샘플링·지연·팜 리젝션 타이밍 검출 불가 |
| GPU 컴포지터 스크롤, `desynchronized` 캔버스 | 없음 | 스크롤 뒤처짐(rubber-banding) 검출 불가 |
| Android WebView(Chromium 버전 차이), 하드웨어 가속 | 없음 | WebView 고유 버그 검출 불가 |
| `NativeInkOverlayView.java` / `NativeStylusOverlayPlugin.java` | **한 줄도 실행되지 않음** | 네이티브 오버레이 ↔ 웹 캔버스 전환 문제 검출 불가 |
| 손바닥 + 펜 동시 접촉, 배럴 버튼, 호버 | 시뮬레이션 값 | 실제 하드웨어 이벤트 순서와 다를 수 있음 |

> [!IMPORTANT]
> **jsdom 테스트 통과 = "이벤트 라우팅 로직이 의도대로 분기한다"까지만 증명한다.**
> "화면에 선명하게 보인다 / 깜빡이지 않는다 / 늦게 따라오지 않는다"는 **증명하지 못한다.**

---

## 1. 검증 레벨 (Verification Levels)

모든 스타일러스 요구사항은 아래 레벨 중 **어디까지 검증해야 하는지**를 명세서에 명시해야 한다.

| 레벨 | 환경 | 증명할 수 있는 것 | 증명할 수 없는 것 | 실행 주체 |
|---|---|---|---|---|
| **L1** 순수 로직 | Vitest (node) | 좌표 변환, `pointInPolygon`, 팜 리젝션 상태머신, 청크 인덱스 계산, 직렬화 스키마 | DOM·렌더링 일체 | 에이전트 |
| **L2** DOM 라우팅 | Vitest (jsdom) | `preventDefault`/`stopPropagation`/`setPointerCapture` 호출 여부, 용지 외 바이패스 분기, Undo/Redo 스택 | 픽셀, 레이아웃, 지연 | 에이전트 |
| **L3** 실브라우저 | Playwright + Chromium (CDP `pointerType: 'pen'`) | 실제 레이아웃 좌표, `canvas.width/height` 실측, 픽셀 스냅샷 비교(블러·소실·모양 변형), 스크롤 후 좌표 정합 | 실제 WebView/네이티브 레이어, 실제 펜 하드웨어 | 에이전트 (도입 필요, §6) |
| **L4** 실기기 자동 | `adb` + WebView 원격 디버깅 + 디버그 HUD 로그 | 실기기 WebView에서의 라우팅·DPR·캔버스 크기·네이티브↔웹 전환 로그, 프레임 드랍 | 사람 눈으로 보는 체감 품질 | 에이전트(명령 준비) + 사용자(기기 연결) |
| **L5** 실기기 수동 | 사용자 태블릿 + 실제 S-Pen | 체감 지연, 깜빡임, 선명도, 손바닥 오입력 | — | 사용자 (체크리스트 §4) |

### 1.1 요구사항 유형별 최소 필수 레벨

| 요구사항 유형 | 최소 필수 레벨 |
|---|---|
| 좌표 계산 / 올가미 판정 / 직렬화 | L1 + L2 |
| 이벤트 라우팅 (펜 vs 터치, 용지 외 바이패스, 팜 리젝션) | L2 + **L4** |
| **렌더링 품질 (블러, 깜빡임, 모양 변형, 소실)** | L2 + **L3 + L5** |
| **스크롤/줌 동기화, 지연(latency)** | **L4 + L5** |
| **네이티브 오버레이(Kotlin/Java) 관련 일체** | **L4 + L5** (+ Android Instrumented Test 권장) |
| PDF 임포트 후 페이지 좌표 | L3 + L5 |

> [!WARNING]
> 필수 레벨 중 하나라도 미수행이면 에이전트는 **"수정 완료"라고 보고하지 않는다.** 대신 "L2까지 통과, L5 기기 확인 필요"처럼 **도달한 레벨을 명시**한다.

---

## 2. 스타일러스 요구사항 작성 템플릿

사용자가 버그/기능을 제기할 때 아래 항목을 채우면 검증 가능한 명세가 된다. (모르는 항목은 비워두면 에이전트가 질문한다.)

```markdown
## [STYLUS-REQ] <제목>

### A. 환경
- 기기: (예: Galaxy Tab S9, Android 14, One UI 6)
- WebView 버전: (설정 > 앱 > Android System WebView, 또는 chrome://inspect 표시값)
- 빌드: app-debug.apk (빌드 시각 / git 커밋 해시)
- 문서 조건: (예: PDF 21페이지, 줌 119%, A4 페이지 분리 모드)

### B. 재현 절차 (번호 순서대로, 손/펜 구분 명시)
1. 21페이지 PDF를 연다
2. 20페이지까지 손가락으로 스크롤한다
3. 펜으로 한 획을 긋고 뗀다

### C. 기대 결과 / 실제 결과
- 기대: 펜을 뗀 후에도 필기 중과 동일한 선명도 유지
- 실제: 펜을 떼는 순간 모자이크처럼 흐려짐
- 증거: 스크린샷 / 화면녹화(권장: `adb shell screenrecord`) / 디버그 HUD 캡처

### D. 측정 가능한 수용 기준 (Acceptance Criteria)
- [ ] (L3) 25,000px 문서에서 committed 캔버스 `width === pageWidth × devicePixelRatio`
- [ ] (L3) 획 커밋 전/후 픽셀 스냅샷 차이 ≤ 1%
- [ ] (L5) 기기에서 펜 뗀 직후 흐려짐 0회 / 10회 시도

### E. 발생 빈도
- 항상 / 가끔(10회 중 n회) / 특정 조건에서만
```

> [!TIP]
> **"수용 기준"은 반드시 숫자 또는 예/아니오로 판정 가능해야 한다.** "부드럽게", "자연스럽게"는 기준이 아니다.
> 예) "필기 후 0.3초 이내 흐려짐 없음", "사이드바 버튼을 펜으로 10회 탭 시 10회 모두 반응".

---

## 3. 실기기 관측 장치 (Debug Instrumentation) — 구현 대상

실기기에서 "왜" 다르게 동작하는지 알려면 앱이 스스로 상태를 보여줘야 한다. 아래 장치는 **디버그 빌드에서만** 활성화한다.

### 3.1 Ink Debug HUD (`?inkDebug=1` 또는 설정 토글)
화면 우측 하단에 반투명 패널로 실시간 표시:

| 항목 | 예시 | 잡아내는 버그 |
|---|---|---|
| `pointerType / buttons / pressure` | `pen / 1 / 0.62` | 펜이 `touch`나 `mouse`로 들어오는 WebView 버그, 배럴 버튼(32) 미인식 |
| `route` | `native-overlay` / `web-canvas` / `bypass(outside-page)` / `palm-rejected` | 사이드바 클릭 씹힘, 이중 렌더링 |
| `devicePixelRatio`, 청크별 `canvas.width×height` | `2.625 / 840→2205×4200` | **블러(DPR 다운스케일)** |
| 청크 CSS 높이 vs 비트맵 높이 비율 | `1600px / 4200 = 2.625 ✅` | 마지막 청크 세로 늘어남 |
| `zoom / scrollTop / pageRect.top` | `1.19 / 23410 / -23280` | 올가미·좌표 어긋남, PDF 페이지 겹침 |
| `isPenDrawing / msSinceLastPen` | `false / 312` | 팜 리젝션 창(450ms) 오동작 |
| 최근 프레임 시간(rAF 간격) | `8.3ms / max 41ms` | 스크롤 뒤처짐, 프레임 드랍 |
| 네이티브 오버레이 상태 | `attached / strokes pending: 0` | ACTION_UP 시 깜빡임(전환 공백) |

### 3.2 구조화 로그 (logcat으로 수집)
- 웹: `console.info('[EduInkStylus]', JSON.stringify({ev, pointerType, route, dpr, chunk, x, y, t}))`
- 네이티브: `Log.d("EduInkStylus", ...)` — `onTouchEvent` 진입, `TOOL_TYPE`, 소비 여부(`return true/false`), `onStrokeFinished` 전송 시각
- 같은 태그를 쓰면 `adb logcat -s EduInkStylus chromium` 하나로 **네이티브→웹 순서**를 타임라인으로 볼 수 있다.

### 3.3 전환 타이밍 측정 (깜빡임 검증용)
- 네이티브 `ACTION_UP` 시각(T0) → 웹 `onStrokeFinished` 수신(T1) → 웹 캔버스 그리기 완료(T2) → 네이티브 오버레이 클리어(T3)
- **불변 조건: T3 ≥ T2** (웹이 다 그린 뒤에 네이티브를 지워야 깜빡임이 없다). 로그로 T0~T3을 남겨 위반 여부를 판정한다.

---

## 4. 실기기 수동 검증 체크리스트 (L5)

에이전트는 완료 보고 시 **해당 요구사항과 관련된 항목만 골라** 사용자에게 제시한다. 사용자는 ✅/❌와 빈도를 회신한다.

### 4.1 필기 품질
| # | 절차 | 합격 기준 |
|---|---|---|
| Q1 | 1페이지 문서에서 펜으로 "가나다" 쓰기 | 쓰는 중/뗀 후 선 굵기·선명도 동일 |
| Q2 | **21페이지 이상** PDF의 마지막 페이지 근처에서 쓰기 | Q1과 동일 선명도 (흐려짐 없음) |
| Q3 | 획을 빠르게 10회 연속 긋기 | 펜 뗄 때 깜빡임 0회 |
| Q4 | 빠르게 원 그리기 | 펜촉과 선 끝의 간격 체감 1~2mm 이내, 끊김 없음 |
| Q5 | 필압 약→강으로 긋기 | 굵기가 연속적으로 변함 |
| Q6 | 청크 경계(약 1600px 단위, 페이지 1.3장 지점)를 가로지르는 긴 세로선 | 경계에서 선 끊김·어긋남 없음 |

### 4.2 지우개 / 올가미
| # | 절차 | 합격 기준 |
|---|---|---|
| E1 | 지우개 도구로 획 근처 빈 곳 터치 | **다른 획 모양 변화 없음** |
| E2 | S-Pen 배럴 버튼 누른 채 획 문지르기 | 도구 전환 없이 지워짐 |
| E3 | 지운 후 Undo 3회 / Redo 3회 | 원래 모양 그대로 복원 |
| L1 | 줌 119% + 20페이지까지 스크롤 후 올가미로 글씨 감싸기 | 감싼 획만 선택됨 |
| L2 | 선택 후 드래그 이동 | 손 위치와 획이 함께 이동, 뗀 위치에 고정 |

### 4.3 제스처 격리 / 바이패스
| # | 절차 | 합격 기준 |
|---|---|---|
| G1 | 펜으로 필기 중 손바닥을 화면에 올림 | 화면 이동·확대 0회, 손바닥 자국 0개 |
| G2 | 펜 뗀 직후(0.5초 내) 손가락 스크롤 | 0.45초 이후엔 스크롤 정상 동작 |
| G3 | **펜으로** 좌측 페이지 목록/툴바/우측 AI 패널/탭 클릭 | 10회 중 10회 정상 반응, 선 그려지지 않음 |
| G4 | **펜으로** 용지 바깥 회색 여백 터치 | 선 안 그려짐 |
| G5 | 두 손가락 핀치 줌 중 펜 접촉 | 줌 상태 깨지지 않음 |
| G6 | 손가락으로 빠르게 스크롤 | 손글씨가 텍스트/용지와 **동시에** 움직임(뒤처짐 없음) |

### 4.4 생명주기 / 환경
| # | 절차 | 합격 기준 |
|---|---|---|
| S1 | 화면 회전 후 필기 | 위치 어긋남 없음, 기존 획 선명 |
| S2 | 홈 → 앱 복귀 후 필기 | 오버레이 정상, 획 소실 없음 |
| S3 | 탭 전환 후 복귀 | 이전 탭 획이 섞이지 않음 |
| S4 | 저장 → 앱 재시작 → 재오픈 | 모든 획 동일 위치·모양 |

---

## 5. 실기기 자동 검증 명령 (L4)

> 사용자는 태블릿을 USB 디버깅으로 연결만 하면 된다. 에이전트가 아래 명령을 준비/실행하고 결과를 해석한다.

```powershell
# 1) 빌드 & 설치
npm run android:build:apk
adb install -r android/app/build/outputs/apk/debug/app-debug.apk

# 2) 로그 수집 (네이티브 + WebView 콘솔을 하나의 타임라인으로)
adb logcat -c
adb logcat -s EduInkStylus chromium > report/stylus_log.txt

# 3) 화면 녹화 (깜빡임/뒤처짐 증거, 최대 180초)
adb shell screenrecord --bit-rate 8000000 /sdcard/stylus.mp4
adb pull /sdcard/stylus.mp4 report/

# 4) 스타일러스 이벤트 주입 (Android 12+, TOOL_TYPE_STYLUS 로 전달됨)
adb shell input stylus swipe 400 600 900 650 300
adb shell input stylus tap 120 400          # 사이드바 위치 탭 → 바이패스 검증

# 5) 원시 하드웨어 이벤트 확인 (펜/손바닥/배럴 버튼 실제 값)
adb shell getevent -lt

# 6) 프레임 지연 통계
adb shell dumpsys gfxinfo com.eduink.studio reset
#   (스크롤/필기 수행 후)
adb shell dumpsys gfxinfo com.eduink.studio
```

- **WebView 원격 디버깅**: PC Chrome에서 `chrome://inspect` → 기기 WebView 선택 → Console에서 `document.querySelectorAll('.ink-canvas-chunk')` 의 `width/height`, `devicePixelRatio` 실측. Performance 탭으로 스크롤 중 프레임 기록.
- `adb input stylus`는 압력·기울기·coalesced 샘플을 재현하지 못하므로 **라우팅/좌표 검증용**이며, 품질 검증은 L5로 보완한다.

### 5.1 네이티브 오버레이 Instrumented Test (권장)
- 위치: `android/app/src/androidTest/java/com/eduink/studio/ink/NativeInkOverlayViewTest.java`
- `MotionEvent.obtain()` + `PointerProperties.toolType = TOOL_TYPE_STYLUS / TOOL_TYPE_FINGER / TOOL_TYPE_ERASER` 로 `onTouchEvent` 호출
- 검증: FINGER → `return false`(투과), STYLUS → `return true`(소비), ACTION_UP → `onStrokeFinished` JSON 스키마 유효
- 실행: `cd android; .\gradlew.bat connectedDebugAndroidTest` (기기 연결 필요)

---

## 6. L3(실브라우저) 테스트 도입 계획 — 제안

jsdom으로는 렌더링 버그를 영원히 잡을 수 없으므로 다음을 도입할 것을 제안한다. (도입 시 별도 `REQ_` 명세 + 사용자 승인 필요)

- 도구: `@playwright/test` + Chromium (Android WebView와 엔진 동일)
- 펜 이벤트: CDP `Input.dispatchMouseEvent({ pointerType: 'pen', force })` 또는 `page.evaluate`로 실제 `PointerEvent` 생성
- 기기 에뮬레이션: `deviceScaleFactor: 2.625`, viewport 1280×800 (Galaxy Tab 해상도 근사)
- 검증 항목:
  1. **DPR 실측**: 모든 `.ink-canvas-chunk`에 대해 `canvas.width ≈ clientWidth × DPR`, `canvas.height ≈ clientHeight × DPR` (블러 방지 — CSS 높이와 비트맵 높이 비율 불일치도 함께 검출)
  2. **픽셀 스냅샷**: 획 진행 중 스크린샷 vs 커밋 후 스크린샷 차이 ≤ 1% (깜빡임/흐려짐/모양 변형)
  3. **지우개 불변**: 지우개 터치 전/후 비대상 획 영역 픽셀 동일
  4. **스크롤 정합**: 스크롤 후 같은 문서 좌표에 올가미 → 선택 성공
  5. **용지 외 바이패스**: 사이드바 좌표에 펜 클릭 → 버튼 `click` 핸들러 호출 확인
- 명령(예정): `npx playwright test e2e/stylus/`

---

## 7. 에이전트 완료 보고 규칙 (스타일러스 한정)

1. 보고 첫 줄에 **도달 검증 레벨**을 명시한다. 예: `검증: L1 ✅ L2 ✅ L3 ⏳(미도입) L5 ⏳(기기 확인 필요)`
2. L5가 필요한 요구사항은 §4에서 **관련 체크 항목 번호를 골라** 사용자에게 제시한다. (예: "Q2, Q3, Q6, E1을 기기에서 확인해주세요")
3. jsdom 테스트만으로 렌더링 품질이 "해결되었다"고 표현하지 않는다. ("로직 수정 완료, 화면 품질은 기기 확인 대기"로 표현)
4. 사용자가 ❌를 회신하면, 수정 전에 **디버그 HUD 캡처 또는 `stylus_log.txt`** 를 먼저 요청/수집하여 원인을 데이터로 특정한다. 추측 기반 재수정 금지.
5. `/report/*.md`에 체크리스트 결과표(✅/❌/빈도)를 포함한다.

---

## 8. 요구사항 → 검증 매핑 예시 (최근 이슈 기준)

| 최근 이슈 | 이전 검증 | 누락된 레벨 | 앞으로 필요한 검증 |
|---|---|---|---|
| 펜 뗀 후 깜빡임 | L2 (clearRect 호출 횟수 mock) | L4, L5 | T0~T3 전환 로그(§3.3) + Q3 |
| 지우개 터치 시 모양 변형 | L1 (곡선 명령 비교) | L3, L5 | 지우개 전/후 픽셀 비교 + E1 |
| 필기 후 저화질 | L2 (mock 캔버스 width) | L3, L5 | 청크별 DPR·CSS 비율 실측 + Q2, Q6 |
| 스크롤 시 손글씨 뒤처짐 | L2 | L4, L5 | gfxinfo + 화면녹화 + G6 |
| 펜으로 사이드바 클릭 씹힘 | L2 | L4, L5 | `adb input stylus tap` + route 로그 + G3 |
| PDF 페이지 겹침 | L2 | L3, L5 | 실제 레이아웃 좌표 측정 + PDF 문서로 Q2 |

