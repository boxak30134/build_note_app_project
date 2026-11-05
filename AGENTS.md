# AGENTS.md: EduInk Studio Specification

## 0. Agent Token & Execution Guardrails (STRICT)
- **Output Format**: 인사말·서론·요약 생략. 50줄 이상 파일 전체 재작성 금지(수정 함수/Diff 블록만 출력). 코드 뒤 설명은 한국어 불릿 3개 이내로 제한.
- **Context Boundary**: `node_modules/`, `dist/`, `build/`, `out/`, `.git/`, `*.log`, `*.sdocx`, `package-lock.json` 열람·인덱싱 금지. 명시적 지시 없이 작업 대상 기준 2-hop 이상 파일 탐색 금지.
- **Autonomous Decision**: 미명시 세부 구현은 자율 판단 후 작업 보고서에 `[결정 — 이유 — 영향]` 1줄 기록.

---

## 1. Tech Stack
- **Core**: `React 19`, `Vite 6`, `TypeScript 5.x` (strict, `type` alias 선호, `any` 금지)
- **Mobile/Native**: `@capacitor/core`, `@capacitor/filesystem`, `@capacitor/camera`
- **UI/Style**: `Tailwind CSS` (inline only), `framer-motion`, `lucide-react`, `@floating-ui/react`
- **Editor**: `@tiptap/react`, `@tiptap/starter-kit`, `@tiptap/suggestion`, `@tiptap/extension-table`, `katex`
- **Canvas**: `HTML5 2D Canvas`, `perfect-freehand` (pressure $0.0 \sim 1.0$)
- **State/Storage**: `zustand`, `immer`, `dexie` (IndexedDB), `OPFS`
- **File/Import**: `iconv-lite`, `chokidar`, `pdfjs-dist`, `JSZip`
- **Search**: `OfflineDocumentLinker` (순수 TS 기반 $\LaTeX$ 수식·한국어 조사 제거·2-gram 하이브리드 토크나이저, BM25 + TF-IDF 코사인 유사도 $< 10\text{ms}$) + `Elasticsearch REST API` & `Web Worker` (`MiniSearch` BM25 폴백)
- **AI**: `@google/genai` (기본 `gemini-3.8-flash`), `ai` (Vercel AI SDK: Google/Anthropic/OpenAI BYOK)
- **Test**: `vitest`, `@testing-library/react`

---

## 2. Layout Architecture
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

## 3. Core Feature Specifications

### 3.1 Header & Attach (`+`) Menu
- `+` 드롭다운 5종 삽입 (현재 커서/캔버스 위치):
  1. `PDF`: OPFS 저장 후 페이지별 캔버스 배경/뷰어 마운트
  2. `이미지`: 로컬 파일 선택 또는 Drag & Drop
  3. `카메라`: Capacitor Camera (웹: `getUserMedia`) 촬영 즉시 이미지 노드 삽입
  4. `표`: TipTap $3 \times 3$ 기본 테이블 삽입
  5. `말풍선`: 선택 영역에 인라인 말풍선 주석 즉시 생성

### 3.2 Toolbar & Drawing Engine
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

### 3.3 Hybrid Workspace & WikiLink
- **Input Routing & Sync**: `e.pointerType === 'pen'` $\rightarrow$ Layer 2 Canvas 필기 | `'touch'` $\rightarrow$ 스크롤/줌 | 마우스·키보드 $\rightarrow$ Layer 1 TipTap. 에디터 `scrollTop`과 캔버스 오프셋 실시간 동기화.
- **Multi-Tab**: 탭 전환 시 에디터 상태, 스트로크 배열, 스크롤 위치 메모리 보존.
- **Long-Press Menu**: $500\text{ms}$ 이상, 반경 $5\text{px}$ 이내 유지 시 `navigator.vibrate(20)` 후 우클릭 메뉴(복사/붙여넣기/말풍선/링크 생성) 호출.
- **WikiLink (`[[]]`)**:
  - `[[` 입력 시 노트 제목·단락 실시간 검색 팝오버 호출 $\rightarrow$ `<WikiLink targetDocId="..." targetBlockId="..." />` 변환.
  - `onPointerEnter`: `@floating-ui/react` 툴팁으로 타깃 단락 스니펫(최대 300자) 표시.
  - `onDoubleClick`: 해당 문서 탭 열기/활성화 후 타깃 단락 스크롤 이동.
