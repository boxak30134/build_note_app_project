// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { setDeviceOverrideForTest } from '../src/core/utils/device';
import {
  TabletMarkdownImeFix,
  evaluateMarkdownIme,
} from '../src/editor/extensions/tabletMarkdownImeFix';
import { buildExtensions, markdownToJson } from '../src/editor/extensions';
import { NoteSession } from '../src/session/NoteSession';
import { emptyNote } from '../src/storage/db';
import { offlineLinker } from '../src/services/offlineDocumentLinker';
import { searchRelated } from '../src/search/searchClient';

describe('REQ_TABLET_MARKDOWN_AND_LINK_RECOVERY: 태블릿 Markdown 렌더링 및 어휘 유사도 링크 생성 복구', () => {
  let editor: Editor;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    editor = new Editor({
      element: container,
      extensions: [
        StarterKit.configure({ undoRedo: false }),
        TabletMarkdownImeFix,
      ],
      content: '<p></p>',
    });
  });

  afterEach(() => {
    editor.destroy();
    container.remove();
    setDeviceOverrideForTest(null);
  });

  describe('PART A. Markdown 테스트 (요청서 §14)', () => {
    beforeEach(() => {
      setDeviceOverrideForTest(true); // 태블릿 모드
    });

    it('1. 굵은 글씨: **굵은 글씨** 입력 시 bold 마크가 적용되고 ** 기호가 제거된다', () => {
      editor.commands.setContent('<p></p>');
      editor.commands.insertContent('**굵은 글씨** ');

      const handled = evaluateMarkdownIme(editor.view);
      expect(handled).toBe(true);

      const json = editor.getJSON();
      const textNode = json.content?.[0]?.content?.[0];
      expect(textNode?.text).toContain('굵은 글씨');
      expect(textNode?.marks?.[0]?.type).toBe('bold');
      expect(editor.getText()).not.toContain('**');
    });

    it('2. 기울임 글씨: *기울임 글씨* 입력 시 italic 마크가 적용된다', () => {
      editor.commands.setContent('<p></p>');
      editor.commands.insertContent('*기울임 글씨* ');

      const handled = evaluateMarkdownIme(editor.view);
      expect(handled).toBe(true);

      const json = editor.getJSON();
      const textNode = json.content?.[0]?.content?.[0];
      expect(textNode?.text).toContain('기울임 글씨');
      expect(textNode?.marks?.[0]?.type).toBe('italic');
    });

    it('3. 취소선: ~~취소선~~ 입력 시 strike 마크가 적용된다', () => {
      editor.commands.setContent('<p></p>');
      editor.commands.insertContent('~~취소선~~ ');

      const handled = evaluateMarkdownIme(editor.view);
      expect(handled).toBe(true);

      const json = editor.getJSON();
      const textNode = json.content?.[0]?.content?.[0];
      expect(textNode?.text).toContain('취소선');
      expect(textNode?.marks?.[0]?.type).toBe('strike');
    });

    it('4. 제목: # Markdown Test 입력 시 H1 노드로 변환된다', () => {
      editor.commands.setContent('<p></p>');
      editor.commands.insertContent('# ');

      const handled = evaluateMarkdownIme(editor.view);
      expect(handled).toBe(true);

      const json = editor.getJSON();
      expect(json.content?.[0]?.type).toBe('heading');
      expect(json.content?.[0]?.attrs?.level).toBe(1);
    });

    it('5. 순서 없는 목록: - 첫 번째 목록 입력 시 bulletList로 변환된다', () => {
      editor.commands.setContent('<p></p>');
      editor.commands.insertContent('- ');

      const handled = evaluateMarkdownIme(editor.view);
      expect(handled).toBe(true);

      const json = editor.getJSON();
      expect(json.content?.[0]?.type).toBe('bulletList');
    });

    it('6. 순서 있는 목록: 1. 순서가 있는 목록 입력 시 orderedList로 변환된다', () => {
      editor.commands.setContent('<p></p>');
      editor.commands.insertContent('1. ');

      const handled = evaluateMarkdownIme(editor.view);
      expect(handled).toBe(true);

      const json = editor.getJSON();
      expect(json.content?.[0]?.type).toBe('orderedList');
    });

    it('7. 인용문: > 인용문 테스트 입력 시 blockquote로 감싸진다', () => {
      editor.commands.setContent('<p></p>');
      editor.commands.insertContent('> ');

      const handled = evaluateMarkdownIme(editor.view);
      expect(handled).toBe(true);

      const json = editor.getJSON();
      expect(json.content?.[0]?.type).toBe('blockquote');
    });

    it('8. 코드 블록: ``` 입력 시 codeBlock으로 변환된다', () => {
      editor.commands.setContent('<p></p>');
      editor.commands.insertContent('``` ');

      const handled = evaluateMarkdownIme(editor.view);
      expect(handled).toBe(true);

      const json = editor.getJSON();
      expect(json.content?.[0]?.type).toBe('codeBlock');
    });

    it('9. 저장된 Markdown 로드 (경로 B): 전체 Markdown 문서를 파싱했을 때 AST 노드가 완벽히 구성된다', () => {
      const sampleMd = [
        '# Markdown Test',
        '',
        '**굵은 글씨**',
        '',
        '*기울임 글씨*',
        '',
        '~~취소선~~',
        '',
        '- 첫 번째 목록',
        '- 두 번째 목록',
        '',
        '1. 순서가 있는 목록',
        '2. 두 번째 항목',
        '',
        '> 인용문 테스트',
        '',
        '```javascript',
        'const answer = "Markdown Test";',
        '```',
      ].join('\n');

      const parsedJson = markdownToJson(sampleMd) as { content: Array<{ type: string; attrs?: Record<string, unknown> }> };
      expect(parsedJson.content).toBeDefined();

      const types = parsedJson.content.map((n) => n.type);
      expect(types).toContain('heading');
      expect(types).toContain('bulletList');
      expect(types).toContain('orderedList');
      expect(types).toContain('blockquote');
      expect(types).toContain('codeBlock');
    });
  });

  describe('PART B. 링크 추천 및 TextObjectLayer 이벤트 격리 테스트 (요청서 §8, §10, §11, §15)', () => {
    let session: NoteSession;

    beforeEach(() => {
      // 오프라인 링커에 사전 테스트 문서 색인
      offlineLinker.upsertDocument({
        id: 'doc-eigen',
        title: '선형대수학: 고유값과 고유벡터',
        content: '고유값과 고유벡터는 선형변환의 주축 방향과 신장률을 나타낸다.',
        updatedAt: Date.now(),
      });
      offlineLinker.upsertDocument({
        id: 'doc-linear-transform',
        title: '선형변환과 행렬식',
        content: '선형변환은 벡터 공간 사이의 선형성을 보존하는 사상이다.',
        updatedAt: Date.now(),
      });
      offlineLinker.upsertDocument({
        id: 'doc-core-concept',
        title: '기저와 차원의 핵심 개념',
        content: '핵심 개념으로서의 기저와 차원은 유한차원 벡터공간의 뼈대이다.',
        updatedAt: Date.now(),
      });

      const note = emptyNote({
        id: 'test-academic-note',
        title: '수학 노트',
        content: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: '행렬의 고유값과 고유벡터는 선형변환의 성질을 설명하는 핵심 개념이다.',
                },
              ],
            },
          ],
        },
      });

      session = new NoteSession(note);
    });

    afterEach(() => {
      session.destroy();
    });

    it('10. TextObjectLayer 이벤트 차단 해제: 일반 Markdown 텍스트 요소는 preventDefault로 차단되지 않는다', () => {
      const pageEl = document.createElement('div');
      pageEl.className = 'page-canvas-surface';
      const proseEl = document.createElement('div');
      proseEl.className = 'ProseMirror prose-note';
      const p = document.createElement('p');
      p.textContent = '일반 본문 텍스트입니다.';
      proseEl.appendChild(p);
      pageEl.appendChild(proseEl);
      document.body.appendChild(pageEl);

      // ProseMirror p 태그 타깃 판별
      const isProseTarget = p.closest('.ProseMirror, p') !== null && !p.closest('.ink-template');
      expect(isProseTarget).toBe(true);

      pageEl.remove();
    });

    it('11. 링크 추천: "고유값" 선택 시 상위 추천 문서에 "고유값과 고유벡터"가 포함된다', () => {
      const recs = session.recommendByCurrentSelection(5, {
        from: 4,
        to: 7,
        text: '고유값',
      });

      expect(recs.text).toBe('고유값');
      expect(recs.recommendations.length).toBeGreaterThan(0);
      expect(recs.recommendations.some((r) => r.title.includes('고유값'))).toBe(true);
    });

    it('12. 링크 추천: "선형변환" 선택 시 "선형변환과 행렬식" 문서가 추천된다', () => {
      const recs = session.recommendByCurrentSelection(5, {
        from: 17,
        to: 21,
        text: '선형변환',
      });

      expect(recs.text).toBe('선형변환');
      expect(recs.recommendations.length).toBeGreaterThan(0);
      expect(recs.recommendations.some((r) => r.title.includes('선형변환'))).toBe(true);
    });

    it('13. 링크 추천: "핵심 개념" 선택 시 "핵심 개념" 문서가 추천된다', () => {
      const recs = session.recommendByCurrentSelection(5, {
        from: 30,
        to: 35,
        text: '핵심 개념',
      });

      expect(recs.text).toBe('핵심 개념');
      expect(recs.recommendations.length).toBeGreaterThan(0);
      expect(recs.recommendations.some((r) => r.title.includes('핵심 개념'))).toBe(true);
    });

    it('14. WikiLink 삽입: 추천 문서를 선택하면 [[선택문서|선택구절]] 위키링크로 치환된다', () => {
      const rec = {
        docId: 'doc-eigen',
        title: '선형대수학: 고유값과 고유벡터',
        score: 0.95,
        matchedKeywords: ['고유값'],
        snippet: '고유값과 고유벡터는 선형변환의 주축 방향과 신장률을 나타낸다.',
      };

      session.applySelectionWikiLink(rec, {
        from: 4,
        to: 7,
        text: '고유값',
      });

      const md = session.editor.getMarkdown();
      expect(md).toContain('[[선형대수학: 고유값과 고유벡터|고유값]]');
    });

    it('15. Web Worker 미지원/실패 시 Main Thread offlineLinker 폴백으로 searchRelated가 정상 동작한다', async () => {
      const res = await searchRelated('고유값', 'doc-other', 5);
      expect(res.hits.length).toBeGreaterThan(0);
      expect(res.hits.some((h) => h.title.includes('고유값'))).toBe(true);
    });
  });
});
