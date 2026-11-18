// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { db, seedIfEmpty, type NoteRecord } from '../src/storage/db';
import { markdownToJson } from '../src/editor/extensions';

describe('최초 접속 온보딩 README 시딩 및 마크다운 검증', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1. 최초 접속(count === 0) 시 README (시작 가이드) 노트를 최상위 updatedAt으로 시딩하고 유효한 TipTap 문서로 파싱된다', async () => {
    vi.spyOn(db.notes, 'count').mockResolvedValue(0);
    const foldersBulkAdd = vi.spyOn(db.folders, 'bulkAdd').mockResolvedValue([] as never);
    let addedNotes: NoteRecord[] = [];
    const notesBulkAdd = vi.spyOn(db.notes, 'bulkAdd').mockImplementation(async (items) => {
      addedNotes = [...items] as NoteRecord[];
      return [] as never;
    });

    await seedIfEmpty();

    expect(foldersBulkAdd).toHaveBeenCalledTimes(1);
    expect(notesBulkAdd).toHaveBeenCalledTimes(1);
    expect(addedNotes).toHaveLength(4);

    // App.tsx 최초 실행 로직(orderBy('updatedAt').reverse())과 동일하게 내림차순 정렬 시 1순위가 README여야 함
    const sortedByRecent = [...addedNotes].sort((a, b) => b.updatedAt - a.updatedAt);
    const firstOpened = sortedByRecent[0];
    expect(firstOpened.title).toBe('README (시작 가이드)');
    expect(firstOpened.folderId).toBeNull();
    expect(firstOpened.content).toBeUndefined();
    expect(firstOpened.markdown).toContain('EduInk Studio 시작 가이드');
    expect(firstOpened.markdown).toContain('S-Pen');
    expect(firstOpened.markdown).toContain('AI 튜터');
    expect(firstOpened.plainText.length).toBeGreaterThan(50);

    const parsedDoc = markdownToJson(firstOpened.markdown) as { type?: string; content?: unknown[] };
    expect(parsedDoc.type).toBe('doc');
    expect(Array.isArray(parsedDoc.content)).toBe(true);
    expect((parsedDoc.content ?? []).length).toBeGreaterThan(3);
  });

  it('2. 이미 노트가 존재하는 기존 사용자(count > 0)에게는 seedIfEmpty가 중복 시딩을 수행하지 않는다', async () => {
    vi.spyOn(db.notes, 'count').mockResolvedValue(2);
    const foldersBulkAdd = vi.spyOn(db.folders, 'bulkAdd').mockResolvedValue([] as never);
    const notesBulkAdd = vi.spyOn(db.notes, 'bulkAdd').mockResolvedValue([] as never);

    await seedIfEmpty();

    expect(foldersBulkAdd).not.toHaveBeenCalled();
    expect(notesBulkAdd).not.toHaveBeenCalled();
  });
});