- **Async Auto-Link & Offline Document Linker (`src/services/offlineDocumentLinker.ts`)**:
  - 텍스트 드래그 후 `[🔗 문서 연결]` 클릭 시 `OfflineDocumentLinker.recommendBySelection()`으로 $10\text{ms}$ 이내에 상위 5개 연관 문서를 드롭다운 표시 $\rightarrow$ 선택 시 `[[문서제목|선택 구절]]` 위키링크 즉시 치환.
  - 텍스트 드래그 후 `[링크 생성]` 클릭 시 **Web Worker** 내 Elasticsearch/MiniSearch로 비동기 검색 전송(메인 스레드 블로킹 0, 미니 스피너 표시) $\rightarrow$ 완료 시 추천 배지 활성화 $\rightarrow$ 말풍선 인용(Citation) 또는 위키링크 병합.
  - 노트 저장 또는 편집 $1000\text{ms}$ 디바운스 시 `recommendSimilarDocuments()`(TF-IDF 코사인 유사도 + `#태그` Jaccard + 명시적 위키링크 보너스)로 우측 하단 `연관 노트(Related Notes)` 패널 자동 갱신.

### 3.4 Speech Bubble Annotations (`💬`)
- **Target**: 드래그 텍스트 또는 올가미 선택 영역.
- **Minimize/Restore**: 저장 또는 외부 클릭 시 말풍선 언마운트(가상화) 및 앵커 우상단 핀(`💬`)만 유지. 핀 클릭 시 팝오버 복원.
- **In-Bubble AI**: 내부에 `[AI에게 질문]`, 입력창, 미니 파일 첨부 내장. 타깃 원문(또는 올가미 캡처 Base64 이미지) 자동 컨텍스트 주입 후 스트리밍 답변을 **Editable Markdown 필드**에 기록.
- **Guardrails (STRICT)**:
  - `MAX_AI_TURNS_PER_BUBBLE = 5`: 5회 도달 시 입력 비활성화 및 `"말풍선 당 AI 질문은 최대 5회까지 가능합니다."` 출력.
  - `MAX_BUBBLE_CHAR_LENGTH = 2500`, 단일 답변 `maxOutputTokens: 600~800`, 컨테이너 `max-height: 280px; overflow-y: auto`.

### 3.5 Sidebars & Samsung Note Import
- **Right Sidebar (BYOK)**: 최초 실행 시 `Gemini`, `Claude`, `ChatGPT` 선택 카드 노출. API Key는 Web Crypto(`AES-GCM`) 또는 Capacitor Secure Storage 암호화 저장.
- **Import Pipeline**:
  1. `Samsung Note (PDF)`: `pdfjs-dist`로 텍스트(TipTap 마크다운 변환)와 손글씨 페이지(캔버스 템플릿 레이어) 분리 마운트.
  2. `Samsung Note (.sdocx)`: `JSZip` 압축 해제 $\rightarrow$ `document.xml`/`text.json` 마크다운 변환, 미디어는 `attachments/` 복사 후 `![](...)` 연결.

---

