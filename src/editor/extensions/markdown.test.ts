// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { markdownToJson, jsonToMarkdown } from './index';

describe('마크다운 직렬화 (위키링크·수식·표)', () => {
  it('위키링크/인라인 수식/블록 수식 왕복', () => {
    const md = '# 제목\n\n본문 [[note-1#b123|인지부하]] 와 $a^2+b^2$ 수식\n\n$$\nE=mc^2\n$$';
    const json = markdownToJson(md) as { content: Array<{ type: string; content?: Array<{ type: string; attrs?: Record<string, unknown> }> }> };
    const para = json.content[1];
    const types = para.content!.map((n) => n.type);
    expect(types).toContain('wikiLink');
    expect(types).toContain('inlineMath');
    const link = para.content!.find((n) => n.type === 'wikiLink')!;
    expect(link.attrs).toMatchObject({ targetDocId: 'note-1', targetBlockId: 'b123', label: '인지부하' });
    expect(json.content[2].type).toBe('blockMath');

    const out = jsonToMarkdown(json);
    expect(out).toContain('[[note-1#b123|인지부하]]');
    expect(out).toContain('$a^2+b^2$');
    expect(out).toContain('$$\nE=mc^2\n$$');
  });

  it('외부 Obsidian 스타일 [[제목]] 파싱', () => {
    const json = markdownToJson('참고: [[멀티미디어 학습 원리]]') as { content: Array<{ content?: Array<{ type: string; attrs?: Record<string, unknown> }> }> };
    const link = json.content[0].content!.find((n) => n.type === 'wikiLink')!;
    expect(link.attrs).toMatchObject({ targetDocId: '멀티미디어 학습 원리', label: '멀티미디어 학습 원리' });
  });

  it('표 직렬화', () => {
    const md = '| a | b |\n| --- | --- |\n| 1 | 2 |';
    const json = markdownToJson(md) as { content: Array<{ type: string }> };
    expect(json.content[0].type).toBe('table');
    expect(jsonToMarkdown(json)).toMatch(/\|\s*a\s*\|\s*b\s*\|/);
  });

  it('단일 줄바꿈·인용구·표·이중 이스케이프된 &nbsp; / &lt; / &gt; 복원 및 코드 블록 보존', () => {
    const md = [
      '&nbsp;',
      '&nbsp;',
      '그러나 &amp;lt;킹덤 오브 헤븐&amp;gt;의 보두앵 4세가',
      '',
      '> [!note] 제목 &lt;킹덤&gt;',
      '> &nbsp;',
      '> 본문 &lt;헤븐&gt;',
      '',
      '| 열 | 값 |',
      '| --- | --- |',
      '| &nbsp; | &lt;태그&gt; |',
      '',
      '```html',
      '<div>&lt;코드&gt;&nbsp;</div>',
      '```',
      '',
      '인라인 코드 `&lt;span&gt;&nbsp;` 유지',
    ].join('\n');

    const json = markdownToJson(md) as { content: Array<Record<string, unknown>> };
    const serialized = JSON.stringify(json);

    // 일반 문장/표/콜아웃에는 리터럴 &nbsp;, &lt;, &gt; 가 남아있지 않아야 함
    const nonCodeNodes = json.content.filter((n) => n.type !== 'codeBlock');
    const nonCodeText = JSON.stringify(
      nonCodeNodes.map((n) => {
        if (n.type === 'paragraph' && Array.isArray(n.content)) {
          return {
            ...n,
            content: n.content.filter(
              (c: Record<string, unknown>) =>
                !Array.isArray(c.marks) || !c.marks.some((m: Record<string, unknown>) => m.type === 'code'),
            ),
          };
        }
        return n;
      }),
    );
    expect(nonCodeText).not.toContain('&nbsp;');
    expect(nonCodeText).not.toContain('&lt;');
    expect(nonCodeText).not.toContain('&gt;');
    expect(nonCodeText).toContain('그러나 <킹덤 오브 헤븐>의 보두앵 4세가');
    expect(nonCodeText).toContain('제목 <킹덤>');
    expect(nonCodeText).toContain('<태그>');

    // 코드 블록과 인라인 코드는 원형 유지
    const codeBlock = json.content.find((n) => n.type === 'codeBlock') as { content?: Array<{ text?: string }> };
    expect(codeBlock?.content?.[0]?.text).toBe('<div>&lt;코드&gt;&nbsp;</div>');
    expect(serialized).toContain('`&lt;span&gt;&nbsp;`'.slice(1, -1));
  });
});
