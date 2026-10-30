import { describe, expect, it } from 'vitest';
import { CompositeHistoryManager, newCommandId } from './CompositeHistoryManager';
import { StrokeStore, type Stroke } from '../strokes/StrokeStore';

/** 간단한 텍스트 모델: editor-tr 명령으로 기록 */
class FakeTextModel {
  text = '';
  constructor(private history: CompositeHistoryManager) {}
  type(s: string) {
    const before = this.text;
    const after = before + s;
    this.text = after;
    this.history.push({
      id: newCommandId(),
      type: 'editor-tr',
      timestamp: Date.now(),
      undo: () => (this.text = before),
      redo: () => (this.text = after),
    });
  }
}

const stroke = (id: string, x = 0): Stroke => ({
  id,
  tool: 'pencil',
  color: '#000000',
  size: 4,
  points: [
    [x, 0, 0.5],
    [x + 10, 10, 0.5],
  ],
});

describe('CompositeHistoryManager 통합 Undo/Redo', () => {
  it('텍스트 입력 → 펜 필기 → 지우개 → Undo 3회 → Redo 3회 상태 무결성', () => {
    const h = new CompositeHistoryManager();
    const text = new FakeTextModel(h);
    const strokes = new StrokeStore(h);

    text.type('안녕하세요');
    strokes.addStroke(stroke('a'));
    strokes.removeStrokes(['a']); // 지우개

    const snapshot = () => ({ text: text.text, strokes: strokes.getAll().map((s) => s.id) });
    const s3 = snapshot();
    expect(s3).toEqual({ text: '안녕하세요', strokes: [] });

    h.undo(); // 지우개 취소
    expect(snapshot()).toEqual({ text: '안녕하세요', strokes: ['a'] });
    h.undo(); // 필기 취소
    expect(snapshot()).toEqual({ text: '안녕하세요', strokes: [] });
    h.undo(); // 텍스트 취소
    expect(snapshot()).toEqual({ text: '', strokes: [] });
    expect(h.canUndo).toBe(false);

    h.redo();
    expect(snapshot()).toEqual({ text: '안녕하세요', strokes: [] });
    h.redo();
    expect(snapshot()).toEqual({ text: '안녕하세요', strokes: ['a'] });
    h.redo();
    expect(snapshot()).toEqual(s3);
    expect(h.canRedo).toBe(false);
  });

  it('지우개로 지운 스트로크는 원래 순서(z-order) 위치로 복원', () => {
    const h = new CompositeHistoryManager();
    const st = new StrokeStore(h);
    st.addStroke(stroke('a'));
    st.addStroke(stroke('b'));
    st.addStroke(stroke('c'));
    st.removeStrokes(['b']);
    h.undo();
    expect(st.getAll().map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });

  it('올가미 이동: 미리보기 이동 후 commit 은 단일 명령, undo 시 원위치', () => {
    const h = new CompositeHistoryManager();
    const st = new StrokeStore(h);
    st.addStroke(stroke('a'));
    st.previewTranslate(['a'], 5, 5);
    st.previewTranslate(['a'], 5, 5);
    st.commitMove(['a'], 10, 10);
    expect(st.get('a')!.points[0]).toEqual([10, 10, 0.5]);
    expect(h.size.undo).toBe(2);
    h.undo();
    expect(st.get('a')!.points[0]).toEqual([0, 0, 0.5]);
    h.redo();
    expect(st.get('a')!.points[0]).toEqual([10, 10, 0.5]);
  });

  it('새 명령 push 시 redo 스택 폐기, replay 중에는 기록 차단', () => {
    const h = new CompositeHistoryManager();
    const st = new StrokeStore(h);
    st.addStroke(stroke('a'));
    h.undo();
    expect(h.canRedo).toBe(true);
    st.addStroke(stroke('b'));
    expect(h.canRedo).toBe(false);
    h.push({
      id: 'x',
      type: 'stroke-batch',
      timestamp: 0,
      undo: () => h.push({ id: 'nested', type: 'stroke-add', timestamp: 0, undo() {}, redo() {} }),
      redo() {},
    });
    h.undo();
    expect(h.size.undo).toBe(1);
  });
});
