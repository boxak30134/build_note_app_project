import { describe, expect, it } from 'vitest';
import { OfflineDocumentLinker, stripKoreanJosa } from './offlineDocumentLinker';

describe('OfflineDocumentLinker (오프라인 검색 및 문서 연결 엔진)', () => {
  it('1. 한국어 조사 유연성: "직육면체를", "직육면체의", "직육면체에서"가 모두 동일 어간("직육면체") 및 2-gram으로 매칭된다', () => {
    const linker = new OfflineDocumentLinker();

    expect(stripKoreanJosa('직육면체를')).toBe('직육면체');
    expect(stripKoreanJosa('직육면체의')).toBe('직육면체');
    expect(stripKoreanJosa('직육면체에서')).toBe('직육면체');

    const t1 = linker.tokenize('직육면체를');
    const t2 = linker.tokenize('직육면체의');
    const t3 = linker.tokenize('직육면체에서');

    expect(t1).toContain('직육면체');
    expect(t2).toContain('직육면체');
    expect(t3).toContain('직육면체');
    expect(t1).toEqual(expect.arrayContaining(['직육', '육면', '면체']));

    linker.upsertDocument({
      id: 'doc-cuboid',
      title: '입체도형과 직육면체',
      content: '직육면체의 부피와 겉넓이를 구하는 공식을 유도한다.',
      updatedAt: Date.now(),
    });

    const r1 = linker.recommendBySelection('직육면체를', 'doc-current');
    const r2 = linker.recommendBySelection('직육면체의', 'doc-current');
    const r3 = linker.recommendBySelection('직육면체에서', 'doc-current');

    expect(r1[0]?.docId).toBe('doc-cuboid');
    expect(r2[0]?.docId).toBe('doc-cuboid');
    expect(r3[0]?.docId).toBe('doc-cuboid');
  });

  it('2. 수식 기호 매칭: \\int, \\frac 등 동일한 LaTeX 수식 구조를 다수 포함한 수학 노트끼리 유사도 가중치가 상승한다', () => {
    const linker = new OfflineDocumentLinker();

    const tokens = linker.tokenize('정적분 $$\\int_{a}^{b} \\frac{f(x)}{g(x)} dx + \\sum_{k=1}^{n} \\sqrt{k}$$');
    expect(tokens).toEqual(expect.arrayContaining(['math:\\int', 'math:\\frac', 'math:\\sum', 'math:\\sqrt']));

    linker.upsertDocument({
      id: 'calc-1',
      title: '미적분학 정적분 기본 정리',
      content: '연속함수의 정적분 계산: $$\\int_0^1 \\frac{x^2}{\\sqrt{x+1}} dx$$ 및 $$\\int \\frac{1}{x} dx$$ #미적분',
      updatedAt: Date.now(),
    });

    linker.upsertDocument({
      id: 'calc-2',
      title: '치환적분과 부분적분 기법',
      content: '유리함수와 무리함수의 적분: $$\\int \\frac{f(x)}{\\sqrt{g(x)}} dx$$ 와 $$\\int_a^b \\frac{1}{x^2+1} dx$$ #미적분',
      updatedAt: Date.now(),
    });

    linker.upsertDocument({
      id: 'history-1',
      title: '근현대사 요약 노트',
      content: '산업혁명 이후 도시화와 사회적 변화에 대한 역사적 고찰을 정리한다.',
      updatedAt: Date.now(),
    });

    const similar = linker.recommendSimilarDocuments('calc-1', 5);
    expect(similar.length).toBeGreaterThanOrEqual(1);
    expect(similar[0].docId).toBe('calc-2');
    expect(similar.some((s) => s.docId === 'history-1')).toBe(false);
  });

  it('3. 오프라인 완전성 및 드래그 구절 기반 추천: 네트워크 없이 "원뿔의 수직 단면" 드래그 시 연관 문서를 즉시 추천한다', () => {
    const linker = new OfflineDocumentLinker();

    linker.upsertDocument({
      id: 'geo-cone',
      title: '기하학_회전체_단면.md',
      content: '원뿔을 축에 수직인 평면으로 자른 원뿔의 수직 단면은 원이 되며, 모선에 평행하게 자르면 포물선이 된다. #기하학',
      updatedAt: Date.now(),
    });

    linker.upsertDocument({
      id: 'alg-matrix',
      title: '선형대수_행렬식.md',
      content: '정사각행렬의 역행렬 존재 여부와 행렬식의 성질을 다룬다. #선형대수',
      updatedAt: Date.now(),
    });

    const recs = linker.recommendBySelection('원뿔의 수직 단면', 'current-doc', 5);
    expect(recs.length).toBeGreaterThan(0);
    expect(recs[0].docId).toBe('geo-cone');
    expect(recs[0].title).toBe('기하학_회전체_단면.md');
    expect(recs[0].matchedKeywords).toEqual(expect.arrayContaining(['원뿔', '수직', '단면']));
    expect(recs[0].snippet).toContain('원뿔');
  });

  it('4. 연산 지연 시간: 노트 500개 기준 recommendBySelection() 호출 시 소요 시간이 10ms 미만이다', () => {
    const linker = new OfflineDocumentLinker();

    for (let i = 0; i < 500; i++) {
      const isGeometry = i % 20 === 0;
      linker.upsertDocument({
        id: `note-${i}`,
        title: isGeometry ? `기하학 노트 ${i} - 직육면체와 회전체` : `해석학 개념 노트 ${i} - 함수와 극한`,
        content: isGeometry
          ? `이 문서는 ${i}번째 기하학 노트입니다. 직육면체의 부피와 원뿔의 수직 단면 성질 및 회전체의 단면적을 다룹니다. #기하학`
          : `이 문서는 ${i}번째 미적분 학습 노트입니다. 주요 수식 $$\\int_0^{\\pi} \\frac{\\sin x}{x} dx$$ 및 코시 수열의 수렴성을 증명합니다. #해석학`,
        updatedAt: Date.now(),
      });
    }

    // 최초 1회 인덱스 빌드 워밍업 후 순수 쿼리 시간 측정
    linker.recommendBySelection('워밍업', 'note-0', 5);

    const start = performance.now();
    const results = linker.recommendBySelection('원뿔의 수직 단면과 직육면체의 부피', 'note-0', 5);
    const elapsedMs = performance.now() - start;

    expect(results.length).toBe(5);
    expect(elapsedMs).toBeLessThan(10);
  });
});

