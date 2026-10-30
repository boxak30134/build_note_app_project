import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state';
import type { Step } from '@tiptap/pm/transform';
import type { CompositeHistoryManager } from '../../core/history/CompositeHistoryManager';
import { newCommandId } from '../../core/history/CompositeHistoryManager';
import type { HistoryCommand } from '../../core/history/types';

export const HISTORY_REPLAY_META = 'eduinkHistoryReplay';
const GROUP_MS = 600;

interface EditorTrCommand extends HistoryCommand {
  type: 'editor-tr';
  steps: Step[];
  inverted: Step[];
  editorKey: string;
}

export interface HistoryBridgeOptions {
  getHistory: () => CompositeHistoryManager | null;
  editorKey: string;
}

const bridgeKey = new PluginKey('eduinkHistoryBridge');

/**
 * TipTap 기본 history 를 대체: ProseMirror 트랜잭션의 Step 과 역변환(Inverted Step)을
 * CompositeHistoryManager 의 'editor-tr' 명령으로 푸시한다. 연속 타이핑은 600ms 이내 병합.
 */
export const HistoryBridge = Extension.create<HistoryBridgeOptions>({
  name: 'historyBridge',

  addOptions() {
    return { getHistory: () => null, editorKey: 'editor' };
  },

  addKeyboardShortcuts() {
    const undo = () => {
      this.options.getHistory()?.undo();
      return true;
    };
    const redo = () => {
      this.options.getHistory()?.redo();
      return true;
    };
    return { 'Mod-z': undo, 'Mod-Z': redo, 'Mod-Shift-z': redo, 'Mod-y': redo };
  },

  addProseMirrorPlugins() {
    const editor = this.editor;
    const opts = this.options;

    const makeCommand = (steps: Step[], inverted: Step[], timestamp: number): EditorTrCommand => ({
      id: newCommandId(),
      type: 'editor-tr',
      timestamp,
      steps,
      inverted,
      editorKey: opts.editorKey,
      undo: () => {
        const tr = editor.state.tr;
        for (let i = inverted.length - 1; i >= 0; i--) tr.maybeStep(inverted[i]);
        tr.setMeta(HISTORY_REPLAY_META, true).setMeta('addToHistory', false);
        editor.view.dispatch(tr);
      },
      redo: () => {
        const tr = editor.state.tr;
        for (const s of steps) tr.maybeStep(s);
        tr.setMeta(HISTORY_REPLAY_META, true).setMeta('addToHistory', false);
        editor.view.dispatch(tr);
      },
    });

    const record = (tr: Transaction) => {
      const history = opts.getHistory();
      if (!history || history.isReplaying) return;
      const steps = tr.steps.slice();
      const inverted = tr.steps.map((s, i) => s.invert(tr.docs[i]));
      const now = Date.now();
      const top = history.peek() as EditorTrCommand | undefined;
      const isTyping = !tr.getMeta('paste') && !tr.getMeta('uiEvent') && !tr.getMeta('forceNewGroup');
      if (top && top.type === 'editor-tr' && top.editorKey === opts.editorKey && isTyping && now - top.timestamp < GROUP_MS) {
        history.replaceTop(makeCommand([...top.steps, ...steps], [...top.inverted, ...inverted], now));
      } else {
        history.push(makeCommand(steps, inverted, now));
      }
    };

    return [
      new Plugin({
        key: bridgeKey,
        state: {
          init: () => null,
          apply(tr, value) {
            if (tr.docChanged && !tr.getMeta(HISTORY_REPLAY_META) && tr.getMeta('addToHistory') !== false) {
              record(tr);
            }
            return value;
          },
        },
      }),
    ];
  },
});
