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
});
