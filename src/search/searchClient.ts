import { extractBlocks, plainTextOf } from '../core/doc/blocks';
import { offlineLinker } from '../services/offlineDocumentLinker';
import { db, type NoteRecord } from '../storage/db';
import { useSettings } from '../store/settingsStore';
import type { SearchDoc, SearchHit, WorkerRequest, WorkerResponse } from './protocol';

let worker: Worker | null = null;
let workerFailed = false;
let reqSeq = 0;
const pending = new Map<number, (r: { hits: SearchHit[]; source: 'elasticsearch' | 'minisearch' }) => void>();

function getWorker(): Worker | null {
  if (workerFailed) return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL('./search.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const msg = ev.data;
      if (msg.type === 'result') {
        pending.get(msg.reqId)?.(msg);
        pending.delete(msg.reqId);
      }
    };
    worker.onerror = (err) => {
      console.warn('[SEARCH_WORKER_ERROR] Web Worker encountered error, falling back to main-thread search:', err);
      workerFailed = true;
      worker = null;
    };
    const s = useSettings.getState();
    send({ type: 'config', esUrl: s.esUrl, esIndex: s.esIndex });
    useSettings.subscribe((st, prev) => {
      if (st.esUrl !== prev.esUrl || st.esIndex !== prev.esIndex) send({ type: 'config', esUrl: st.esUrl, esIndex: st.esIndex });
    });
    return worker;
  } catch (err) {
    console.warn('[SEARCH_WORKER_INIT_FAILED] Web Worker module creation failed, falling back to offlineLinker:', err);
    workerFailed = true;
    worker = null;
    return null;
  }
}

function send(msg: WorkerRequest) {
  const w = getWorker();
  if (w) {
    try {
      w.postMessage(msg);
    } catch (e) {
      console.warn('[SEARCH_WORKER_POSTMESSAGE_FAILED]', e);
    }
  }
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

/** 비동기 논블로킹 연관 단락 검색 (Web Worker 우선, 미지원/실패 시 offlineLinker 메인스레드 폴백) */
export function searchRelated(text: string, excludeNoteId?: string, limit = 5) {
  const fallback = () => {
    const recs = offlineLinker.recommendBySelection(text, excludeNoteId, limit);
    const hits: SearchHit[] = recs.map((r) => ({
      noteId: r.docId,
      blockId: null,
      title: r.title,
      text: r.snippet || r.title,
      score: r.score,
    }));
    return { hits, source: 'minisearch' as const };
  };

  const w = getWorker();
  if (!w) {
    return Promise.resolve(fallback());
  }

  const reqId = ++reqSeq;
  return new Promise<{ hits: SearchHit[]; source: 'elasticsearch' | 'minisearch' }>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(reqId);
      console.warn('[SEARCH_WORKER_TIMEOUT] Worker query timed out (2000ms), falling back to offlineLinker');
      resolve(fallback());
    }, 2000);

    pending.set(reqId, (res) => {
      clearTimeout(timer);
      resolve(res);
    });

    send({ type: 'query', reqId, text, excludeNoteId, limit });
  });
}
