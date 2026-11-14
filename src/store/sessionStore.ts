import { create } from 'zustand';
import type { Annotation } from '../features/annotations/types';
import type { NoteTextObject } from '../core/text/textObjects';
import { createPage, DEFAULT_NOTE_ZOOM, type NotePage } from '../core/page/pageTypes';
import type { LinkRecommendation } from '../services/offlineDocumentLinker';

export interface CitationResult {
  noteId: string;
  blockId: string | null;
  title: string;
  text: string;
  score: number;
}

export interface PendingCitation {
  id: string;
  from: number;
  to: number;
  text: string;
  status: 'pending' | 'done' | 'error';
  source?: 'elasticsearch' | 'minisearch';
  results: CitationResult[];
  error?: string;
}

export interface SessionUI {
  loaded: boolean;
  dirty: boolean;
  readOnly: boolean;
  external: null | 'modified' | 'deleted';
  annotations: Annotation[];
  openAnnotationId: string | null;
  /** 백그라운드에서 AI 스트리밍 응답이 진행 중인 말풍선 ID 맵 */
  streamingAnnotationIds?: Record<string, boolean>;
  /** 페이지 앵커 기반 독립형 텍스트 객체 목록 및 현재 편집 중인 텍스트 객체 ID */
  textObjects: NoteTextObject[];
  editingTextObjectId: string | null;
  lassoIds: string[];
  moveMode: boolean;
  citations: PendingCitation[];
  openCitationId: string | null;
  /** 히스토리 버튼 상태 */
  canUndo: boolean;
  canRedo: boolean;
  /** 문서 페이지 리스트 (기본 A4 1페이지) 및 현재 포커스된 페이지 인덱스 */
  pages: NotePage[];
  currentPageIndex: number;
  /** 노트 영역 확대/축소 배율 (기본 1.0, 범위 0.5 ~ 3.0) */
  zoom: number;
  /** 오프라인 TF-IDF 코사인 유사도 + 태그 기반 연관 노트 추천 목록 */
  relatedNotes: LinkRecommendation[];
}

const emptySession = (): SessionUI => ({
  loaded: false,
  dirty: false,
  readOnly: false,
  external: null,
  annotations: [],
  openAnnotationId: null,
  streamingAnnotationIds: {},
  textObjects: [],
  editingTextObjectId: null,
  lassoIds: [],
  moveMode: false,
  citations: [],
  openCitationId: null,
  canUndo: false,
  canRedo: false,
  pages: [createPage()],
  currentPageIndex: 0,
  zoom: DEFAULT_NOTE_ZOOM,
  relatedNotes: [],
});

interface SessionsState {
  sessions: Record<string, SessionUI>;
  patch: (id: string, p: Partial<SessionUI> | ((s: SessionUI) => Partial<SessionUI>)) => void;
  remove: (id: string) => void;
}

export const useSessions = create<SessionsState>((set) => ({
  sessions: {},
  patch: (id, p) =>
    set((st) => {
      const existing = st.sessions[id];
      const cur = existing ?? emptySession();
      const delta = typeof p === 'function' ? p(cur) : p;
      if (existing) {
        const keys = Object.keys(delta) as Array<keyof SessionUI>;
        const hasChange = keys.some((k) => !Object.is(cur[k], delta[k]));
        if (!hasChange) return st;
      }
      return { sessions: { ...st.sessions, [id]: { ...cur, ...delta } } };
    }),
  remove: (id) =>
    set((st) => {
      const next = { ...st.sessions };
      delete next[id];
      return { sessions: next };
    }),
}));

export function useSessionUI(id: string | null): SessionUI {
  return useSessions((s) => (id ? s.sessions[id] : undefined)) ?? EMPTY;
}

const EMPTY = emptySession();

export function getSessionUI(id: string): SessionUI {
  return useSessions.getState().sessions[id] ?? EMPTY;
}
