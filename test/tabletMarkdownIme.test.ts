// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { setDeviceOverrideForTest, isTouchDevice } from '../src/core/utils/device';
import {
  TabletMarkdownImeFix,
  evaluateMarkdownIme,
} from '../src/editor/extensions/tabletMarkdownImeFix';
import { isPointerInsidePageCanvasSurface } from '../src/core/input/gestureRouting';

describe('안드로이드 태블릿/가상 키보드 마크다운 IME 보정 및 데스크톱 격리', () => {
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

  describe('1. 디바이스 환경 격리 (isTouchDevice)', () => {
    it('데스크톱 PC 환경(override=false)에서는 isTouchDevice가 false를 반환한다', () => {
      setDeviceOverrideForTest(false);
      expect(isTouchDevice()).toBe(false);
    });

    it('태블릿/모바일 터치 환경(override=true)에서는 isTouchDevice가 true를 반환한다', () => {
      setDeviceOverrideForTest(true);
      expect(isTouchDevice()).toBe(true);
    });
  });

  describe('2. 태블릿 가상 키보드 환경 마크다운 변환 (Heading)', () => {
    beforeEach(() => {
      setDeviceOverrideForTest(true);
    });

    it('# 입력 후 compositionend 발생 시 H1 노드로 변환되고 "# " 텍스트는 제거된다', () => {
      // 본문에 '# ' 삽입 (insertContent는 끝 공백을 온전히 보존)
      editor.commands.setContent('<p></p>');
      editor.commands.insertContent('# ');

      const handled = evaluateMarkdownIme(editor.view);
      expect(handled).toBe(true);

      const json = editor.getJSON();
      const firstNode = json.content?.[0];
      expect(firstNode?.type).toBe('heading');
      expect(firstNode?.attrs?.level).toBe(1);
      expect(editor.getText().trim()).toBe('');
    });

    it('##, ###, ####, #####, ###### 입력 시 각각 H2~H6 노드로 변환된다', () => {
      for (let level = 2; level <= 6; level++) {
        const hashes = '#'.repeat(level) + ' ';
        editor.commands.setContent('<p></p>');
        editor.commands.insertContent(hashes);

        const handled = evaluateMarkdownIme(editor.view);
        expect(handled).toBe(true);

        const json = editor.getJSON();
        const firstNode = json.content?.[0];
        expect(firstNode?.type).toBe('heading');
        expect(firstNode?.attrs?.level).toBe(level);
      }
    });
  });

  describe('3. 태블릿 가상 키보드 환경 블록 및 인라인 마크다운 변환', () => {
    beforeEach(() => {
      setDeviceOverrideForTest(true);
    });

    it('> 입력 후 compositionend 발생 시 blockquote로 감싸진다', () => {
      editor.commands.setContent('<p></p>');
      editor.commands.insertContent('> ');

      const handled = evaluateMarkdownIme(editor.view);
      expect(handled).toBe(true);

      const json = editor.getJSON();
      expect(json.content?.[0]?.type).toBe('blockquote');
    });

    it('- 입력 후 bulletList로 변환된다', () => {
      editor.commands.setContent('<p></p>');
      editor.commands.insertContent('- ');

      const handled = evaluateMarkdownIme(editor.view);
      expect(handled).toBe(true);

      const json = editor.getJSON();
      expect(json.content?.[0]?.type).toBe('bulletList');
    });

    it('1. 입력 후 orderedList로 변환된다', () => {
      editor.commands.setContent('<p></p>');
      editor.commands.insertContent('1. ');

      const handled = evaluateMarkdownIme(editor.view);
      expect(handled).toBe(true);

      const json = editor.getJSON();
      expect(json.content?.[0]?.type).toBe('orderedList');
    });

    it('**굵은글씨** 입력 후 bold mark가 적용되고 ** 기호가 제거된다', () => {
      editor.commands.setContent('<p></p>');
      editor.commands.insertContent('**굵은글씨** ');

      const handled = evaluateMarkdownIme(editor.view);
      expect(handled).toBe(true);

      const json = editor.getJSON();
      const para = json.content?.[0];
      const textNode = para?.content?.[0];
      expect(textNode?.text).toContain('굵은글씨');
      expect(textNode?.marks?.[0]?.type).toBe('bold');
      expect(editor.getText()).not.toContain('**');
    });
  });

  describe('4. 데스크톱 PC 회귀 방지 (Regression Prevention)', () => {
    beforeEach(() => {
      setDeviceOverrideForTest(false); // PC 환경
    });

    it('데스크톱 PC 환경에서는 evaluateMarkdownIme가 false를 반환하여 기본 동작을 방해하지 않는다', () => {
      editor.commands.setContent('<p></p>');
      editor.commands.insertContent('# ');

      const handled = evaluateMarkdownIme(editor.view);
      expect(handled).toBe(false);

      // state가 변조되지 않고 그대로 유지됨
      const json = editor.getJSON();
      expect(json.content?.[0]?.type).toBe('paragraph');
      expect(editor.getText()).toBe('# ');
    });

    it('한글 입력 중("학교", "가") compositionend가 발생해도 단어가 복제되거나 삭제되지 않는다', () => {
      setDeviceOverrideForTest(true); // 태블릿 모드에서도 한글 입력은 무변조 보장
      editor.commands.setContent('<p></p>');
      editor.commands.insertContent('학교');

      const handled = evaluateMarkdownIme(editor.view);
      expect(handled).toBe(false);

      expect(editor.getText()).toBe('학교');
    });
  });

  describe('5. 에디터 텍스트 입력 영역 캔버스 포인터 가드 바이패스', () => {
    it('[data-overlay], button, input, textarea 등의 UI 요소는 캔버스 포인터 가드가 false를 반환하여 이벤트를 바이패스한다', () => {
      const pageEl = document.createElement('div');
      pageEl.className = 'page-canvas-surface';
      document.body.appendChild(pageEl);

      const input = document.createElement('input');
      pageEl.appendChild(input);

      const dummyEvent = {
        clientX: 100,
        clientY: 100,
        target: input,
      };

      const result = isPointerInsidePageCanvasSurface(dummyEvent, pageEl);
      expect(result).toBe(false);

      pageEl.remove();
    });
  });
});
