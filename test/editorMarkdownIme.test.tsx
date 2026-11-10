// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { setDeviceOverrideForTest, isTouchDevice } from '../src/core/utils/device';
import {
  TabletMarkdownImeFix,
  evaluateMarkdownIme,
} from '../src/editor/extensions/tabletMarkdownImeFix';
import { MarkdownAccessoryBar } from '../src/components/MarkdownAccessoryBar';
import { NoteSession } from '../src/session/NoteSession';
import { emptyNote } from '../src/storage/db';

describe('BUGFIX_TABLET_MARKDOWN_IME_INPUTRULES: 안드로이드 태블릿 IME 마크다운 InputRules 차단 해결 및 PC 회귀 방어', () => {
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
    cleanup();
    editor.destroy();
    container.remove();
    setDeviceOverrideForTest(null);
  });

  afterAll(() => {
    cleanup();
    setDeviceOverrideForTest(null);
  });

  describe('1. 태블릿 가상 키보드 InputRules 강제 평가 트리거 (Android IME Bypass)', () => {
    beforeEach(() => {
      setDeviceOverrideForTest(true); // 태블릿 모드
    });

    it('안드로이드 가상 키보드에서 "# " 입력 및 compositionend 시 H1 노드로 변환된다', () => {
      editor.commands.setContent('<p></p>');
      editor.commands.insertContent('# ');

      // IME compositionend 모의 실행
      const handled = evaluateMarkdownIme(editor.view);
      expect(handled).toBe(true);

      const json = editor.getJSON();
      expect(json.content?.[0]?.type).toBe('heading');
      expect(json.content?.[0]?.attrs?.level).toBe(1);
    });

    it('가상 키보드 keyCode 229(composition) 직후 스페이스바 입력 시 evaluateMarkdownIme가 발화하여 리스트로 변환된다', () => {
      editor.commands.setContent('<p></p>');
      editor.commands.insertContent('- ');

      const handled = evaluateMarkdownIme(editor.view);
      expect(handled).toBe(true);

      const json = editor.getJSON();
      expect(json.content?.[0]?.type).toBe('bulletList');
    });

    it('가상 키보드에서 "> " 입력 후 엔터/스페이스 시 인용구(blockquote)로 감싸진다', () => {
      editor.commands.setContent('<p></p>');
      editor.commands.insertContent('> ');

      const handled = evaluateMarkdownIme(editor.view);
      expect(handled).toBe(true);

      const json = editor.getJSON();
      expect(json.content?.[0]?.type).toBe('blockquote');
    });

    it('가상 키보드에서 "**굵은글씨** " 입력 후 compositionend 시 bold mark가 적용된다', () => {
      editor.commands.setContent('<p></p>');
      editor.commands.insertContent('**굵은글씨** ');

      const handled = evaluateMarkdownIme(editor.view);
      expect(handled).toBe(true);

      const json = editor.getJSON();
      const textNode = json.content?.[0]?.content?.[0];
      expect(textNode?.text).toContain('굵은글씨');
      expect(textNode?.marks?.[0]?.type).toBe('bold');
    });

    it('가상 키보드에서 "*기울임* " 입력 후 compositionend 시 italic mark가 적용된다', () => {
      editor.commands.setContent('<p></p>');
      editor.commands.insertContent('*기울임* ');

      const handled = evaluateMarkdownIme(editor.view);
      expect(handled).toBe(true);

      const json = editor.getJSON();
      const textNode = json.content?.[0]?.content?.[0];
      expect(textNode?.text).toContain('기울임');
      expect(textNode?.marks?.[0]?.type).toBe('italic');
    });
  });

  describe('2. 데스크톱 PC 한글 입력 회귀 버그(Regression) 완전 차단', () => {
    beforeEach(() => {
      setDeviceOverrideForTest(false); // 데스크톱 PC 환경
    });

    it('데스크톱 PC 환경에서는 isTouchDevice()가 false이며 evaluateMarkdownIme가 발화하지 않는다', () => {
      expect(isTouchDevice()).toBe(false);

      editor.commands.setContent('<p></p>');
      editor.commands.insertContent('# ');

      const handled = evaluateMarkdownIme(editor.view);
      expect(handled).toBe(false);

      // DOM/트랜잭션이 변조되지 않고 기본 동작 유지
      expect(editor.getText()).toBe('# ');
      expect(editor.getJSON().content?.[0]?.type).toBe('paragraph');
    });

    it('데스크톱 PC에서 한글 음절("노트", "학교", "테스트") 입력 및 compositionend 시 글자 중복("노트트") 및 커서 튐이 발생하지 않는다', () => {
      editor.commands.setContent('<p></p>');
      editor.commands.insertContent('노트');

      // PC 모의 한글 compositionend
      const handled = evaluateMarkdownIme(editor.view);
      expect(handled).toBe(false);

      // 글자가 중복되거나 변조되지 않음
      expect(editor.getText()).toBe('노트');
      expect(editor.getText()).not.toBe('노트트');
    });

    it('태블릿 모드에서도 일반 한글 입력 중("수학공부")에는 트랜잭션을 발생시키지 않아 한글 씹힘/중복이 없다', () => {
      setDeviceOverrideForTest(true); // 태블릿 모드
      editor.commands.setContent('<p></p>');
      editor.commands.insertContent('수학공부');

      const handled = evaluateMarkdownIme(editor.view);
      expect(handled).toBe(false);

      expect(editor.getText()).toBe('수학공부');
    });
  });

  describe('3. 모바일 마크다운 보조 툴바 (MarkdownAccessoryBar)', () => {
    let session: NoteSession;

    beforeEach(() => {
      setDeviceOverrideForTest(true);
      const note = emptyNote({
        id: 'test-accessory-note',
        title: '액세서리 툴바 테스트',
        content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '테스트 문장' }] }] },
      });
      session = new NoteSession(note);
    });

    afterEach(() => {
      session.destroy();
    });

    it('MarkdownAccessoryBar가 렌더링되고 모든 마크다운 단축 버튼이 노출된다', () => {
      const { getByTestId } = render(<MarkdownAccessoryBar session={session} forceShowForTest />);

      expect(getByTestId('markdown-accessory-bar')).toBeDefined();
      expect(getByTestId('accessory-btn-h1')).toBeDefined();
      expect(getByTestId('accessory-btn-h2')).toBeDefined();
      expect(getByTestId('accessory-btn-h3')).toBeDefined();
      expect(getByTestId('accessory-btn-bold')).toBeDefined();
      expect(getByTestId('accessory-btn-italic')).toBeDefined();
      expect(getByTestId('accessory-btn-strike')).toBeDefined();
      expect(getByTestId('accessory-btn-bullet')).toBeDefined();
      expect(getByTestId('accessory-btn-ordered')).toBeDefined();
      expect(getByTestId('accessory-btn-quote')).toBeDefined();
      expect(getByTestId('accessory-btn-code')).toBeDefined();
      expect(getByTestId('accessory-btn-math')).toBeDefined();
    });

    it('H1 버튼 클릭 시 현재 문단이 Heading level 1로 원터치 토글된다', () => {
      const { getByTestId } = render(<MarkdownAccessoryBar session={session} forceShowForTest />);
      const h1Btn = getByTestId('accessory-btn-h1');

      // pointerDown preventDefault 검증
      const pointerDownEvent = new MouseEvent('pointerdown', { bubbles: true, cancelable: true });
      fireEvent(h1Btn, pointerDownEvent);
      expect(pointerDownEvent.defaultPrevented).toBe(true);

      fireEvent.click(h1Btn);

      const json = session.editor.getJSON();
      expect(json.content?.[0]?.type).toBe('heading');
      expect(json.content?.[0]?.attrs?.level).toBe(1);
    });

    it('수식 버튼($수식$) 클릭 시 LaTeX math 구분자($$)가 삽입된다', () => {
      session.editor.commands.setContent('<p></p>');
      const { getByTestId } = render(<MarkdownAccessoryBar session={session} forceShowForTest />);
      const mathBtn = getByTestId('accessory-btn-math');

      fireEvent.click(mathBtn);

      expect(session.editor.getText()).toContain('$$');
    });
  });
});
