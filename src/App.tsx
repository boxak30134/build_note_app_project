import { useEffect, useRef, useState } from 'react';
import { FilePlus } from 'lucide-react';
import { Header } from './components/Header';
import { Toolbar } from './components/Toolbar';
import { TabBar } from './components/TabBar';
import { LeftSidebar } from './components/LeftSidebar';
import { RightSidebar } from './components/RightSidebar';
import { NoteWorkspace } from './components/NoteWorkspace';
import { WikiSuggestPopup } from './components/WikiSuggestPopup';
import { ContextMenu } from './components/ContextMenu';
import { Toasts, ConfirmDialog, PromptDialog, CameraModal } from './components/Dialogs';
import { useSettings } from './store/settingsStore';
import { useTabs } from './store/tabsStore';
import { useSessions } from './store/sessionStore';
import { db, emptyNote, seedIfEmpty } from './storage/db';
import { indexAllNotes, indexNote } from './search/searchClient';
import { allSessions, getSession } from './session/NoteSession';
import { toast } from './store/uiStore';

function Resizer({ side }: { side: 'left' | 'right' }) {
  const setPaneWidth = useSettings((s) => s.setPaneWidth);
  const start = useRef<{ x: number; w: number } | null>(null);
  return (
    <div
      className="pane-resizer"
      onPointerDown={(e) => {
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        start.current = { x: e.clientX, w: useSettings.getState().paneWidths[side] };
      }}
      onPointerMove={(e) => {
        if (!start.current) return;
        const dx = e.clientX - start.current.x;
        setPaneWidth(side, start.current.w + (side === 'left' ? dx : -dx));
      }}
      onPointerUp={() => (start.current = null)}
      title="드래그하여 너비 조절"
    />
  );
}

export default function App() {
  const { leftOpen, rightOpen, paneWidths } = useSettings();
  const { openDocTabs, activeTabId } = useTabs();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    void (async () => {
      await seedIfEmpty();
      // 재시작 시 마지막 열린 탭 복원 (삭제된 노트 제외)
      const tabs = useTabs.getState().openDocTabs;
      const existing = await db.notes.bulkGet(tabs);
      const valid = tabs.filter((_, i) => existing[i] && !existing[i]!.deletedAt);
      if (valid.length !== tabs.length) useTabs.setState({ openDocTabs: valid, activeTabId: valid.includes(useTabs.getState().activeTabId ?? '') ? useTabs.getState().activeTabId : valid[0] ?? null });
      if (valid.length === 0) {
        const first = await db.notes.filter((n) => !n.deletedAt).first();
        if (first) useTabs.getState().openTab(first.id);
      }
      setReady(true);
      void indexAllNotes();
    })();
  }, []);

  // 전역 단축키: Ctrl+S 저장, 에디터 밖 Ctrl+Z/Y 통합 Undo/Redo
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const s = getSession(useTabs.getState().activeTabId);
      const k = e.key.toLowerCase();
      if (k === 's') {
        e.preventDefault();
        if (s) void s.save().then((ok) => ok && toast.success('저장했습니다.'));
        return;
      }
      if (e.defaultPrevented) return;
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault();
        s?.undo();
      } else if ((k === 'z' && e.shiftKey) || k === 'y') {
        e.preventDefault();
        s?.redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // 미저장 탭이 있으면 종료 전 확인
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      const dirty = Object.values(useSessions.getState().sessions).some((s) => s.dirty);
      if (dirty) {
        e.preventDefault();
        e.returnValue = '저장하지 않은 변경 사항이 있습니다. 페이지를 나가시겠습니까?';
        return e.returnValue;
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  // File Watcher: 로컬 파일과 연결된 열린 문서의 외부 변경/삭제 감지 (2초 폴링)
  useEffect(() => {
    const t = setInterval(() => {
      for (const s of allSessions()) void s.pollDisk();
    }, 2000);
    return () => clearInterval(t);
  }, []);

  const newNote = async () => {
    const n = emptyNote();
    await db.notes.add(n);
    indexNote(n);
    useTabs.getState().openTab(n.id);
  };

  return (
    <div className="flex h-full flex-col bg-white text-slate-800">
      <Header />
      <Toolbar />
      <div className="flex min-h-0 flex-1">
        {leftOpen && (
          <>
            <div style={{ width: paneWidths.left }} className="shrink-0 border-r border-slate-200">
              <LeftSidebar />
            </div>
            <Resizer side="left" />
          </>
        )}
        <main className="flex min-w-0 flex-1 flex-col bg-slate-100">
          <TabBar />
          {ready && openDocTabs.map((id) => <NoteWorkspace key={id} noteId={id} active={id === activeTabId} />)}
          {ready && openDocTabs.length === 0 && (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 text-slate-400">
              <p className="text-sm">열린 노트가 없습니다.</p>
              <button className="btn-primary" onClick={() => void newNote()}>
                <FilePlus size={15} /> 새 노트
              </button>
            </div>
          )}
        </main>
        {rightOpen && (
          <>
            <Resizer side="right" />
            <div style={{ width: paneWidths.right }} className="shrink-0 border-l border-slate-200">
              <RightSidebar />
            </div>
          </>
        )}
      </div>
      <WikiSuggestPopup />
      <ContextMenu />
      <Toasts />
      <ConfirmDialog />
      <PromptDialog />
      <CameraModal />
    </div>
  );
}
