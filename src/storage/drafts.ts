/** 작성 중 내용(Draft) 로컬 임시 저장: drafts[tabId] */
import type { Stroke } from '../core/strokes/StrokeStore';
import type { Annotation } from '../features/annotations/types';

export interface NoteDraft {
  doc: unknown;
  strokes: Stroke[];
  annotations: Annotation[];
  at: number;
}

const KEY = 'eduink-drafts';
const BUBBLE_KEY = 'eduink-bubble-drafts';

function readAll<T>(key: string): Record<string, T> {
  try {
    return JSON.parse(localStorage.getItem(key) ?? '{}');
  } catch {
    return {};
  }
}

function writeAll(key: string, v: Record<string, unknown>) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    // 용량 초과 시 조용히 무시 (Dexie 저장본은 안전)
  }
}

export const drafts = {
  get(tabId: string): NoteDraft | undefined {
    return readAll<NoteDraft>(KEY)[tabId];
  },
  set(tabId: string, d: NoteDraft) {
    const all = readAll<NoteDraft>(KEY);
    all[tabId] = d;
    writeAll(KEY, all);
  },
  clear(tabId: string) {
    const all = readAll<NoteDraft>(KEY);
    delete all[tabId];
    writeAll(KEY, all);
  },
};

/** 말풍선 질문 입력창의 미제출 텍스트 */
export const bubbleDrafts = {
  get(id: string): string {
    return readAll<string>(BUBBLE_KEY)[id] ?? '';
  },
  set(id: string, text: string) {
    const all = readAll<string>(BUBBLE_KEY);
    if (text) all[id] = text;
    else delete all[id];
    writeAll(BUBBLE_KEY, all);
  },
};
