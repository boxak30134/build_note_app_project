# TOKEN_OPTIMIZATION_GUIDE.md: LLM 토큰 소비 최소화 및 비용 효율화 지침서

본 문서는 EduInk Studio / Shema 프로젝트 내 Gemini API 및 대형 언어 모델(LLM) 연동 시, 프롬프트 길이와 응답 토큰을 체계적으로 감축하여 **API 비용 절감, 응답 속도(Latency) 단축, 컨텍스트 윈도우 보존**을 달성하기 위한 실전 개발 지침서입니다.

---

## 1. 토큰 누수 진단: 주요 원인 분석

1. **전체 대화 히스토리 무차별 누적**:
   * 멀티턴 대화가 길어질수록 이전 질문/답변 전체가 누적 전송되어 $O(N^2)$ 형태로 토큰이 급증함.
2. **비구조화된 시스템 프롬프트(System Instruction)**:
   * 중복된 어조 지시, 과도한 예시(Few-shot), 불필요한 서술형 규칙 나열.
3. **노트/문서 컨텍스트 통째 주입**:
   * 현재 편집 중인 수만 자의 마크다운 전체 또는 전체 필기 획 데이터를 가공 없이 프롬프트에 첨부.
4. **장황한 모델 응답(Verbose Output)**:
   * 모델이 질문 복창, 장황한 서론/결론 인사말, 불필요한 설명을 덧붙여 출력 토큰을 낭비.

---

## 2. 토큰 절감 5대 핵심 아키텍처

### 2.1 슬라이딩 윈도우 & 대화 압축 (Sliding Window & Summarization)

* **최근 $K$개 턴만 전송**:
  * 기본적으로 최근 3~5개 대화 턴(`user` / `model` 쌍)만 유지하고, 이전 턴은 컨텍스트에서 제외합니다.
* **대화 요약 압축 (Rolling Summary)**:
  * 대화가 6턴을 초과하면 이전 내용을 $1 \sim 2$문장의 핵심 요약문(Summary State)으로 압축하여 시스템 메시지 영역에 단일 주입합니다.

```typescript
// 대화 히스토리 슬라이딩 윈도우 예시 (최근 4개 메시지만 전송)
const MAX_HISTORY_TURNS = 4;
const prunedHistory = conversationHistory.slice(-MAX_HISTORY_TURNS);
```

### 2.2 검색 기반 컨텍스트 주입 (RAG & Chunking)

* **전체 문서 전송 금지**:
  * 문서 전체를 프롬프트에 넣지 않고, 사용자의 현재 커서 위치 주변 단락(Paragraph) 또는 질문과 코사인 유사도가 높은 상위 2~3개 청크(Chunk, 300~500자 단위)만 선택 주입합니다.
* **필기 스트로크 좌표 전송 금지**:
  * 수천 개의 $(x, y)$ 좌표 배열을 LLM에 직접 전송하지 않고, 캔버스 이미지를 필요한 크기로 크롭하여 압축된 저용량 이미지(JPEG/WebP) 단일 파트로 전송하거나 텍스트 OCR 결과만 전달합니다.

### 2.3 시스템 프롬프트 압축 기법

* **압축된 마크다운/불릿 규칙 활용**:
  * 자연어 줄글 대신 키워드 중심의 마크다운 불릿을 사용하여 동일한 지시 효과를 내면서 토큰을 $40\%$ 이상 절감합니다.

**Bad (비효율적 - 82 토큰):**
> 당신은 친절하고 똑똑한 수학교육 전문 보조교사입니다. 학생이 수학 문제를 물어보면 자세하게 단계별로 설명해 주시고, 절대로 정답을 먼저 말하지 말고 유도 질문을 해주세요. 답변은 한국어로 정중하게 해주시기 바랍니다.

**Good (최적화 - 38 토큰):**
> Role: Math Tutor.
> - Hint-first (Socratic method); never give direct answers.
> - Step-by-step guidance.
> - Tone: Polite Korean. Conciseness is priority.

### 2.4 출력 토큰(Max Output Tokens) 및 형식 통제

* **`maxOutputTokens` 하드 리밋 설정**:
  * 의도치 않은 환각이나 장황한 답변으로 인한 토큰 폭증을 방지하기 위해 작업 유형별로 상한선을 설정합니다.
  * 예: 개념 질의($800$), 수식 변환($200$), 요약/키워드 추출($150$).
* **불필요한 인사말 차단 지시**:
  * 시스템 프롬프트에 "서론 및 맺음말 생략, 본론만 즉시 답변(No pleasantries, direct answer only)"을 명시하여 매 응답마다 $30 \sim 50$ 토큰을 절약합니다.

### 2.5 구조화된 출력 (Structured Outputs / JSON Schema)

* 마크다운 자유 텍스트 대신 `responseSchema`를 사용하여 정확히 필요한 필드만 JSON 형태로 반환받음으로써 파싱 오류 및 장황한 부가 설명을 원천 차단합니다.

---

## 3. 코드 구현 패턴 (Gemini SDK 최적화 적용)

```typescript
import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI();

export async function askOptimizedTutor(
  userQuery: string,
  relevantContextChunk: string, // 전체 문서 대신 좁혀진 청크만 전달
  recentHistory: { role: 'user' | 'model'; text: string }[]
) {
  // 1. 최소화된 시스템 인스트럭션
  const systemInstruction = `
Role: High-school Math Assistant.
Rules:
- Concise, pedagogical hints only.
- Output KaTeX enclosed in $ or $$.
- No greetings or sign-offs.
`.trim();

  // 2. 프롬프트 페이로드 조립 (히스토리 슬라이딩 윈도우 적용)
  const contents = [
    ...recentHistory.slice(-4).map(h => ({
      role: h.role,
      parts: [{ text: h.text }]
    })),
    {
      role: 'user',
      parts: [
        { text: `[Context: ${relevantContextChunk}]\nQuestion: ${userQuery}` }
      ]
    }
  ];

  // 3. 토큰 상한 및 모델 파라미터 제어
  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash', // 가볍고 빠른 Flash 계열 모델 권장
    contents,
    config: {
      systemInstruction,
      maxOutputTokens: 600, // 토큰 상한
      temperature: 0.2,     // 결정론적이고 간결한 답변 유도
    }
  });

  return response.text;
}
```

---

## 4. 토큰 모니터링 및 검증 체크리스트

- [ ] **히스토리 상한 확인**: 4~5턴 이상 지난 오래된 대화가 누적되지 않고 슬라이딩/제거되는가?
- [ ] **컨텍스트 청킹**: 전체 마크다운 파일 대신 질문과 연관된 특정 단락만 프롬프트에 주입하는가?
- [ ] **원시 좌표 전송 차단**: 펜 획(Stroke) 좌표 배열을 텍스트로 직렬화하여 프롬프트에 보내고 있지 않은가?
- [ ] **출력 제약**: `maxOutputTokens`가 설정되어 과도한 길이의 응답 생성을 차단하는가?
- [ ] **서론/결론 제거**: 불필요한 "안녕하세요! 좋은 질문입니다..." 류의 래퍼 텍스트가 생략되는가?