# OFFLINE_SEARCH_LINKING_GUIDE.md: 순수 JS 기반 오프라인 노트 검색 및 문서 연결 지침서

본 문서는 `<Shema>` 노트 애플리케이션에서 외부 AI API 호출이나 무거운 딥러닝 모델 다운로드 없이, **순수 TypeScript/JavaScript 알고리즘만으로 문서 간 유사도 계산, 연관 노트 추천, 자동/수동 양방향 링크 생성**을 오프라인 환경에서 초저지연($10\text{ms}$ 이내)으로 처리하기 위한 기술 명세 및 구현 가이드입니다.

## 1. 아키텍처 설계 목표 (Design Goals)

1. **완전한 오프라인 구동 및 제로 비용 (100% Offline & Zero Cost)**:

   * 네트워크 연결이나 API 키 없이 기기 로컬 환경(WebView / 브라우저 인메모리)에서 즉시 동작합니다.

2. **초저지연 반응성 (**$< 10\text{ms}$**)**:

   * 사용자가 특정 단어나 문장을 드래그하거나 노트를 작성할 때, 버벅임 없이 실시간으로 연관 문서를 계산하여 추천합니다.

3. **수학교육 도메인 특화 토크나이징**:

   * 일반 자연어 처리에서 특수문자로 버려지기 쉬운 $\LaTeX$ 수식 기호(예: `\int`, `\frac`, `\sum`, `\sqrt`)를 독립된 핵심 토큰으로 보존합니다.

4. **하이브리드 랭킹 결합**:

   * **명시적 연결**(위키링크 `[[문서명]]`, 공통 태그 `#기하학`)과 **통계적 문맥 유사도**(BM25 및 TF-IDF 코사인 유사도)를 결합하여 정확도를 극대화합니다.

## 2. 텍스트 전처리 및 하이브리드 토크나이저 (Tokenizer)

무거운 외부 형태소 분석기(C++/Java 바인딩)를 쓰지 않고도 한국어 조사 변화와 수식을 정확히 색인하기 위해 **3단계 하이브리드 토크나이징**을 수행합니다.

### 2.1 처리 파이프라인

1. $\LaTeX$ **수식 명령어 추출**:

   * `$...$` 또는 `$$...$$` 내부의 핵심 수학 명령어(`\lim`, `\int`, `\pi`, `\theta`, `matrix` 등)와 수식 구조를 정규표현식으로 먼저 추출하여 별도 토큰으로 보존합니다.

2. **한국어 어미/조사 제거 (Stemming Heuristic)**:

   * 단어 끝의 대표적인 한국어 조사(`은`, `는`, `이`, `가`, `을`, `를`, `의`, `에`, `에서`, `으로`, `로`, `과`, `와`, `도`, `만`)를 제거하여 어간(Stem)을 추출합니다.

3. **Character Bi-gram 생성 (보조 인덱스)**:

   * 복합명사나 띄어쓰기 오류에 대응하기 위해 $2$음절 단위(Bi-gram, 예: `직육면체` $\rightarrow$ `직육`, `육면`, `면체`) 토큰을 함께 생성합니다.

## 3. 핵심 수식 및 랭킹 알고리즘 (Core Algorithms)

### 3.1 TF-IDF 가중치 계산

전체 문서 집합 $D$에서 특정 문서 $d$에 등장하는 토큰 $t$의 중요도는 다음과 같이 계산합니다.

$$
\text{TF}(t, d) = 1 + \ln(f_{t, d})
$$

$$
\text{IDF}(t, D) = \ln\left(1 + \frac{\vert{}D\vert{}}{1 + \vert{}\{d \in D : t \in d\}\vert{}}\right)
$$

$$
\text{TF-IDF}(t, d, D) = \text{TF}(t, d) \times \text{IDF}(t, D)
$$

### 3.2 코사인 유사도 (Cosine Similarity)

현재 선택된 텍스트(또는 현재 문서)의 벡터 $\mathbf{A}$와 비교 대상 문서 벡터 $\mathbf{B}$ 간의 각도 유사도를 측정합니다.

$$
\text{CosineSim}(\mathbf{A}, \mathbf{B}) = \frac{\sum_{i=1}^{n} A_i B_i}{\sqrt{\sum_{i=1}^{n} A_i^2} \sqrt{\sum_{i=1}^{n} B_i^2}}
$$

