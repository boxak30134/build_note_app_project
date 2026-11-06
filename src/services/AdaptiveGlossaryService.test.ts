import { describe, expect, it, beforeEach } from 'vitest';
import { AdaptiveGlossaryService } from './AdaptiveGlossaryService';
import { jsonToMarkdown, markdownToJson } from '../editor/extensions';
import { plainTextOf } from '../core/doc/blocks';

describe('AdaptiveGlossaryService (점진적 적응형 오프라인 문맥 번역)', () => {
  let service: AdaptiveGlossaryService;

  beforeEach(() => {
    service = new AdaptiveGlossaryService();
  });

  it('Day 1 콜드스타트 검증: "In abstract algebra, a ring is..." 입력 시 ring 이 환(環)으로 즉시 판별된다', () => {
    const res = service.resolveMeaning('ring', 'In abstract algebra, a ring is a set equipped with two binary operations.');
    expect(res.selectedMeaning).toBe('환(環)');
    expect(res.confidence).toBe(95);
    expect(res.source).toBe('seed_context');
    expect(res.matchedTrigger).toBeTruthy();
    expect(res.alternatives.some((a) => a.meaning === '고리, 반지')).toBe(true);
  });

  it('일상어 문맥 분기 검증: "He gave her a gold ring." 입력 시 ring 이 고리, 반지로 판별된다', () => {
    const res = service.resolveMeaning('ring', 'He gave her a gold ring on her finger.');
    expect(res.selectedMeaning).toBe('고리, 반지');
    expect(res.confidence).toBe(95);
    expect(res.source).toBe('seed_context');
  });

  it('다의어 도메인 분기 검증: field 가 대수학 문맥에서는 체(體), 물리학 문맥에서는 장(場)으로 판별된다', () => {
    const algebraRes = service.resolveMeaning('field', 'Every finite field has prime power order in Galois theory.');
    expect(algebraRes.selectedMeaning).toBe('체(體)');

    const physicsRes = service.resolveMeaning('field', 'An electromagnetic field exerts a magnetic force on a moving charge.');
    expect(physicsRes.selectedMeaning).toBe('장(場)');
  });

  it('Day 2 자가 학습 검증: 사용자가 번역을 수정한 후 동일 키워드가 포함된 다른 문장에서 수정 단어가 1순위로 표시된다', () => {
    // 사용자가 "ring"을 특수 문맥("topology", "cohomology")에서 "코호몰로지 환"으로 직접 수정 학습
    const feedback = service.recordUserFeedback(
      'ring',
      '코호몰로지 환',
      'The cohomology ring of a topological manifold has graded structure.',
      'topology',
    );
    expect(feedback.word).toBe('ring');
    expect(feedback.selectedMeaning).toBe('코호몰로지 환');
    expect(feedback.learnedTriggers).toContain('cohomology');

    // 이후 동일 트리거("cohomology")가 포함된 다른 문장에서 조회 시 사용자 학습 번역어가 1순위로 반환됨
    const nextRes = service.resolveMeaning('ring', 'We compute the cohomology ring of projective space.');
    expect(nextRes.selectedMeaning).toBe('코호몰로지 환');
    expect(nextRes.source).toBe('user_learned');
    expect(nextRes.confidence).toBeGreaterThanOrEqual(85);
  });

  it('연산 지연 시간 검증: 문맥 탐지 및 스코어링 소요 시간이 1ms 미만이다', () => {
    const iterations = 100;
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      service.resolveMeaning('compact', 'Every closed subset of a compact Hausdorff topology is compact.');
    }
    const avgMs = (performance.now() - start) / iterations;
    expect(avgMs).toBeLessThan(1.0);
  });

  it('RubyText 확장: <ruby>ring<rt>환(環)</rt></ruby> 노드가 마크다운 직렬화 및 plainText 추출에서 정상 동작한다', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'A commutative ' },
            { type: 'rubyText', attrs: { base: 'ring', rt: '환(環)' } },
            { type: 'text', text: ' with identity.' },
          ],
        },
      ],
    };

    const md = jsonToMarkdown(doc);
    expect(md).toContain('<ruby>ring<rt>환(環)</rt></ruby>');
    expect(plainTextOf(doc)).toBe('A commutative ring with identity.');

    const parsed = markdownToJson(md);
    expect(plainTextOf(parsed)).toContain('ring');
  });
});

