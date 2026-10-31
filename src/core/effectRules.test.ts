import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(__dirname, '..');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(tsx?|jsx?)$/.test(name) && !/\.test\./.test(name) ? [p] : [];
  });
}

/**
 * 회귀 방지: useEffect(() => expr) 축약형 금지.
 * 최신 Chrome 의 scrollIntoView()/scrollTo() 처럼 Promise 를 반환하는 API 를 축약형으로 호출하면
 * effect 가 Promise 를 반환하게 되고, React 가 이를 cleanup 으로 호출하다 "destroy is not a function" 으로 크래시한다.
 * (cleanup 함수를 반환하는 `() => () => …` 형태는 허용)
 */
describe('React effect 반환값 규칙', () => {
  it('useEffect / useLayoutEffect 콜백은 블록 본문 또는 cleanup 함수만 반환한다', () => {
    const offenders: string[] = [];
    const pattern = /use(?:Layout|Insertion)?Effect\(\s*(?:async\s*)?\(\s*\)\s*=>(?!\s*\{)(?!\s*\(\s*\)\s*=>)/g;
    for (const file of walk(SRC)) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(pattern)) {
        const line = text.slice(0, m.index).split('\n').length;
        offenders.push(`${relative(SRC, file)}:${line}`);
      }
      if (/use(?:Layout)?Effect\(\s*async/.test(text)) offenders.push(`${relative(SRC, file)}: async effect`);
    }
    expect(offenders).toEqual([]);
  });
});
