// src/core/history/types.ts
export interface HistoryCommand {
  id: string;
  type: 'editor-tr' | 'stroke-add' | 'stroke-remove' | 'stroke-move' | 'stroke-batch';
  timestamp: number;
  undo: () => void;
  redo: () => void;
}
