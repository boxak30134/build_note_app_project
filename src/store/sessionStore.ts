import { create } from 'zustand';
import type { Annotation } from '../features/annotations/types';
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
      const cur = st.sessions[id] ?? emptySession();
      const delta = typeof p === 'function' ? p(cur) : p;
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
