# EduInk Studio

교육자·학습자를 위한 하이브리드 노트 워크스페이스입니다. 마크다운 텍스트, S-Pen 벡터 필기, 말풍선 AI 주석, `[[위키링크]]`를 한 화면에서 함께 다룹니다.

## 실행

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # tsc --noEmit + vite build
npx vitest run     # 단위 테스트
```

> 로컬 파일 열기/폴더 가져오기(File System Access API)는 Chrome·Edge 에서 동작합니다. 그 외 브라우저에서는 파일 가져오기만 지원합니다.

## 화면 구성

| 영역 | 기능 |
| --- | --- |
| Header | 좌/우 사이드바 토글, 제목 실시간 입력(300ms 디바운스, 파일명 규칙 검증), 저장(Ctrl+S), `+ 첨부`(PDF·이미지·카메라·표·말풍선) |
| Toolbar | 텍스트/펜슬/형광펜/지우개/올가미, 3색 슬롯(더블클릭 시 우측 플로팅 컬러 피커), 굵기, 통합 Undo/Redo, 마우스 필기 토글 |
| Left | 폴더/노트 트리, 파일명·본문 검색, 새 노트/폴더, 드래그 이동, 우클릭 이름 변경·휴지통, 휴지통 복원/영구 삭제, 로컬 파일·폴더 가져오기, **삼성 노트 / PDF 가져오기** |
| Center | 멀티 탭(● 미저장 표시), Layer1 TipTap 에디터 / Layer2 벡터 캔버스 / Layer3 핀·말풍선·액션바·인용 배지 |
| Right | AI 온보딩(ChatGPT·Gemini·Claude BYOK), 노트 전체 문맥 채팅/요약, 모델·Elasticsearch 설정 |

## 삼성 노트 및 외부 문서 가져오기 (Import Pipeline)

왼쪽 사이드바의 **[삼성 노트 / PDF 가져오기]** 버튼으로 파일을 고르면 새 노트로 변환됩니다. 여러 파일을 한 번에 고를 수 있습니다.

| 포맷 | 처리 |
| --- | --- |
| 삼성 노트 PDF 내보내기 | `pdfjs-dist`로 페이지마다 다음을 수행 ① 텍스트 아이템 → 줄·단락·제목으로 묶어 TipTap 노드로 변환 ② 임베디드 이미지 → `attachments/`에 PNG로 분리 저장 후 이미지 노드로 삽입 ③ 벡터 패스(손글씨 획)가 많은 페이지 → **텍스트·이미지 연산을 빼고 손글씨만 렌더링**해 `inkTemplate`(캔버스 템플릿) 노드로 마운트. 그 위에 S-Pen으로 이어서 필기할 수 있음 |
| 삼성 노트 `.sdocx` | `JSZip`으로 압축 해제 → `text.json`에서 텍스트 키(text/content/body…)를 재귀 수집, 없으면 `document.xml`의 단락 요소에서 추출 → 마크다운으로 변환. 패키지 안의 이미지(썸네일 제외)는 `attachments/`에 자동 복사하고 `![](attachments/...)` 인라인 링크로 연결 |

pdf.js는 가져오기를 실행할 때만 동적으로 불러오므로 초기 로딩 크기에 영향이 없습니다. 가져오기에 실패하면 그 사이 저장된 첨부 파일을 바로 정리합니다.

## 디렉터리

```
src/core        순수 로직 (geometry, history, strokes, codec, bubble limits, validation) + 단위 테스트
src/editor      TipTap 확장 (historyBridge, blockId, wikiLink, math, annotation, media)
src/canvas      InkCanvas (포인터 입력·렌더링), perfect-freehand 렌더러
src/session     NoteSession: 탭별 에디터+스트로크+주석+히스토리, 저장/파일 감시
src/search      Web Worker (Elasticsearch → MiniSearch BM25 폴백)
src/ai          Vercel AI SDK 멀티 프로바이더 스트리밍
src/storage     Dexie(IndexedDB), OPFS 첨부, 로컬 파일, 임시 저장, 키 암호화
src/features    import(삼성 노트 PDF/.sdocx), annotations, lasso, tab actions
src/components  UI
```

## 검증

- `npx vitest run`: 단위 테스트 47개 — Ray-Casting/이동 변환, 텍스트→펜→지우개→Undo×3→Redo×3 (모델 단위 + 실제 ProseMirror 트랜잭션), CP949/UTF-8 왕복 및 저장 거부, 말풍선 5회/2,500자 제한, 파일명/이미지 규칙, 마크다운 위키링크·수식·표 직렬화, PDF 텍스트→단락/제목·연산자 분류·손글씨 판정, `.sdocx` 압축 해제·text.json/document.xml 추출·미디어 링크.
- 헤드리스 Chrome(CDP) E2E 24개 항목 통과: 펜 포인터 필기, 통합 Undo/Redo, 올가미 액션바, 컬러 피커 위치·색 교체, 사이드바 토글 좌표계, `[[` 자동완성·호버 미리보기·더블클릭 탭 이동, 링크 생성 직후 타이핑(Non-blocking, 약 8ms), 인용 추천 배지, 말풍선 핀 최소화/복원, 재시작 시 탭 복원, beforeunload 확인, 활성 탭 닫기(화면 유지·예외 0건).
- 가져오기 E2E 10개 항목 통과: 삼성 노트 PDF(텍스트→제목·단락, 손글씨 템플릿, 이미지 분리, 템플릿 위 필기), `.sdocx`(text.json 텍스트, 미디어 → attachments 링크, 저장된 마크다운의 `![](attachments/...)`), 미지원 형식 안내.

## 자율 판단 기록 (결정 — 이유 — 틀렸을 때의 영향)

| 결정 | 이유 | 틀렸을 때의 영향 |
| --- | --- | --- |
| 필기 좌표를 **중앙 고정폭(840px) 페이지 기준**으로 저장하고, 캔버스는 뷰포트 크기로 두어 매 프레임 페이지 오프셋(스크롤 포함)만큼 이동해 그림 | 사이드바를 열고 닫아도, 스크롤해도 텍스트 위 필기가 어긋나지 않음. 캔버스가 긴 문서 높이만큼 커지지 않아 메모리 사용이 적음 | 창이 840px보다 좁으면 가로 스크롤이 생김. 반응형 리플로우가 필요하면 좌표를 블록 기준으로 앵커링해야 함 |
| 히스토리를 **탭(노트)별** `CompositeHistoryManager`로 둠 | 한 노트 안의 텍스트·필기 변경을 시간순으로 통합하고, 다른 탭의 Undo가 섞이지 않게 함 | 앱 전체에 걸친 단일 Undo가 필요하면 매니저를 전역으로 올려야 함 (API는 같음) |
| 600ms 안의 연속 타이핑은 Undo 명령 하나로 병합 | 한 글자씩 Undo되는 불편을 막음 (일반 에디터와 같은 방식) | 병합 단위가 크다고 느끼면 `GROUP_MS`만 조정하면 됨 |
| 블록 ID 부여 트랜잭션은 히스토리에 기록하지 않음 | 속성만 바꾸는 단계라 위치가 바뀌지 않아 역변환과 충돌하지 않음 | 블록을 Redo하면 새 ID가 부여되어 그 블록을 가리키던 위키링크는 문서 맨 위로 열림 |
| 노트의 진실 원본은 Dexie에 저장한 TipTap JSON, 마크다운은 내보내기·로컬 파일용 | 주석 마크·블록 ID·수식 노드를 잃지 않음 | 로컬 `.md`에는 주석 위치·블록 ID가 남지 않음 (주석 데이터는 노트 메타데이터에만 저장) |
| `chokidar` 대신 **File System Access 핸들 2초 폴링** | 브라우저에서는 chokidar(Node)를 쓸 수 없음. 폴더 가져오기 시 `node_modules, .git …` 제외 규칙은 그대로 적용 | 데스크톱(Electron 등)으로 옮기면 chokidar로 교체해야 함. 권한이 만료된 핸들은 감시를 조용히 건너뜀 |
| 인코딩: `iconv-lite` + `buffer` 폴리필, 비표현 문자는 왕복 비교로 검출 | Node 테스트와 브라우저에서 같은 CP949(UHC) 동작 보장 (Node의 TextDecoder `euc-kr`은 UHC 확장을 지원하지 않음) | 번들 크기가 약 150KB 늘어남 |
| 휴지통은 OS 휴지통이 아닌 **앱 내 휴지통**(deletedAt) | 웹 환경에서는 OS 휴지통 API를 쓸 수 없음. 복원과 영구 삭제를 지원 | 로컬 원본 파일은 삭제되지 않음 (트리에서만 제거) |
| 지우개는 **스트로크 단위 삭제** (분할하지 않음) | 명세가 "삭제 또는 분할"을 허용함. 구현이 단순하고 Undo도 확실함 | 부분 지우기가 필요하면 분할 로직을 추가해야 함 |
| PDF는 OPFS에 저장한 뒤 **임베디드 뷰어(iframe)** 로 삽입 | pdf.js 페이지 배경 렌더링은 범위·번들 부담이 큼 | PDF 페이지 위에 직접 필기하는 기능은 아직 없음 |
| OAuth 로그인은 비활성(준비 중), **API Key(BYOK)** 만 지원. 키는 추출 불가능한 AES-GCM 키로 암호화해 IndexedDB에 저장 | OAuth는 각 서비스에 앱을 등록해야 함 | 키는 브라우저에서 해당 AI API로 직접 전송됨 (Anthropic은 직접 호출 허용 헤더 사용) |
| Elasticsearch 미설정·실패 시 Worker 내 MiniSearch(BM25 + 한글 2-gram)로 폴백, 현재 노트는 결과에서 제외 | 오프라인에서도 동작하고 조사가 붙은 한국어 어절도 매칭됨 | ES 매핑에 `noteId.keyword`가 있다고 가정함 |
| 롱프레스·우클릭 메뉴를 같은 컴포넌트로 처리하고 700ms 안의 중복 호출은 무시 | 터치 롱프레스 시 브라우저의 contextmenu 이벤트와 겹치지 않게 함 | — |
| 데스크톱 테스트용 **"마우스 필기" 토글** 추가 | S-Pen이 없는 환경에서도 필기 기능을 확인할 수 있게 함 | 기본값은 OFF라 명세대로 펜만 필기함 |
| 이미지 붙여넣기는 OPFS `notes/<id>/images/YYYYMMDD-HHmmss-n.ext`에 저장 | 로컬 파일 옆 폴더에 쓰려면 디렉터리 권한이 필요함 | 로컬 `.md`를 다른 편집기로 열면 이미지 상대 경로가 깨짐 |
| **손글씨 페이지 판정**: 벡터 패스 연산이 12개 이상인 PDF 페이지 | 삼성 노트 PDF는 펜 획마다 패스를 만들기 때문. 텍스트만 있는 페이지는 템플릿을 만들지 않아 문서가 가벼움 | 표 테두리·도형이 많은 일반 PDF도 손글씨 페이지로 판정될 수 있음 (`HANDWRITING_PATH_THRESHOLD`로 조정) |
| **캔버스 템플릿을 문서 흐름 안의 블록 노드(`inkTemplate`)** 로 마운트 | 앞뒤 텍스트와의 상대 위치가 유지되고, Layer 2 잉크 캔버스가 그대로 위에 겹쳐 필기할 수 있음 | 템플릿 앞에 텍스트를 추가하면 템플릿은 함께 내려가지만, 그 위에 그린 잉크 스트로크(페이지 절대 좌표)는 따라 내려가지 않음 |
| 템플릿은 텍스트·이미지를 **제외하고** 렌더링 (`operationsFilter`) | 텍스트는 편집 가능한 마크다운으로, 이미지는 첨부로 이미 분리했으므로 중복 표시 방지 | 텍스트를 손글씨 위치 옆에서 함께 보고 싶다면 원본 PDF를 `+ 첨부 → PDF`로 함께 삽입해야 함 |
| `.sdocx`: `text.json` 우선, 없을 때만 `document.xml` 사용. 미디어는 본문 끝에 링크 | 두 파일에 같은 텍스트가 중복 저장되는 경우가 있음. 실제 `.sdocx` 내부 구조는 비공개라 명세에 적힌 두 엔트리를 기준으로 함 | 버전에 따라 텍스트가 다른 엔트리(바이너리 페이지 파일)에만 있으면 텍스트 없이 미디어만 가져옴 (안내 메시지 표시) |
| 템플릿 렌더링 배경은 흰색 + CSS `mix-blend-mode: multiply` | pdf.js는 불투명 캔버스로 그려서 투명 배경이 검게 나옴 | — |