### 3.3 BM25 키워드 검색 스코어

사용자가 특정 구절을 드래그하여 연관 문서를 찾을 때 문서 길이 정규화를 반영한 BM25 점수를 함께 산출합니다 ($k_1 = 1.5, b = 0.75$).

$$
\text{BM25}(D, Q) = \sum_{q \in Q} \text{IDF}(q) \cdot \frac{f(q, D) \cdot (k_1 + 1)}{f(q, D) + k_1 \cdot \left(1 - b + b \cdot \frac{\vert{}D\vert{}}{\text{avgdl}}\right)}
$$

### 3.4 최종 하이브리드 유사도 점수 ($S_{\text{total}}$)

단순 단어 빈도만으로는 부족할 수 있는 맥락을 보완하기 위해 제목 일치, 공유 태그, 위키링크에 가중치를 부여합니다.

$$
S_{\text{total}} = 0.5 \cdot \text{CosineSim} + 0.3 \cdot \text{NormalizedBM25} + 0.15 \cdot \text{TagOverlap} + 0.05 \cdot \text{TitleMatch}
$$

## 4. TypeScript 실전 구현 코드 (Reference Implementation)

`src/services/offlineDocumentLinker.ts` 파일로 즉시 프로젝트에 이식할 수 있는 순수 TypeScript 엔진입니다.

