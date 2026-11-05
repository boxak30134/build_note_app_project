// src/services/offlineDocumentLinker.ts

export type NoteDocument = {
  id: string;
  title: string;
  content: string; // Markdown + LaTeX
  tags?: string[];
  updatedAt: number;
};

export type LinkRecommendation = {
  docId: string;
  title: string;
  score: number;
  matchedKeywords: string[];
  snippet: string;
};

type IndexedDoc = {
  id: string;
  title: string;
  tags: Set<string>;
  explicitLinks: Set<string>;
  termFreq: Map<string, number>;
  tfidfVector: Map<string, number>;
  norm: number;
  length: number;
  rawContent: string;
};

const KOREAN_JOSA_REGEX = /(은|는|이|가|을|를|의|에|에서|으로|로|과|와|도|만|부터|까지|에게|한테)$/;
const STOPWORDS = new Set([
  '그리고',
  '그러나',
  '하지만',
  '따라서',
  '그래서',
  '또한',
  '경우',
  '통해',
  '대한',
  '위해',
  'the',
  'and',
  'for',
  'that',
  'this',
  'with',
  'from',
  'are',
  'was',
  'were',
  'have',
  'has',
]);

/**
 * 한국어 어미/조사 제거 휴리스틱 (복합 조사 2단계까지 안전 제거)
 */
export function stripKoreanJosa(word: string): string {
  let current = word;
  for (let step = 0; step < 2; step++) {
    const stripped = current.replace(KOREAN_JOSA_REGEX, '');
    if (stripped === current || stripped.length < 2) break;
    current = stripped;
  }
  return current.length >= 2 ? current : word;
}

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
      const targetWord = stripKoreanJosa(word);

      if (STOPWORDS.has(targetWord)) continue;
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
    const tags = new Set<string>(explicitTags.map((t) => t.toLowerCase()));
    const explicitLinks = new Set<string>();

    // #태그 추출
    const tagMatches = content.match(/#([a-zA-Z0-9가-힣_-]+)/g);
    if (tagMatches) {
      tagMatches.forEach((t) => tags.add(t.slice(1).toLowerCase()));
    }

    // [[위키링크]] 추출 ([[문서명]], [[문서명|별칭]], [[docId#blockId|별칭]] 모두 지원)
    const linkMatches = content.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g);
    for (const match of linkMatches) {
      explicitLinks.add(match[1].trim().toLowerCase());
      if (match[2]) {
        explicitLinks.add(match[2].trim().toLowerCase());
      }
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
   * 전체 인덱스 초기화
   */
  public clear(): void {
    this.docs.clear();
    this.docFreq.clear();
    this.avgDocLength = 0;
    this.isDirty = false;
  }

  public get size(): number {
    return this.docs.size;
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
  public recommendBySelection(selectedText: string, currentDocId?: string, topK = 5): LinkRecommendation[] {
    this.rebuildIndexIfNeeded();
    const queryTokens = this.tokenize(selectedText);
    if (queryTokens.length === 0) return [];

    const N = this.docs.size;
    const k1 = 1.5;
    const b = 0.75;
    const results: LinkRecommendation[] = [];
    const uniqueQueryTokens = new Set(queryTokens);
    const cleanSelection = selectedText.trim().toLowerCase();

    for (const doc of this.docs.values()) {
      if (doc.id === currentDocId) continue;

      let bm25Score = 0;
      const matched: string[] = [];

      for (const q of uniqueQueryTokens) {
        const tf = doc.termFreq.get(q) || 0;
        if (tf === 0) continue;

        if (!q.startsWith('math:') && q.length >= 2) {
          matched.push(q);
        }

        const df = this.docFreq.get(q) || 1;
        const bm25Idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        const smoothIdf = Math.log(1 + N / (1 + df));
        const idf = Math.max(bm25Idf, smoothIdf * 0.25);
        const numerator = tf * (k1 + 1);
        const denominator = tf + k1 * (1 - b + b * (doc.length / this.avgDocLength));
        bm25Score += idf * (numerator / denominator);
      }

      // 제목 직접 포함 보너스 가중치
      const lowerTitle = doc.title.toLowerCase();
      if (
        cleanSelection.length > 0 &&
        lowerTitle.length > 0 &&
        (lowerTitle.includes(cleanSelection) || cleanSelection.includes(lowerTitle))
      ) {
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
   * 7. 특정 문서와 전체적으로 가장 유사한 노트 추천 (코사인 유사도 + 태그 공유 + 명시적 위키링크)
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
      const candTitleLower = candidate.title.toLowerCase();
      const srcTitleLower = source.title.toLowerCase();
      const hasExplicitLink =
        source.explicitLinks.has(candTitleLower) ||
        source.explicitLinks.has(candidate.id.toLowerCase()) ||
        candidate.explicitLinks.has(srcTitleLower) ||
        candidate.explicitLinks.has(source.id.toLowerCase())
          ? 0.25
          : 0;

      const finalScore = cosineSim * 0.7 + tagOverlap * 0.2 + hasExplicitLink;

      if (finalScore > 0.08) {
        sharedTerms.sort((a, b) => b.contribution - a.contribution);
        const topKeywords = sharedTerms.slice(0, 4).map((t) => t.term);

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
    const plain = content
      .replace(/[#*`~>[\]]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!keyword) return plain.slice(0, 80) + (plain.length > 80 ? '...' : '');

    const idx = plain.toLowerCase().indexOf(keyword.toLowerCase());
    if (idx === -1) return plain.slice(0, 80) + (plain.length > 80 ? '...' : '');

    const start = Math.max(0, idx - 25);
    const end = Math.min(plain.length, idx + 55);
    return (start > 0 ? '...' : '') + plain.slice(start, end) + (end < plain.length ? '...' : '');
  }
}

/** 앱 전역 오프라인 문서 링커 싱글톤 인스턴스 */
export const offlineLinker = new OfflineDocumentLinker();

