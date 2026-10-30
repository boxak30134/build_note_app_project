import { useLiveQuery } from 'dexie-react-hooks';
import { X, FileText, HardDrive } from 'lucide-react';
import { useTabs } from '../store/tabsStore';
import { useSessions } from '../store/sessionStore';
import { db } from '../storage/db';
import { requestCloseTab } from '../features/tabActions';

export function TabBar() {
  const { openDocTabs, activeTabId, activate } = useTabs();
  const notes = useLiveQuery(() => db.notes.bulkGet(openDocTabs), [openDocTabs.join('|')]);
  const dirtyMap = useSessions((s) => s.sessions);

  if (openDocTabs.length === 0) return null;
  return (
    <div className="flex h-9 shrink-0 items-end gap-0.5 overflow-x-auto border-b border-slate-200 bg-slate-100 px-1 pt-1">
      {openDocTabs.map((id, i) => {
        const n = notes?.[i];
        const active = id === activeTabId;
        const dirty = dirtyMap[id]?.dirty;
        return (
          <div
            key={id}
            className={`group flex h-8 max-w-[220px] shrink-0 cursor-pointer items-center gap-1.5 rounded-t-lg border border-b-0 px-3 text-xs ${
              active ? 'border-slate-200 bg-white text-slate-800' : 'border-transparent text-slate-500 hover:bg-slate-200'
            }`}
            onClick={() => activate(id)}
            onAuxClick={(e) => e.button === 1 && void requestCloseTab(id)}
            title={n?.title}
          >
            {n?.fileHandle ? <HardDrive size={12} /> : <FileText size={12} />}
            <span className="truncate">{n?.title ?? '…'}</span>
            {dirty && (
              <span className="text-indigo-500" title="저장되지 않음">
                ●
              </span>
            )}
            <button
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
  );
}
