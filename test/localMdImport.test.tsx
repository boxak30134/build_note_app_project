// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { detectImportKind } from '../src/features/import/importer';
import {
  importMarkdownFiles,
  MD_ACCEPT_ATTR,
  PDF_AND_MD_ACCEPT_ATTR,
} from '../src/storage/localFiles';
import * as localFilesMod from '../src/storage/localFiles';
import { LeftSidebar } from '../src/components/LeftSidebar';
import { NoteSession } from '../src/session/NoteSession';
import { markdownToJson } from '../src/editor/extensions';
import { encodeText } from '../src/core/codec/textCodec';
import { db, emptyNote, type NoteRecord } from '../src/storage/db';
import { useTabs } from '../src/store/tabsStore';

vi.mock('../src/search/searchClient', () => ({
  indexNote: vi.fn(),
  unindexNote: vi.fn(),
  searchRelated: vi.fn().mockResolvedValue([]),
}));

function makeBinaryFile(bytes: Uint8Array, name: string, type: string): File {
  const f = new File([bytes as BlobPart], name, { type });
  if (typeof f.arrayBuffer !== 'function') {
    Object.defineProperty(f, 'arrayBuffer', {
      value: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    });
  }
  return f;
}

describe('REQ_local_md_import: 로컬 PC·태블릿 PDF 및 Markdown(.md) 가져오기', () => {
  beforeEach(() => {
    cleanup();
    vi.restoreAllMocks();
    useTabs.setState({ activeTabId: null, openDocTabs: [] });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('1. detectImportKind가 .pdf, .md, .markdown, .txt 및 MIME 타입을 정확히 판별한다', () => {
    expect(detectImportKind({ name: 'lecture.pdf', type: 'application/pdf' })).toBe('pdf');
    expect(detectImportKind({ name: 'notes.md', type: '' })).toBe('markdown');
    expect(detectImportKind({ name: 'README.MARKDOWN', type: 'text/markdown' })).toBe('markdown');
    expect(detectImportKind({ name: 'memo.txt', type: 'text/plain' })).toBe('markdown');
    expect(detectImportKind({ name: 'photo.png', type: 'image/png' })).toBeNull();
  });

  it('2. importMarkdownFiles가 UTF-8 및 CP949 .md 파일을 깨짐 없이 NoteRecord로 변환·저장한다', async () => {
    const bulkAddSpy = vi.spyOn(db.notes, 'bulkAdd').mockResolvedValue('ok' as never);

    const utf8Bytes = encodeText('# 위상수학\n\n열린 집합 정의', 'utf-8', 'lf');
    const cp949Bytes = encodeText('# 선형대수\r\n\r\n고유값 분해', 'cp949', 'crlf');

    const files = [
      makeBinaryFile(utf8Bytes, 'topology.md', 'text/markdown'),
      makeBinaryFile(cp949Bytes, 'linear.md', ''),
    ];

    const created = await importMarkdownFiles(files, markdownToJson, 'folder-1');
    expect(created).toHaveLength(2);
    expect(bulkAddSpy).toHaveBeenCalledTimes(1);

    expect(created[0].title).toBe('topology');
    expect(created[0].folderId).toBe('folder-1');
    expect(created[0].encoding).toBe('utf-8');
    expect(created[0].markdown).toContain('위상수학');

    expect(created[1].title).toBe('linear');
    expect(created[1].encoding).toBe('cp949');
    expect(created[1].eol).toBe('crlf');
    expect(created[1].markdown).toContain('고유값 분해');
  });

  it('3. LeftSidebar "PDF / MD 가져오기" 버튼이 태블릿 호환 accept로 .md 파일을 가져와 새 탭을 연다', async () => {
    const noteStore: NoteRecord[] = [];
    vi.spyOn(db.notes, 'bulkAdd').mockImplementation((async (items: NoteRecord[]) => {
      noteStore.push(...items);
      return 'ok';
    }) as unknown as typeof db.notes.bulkAdd);

    const mdFile = makeBinaryFile(
      encodeText('# 태블릿 메모\n\n본문 **강조**', 'utf-8', 'lf'),
      'tablet-note.md',
      'text/markdown',
    );
    const pickSpy = vi.spyOn(localFilesMod, 'pickFiles').mockResolvedValue([mdFile]);

    render(<LeftSidebar />);

    const importBtn = screen.getByTestId('import-external-btn');
    expect(importBtn.textContent).toContain('PDF / MD 가져오기');
    fireEvent.click(importBtn);

    await waitFor(() => {
      expect(pickSpy).toHaveBeenCalledWith(PDF_AND_MD_ACCEPT_ATTR, true);
      expect(noteStore).toHaveLength(1);
    });

    expect(noteStore[0].title).toBe('tablet-note');
    expect(useTabs.getState().activeTabId).toBe(noteStore[0].id);
    expect(MD_ACCEPT_ATTR).toContain('text/markdown');
    expect(PDF_AND_MD_ACCEPT_ATTR).toContain('.md');
  });

  it('4. NoteSession.insertMarkdownFile이 활성 노트에 로컬 .md 본문을 삽입한다', async () => {
    const record = emptyNote({ id: 'note-insert-md-1', title: '삽입 대상' });
    const session = new NoteSession(record);

    const mdFile = makeBinaryFile(
      encodeText('## 첨부된 절\n\n- 항목 A\n- 항목 B', 'utf-8', 'lf'),
      'section.md',
      'text/markdown',
    );

    await session.insertMarkdownFile(mdFile);

    const mdOut = session.editor.getMarkdown();
    expect(mdOut).toContain('첨부된 절');
    expect(mdOut).toContain('항목 A');
    expect(mdOut).toContain('항목 B');

    session.destroy();
  });
});