## 4. Storage & File Integrity
- **Encoding (`textCodec`)**: 열기 시 `UTF-8`, `UTF-8 BOM`, `CP949` 및 줄바꿈(`CRLF`/`LF`) 자동 감지 후 저장 시 100% 동일 유지. `CP949` 미지원 유니코드 포함 시 저장 거부 및 위치·문자 토스트/모달 경고. 새 파일 기본값은 `UTF-8(No BOM)`.
- **Normalization & Dirty Check**: 저장/전환 직전 에디터 `getMarkdown()` 직접 호출. 마운트 직후 최초 직렬화 값을 `Clean` 기준점으로 설정. 미저장 탭은 `●` 표시 및 `beforeunload`/탭 닫기 시 한국어 확인창 호출. 재시작 시 `openDocTabs` 복원.
- **File Watcher (`chokidar`)**:
  - 외부 수정 시: `Clean` 탭은 무음 리로드, `Dirty` 탭은 `[디스크 내용으로 다시 불러오기] / [내 편집 내용 유지]` 배너 노출. 외부 삭제 시 읽기 전용 전환 및 배너 알림.
  - 감시 제외: `node_modules, target, .git, dist, build, .gradle, .idea, out, .next, .venv, __pycache__`
- **File Security**: 삭제는 OS 휴지통(`trashItem`/Recycle Bin) 이동. 파일명 금지 규칙: 빈 이름, `.`, `..`, `\ / < > : " | ? *`, 제어문자, 끝 공백/점 거부.
- **Images**: 에디터 `Ctrl+V` 시 클립보드에 텍스트+이미지 공존 시 **텍스트 우선**. 이미지는 `images/YYYYMMDD-HHmmss-n.png` 저장 후 상대 링크 삽입. 장당 최대 $20\text{MB}$, 1회 최대 10장, 허용: `png, jpg, jpeg, gif, webp` (실패 시 임시 파일 즉시 삭제).
- **Persistence**: 미제출 입력 텍스트는 `drafts[tabId]`에, UI 설정(`paneWidths`, 3색 슬롯 등)은 `localStorage`에 즉시 영속화.

---

## 5. Gemini Academic Tutor Module (`src/modules/ai/`)
- **Config**: SDK `@google/genai`, 모델 `gemini-3.8-flash` (폴백 `gemini-2.5-flash`), `generateContentStream` 필수(TTFT $< 1\text{s}$).
- **Params**: `temperature: 1.0` 고정, `thinkingConfig: { thinkingLevel: "low" }`, `maxOutputTokens`: 말풍선 `800` / 사이드바 `1500`. 키 우선순위: `import.meta.env.VITE_GEMINI_API_KEY` $\rightarrow$ 로컬 암호화 키.
- **Payload Optimization**:
  - 말풍선 질문: `Target Focus`(선택 문장) + `Surrounding Context`(앞뒤 1단락, 최대 1,000자 클리핑).
  - 손글씨 수식 HTR(Base64): `"이 손글씨 수식을 KaTeX 호환 LaTeX 수식($ 또는 $$)으로 변환하라. 설명 문구 없이 순수 LaTeX 코드만 출력하라."`
- **Error Handling**: `429 Rate Limit` 시 10초 지수 백오프 재시도 토스트. $\text{KaTeX}$ `ParseError` 시 `<code>` 모노스페이스 원문 폴백.
- **System Instruction (`systemInstruction` 필수 주입)**:
```text
너는 대학 학부 전공생(수학, 수리과학, 컴퓨터과학, 공학 등)을 지원하는 엄밀하고 간결한 학술 튜터이다.
1. 학술적 엄밀성: 학부 전공 과정에 부합하는 정의(Definition), 정리(Theorem), 증명 스케치(Proof Idea), 반례(Counterexample)를 제공한다. 첫 문장에 직관적 결론(두괄식)을 제시하고 논리적 비약 없이 핵심 보조정리(Lemma)와 가정을 명시한다.
2. KaTeX 무결성: 인라인 수식은 $...$, 블록 수식은 $$...$$로 감싼다. 유니코드 기호(≤, ≥, ×, ÷, ℝ, ℂ, ℤ, ∈, ∀, ∃ 등) 출력 금지, 순수 LaTeX(\le, \ge, \times, \div, \mathbb{R}, \mathbb{C}, \mathbb{Z}, \in, \forall, \exists)만 사용한다. 한국어 조사 앞에는 공백을 둔다(예: $x$ 는). 블록 수식 내 정렬은 \begin{aligned} ... \end{aligned}를 사용한다.
3. 서식 제약: 인사말·미사여구를 완전히 배제하고 즉시 본론으로 들어간다. 단락은 2~3문장 이내로 끊고 글머리 기호(-, *)와 번호를 활용한다.
```

