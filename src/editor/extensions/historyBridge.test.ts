// @vitest-environment jsdom
import { describe, expect, it, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { HistoryBridge } from './historyBridge';
import { BlockId, ASSIGN_IDS_META } from './blockId';
import { CompositeHistoryManager } from '../../core/history/CompositeHistoryManager';
import { StrokeStore, type Stroke } from '../../core/strokes/StrokeStore';

const stroke = (id: string): Stroke => ({
  id,
  tool: 'pencil',
  color: '#000',
  size: 3,
  points: [
    [0, 0, 0.5],
    [10, 10, 0.5],
  ],
});

let editor: Editor | null = null;
afterEach(() => editor?.destroy());

function setup() {
  const history = new CompositeHistoryManager();
  const strokes = new StrokeStore(history);
  editor = new Editor({
    element: document.createElement('div'),
    extensions: [StarterKit.configure({ undoRedo: false }), BlockId, HistoryBridge.configure({ getHistory: () => history, editorKey: 't' })],
    content: '<p>시작</p>',
  });
  editor.view.dispatch(editor.state.tr.setMeta(ASSIGN_IDS_META, true).setMeta('addToHistory', false));
  return { history, strokes, editor };
}

describe('TipTap ↔ CompositeHistoryManager 통합 (실제 ProseMirror 트랜잭션)', () => {
  it('텍스트 입력 → 펜 필기 → 지우개 → Undo×3 → Redo×3', () => {
    const { history, strokes, editor: ed } = setup();
    expect(history.size.undo).toBe(0); // 블록 ID 부여는 히스토리에 기록되지 않음

    ed.commands.insertContentAt(ed.state.doc.content.size - 1, ' 안녕');
    strokes.addStroke(stroke('s1'));
    strokes.removeStrokes(['s1']);
    const finalText = ed.getText();
    expect(finalText).toBe('시작 안녕');
    expect(history.size.undo).toBe(3);

    history.undo();
    expect(strokes.getAll().map((s) => s.id)).toEqual(['s1']);
    expect(ed.getText()).toBe('시작 안녕');
    history.undo();
    expect(strokes.getAll()).toEqual([]);
    expect(ed.getText()).toBe('시작 안녕');
    history.undo();
    expect(ed.getText()).toBe('시작');
    expect(history.canUndo).toBe(false);

    history.redo();
    expect(ed.getText()).toBe('시작 안녕');
    expect(strokes.getAll()).toEqual([]);
    history.redo();
    expect(strokes.getAll().map((s) => s.id)).toEqual(['s1']);
    history.redo();
    expect(strokes.getAll()).toEqual([]);
    expect(ed.getText()).toBe(finalText);
    expect(history.canRedo).toBe(false);
  });

  it('600ms 이내 연속 타이핑은 하나의 명령으로 병합, 텍스트 삭제도 기록', () => {
    const { history, editor: ed } = setup();
    const end = () => ed.state.doc.content.size - 1;
    ed.commands.insertContentAt(end(), 'a');
    ed.commands.insertContentAt(end(), 'b');
    ed.commands.insertContentAt(end(), 'c');
    expect(history.size.undo).toBe(1);
    history.undo();
    expect(ed.getText()).toBe('시작');
    history.redo();
    expect(ed.getText()).toBe('시작abc');

    // 삭제 (강제 새 그룹)
    ed.view.dispatch(ed.state.tr.delete(end() - 3, end()).setMeta('forceNewGroup', true));
    expect(ed.getText()).toBe('시작');
    history.undo();
    expect(ed.getText()).toBe('시작abc');
  });
});
