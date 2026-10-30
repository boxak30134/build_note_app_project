/// <reference lib="webworker" />
/**
 * 백그라운드 검색 워커: Elasticsearch REST API 우선, 실패/미설정 시 MiniSearch(BM25) 오프라인 폴백.
 * 메인 UI 스레드를 절대 블로킹하지 않는다.
 */
import MiniSearch from 'minisearch';
import { tokenizeKo } from './tokenize';
import type { SearchDoc, WorkerRequest, WorkerResponse, SearchHit } from './protocol';

const mini = new MiniSearch<SearchDoc>({
  fields: ['title', 'text'],
  storeFields: ['noteId', 'blockId', 'title', 'text'],
  tokenize: tokenizeKo,
  searchOptions: { tokenize: tokenizeKo, boost: { title: 1.5 }, fuzzy: 0.15, prefix: true, combineWith: 'OR' },
});

const byNote = new Map<string, string[]>();
let esUrl = '';
let esIndex = 'eduink';

function post(msg: WorkerResponse) {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg);
}

function removeNote(noteId: string) {
  const ids = byNote.get(noteId);
  if (ids) {
    for (const id of ids) if (mini.has(id)) mini.discard(id);
    byNote.delete(noteId);
  }
}

async function esBulk(docs: SearchDoc[], deleteNoteId?: string) {
  if (!esUrl) return;
  try {
    if (deleteNoteId) {
      await fetch(`${esUrl}/${esIndex}/_delete_by_query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: { term: { 'noteId.keyword': deleteNoteId } } }),
      });
    }
    if (docs.length === 0) return;
    const body = docs.map((d) => `${JSON.stringify({ index: { _index: esIndex, _id: d.id } })}\n${JSON.stringify(d)}\n`).join('');
    await fetch(`${esUrl}/_bulk`, { method: 'POST', headers: { 'Content-Type': 'application/x-ndjson' }, body });
  } catch {
    /* ES 미가용 — MiniSearch 로 계속 동작 */
  }
}

async function esSearch(text: string, excludeNoteId: string | undefined, limit: number): Promise<SearchHit[]> {
  const res = await fetch(`${esUrl}/${esIndex}/_search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      size: limit,
      query: {
        bool: {
          must: { multi_match: { query: text, fields: ['title^1.5', 'text'] } },
          must_not: excludeNoteId ? [{ term: { 'noteId.keyword': excludeNoteId } }] : [],
        },
      },
    }),
  });
  if (!res.ok) throw new Error(`Elasticsearch ${res.status}`);
  const json = await res.json();
  return (json.hits?.hits ?? []).map((h: { _source: SearchDoc; _score: number }) => ({
    noteId: h._source.noteId,
    blockId: h._source.blockId,
    title: h._source.title,
    text: h._source.text,
    score: h._score,
  }));
}

function miniSearch(text: string, excludeNoteId: string | undefined, limit: number): SearchHit[] {
  return mini
    .search(text)
    .filter((r) => r.noteId !== excludeNoteId)
    .slice(0, limit)
    .map((r) => ({ noteId: r.noteId, blockId: r.blockId, title: r.title, text: r.text, score: r.score }));
}

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'config':
      esUrl = msg.esUrl.replace(/\/+$/, '');
      esIndex = msg.esIndex || 'eduink';
      break;
    case 'upsertNote': {
      removeNote(msg.noteId);
      mini.addAll(msg.docs);
      byNote.set(
        msg.noteId,
        msg.docs.map((d) => d.id),
      );
      void esBulk(msg.docs, msg.noteId);
      break;
    }
    case 'removeNote':
      removeNote(msg.noteId);
      void esBulk([], msg.noteId);
      break;
    case 'query': {
      const limit = msg.limit ?? 5;
      if (esUrl) {
        try {
          const hits = await esSearch(msg.text, msg.excludeNoteId, limit);
          post({ type: 'result', reqId: msg.reqId, hits, source: 'elasticsearch' });
          return;
        } catch {
          /* 폴백 */
        }
      }
      post({ type: 'result', reqId: msg.reqId, hits: miniSearch(msg.text, msg.excludeNoteId, limit), source: 'minisearch' });
      break;
    }
  }
};
