import { extractBlocks, plainTextOf } from '../core/doc/blocks';
import { offlineLinker } from '../services/offlineDocumentLinker';
import { db, type NoteRecord } from '../storage/db';
import { useSettings } from '../store/settingsStore';
import type { SearchDoc, SearchHit, WorkerRequest, WorkerResponse } from './protocol';

let worker: Worker | null = null;
let reqSeq = 0;
const pending = new Map<number, (r: { hits: SearchHit[]; source: 'elasticsearch' | 'minisearch' }) => void>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./search.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
    const msg = ev.data;
    if (msg.type === 'result') {
      pending.get(msg.reqId)?.(msg);
      pending.delete(msg.reqId);
    }
  };
  const s = useSettings.getState();
  send({ type: 'config', esUrl: s.esUrl, esIndex: s.esIndex });
  useSettings.subscribe((st, prev) => {
    if (st.esUrl !== prev.esUrl || st.esIndex !== prev.esIndex) send({ type: 'config', esUrl: st.esUrl, esIndex: st.esIndex });
  });
  return worker;
}

function send(msg: WorkerRequest) {
  getWorker().postMessage(msg);
}

export function noteToDocs(note: Pick<NoteRecord, 'id' | 'title' | 'content'>): SearchDoc[] {
  return extractBlocks(note.content).map((b, i) => ({
    id: `${note.id}#${b.blockId ?? `i${i}`}`,
    noteId: note.id,
    blockId: b.blockId,
    title: note.title,
    text: b.text,
  }));
}

export function indexNote(note: Pick<NoteRecord, 'id' | 'title' | 'content'> & Partial<Pick<NoteRecord, 'markdown' | 'updatedAt'>>) {
  const rawContent = note.markdown ?? plainTextOf(note.content);
  offlineLinker.upsertDocument({
    id: note.id,
    title: note.title,
    content: rawContent,
    updatedAt: note.updatedAt ?? Date.now(),
  });
  send({ type: 'upsertNote', noteId: note.id, docs: noteToDocs(note) });
}

export function unindexNote(noteId: string) {
  offlineLinker.removeDocument(noteId);
  send({ type: 'removeNote', noteId });
}

export async function indexAllNotes() {
  const notes = await db.notes.filter((n) => !n.deletedAt).toArray();
  for (const n of notes) indexNote(n);
}

/** 비동기 논블로킹 연관 단락 검색 (Web Worker) */
export function searchRelated(text: string, excludeNoteId?: string, limit = 5) {
  const reqId = ++reqSeq;
  return new Promise<{ hits: SearchHit[]; source: 'elasticsearch' | 'minisearch' }>((resolve) => {
    pending.set(reqId, resolve);
    send({ type: 'query', reqId, text, excludeNoteId, limit });
  });
}
