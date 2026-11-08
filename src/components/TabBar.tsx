import { useLiveQuery } from 'dexie-react-hooks';
import { X, FileText, HardDrive, Columns2 } from 'lucide-react';
import { useTabs } from '../store/tabsStore';
import { useSessions } from '../store/sessionStore';
import { db } from '../storage/db';
import { requestCloseTab } from '../features/tabActions';

export function TabBar() {
  const { openDocTabs, activeTabId, splitOpen, secondaryTabId, focusedPane, activate, toggleSplit, openInSecondary } = useTabs();
  const notes = useLiveQuery(() => db.notes.bulkGet(openDocTabs), [openDocTabs.join('|')]);
  const dirtyMap = useSessions((s) => s.sessions);

  if (openDocTabs.length === 0) return null;
  return (
    <div className="flex h-9 shrink-0 items-center justify-between gap-1 border-b border-slate-200 bg-slate-100 px-1 pt-1">
      <div className="flex h-full min-w-0 flex-1 items-end gap-0.5 overflow-x-auto">
        {openDocTabs.map((id, i) => {
          const n = notes?.[i];
          const isPrimary = id === activeTabId;
          const isSecondary = splitOpen && id === secondaryTabId;
          const active = isPrimary || isSecondary;
          const dirty = dirtyMap[id]?.dirty;
          return (
            <div
              key={id}
              className={`group flex h-8 max-w-[230px] shrink-0 cursor-pointer items-center gap-1.5 rounded-t-lg border border-b-0 px-3 text-xs ${
                active ? 'border-slate-200 bg-white text-slate-800' : 'border-transparent text-slate-500 hover:bg-slate-200'
              }`}
              onClick={() => activate(id)}
              onAuxClick={(e) => e.button === 1 && void requestCloseTab(id)}
              title={n?.title}
            >
              {n?.fileHandle ? <HardDrive size={12} /> : <FileText size={12} />}
              <span className="truncate">{n?.title ?? '…'}</span>
              {splitOpen && isPrimary && (
                <span className={`rounded px-1 text-[10px] font-semibold ${focusedPane === 'primary' ? 'bg-indigo-100 text-indigo-700' : 'bg-slate-100 text-slate-500'}`}>
                  좌
                </span>
              )}
              {splitOpen && isSecondary && (
                <span className={`rounded px-1 text-[10px] font-semibold ${focusedPane === 'secondary' ? 'bg-indigo-100 text-indigo-700' : 'bg-slate-100 text-slate-500'}`}>
                  우
                </span>
              )}
              {dirty && (
                <span className="text-indigo-500" title="저장되지 않음">
                  ●
                </span>
              )}
              <button
                type="button"
                className="ml-0.5 hidden rounded p-0.5 opacity-60 hover:bg-slate-200 hover:opacity-100 group-hover:inline-flex"
                onClick={(e) => {
                  e.stopPropagation();
                  openInSecondary(id);
                }}
                title="우측 분할 화면으로 열기"
              >
                <Columns2 size={11} />
              </button>
              <button
                type="button"
                className="ml-0.5 rounded p-0.5 opacity-60 hover:bg-slate-300 hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  void requestCloseTab(id);
                }}
                title="탭 닫기"
              >
                <X size={12} />
              </button>
            </div>
          );
        })}
      </div>
      <button
        type="button"
        data-testid="toggle-split-pane-btn"
        onClick={() => toggleSplit()}
        className={`mb-1 mr-1 flex shrink-0 items-center gap-1 rounded-lg border px-2.5 py-1 text-xs font-medium transition ${
          splitOpen
            ? 'border-indigo-300 bg-indigo-50 text-indigo-700 shadow-xs'
            : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
        }`}
        title={splitOpen ? '좌우 화면 분할 닫기' : '좌우 화면 분할 열기 (Dual Split Pane)'}
      >
        <Columns2 size={13} />
        <span>{splitOpen ? '분할 해제' : '좌우 분할'}</span>
      </button>
    </div>
  );
}
