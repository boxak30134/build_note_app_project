// src/core/history/types.ts
export type CommandType =
  | 'editor-tr'
  | 'stroke-add'
  | 'stroke-remove'
  | 'stroke-move'
  | 'stroke-batch'
  | 'text-add'
  | 'text-update'
  | 'text-delete'
  | 'page-add'
  | 'page-delete'
  | 'page-reorder'
  | 'page-duplicate'
  | 'annotation-add'
  | 'annotation-delete'
  | 'annotation-update'
  | 'composite-transaction';

export interface HistoryCommand {
  id: string;
  type: CommandType;
  timestamp: number;
  undo: () => void;
  redo: () => void;
  description?: string;
}
