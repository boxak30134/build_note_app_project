// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NoteSession } from './NoteSession';
import { useSettings } from '../store/settingsStore';
import type { NoteRecord } from '../storage/db';

function createMockRecord(id: string, title: string, content: string): NoteRecord {
  return {
    id,
    title,
    folderId: null,
    content,
    markdown: content,
    plainText: content,
    strokes: [],
    annotations: [],
    encoding: 'utf-8',
    eol: 'lf',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

describe('Translation Insertion Modes (1: 원문 뒤 괄호 삽입, 2: 루비 주석, 3: 원문 대체)', () => {
  let session: NoteSession;

  beforeEach(() => {
    useSettings.setState({ translationInsertMode: 'parentheses' });
  });

  afterEach(() => {
    session?.destroy();
  });

  it('1번: parentheses 모드 - 원래 문장 뒤에 괄호치고 번역 문장을 삽입한다 (뒤에 다른 문장이 있어도 그 사이에 삽입)', () => {
    const record = createMockRecord(
      'test-note-1',
      'Algebra Note',
      '<p>This is a ring in algebra. Another sentence follows.</p>'
    );
    session = new NoteSession(record);

    // 본문에서 "ring"의 위치 찾기 (from: 11, to: 15)
    const text = session.editor.getText();
    const targetWord = 'ring';
    const from = text.indexOf(targetWord) + 1; // ProseMirror doc pos (+1 for <p>)
    const to = from + targetWord.length;

    useSettings.setState({ translationInsertMode: 'parentheses' });

    session.applyTranslation('환(環)', {
      from,
      to,
      targetWord,
      surroundingSentence: 'This is a ring in algebra.',
    });

    const updatedText = session.editor.getText();
    // "ring (환(環))" 형태로 원래 단어 바로 뒤 괄호에 삽입되며, 뒤의 " in algebra. Another sentence follows."는 그대로 유지됨
    expect(updatedText).toContain('This is a ring (환(環)) in algebra. Another sentence follows.');
  });

  it('1번: parentheses 모드 - 문장 단위 번역 시에도 다음 문장 사이에 괄호로 정상 삽입된다', () => {
    const record = createMockRecord(
      'test-note-sentence',
      'Group Theory',
      '<p>Every group has an identity element. It is unique.</p>'
    );
    session = new NoteSession(record);

    const targetSentence = 'Every group has an identity element.';
    const text = session.editor.getText();
    const from = text.indexOf(targetSentence) + 1;
    const to = from + targetSentence.length;

    useSettings.setState({ translationInsertMode: 'parentheses' });

    session.applyTranslation('모든 군은 항등원을 가진다.', {
      from,
      to,
      targetWord: targetSentence,
      surroundingSentence: text,
    });

    const updatedText = session.editor.getText();
    expect(updatedText).toBe('Every group has an identity element. (모든 군은 항등원을 가진다.) It is unique.');
  });

  it('2번: ruby 모드 - 원래 문장 위에 <ruby> 태그로 번역어를 표시한다', () => {
    const record = createMockRecord(
      'test-note-2',
      'Ruby Note',
      '<p>This is a ring in algebra.</p>'
    );
    session = new NoteSession(record);

    const text = session.editor.getText();
    const targetWord = 'ring';
    const from = text.indexOf(targetWord) + 1;
    const to = from + targetWord.length;

    useSettings.setState({ translationInsertMode: 'ruby' });

    session.applyTranslation('환', {
      from,
      to,
      targetWord,
      surroundingSentence: 'This is a ring in algebra.',
    });

    const html = session.editor.getHTML();
    expect(html).toContain('data-base="ring"');
    expect(html).toContain('data-rt="환"');
    expect(html).toContain('<rt class="ruby-rt">환</rt>');
  });

  it('3번: replace 모드 - 원래 문장을 번역 문장으로 대체(덮어쓰기)한다', () => {
    const record = createMockRecord(
      'test-note-3',
      'Replace Note',
      '<p>This is a ring in algebra. Another sentence follows.</p>'
    );
    session = new NoteSession(record);

    const text = session.editor.getText();
    const targetWord = 'ring';
    const from = text.indexOf(targetWord) + 1;
    const to = from + targetWord.length;

    useSettings.setState({ translationInsertMode: 'replace' });

    session.applyTranslation('환', {
      from,
      to,
      targetWord,
      surroundingSentence: 'This is a ring in algebra.',
    });

    const updatedText = session.editor.getText();
    expect(updatedText).toBe('This is a 환 in algebra. Another sentence follows.');
  });
});