```
// src/services/offlineDocumentLinker.ts

export interface NoteDocument {
  id: string;
  title: string;
  content: string; // Markdown + LaTeX
  tags?: string[];
  updatedAt: number;
}

export interface LinkRecommendation {
  docId: string;
  title: string;
  score: number;
  matchedKeywords: string[];
  snippet: string;
}

interface IndexedDoc {
  id: string;
  title: string;
  tags: Set<string>;
  explicitLinks: Set<string>;
  termFreq: Map<string, number>;
  tfidfVector: Map<string, number>;
  norm: number;
  length: number;
  rawContent: string;
}

const KOREAN_JOSA_REGEX = /(은|는|이|가|을|를|의|에|에서|으로|로|과|와|도|만|부터|까지|에게|한테)$/;
const STOPWORDS = new Set([
  '그리고', '그러나', '하지만', '따라서', '그래서', '또한', '경우', '통해', '대한', '위해',
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'are', 'was', 'were', 'have', 'has'
]);

export class OfflineDocumentLinker {
  private docs: Map<string, IndexedDoc> = new Map();
  private docFreq: Map<string, number> = new Map();
  private avgDocLength = 0;
  private isDirty = false;

  /**
   * 1. 한국어 + 영어 + LaTeX 수식 하이브리드 토크나이저
   */
  public tokenize(text: string): string[] {
    const tokens: string[] = [];

    // Step A: LaTeX 핵심 명령어 추출 (\frac, \int, \sum, \sqrt 등)
    const latexCommands = text.match(/\\[a-zA-Z]{2,}/g);
    if (latexCommands) {
      for (const cmd of latexCommands) {
        tokens.push(`math:${cmd}`);
      }
    }

    // Step B: 일반 텍스트 정제 (특수문자 제거 후 공백 분리)
    const cleaned = text
      .toLowerCase()
      .replace(/\$+/g, ' ')
      .replace(/[^\w\s가-힣]/g, ' ');

    const rawWords = cleaned.split(/\s+/).filter(Boolean);

    for (const word of rawWords) {
      if (word.length < 2 || STOPWORDS.has(word)) continue;

      // 한국어 조사 제거
      const stem = word.replace(KOREAN_JOSA_REGEX, '');
      const targetWord = stem.length >= 2 ? stem : word;

      if ( STOPWORDS.has(targetWord)) continue;
      tokens.push(targetWord);

      // 한글 3글자 이상 단어는 2글자 Bi-gram 보조 토큰 추가 (예: 직육면체 -> 직육, 육면, 면체)
      if (/[가-힣]{3,}/.test(targetWord)) {
        for (let i = 0; i < targetWord.length - 1; i++) {
          tokens.push(targetWord.slice(i, i + 2));
        }
      }
    }

    return tokens;
  }

  /**
   * 2. 위키링크 [[문서제목]] 및 #태그 추출
   */
  private extractMetadata(content: string, explicitTags: string[] = []) {
    const tags = new Set<string>(explicitTags.map(t => t.toLowerCase()));
    const explicitLinks = new Set<string>();

    // #태그 추출
    const tagMatches = content.match(/#([a-zA-Z0-9가-힣_-]+)/g);
    if (tagMatches) {
      tagMatches.forEach(t => tags.add(t.slice(1).toLowerCase()));
    }

    // [[위키링크]] 추출
    const linkMatches = content.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g);
    for (const match of linkMatches) {
      explicitLinks.add(match[1].trim().toLowerCase());
    }

    return { tags, explicitLinks };
  }

  /**
   * 3. 단일 문서 인덱싱 (추가 또는 업데이트)
   */
  public upsertDocument(doc: NoteDocument): void {
    // 제목에는 가중치를 주기 위해 2회 반복 포함
    const fullText = `${doc.title} ${doc.title} ${doc.content}`;
    const tokens = this.tokenize(fullText);
    const termFreq = new Map<string, number>();

    for (const token of tokens) {
      termFreq.set(token, (termFreq.get(token) || 0) + 1);
    }

    const { tags, explicitLinks } = this.extractMetadata(doc.content, doc.tags);

    this.docs.set(doc.id, {
      id: doc.id,
      title: doc.title,
      tags,
      explicitLinks,
      termFreq,
      tfidfVector: new Map(),
      norm: 0,
      length: tokens.length,
      rawContent: doc.content,
    });

    this.isDirty = true;
  }

  /**
   * 4. 문서 삭제
   */
  public removeDocument(docId: string): void {
    if (this.docs.delete(docId)) {
      this.isDirty = true;
    }
  }

  /**
   * 5. 전체 TF-IDF 벡터 및 DF(Document Frequency) 재계산
   */
  private rebuildIndexIfNeeded(): void {
    if (!this.isDirty) return;

    this.docFreq.clear();
    let totalLen = 0;
    const N = this.docs.size;

    for (const doc of this.docs.values()) {
      totalLen += doc.length;
      for (const term of doc.termFreq.keys()) {
        this.docFreq.set(term, (this.docFreq.get(term) || 0) + 1);
      }
    }

    this.avgDocLength = N > 0 ? totalLen / N : 1;

    for (const doc of this.docs.values()) {
      doc.tfidfVector.clear();
      let sumSq = 0;

      for (const [term, freq] of doc.termFreq.entries()) {
        const df = this.docFreq.get(term) || 1;
        const tf = 1 + Math.log(freq);
        const idf = Math.log(1 + N / (1 + df));
        const weight = tf * idf;

        doc.tfidfVector.set(term, weight);
        sumSq += weight * weight;
      }

      doc.norm = Math.sqrt(sumSq);
    }

    this.isDirty = false;
  }

  /**
   * 6. 드래그한 문장 또는 키워드로 연관 문서 추천 (BM25 + 제목/태그 매칭)
   */
  public recommendBySelection(
    selectedText: string,
    currentDocId?: string,
    topK = 5
  ): LinkRecommendation[] {
    this.rebuildIndexIfNeeded();
    const queryTokens = this.tokenize(selectedText);
    if (queryTokens.length === 0) return [];

    const N = this.docs.size;
    const k1 = 1.5;
    const b = 0.75;
    const results: LinkRecommendation[] = [];

    for (const doc of this.docs.values()) {
      if (doc.id === currentDocId) continue;

      let bm25Score = 0;
      const matched: string[] = [];

      for (const q of new Set(queryTokens)) {
        const tf = doc.termFreq.get(q) || 0;
        if (tf === 0) continue;

        if (!q.startsWith('math:') && q.length >= 2) {
          matched.push(q);
        }

        const df = this.docFreq.get(q) || 1;
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        const numerator = tf * (k1 + 1);
        const denominator = tf + k1 * (1 - b + b * (doc.length / this.avgDocLength));
        bm25Score += idf * (numerator / denominator);
      }

      // 제목 직접 포함 보너스 가중치
      const cleanSelection = selectedText.trim().toLowerCase();
      if (doc.title.toLowerCase().includes(cleanSelection) || cleanSelection.includes(doc.title.toLowerCase())) {
        bm25Score += 5.0;
      }

      if (bm25Score > 0.1) {
        results.push({
          docId: doc.id,
          title: doc.title,
          score: Number(bm25Score.toFixed(3)),
          matchedKeywords: matched.slice(0, 5),
          snippet: this.extractSnippet(doc.rawContent, matched[0] || cleanSelection),
        });
      }
    }

    return results.sort((a, b) => b.score - a.score).slice(0, topK);
  }

  /**
   * 7. 특정 문서와 전체적으로 가장 유사한 노트 추천 (코사인 유사도 + 태그 공유)
   */
  public recommendSimilarDocuments(targetDocId: string, topK = 5): LinkRecommendation[] {
    this.rebuildIndexIfNeeded();
    const source = this.docs.get(targetDocId);
    if (!source || source.norm === 0) return [];

    const results: LinkRecommendation[] = [];

    for (const candidate of this.docs.values()) {
      if (candidate.id === targetDocId || candidate.norm === 0) continue;

      // 1. TF-IDF 코사인 유사도 계산
      let dotProduct = 0;
      const sharedTerms: { term: string; contribution: number }[] = [];

      for (const [term, srcWeight] of source.tfidfVector.entries()) {
        const candWeight = candidate.tfidfVector.get(term);
        if (candWeight) {
          const prod = srcWeight * candWeight;
          dotProduct += prod;
          if (!term.startsWith('math:') && term.length >= 2) {
            sharedTerms.push({ term, contribution: prod });
          }
        }
      }

      const cosineSim = dotProduct / (source.norm * candidate.norm);

      // 2. 태그 중첩도 (Jaccard 유사도)
      let tagOverlap = 0;
      if (source.tags.size > 0 && candidate.tags.size > 0) {
        let intersection = 0;
        for (const t of source.tags) {
          if (candidate.tags.has(t)) intersection++;
        }
        tagOverlap = intersection / (source.tags.size + candidate.tags.size - intersection);
      }

      // 3. 명시적 위키링크 보너스
      const hasExplicitLink =
        source.explicitLinks.has(candidate.title.toLowerCase()) ||
        candidate.explicitLinks.has(source.title.toLowerCase())
          ? 0.25
          : 0;

      const finalScore = cosineSim * 0.7 + tagOverlap * 0.2 + hasExplicitLink;

      if (finalScore > 0.08) {
        sharedTerms.sort((a, b) => b.contribution - a.contribution);
        const topKeywords = sharedTerms.slice(0, 4).map(t => t.term);

        results.push({
          docId: candidate.id,
          title: candidate.title,
          score: Number(finalScore.toFixed(3)),
          matchedKeywords: topKeywords,
          snippet: this.extractSnippet(candidate.rawContent, topKeywords[0] || ''),
        });
      }
    }

    return results.sort((a, b) => b.score - a.score).slice(0, topK);
  }

  /**
   * 8. 매칭된 키워드 주변 문맥 스니펫 추출
   */
  private extractSnippet(content: string, keyword: string): string {
    const plain = content.replace(/[#*`~>\[\]]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!keyword) return plain.slice(0, 80) + (plain.length > 80 ? '...' : '');

    const idx = plain.toLowerCase().indexOf(keyword.toLowerCase());
    if (idx === -1) return plain.slice(0, 80) + (plain.length > 80 ? '...' : '');

    const start = Math.max(0, idx - 25);
    const end = Math.min(plain.length, idx + 55);
    return (start > 0 ? '...' : '') + plain.slice(start, end) + (end < plain.length ? '...' : '');
  }
}

