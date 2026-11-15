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
import { ErrorBoundary } from './components/ErrorBoundary';
import { useSettings } from './store/settingsStore';
import { useTabs } from './store/tabsStore';
import { useSessions } from './store/sessionStore';
import { db, emptyNote, seedIfEmpty } from './storage/db';
import { registerCustomFontInDOM } from './core/font/fontManager';
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

function SplitResizer({ containerRef }: { containerRef: React.RefObject<HTMLDivElement | null> }) {
  const setSplitRatio = useTabs((s) => s.setSplitRatio);
  const dragging = useRef(false);
  return (
    <div
      data-testid="split-pane-resizer"
      className="pane-resizer"
      onPointerDown={(e) => {
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        dragging.current = true;
      }}
      onPointerMove={(e) => {
        if (!dragging.current || !containerRef.current) return;
        const rect = containerRef.current.getBoundingClientRect();
        if (rect.width <= 0) return;
        const ratio = (e.clientX - rect.left) / rect.width;
        setSplitRatio(ratio);
      }}
      onPointerUp={() => {
        dragging.current = false;
      }}
      title="드래그하여 좌우 분할 비율 조절"
    />
  );
}

export default function App() {
  const { leftOpen, rightOpen, paneWidths } = useSettings();
  const { openDocTabs, activeTabId, splitOpen, secondaryTabId, focusedPane, splitRatio, setFocusedPane, openInSecondary, closeSplit } = useTabs();
  const [ready, setReady] = useState(false);
  const splitContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void (async () => {
      await seedIfEmpty();
      // 로컬 저장된 커스텀 폰트(.ttf, .otf 등) DOM 등록 및 복원
      try {
        const storedFonts = await db.customFonts.toArray();
        for (const font of storedFonts) {
          registerCustomFontInDOM(font);
        }
        if (storedFonts.length > 0) {
          const existingIds = new Set(useSettings.getState().customFonts.map((f) => f.id));
          const merged = [
            ...useSettings.getState().customFonts,
            ...storedFonts
              .filter((f) => !existingIds.has(f.id))
              .map(({ id, name, family, isCustom, fileName, format }) => ({
                id,
                name,
                family,
                isCustom,
                fileName,
                format,
              })),
          ];
          useSettings.setState({ customFonts: merged });
        }
      } catch {
        // IndexedDB 미지원 환경 폴백
      }
      // 재시작 시 마지막 열린 탭 복원 (삭제된 노트 제외)
      const tabs = useTabs.getState().openDocTabs;
      const existing = await db.notes.bulkGet(tabs);
      const valid = tabs.filter((_, i) => existing[i] && !existing[i]!.deletedAt);
      if (valid.length !== tabs.length) useTabs.setState({ openDocTabs: valid, activeTabId: valid.includes(useTabs.getState().activeTabId ?? '') ? useTabs.getState().activeTabId : valid[0] ?? null });
      if (valid.length === 0) {
        // 최근 수정한 노트를 연다 (첫 실행 시 샘플 '인지부하 이론')
        const recent = (await db.notes.orderBy('updatedAt').reverse().toArray()).find((n) => !n.deletedAt);
        if (recent) useTabs.getState().openTab(recent.id);
      }
      setReady(true);
      void indexAllNotes();
    })();
  }, []);

  // 전역 단축키: Ctrl+S 저장, 에디터 밖 Ctrl+Z/Y 통합 Undo/Redo (포커스된 분할 패널 우선)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const st = useTabs.getState();
      const targetId =
        st.splitOpen && st.focusedPane === 'secondary' && st.secondaryTabId
          ? st.secondaryTabId
          : st.activeTabId;
      const s = getSession(targetId);
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

  const newNoteInSecondary = async () => {
    const n = emptyNote();
    await db.notes.add(n);
    indexNote(n);
    openInSecondary(n.id);
  };

  const effectiveSecondaryId =
    splitOpen && secondaryTabId && secondaryTabId !== activeTabId
      ? secondaryTabId
      : splitOpen
        ? openDocTabs.find((id) => id !== activeTabId) ?? null
        : null;

  return (
    <div className="flex h-full flex-col bg-white text-slate-800">
      <Header />
      <Toolbar />
      <div className="flex min-h-0 flex-1">
        {leftOpen && (
          <>
            <div style={{ width: paneWidths.left }} className="shrink-0 border-r border-slate-200">
              <ErrorBoundary>
                <LeftSidebar />
              </ErrorBoundary>
            </div>
            <Resizer side="left" />
          </>
        )}
        <main className="flex min-w-0 flex-1 flex-col bg-slate-100">
          <TabBar />
          {ready && !splitOpen &&
            openDocTabs.map((id) => (
              <ErrorBoundary
                key={id}
                fallback={(error, reset) =>
                  id === activeTabId ? (
                    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm text-slate-500">
                      <p>이 노트를 표시하는 중 오류가 발생했습니다. 다른 탭과 데이터는 안전합니다.</p>
                      <p className="max-w-md break-words font-mono text-xs text-red-500">{error.message}</p>
                      <button className="btn-primary" onClick={reset}>
                        다시 시도
                      </button>
                    </div>
                  ) : null
                }
              >
                <NoteWorkspace noteId={id} active={id === activeTabId} />
              </ErrorBoundary>
            ))}
          {ready && splitOpen && openDocTabs.length > 0 && (
            <div ref={splitContainerRef} data-testid="dual-split-container" className="flex min-h-0 flex-1">
              <div
                data-testid="split-pane-primary"
                data-focused={focusedPane === 'primary' ? 'true' : 'false'}
                style={{ width: `${splitRatio * 100}%` }}
                className={`flex min-h-0 shrink-0 flex-col ${focusedPane === 'primary' ? 'ring-1 ring-inset ring-indigo-300' : ''}`}
                onPointerDownCapture={() => setFocusedPane('primary')}
              >
                <div className="flex h-6 shrink-0 items-center justify-between border-b border-slate-200 bg-white/80 px-3 text-[11px] text-slate-500">
                  <span className="font-semibold text-indigo-700">좌측 패널 (Primary)</span>
                  {focusedPane === 'primary' && <span className="rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] text-indigo-600">필기·편집 활성</span>}
                </div>
                {openDocTabs
                  .filter((id) => id !== effectiveSecondaryId)
                  .map((id) => (
                    <ErrorBoundary key={`pri-${id}`}>
                      <NoteWorkspace noteId={id} active={id === activeTabId} />
                    </ErrorBoundary>
                  ))}
              </div>
              <SplitResizer containerRef={splitContainerRef} />
              <div
                data-testid="split-pane-secondary"
                data-focused={focusedPane === 'secondary' ? 'true' : 'false'}
                className={`flex min-h-0 min-w-0 flex-1 flex-col border-l border-slate-200 ${focusedPane === 'secondary' ? 'ring-1 ring-inset ring-indigo-300' : ''}`}
                onPointerDownCapture={() => setFocusedPane('secondary')}
              >
                <div className="flex h-6 shrink-0 items-center justify-between border-b border-slate-200 bg-white/80 px-3 text-[11px] text-slate-500">
                  <span className="font-semibold text-indigo-700">우측 패널 (Secondary)</span>
                  <div className="flex items-center gap-1.5">
                    {focusedPane === 'secondary' && <span className="rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] text-indigo-600">필기·편집 활성</span>}
                    <button
                      type="button"
                      className="rounded px-1 text-[10px] text-slate-500 hover:bg-slate-200"
                      onClick={() => closeSplit()}
                      title="우측 분할 패널 닫기"
                    >
                      ✕ 닫기
                    </button>
                  </div>
                </div>
                {effectiveSecondaryId ? (
                  <ErrorBoundary key={`sec-${effectiveSecondaryId}`}>
                    <NoteWorkspace noteId={effectiveSecondaryId} active={true} />
                  </ErrorBoundary>
                ) : (
                  <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center text-xs text-slate-400">
                    <p>우측 패널에 표시할 다른 노트를 선택하거나 새로 만드세요.</p>
                    <button type="button" className="btn-primary text-xs" onClick={() => void newNoteInSecondary()}>
                      <FilePlus size={14} /> 우측 패널에 새 노트 열기
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
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
              <ErrorBoundary>
                <RightSidebar />
              </ErrorBoundary>
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
