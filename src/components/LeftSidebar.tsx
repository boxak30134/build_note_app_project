import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  ChevronDown,
  ChevronRight,
  FilePlus,
  FolderPlus,
  Folder,
  FolderOpen,
  FileText,
  Search,
  Trash2,
  RotateCcw,
  HardDrive,
  FileUp,
  FolderInput,
  Pencil,
  Import,
  Loader2,
  FolderTree,
  Layers,
} from 'lucide-react';
import { db, emptyNote, uid, type FolderRecord, type NoteRecord } from '../storage/db';
import { useTabs } from '../store/tabsStore';
import { confirmDialog, promptDialog, toast } from '../store/uiStore';
import { validateFileName } from '../core/files/validation';
import { forceCloseTab } from '../features/tabActions';
import { openLocalFiles, importDirectory, fsAccessSupported, pickFiles } from '../storage/localFiles';
import { markdownToJson } from '../editor/extensions';
import { indexNote, unindexNote } from '../search/searchClient';
import { deleteAttachmentsOf } from '../storage/attachmentsCleanup';
import { getSession } from '../session/NoteSession';
import { PageThumbnailList, extractPageItems } from './PageThumbnailList';

type Menu = { x: number; y: number; kind: 'note' | 'folder'; id: string } | null;

export function LeftSidebar() {
  const folders = useLiveQuery(() => db.folders.toArray(), []) ?? [];
  const notes = useLiveQuery(() => db.notes.toArray(), []) ?? [];
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [menu, setMenu] = useState<Menu>(null);
  const [showTrash, setShowTrash] = useState(false);
  const [importing, setImporting] = useState<string | null>(null);
  const [sidebarView, setSidebarView] = useState<'files' | 'pages'>('files');
  const activeId = useTabs((s) => s.activeTabId);
  const openTab = useTabs((s) => s.openTab);
  const activeSession = getSession(activeId) ?? null;
  const pageItems = extractPageItems(activeSession);
  const totalPages = pageItems.length;

  const liveFolders = folders.filter((f) => !f.deletedAt);
  const liveNotes = notes.filter((n) => !n.deletedAt);
  const trashedNotes = notes.filter((n) => n.deletedAt);
  const trashedFolders = folders.filter((f) => f.deletedAt);

  const q = query.trim().toLowerCase();
  const matches = useMemo(
    () => (q ? liveNotes.filter((n) => n.title.toLowerCase().includes(q) || (n.plainText || n.markdown || '').toLowerCase().includes(q)) : []),
    [q, liveNotes],
  );

  const newNote = async () => {
    const n = emptyNote({ folderId: selectedFolder });
    await db.notes.add(n);
    indexNote(n);
    openTab(n.id);
  };

  const newFolder = async () => {
    const name = await promptDialog('새 폴더 이름', '새 폴더', validateFileName);
    if (!name) return;
    await db.folders.add({ id: uid('folder'), name, parentId: selectedFolder, createdAt: Date.now() });
  };

  const rename = async (kind: 'note' | 'folder', id: string) => {
    const cur = kind === 'note' ? notes.find((n) => n.id === id)?.title : folders.find((f) => f.id === id)?.name;
    const name = await promptDialog('이름 변경', cur ?? '', validateFileName);
    if (!name) return;
    if (kind === 'note') await db.notes.update(id, { title: name });
    else await db.folders.update(id, { name });
  };

  /** 안전한 삭제: 영구 삭제가 아닌 휴지통 이동 */
  const trash = async (kind: 'note' | 'folder', id: string) => {
    const now = Date.now();
    if (kind === 'note') {
      await db.notes.update(id, { deletedAt: now });
      forceCloseTab(id);
      unindexNote(id);
    } else {
      const ids = descendantFolderIds(folders, id);
      await db.folders.where('id').anyOf(ids).modify({ deletedAt: now });
      const affected = notes.filter((n) => n.folderId && ids.includes(n.folderId) && !n.deletedAt);
      for (const n of affected) {
        await db.notes.update(n.id, { deletedAt: now });
        forceCloseTab(n.id);
        unindexNote(n.id);
      }
    }
    toast.info('휴지통으로 이동했습니다.');
  };

  const restore = async (kind: 'note' | 'folder', id: string) => {
    if (kind === 'note') {
      const n = notes.find((x) => x.id === id);
      const parentAlive = !n?.folderId || liveFolders.some((f) => f.id === n.folderId);
      await db.notes.update(id, { deletedAt: null, folderId: parentAlive ? n?.folderId ?? null : null });
      const fresh = await db.notes.get(id);
      if (fresh) indexNote(fresh);
    } else {
      const ids = descendantFolderIds(folders, id);
      const f = folders.find((x) => x.id === id);
      const parentAlive = !f?.parentId || liveFolders.some((x) => x.id === f.parentId);
      await db.folders.where('id').anyOf(ids).modify({ deletedAt: null });
      if (!parentAlive) await db.folders.update(id, { parentId: null });
      const restoredNotes = notes.filter((n) => n.folderId && ids.includes(n.folderId));
      for (const n of restoredNotes) {
        await db.notes.update(n.id, { deletedAt: null });
        indexNote(n);
      }
    }
  };

  const purge = async (kind: 'note' | 'folder', id: string) => {
    const ok = await confirmDialog('영구 삭제', '휴지통에서 영구 삭제합니다. 되돌릴 수 없습니다. 계속할까요?', [
      { label: '취소', value: 'cancel' },
      { label: '영구 삭제', value: 'ok', variant: 'danger' },
    ]);
    if (ok !== 'ok') return;
    if (kind === 'note') {
      await db.notes.delete(id);
      void deleteAttachmentsOf(id);
    } else {
      const ids = descendantFolderIds(folders, id);
      const ns = notes.filter((n) => n.folderId && ids.includes(n.folderId));
      await db.notes.bulkDelete(ns.map((n) => n.id));
      ns.forEach((n) => void deleteAttachmentsOf(n.id));
      await db.folders.bulkDelete(ids);
    }
  };

  const moveNote = async (noteId: string, folderId: string | null) => {
    await db.notes.update(noteId, { folderId });
  };

  const openFiles = async () => {
    try {
      const created = await openLocalFiles(markdownToJson, selectedFolder);
      created.forEach((n) => {
        indexNote(n);
        openTab(n.id);
      });
      if (created.length && !fsAccessSupported) toast.info('이 브라우저에서는 파일 내용을 가져오기만 하며, 원본 파일에 직접 저장되지 않습니다.');
    } catch (e) {
      toast.error(`파일 열기 실패: ${(e as Error).message}`);
    }
  };

  /** PDF 문서 가져오기 */
  const importExternal = async () => {
    const files = await pickFiles('.pdf,application/pdf', true);
    if (files.length === 0) return;
    const { importExternalFile } = await import('../features/import/importer');
    for (const f of files) {
      setImporting(`${f.name} 가져오는 중…`);
      try {
        const r = await importExternalFile(f, selectedFolder, (msg) => setImporting(`${f.name} — ${msg}`));
        indexNote(r.note);
        openTab(r.note.id);
        const detail = `${r.pages}쪽 · 텍스트 블록 ${r.textBlocks}개 · 페이지 템플릿 ${r.handwritingPages}쪽 · 이미지 ${r.media}개`;
        toast.success(`'${r.note.title}' 가져오기 완료\n${detail}`);
      } catch (e) {
        toast.error((e as Error).message, `${f.name} 가져오기 실패`);
      }
    }
    setImporting(null);
  };

  const openFolder = async () => {
    try {
      const n = await importDirectory(markdownToJson);
      if (n > 0) {
        toast.success(`문서 ${n}개를 가져왔습니다.`);
        const all = await db.notes.filter((x) => !x.deletedAt).toArray();
        all.forEach(indexNote);
      }
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const renderFolder = (f: FolderRecord, depth: number): React.ReactNode => {
    const open = !collapsed[f.id];
    const childFolders = liveFolders.filter((c) => c.parentId === f.id).sort((a, b) => a.name.localeCompare(b.name, 'ko'));
    const childNotes = liveNotes.filter((n) => n.folderId === f.id).sort((a, b) => a.title.localeCompare(b.title, 'ko'));
    return (
      <div key={f.id}>
        <div
          className={`tree-row ${selectedFolder === f.id ? 'bg-indigo-50' : ''}`}
          style={{ paddingLeft: 6 + depth * 14 }}
          onClick={() => {
            setSelectedFolder(selectedFolder === f.id ? null : f.id);
            setCollapsed((c) => ({ ...c, [f.id]: open }));
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu({ x: e.clientX, y: e.clientY, kind: 'folder', id: f.id });
          }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            const id = e.dataTransfer.getData('text/note-id');
            if (id) void moveNote(id, f.id);
          }}
        >
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          {open ? <FolderOpen size={14} className="text-amber-500" /> : <Folder size={14} className="text-amber-500" />}
          <span className="truncate">{f.name}</span>
        </div>
        {open && (
          <>
            {childFolders.map((c) => renderFolder(c, depth + 1))}
            {childNotes.map((n) => renderNote(n, depth + 1))}
          </>
        )}
      </div>
    );
  };

  const renderNote = (n: NoteRecord, depth: number, sub?: string) => (
    <div
      key={n.id}
      draggable
      onDragStart={(e) => e.dataTransfer.setData('text/note-id', n.id)}
      className={`tree-row ${activeId === n.id ? 'bg-indigo-100 text-indigo-800' : ''}`}
      style={{ paddingLeft: 6 + depth * 14 + 14 }}
      onClick={() => openTab(n.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY, kind: 'note', id: n.id });
      }}
      title={n.title}
    >
      {n.fileHandle ? <HardDrive size={13} className="shrink-0 text-slate-500" /> : <FileText size={13} className="shrink-0 text-slate-400" />}
      <span className="min-w-0">
        <span className="block truncate">{n.title}</span>
        {sub && <span className="block truncate text-[10px] text-slate-400">{sub}</span>}
      </span>
    </div>
  );

  const rootFolders = liveFolders.filter((f) => !f.parentId || !liveFolders.some((p) => p.id === f.parentId)).sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  const rootNotes = liveNotes.filter((n) => !n.folderId || !liveFolders.some((f) => f.id === n.folderId));

  return (
    <aside className="flex h-full min-w-0 flex-col bg-slate-50" onClick={() => setMenu(null)}>
      {/* 뷰 전환 스위치 토글: [📁 파일 구조] [📑 페이지 목록] */}
      <div className="flex shrink-0 border-b border-slate-200 bg-slate-100/80 p-1">
        <button
          type="button"
          data-testid="sidebar-toggle-files"
          className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg py-1.5 text-xs font-semibold transition ${
            sidebarView === 'files'
              ? 'bg-white text-indigo-700 shadow-xs'
              : 'text-slate-500 hover:text-slate-800'
          }`}
          onClick={() => setSidebarView('files')}
        >
          <FolderTree size={13} />
          <span>파일 구조</span>
        </button>
        <button
          type="button"
          data-testid="sidebar-toggle-pages"
          className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg py-1.5 text-xs font-semibold transition ${
            sidebarView === 'pages'
              ? 'bg-white text-indigo-700 shadow-xs'
              : 'text-slate-500 hover:text-slate-800'
          }`}
          onClick={() => setSidebarView('pages')}
        >
          <Layers size={13} />
          <span>페이지 ({totalPages})</span>
        </button>
      </div>

      {sidebarView === 'pages' ? (
        <PageThumbnailList session={activeSession} />
      ) : (
        <>
          <div className="p-2">
            <div className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2">
              <Search size={14} className="text-slate-400" />
              <input
                type="text"
                inputMode="search"
                lang="ko"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                className="w-full bg-transparent py-1.5 text-sm outline-none"
                placeholder="파일명·본문 검색"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <div className="mt-2 flex gap-1">
              <button className="btn-ghost flex-1 justify-center" onClick={() => void newNote()} title="새 노트">
                <FilePlus size={14} /> 노트
              </button>
              <button className="btn-ghost flex-1 justify-center" onClick={() => void newFolder()} title="새 폴더">
                <FolderPlus size={14} /> 폴더
              </button>
              <button className="btn-ghost" onClick={() => void openFiles()} title="로컬 파일 열기 (UTF-8/CP949 자동 감지)">
                <FileUp size={14} />
              </button>
              <button className="btn-ghost" onClick={() => void openFolder()} title="로컬 폴더 가져오기">
                <FolderInput size={14} />
              </button>
            </div>
            <button className="btn-ghost mt-1 w-full justify-center border border-dashed border-slate-300" onClick={() => void importExternal()} disabled={!!importing} title="PDF 파일을 새 노트로 가져옵니다">
              {importing ? <Loader2 size={14} className="animate-spin" /> : <Import size={14} />} PDF 가져오기
            </button>
            {importing && <div className="mt-1 truncate text-[10px] text-indigo-500" data-testid="import-progress">{importing}</div>}
            {selectedFolder && <div className="mt-1 truncate text-[10px] text-slate-400">새 항목 위치: {folders.find((f) => f.id === selectedFolder)?.name}</div>}
          </div>

          <div
            className="min-h-0 flex-1 overflow-y-auto px-1 pb-2 text-sm"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              if ((e.target as HTMLElement).closest('.tree-row')) return;
              const id = e.dataTransfer.getData('text/note-id');
              if (id) void moveNote(id, null);
            }}
          >
            {q ? (
              <>
                <div className="px-2 py-1 text-[11px] text-slate-400">검색 결과 {matches.length}개</div>
                {matches.map((n) => renderNote(n, -1, liveFolders.find((f) => f.id === n.folderId)?.name ?? '최상위'))}
              </>
            ) : (
              <>
                {rootFolders.map((f) => renderFolder(f, 0))}
                {rootNotes.map((n) => renderNote(n, -1))}
              </>
            )}
          </div>

          <div className="border-t border-slate-200">
            <button className="flex w-full items-center gap-2 px-3 py-2 text-xs text-slate-500 hover:bg-slate-100" onClick={() => setShowTrash((s) => !s)}>
              <Trash2 size={13} /> 휴지통 ({trashedNotes.length + trashedFolders.length})
              {showTrash ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </button>
            {showTrash && (
              <div className="max-h-48 overflow-y-auto px-1 pb-2 text-xs">
                {[...trashedFolders.map((f) => ({ kind: 'folder' as const, id: f.id, name: `📁 ${f.name}` })), ...trashedNotes.map((n) => ({ kind: 'note' as const, id: n.id, name: n.title }))].map((it) => (
                  <div key={it.id} className="flex items-center gap-1 rounded px-2 py-1 hover:bg-slate-100">
                    <span className="flex-1 truncate text-slate-500">{it.name}</span>
                    <button className="icon-btn" title="복원" onClick={() => void restore(it.kind, it.id)}>
                      <RotateCcw size={12} />
                    </button>
                    <button className="icon-btn text-red-500" title="영구 삭제" onClick={() => void purge(it.kind, it.id)}>
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
                {trashedNotes.length + trashedFolders.length === 0 && <div className="px-2 py-1 text-slate-400">비어 있음</div>}
              </div>
            )}
          </div>
        </>
      )}

      {menu && (
        <div className="fixed z-50 w-40 rounded-xl border bg-white py-1 text-sm shadow-xl" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
          <button className="menu-item" onClick={() => (setMenu(null), void rename(menu.kind, menu.id))}>
            <Pencil size={13} /> 이름 변경
          </button>
          <button className="menu-item text-red-600" onClick={() => (setMenu(null), void trash(menu.kind, menu.id))}>
            <Trash2 size={13} /> 휴지통으로 이동
          </button>
        </div>
      )}
    </aside>
  );
}

function descendantFolderIds(folders: FolderRecord[], rootId: string): string[] {
  const out = [rootId];
  for (let i = 0; i < out.length; i++) folders.filter((f) => f.parentId === out[i]).forEach((f) => out.push(f.id));
  return out;
}