---

## 6. Git & Workflow Rules
- **Branch & Approval**: `main`은 항상 빌드/테스트 통과 유지. 작업은 `feature/<name>` 브랜치에서 수행. **`main` 병합, 원격 Push, 파일 삭제는 사용자 사전 승인 필수.**
- **Atomic Commits**: 수정 시마다 `npm run build && npx vitest run` 검증 후 커밋. 태그: `feat:`, `fix:`, `refactor:`, `docs:` + 마지막 줄 `Co-Authored-By` 서명.
- **Line Endings & Ignore**: 소스 줄바꿈 `CRLF` 유지(`git core.autocrlf=true`). `.gitignore`: `node_modules/`, `dist/`, `out/`, `*.log`, `.superpowers/`, `.obsidian/`, `.env*`, `CLAUDE.md`, `image-*.png`.

---

## 7. Milestones & Verification
- **Milestones**:
  - `M1`: Vite+React 19+TS+Tailwind 셋업, 3-Pane 레이아웃, 헤더/첨부 UI, `zustand` 멀티탭 스토어
  - `M2`: TipTap($\text{KaTeX}$, 표, 이미지), `[[]]` 위키링크, `textCodec`(CP949/UTF-8), `chokidar` 배너, 삼성 노트 임포트
  - `M3`: S-Pen Canvas, 4종 툴(Ray-Casting 올가미), 3색 피커, $500\text{ms}$ 롱프레스 메뉴
  - `M4`: `CompositeHistoryManager` 통합 Undo/Redo 및 단위 테스트
  - `M5`: 우측 AI 온보딩, `gemini-3.8-flash` 스트리밍 모듈, 인라인 말풍선(`💬`, 5턴/2,500자 가드레일)
  - `M6`: Web Worker + Elasticsearch 논블로킹 자동 링크 및 인용 말풍선
- **Required Tests (`npx vitest run`)**:
  1. 올가미 `pointInPolygon` 판별 및 $(\Delta x, \Delta y)$ 이동 변환
  2. 텍스트 입력 $\rightarrow$ 펜 필기 $\rightarrow$ 지우개 $\rightarrow$ Undo 3회 $\rightarrow$ Redo 3회 상태 복원
  3. `CP949`/`UTF-8` 왕복 인코딩 및 미지원 문자 저장 차단
  4. 말풍선 AI 질문 5회 초과 차단 및 2,500자 초과 제한 검증



## Report

- Report
  - 명령어에 대한 모든 프로세스가 finished 상태가 되었을 때, report를 생성
  - report 이름은 `YYYYMMdd_(구현한 기능 이름)_(시퀀스숫자)` 형식
  - report 내용은 현 작업으로 변경된 사항, 테스트 내용, 주의점, 향후 변경 필요 사항 등을 포함.
  - `/report` 폴더에 저장한다. 이 폴더는 git에 반영하지 않음.
  - `/requirments` 에 있는 .md 파일의 추가사항, 또는 추가 요구사항 과 같은 내용을 구현을 끝마친 뒤에는 이 추가 요구사항을 해당 문서내의 기존에 있던 요구사항 리스트의 맨 밑으로 이동시킨다. 그리고 요구사항의 표현들을 정교화시킨다.



### Token Optimization

토큰 사용량을 최적화하기 위한 요구사항. 

token_optimization_guide.md 파일을 참고한다.