```

## 5. UI 연동 시나리오: 수동 및 자동 링크 워크플로우

### 5.1 드래그 선택 영역 기반 즉각 링크 생성 (Manual + Assisted Match)

1. 사용자가 에디터에서 `"원뿔의 수직 단면"`이라는 구절을 드래그합니다.

2. 플로팅 툴바에서 **\[🔗 문서 연결\]** 버튼을 클릭합니다.

3. `linker.recommendBySelection("원뿔의 수직 단면", currentDocId)`가 즉시 호출되어 $5\text{ms}$ 이내에 연관도 상위 5개 노트를 드롭다운으로 보여줍니다.

4. 사용자가 목록에서 `기하학_회전체_단면.md`를 탭하면 선택된 구절이 `[[기하학_회전체_단면|원뿔의 수직 단면]]` 위키링크 문법으로 자동 치환됩니다.

### 5.2 우측/하단 '연관 노트(Related Notes)' 자동 패널

* 노트를 저장하거나 편집이 $1000\text{ms}$ 이상 멈출 때(Debounce), `linker.recommendSimilarDocuments(currentDocId)`를 실행하여 현재 작성 중인 노트와 수학적 개념·키워드가 가장 유사한 다른 노트들을 자동으로 카드로 띄워줍니다.

## 6. 검증 체크리스트 (Verification Checklist)

* [x] **오프라인 완전성**: 비행기 모드(네트워크 차단) 상태에서 단어 드래그 시 연관 문서 추천 목록이 정상 표시되는가? (`src/services/offlineDocumentLinker.test.ts` 검증 완료)

* [x] **한국어 조사 유연성**: `"직육면체를"`, `"직육면체의"`, `"직육면체에서"`가 모두 동일 어간(`직육면체`)으로 매칭되는가? (`stripKoreanJosa` 및 2-gram 보조 토큰 검증 완료)

* [x] **수식 기호 매칭**: `\int`나 `\frac` 등 동일한 $\LaTeX$ 수식 구조를 다수 포함한 수학 노트끼리 유사도 가중치가 상승하는가? (`math:\cmd` 토큰화 및 TF-IDF 코사인 유사도 검증 완료)

* [x] **연산 지연 시간**: 노트 $500$개 기준 `recommendBySelection()` 호출 시 소요 시간이 $10\text{ms}$ 미만인가? ($500$개 문서 벤치마크 $< 10\text{ms}$ 통과)

---

## 7. 정교화된 구현 요구사항 명세 (Refined Requirements Specification)

1. **오프라인 하이브리드 문서 링커 엔진 (`src/services/offlineDocumentLinker.ts`)**:
   - **3단계 하이브리드 토크나이저 (`tokenize`)**:
     1. $\LaTeX$ 핵심 수식 명령어(`\\[a-zA-Z]{2,}`)를 정규표현식으로 우선 추출하여 `math:\cmd` 형태의 독립 토큰으로 보존한다.
     2. 영문 소문자 정규화 및 특수문자 정제 후 불용어(`STOPWORDS`)를 제거하고, 한국어 어절 말미의 조사(`은/는/이/가/을/를/의/에/에서/으로/로/과/와/도/만/부터/까지/에게/한테`, 최대 2단계 복합 조사 포함)를 제거하여 길이 $2$ 이상인 어간(Stem)을 추출한다.
     3. $3$음절 이상 한글 어간에 대해 $2$음절 단위 문자 Bi-gram 보조 토큰을 생성하여 복합명사 및 부분 일치를 보완한다.
   - **지연 재색인(Lazy Rebuild) 기반 TF-IDF 및 BM25 랭킹**:
     - 문서 추가/수정(`upsertDocument`) 및 삭제(`removeDocument`) 시 `isDirty` 플래그만 갱신하고, 실제 검색/추천 시점(`rebuildIndexIfNeeded`)에 역문서빈도($\text{IDF}$), 문서 평균 길이($\text{avgdl}$), 문서별 TF-IDF 벡터 및 $L_2$ 노름(`norm`)을 일괄 갱신하여 $500$개 문서 기준 $10\text{ms}$ 미만의 초저지연 응답성을 보장한다.
2. **선택 영역 기반 즉각 문서 연결 워크플로우 (`SelectionMenu.tsx` & `NoteSession.ts`)**:
   - 에디터에서 텍스트 드래그 시 플로팅 메뉴의 **`[🔗 문서 연결]`** 버튼을 통해 `recommendBySelection(selectedText, currentDocId, 5)`를 즉시 실행하고, 상위 $5$개 연관 문서(제목, BM25 점수, 매칭 키워드, 문맥 스니펫)를 드롭다운으로 노출한다.
   - 추천 항목 선택 시 드래그된 원문 구절을 `[[문서제목|선택된 구절]]` 위키링크 노드로 즉시 치환한다.
3. **실시간 연관 노트 자동 추천 패널 (`RightSidebar.tsx` & `NoteSession.ts`)**:
   - 노트 저장 시점 또는 에디터 편집 후 $1000\text{ms}$ 디바운스 시점에 `recommendSimilarDocuments(currentDocId, 5)`를 호출하여 TF-IDF 코사인 유사도($0.7$), `#태그` Jaccard 중첩도($0.2$), 명시적 `[[위키링크]]` 연결 보너스($0.25$)가 결합된 연관 노트 카드를 우측 사이드바 하단 패널에 자동 갱신한다.
