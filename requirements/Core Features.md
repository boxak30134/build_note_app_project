# Core Features

## 1. Layout Architecture

- **Header**: `[☰ Left Toggle] [Title Input (300ms debounce)] [+ Attach Menu] [🤖 Right Toggle]`
- **Toolbar**: `[Pencil][Highlighter][Eraser][Lasso] | [🔴 #EF4444][🟡 #FACC15][⚫ #000000] | [↶ Undo][↷ Redo]`
- **3-Pane Workspace**:
  - `Left Sidebar`: 폴더/노트 트리, 키워드 필터, 생성/휴지통 삭제 (Toggle/Resize)
  - `Center (Multi-Tab)`:
    - **Layer 3**: Floating Pins (`💬`) & Popovers
    - **Layer 2**: Transparent Vector S-Pen Canvas
    - **Layer 1**: TipTap Markdown & $\text{KaTeX}$ Editor
  - `Right Sidebar`: AI 에이전트 온보딩(BYOK) 및 전체 문맥 채팅 (Toggle/Resize)

---

## 2. Core Feature Specifications

### 2.1 Header & Attach (`+`) Menu

- `+` 드롭다운 5종 삽입 (현재 커서/캔버스 위치):
  1. `PDF`: OPFS 저장 후 페이지별 캔버스 배경/뷰어 마운트
  2. `이미지`: 로컬 파일 선택 또는 Drag & Drop
  3. `카메라`: Capacitor Camera (웹: `getUserMedia`) 촬영 즉시 이미지 노드 삽입
  4. `표`: TipTap $3 \times 3$ 기본 테이블 삽입
  5. `말풍선`: 선택 영역에 인라인 말풍선 주석 즉시 생성

### 2.2 Toolbar & Drawing Engine

- **Pens**:
  - `Pencil`: `e.pressure` 비례 불투명 벡터 패스
  - `Highlighter`: `opacity: 0.35`, `mix-blend-mode: multiply`, 사각 끝단
  - `Eraser`: 교차 벡터 스트로크 감지 후 삭제/분할
  - `Lasso (올가미)`:
    - **Ray-Casting (`pointInPolygon`)** 으로 다각형 내부 스트로크 판별
    - 선택 AABB 점선 테두리 + 액션 바(`[이동][복사][잘라내기][삭제][💬 말풍선]`)
    - `[이동]`: 펜 드래그 시 `requestAnimationFrame`으로 선택 스트로크 좌표에 $(\Delta x, \Delta y)$ 실시간 가산
- **3-Slot Color Picker**:
  - 기본값: `#EF4444`, `#FACC15`, `#000000`
  - `onClick`: 색상 즉시 선택 | `onDoubleClick`: 우측(`placement: 'right-start'`) HEX/RGB 팝오버로 슬롯 색상 영구 변경
- **Unified Undo/Redo (`CompositeHistoryManager`)**:
  - TipTap 기본 `history` 비활성화. ProseMirror `onTransaction` 역변환 Step과 캔버스 Stroke 변이를 단일 스택으로 통합:

```typescript
export type HistoryCommand = {
  id: string;
  type: 'editor-tr' | 'stroke-add' | 'stroke-remove' | 'stroke-move' | 'stroke-batch';
  timestamp: number;
  undo: () => void;
  redo: () => void;
};
```

### 2.3 Hybrid Workspace & WikiLink

- **Input Routing & Sync**: `e.pointerType === 'pen'` $\rightarrow$ Layer 2 Canvas 필기 | `'touch'` $\rightarrow$ 스크롤/줌 | 마우스·키보드 $\rightarrow$ Layer 1 TipTap. 에디터 `scrollTop`과 캔버스 오프셋 실시간 동기화.
- **Multi-Tab**: 탭 전환 시 에디터 상태, 스트로크 배열, 스크롤 위치 메모리 보존.
- **Long-Press Menu**: $500\text{ms}$ 이상, 반경 $5\text{px}$ 이내 유지 시 `navigator.vibrate(20)` 후 우클릭 메뉴(복사/붙여넣기/말풍선/링크 생성) 호출.
- **WikiLink (`[[]]`)**:
  - `[[` 입력 시 노트 제목·단락 실시간 검색 팝오버 호출 $\rightarrow$ `<WikiLink targetDocId="..." targetBlockId="..." />` 변환.
  - `onPointerEnter`: `@floating-ui/react` 툴팁으로 타깃 단락 스니펫(최대 300자) 표시.
  - `onDoubleClick`: 해당 문서 탭 열기/활성화 후 타깃 단락 스크롤 이동.
- **Async Auto-Link (Non-blocking)**:
  - 텍스트 드래그 후 `[링크 생성]` 클릭 시 **Web Worker** 내 Elasticsearch로 비동기 검색 전송(메인 스레드 블로킹 0, 미니 스피너 표시).
  - 완료 시 추천 배지 활성화 $\rightarrow$ 클릭 시 말풍선 인용(Citation) 또는 위키링크 병합.

### 2.4 Speech Bubble Annotations (`💬`)

- **Target**: 드래그 텍스트 또는 올가미 선택 영역.
- **Minimize/Restore**: 저장 또는 외부 클릭 시 말풍선 언마운트(가상화) 및 앵커 우상단 핀(`💬`)만 유지. 핀 클릭 시 팝오버 복원.
- **In-Bubble AI**: 내부에 `[AI에게 질문]`, 입력창, 미니 파일 첨부 내장. 타깃 원문(또는 올가미 캡처 Base64 이미지) 자동 컨텍스트 주입 후 스트리밍 답변을 **Editable Markdown 필드**에 기록.
- **Guardrails (STRICT)**:
  - `MAX_AI_TURNS_PER_BUBBLE = 5`: 5회 도달 시 입력 비활성화 및 `"말풍선 당 AI 질문은 최대 5회까지 가능합니다."` 출력.
  - `MAX_BUBBLE_CHAR_LENGTH = 2500`, 단일 답변 `maxOutputTokens: 600~800`, 컨테이너 `max-height: 280px; overflow-y: auto`.

### 2.5 Sidebars & Samsung Note Import

- **Right Sidebar (BYOK)**: 최초 실행 시 `Gemini`, `Claude`, `ChatGPT` 선택 카드 노출. API Key는 Web Crypto(`AES-GCM`) 또는 Capacitor Secure Storage 암호화 저장.
- **Import Pipeline**:
  1. `Samsung Note (PDF)`: `pdfjs-dist`로 텍스트(TipTap 마크다운 변환)와 손글씨 페이지(캔버스 템플릿 레이어) 분리 마운트.
  2. `Samsung Note (.sdocx)`: `JSZip` 압축 해제 $\rightarrow$ `document.xml`/`text.json` 마크다운 변환, 미디어는 `attachments/` 복사 후 `![](...)` 연결.