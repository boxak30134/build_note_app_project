export interface SearchDoc {
  id: string;
  noteId: string;
  blockId: string | null;
  title: string;
  text: string;
}

export interface SearchHit {
  noteId: string;
  blockId: string | null;
  title: string;
  text: string;
  score: number;
}

export type WorkerRequest =
  | { type: 'config'; esUrl: string; esIndex: string }
  | { type: 'upsertNote'; noteId: string; docs: SearchDoc[] }
  | { type: 'removeNote'; noteId: string }
  | { type: 'query'; reqId: number; text: string; excludeNoteId?: string; limit?: number };

export type WorkerResponse = { type: 'result'; reqId: number; hits: SearchHit[]; source: 'elasticsearch' | 'minisearch' };
