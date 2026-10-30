import type { HistoryCommand } from './types';

export interface CompositeHistoryOptions {
  /** 최대 보관 명령 수 */
  limit?: number;
}

type Listener = () => void;

/**
 * 에디터 트랜잭션과 캔버스 스트로크 변경을 단일 시간순 스택으로 관리하는 통합 히스토리.
 * - push: 새 명령 기록(redo 스택 폐기)
 * - merge: 직전 명령과 병합(연속 타이핑 그룹화)
 * - undo/redo 수행 중에는 isReplaying=true 로 재귀 기록을 차단한다.
 */
export class CompositeHistoryManager {
  private undoStack: HistoryCommand[] = [];
  private redoStack: HistoryCommand[] = [];
  private listeners = new Set<Listener>();
  private readonly limit: number;
  private replaying = false;

  constructor(opts: CompositeHistoryOptions = {}) {
    this.limit = opts.limit ?? 500;
  }

  get isReplaying(): boolean {
    return this.replaying;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get size(): { undo: number; redo: number } {
    return { undo: this.undoStack.length, redo: this.redoStack.length };
  }

  peek(): HistoryCommand | undefined {
    return this.undoStack[this.undoStack.length - 1];
  }

  push(cmd: HistoryCommand): void {
    if (this.replaying) return;
    this.undoStack.push(cmd);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
    this.emit();
  }

  /** 직전 명령을 새 명령으로 교체(병합 결과). redo 스택은 폐기된다. */
  replaceTop(cmd: HistoryCommand): void {
    if (this.replaying) return;
    if (this.undoStack.length === 0) return this.push(cmd);
    this.undoStack[this.undoStack.length - 1] = cmd;
    this.redoStack = [];
    this.emit();
  }

  undo(): boolean {
    const cmd = this.undoStack.pop();
    if (!cmd) return false;
    this.replaying = true;
    try {
      cmd.undo();
    } finally {
      this.replaying = false;
    }
    this.redoStack.push(cmd);
    this.emit();
    return true;
  }

  redo(): boolean {
    const cmd = this.redoStack.pop();
    if (!cmd) return false;
    this.replaying = true;
    try {
      cmd.redo();
    } finally {
      this.replaying = false;
    }
    this.undoStack.push(cmd);
    this.emit();
    return true;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.emit();
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    this.listeners.forEach((l) => l());
  }
}

let counter = 0;
export function newCommandId(): string {
  counter++;
  return `cmd-${Date.now().toString(36)}-${counter}`;
}
