import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { X, FileText, HardDrive, Columns2 } from 'lucide-react';
import { useTabs } from '../store/tabsStore';
import { useSessions } from '../store/sessionStore';
import { db } from '../storage/db';
import { requestCloseTab } from '../features/tabActions';

export function TabBar() {
  const {
    openDocTabs,
    activeTabId,
    splitOpen,
    secondaryTabId,
    focusedPane,
    activate,
    moveTab,
    reorderTabById,
    toggleSplit,
    openInSecondary,
  } = useTabs();
  const notes = useLiveQuery(() => db.notes.bulkGet(openDocTabs), [openDocTabs.join('|')]);
  const dirtyMap = useSessions((s) => s.sessions);
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);

  if (openDocTabs.length === 0) return null;
  return (
    <div className="flex h-9 shrink-0 items-center justify-between gap-1 border-b border-slate-200 bg-slate-100 px-1 pt-1">
      <div className="flex h-full min-w-0 flex-1 items-end gap-0.5 overflow-x-auto" role="tablist">
        {openDocTabs.map((id, i) => {
          const n = notes?.[i];
          const isPrimary = id === activeTabId;
          const isSecondary = splitOpen && id === secondaryTabId;
          const active = isPrimary || isSecondary;
          const dirty = dirtyMap[id]?.dirty;
          const isDragging = draggingTabId === id;
          const isDropTarget = dropTargetId === id && draggingTabId !== id;
          return (
            <div
              key={id}
              data-testid={`tab-item-${id}`}
              role="tab"
              aria-selected={active}
              tabIndex={0}
              draggable
              onDragStart={(e) => {
                if ((e.target as HTMLElement | null)?.closest('button')) {
                  e.preventDefault();
                  return;
                }
                setDraggingTabId(id);
                if (e.dataTransfer) {
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', id);
                }
              }}
              onDragOver={(e) => {
                e.preventDefault();
                if (e.dataTransfer) {
                  e.dataTransfer.dropEffect = 'move';
                }
                if (draggingTabId && draggingTabId !== id && dropTargetId !== id) {
                  setDropTargetId(id);
                }
              }}
              onDragLeave={() => {
                if (dropTargetId === id) {
                  setDropTargetId(null);
                }
              }}
              onDrop={(e) => {
                e.preventDefault();
                const dragged = draggingTabId || e.dataTransfer?.getData('text/plain') || '';
                if (dragged && dragged !== id) {
                  reorderTabById(dragged, id);
                }
                setDraggingTabId(null);
                setDropTargetId(null);
              }}
              onDragEnd={() => {
                setDraggingTabId(null);
                setDropTargetId(null);
              }}
              onKeyDown={(e) => {
                if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
                  e.preventDefault();
                  const nextIdx = e.key === 'ArrowLeft' ? i - 1 : i + 1;
                  moveTab(i, nextIdx);
                }
              }}
              className={`group flex h-8 max-w-[230px] shrink-0 select-none cursor-pointer items-center gap-1.5 rounded-t-lg border border-b-0 px-3 text-xs ${
                active ? 'border-slate-200 bg-white text-slate-800' : 'border-transparent text-slate-500 hover:bg-slate-200'
              } ${isDragging ? 'opacity-50' : ''} ${
                isDropTarget ? 'ring-2 ring-inset ring-indigo-400 bg-indigo-50/70' : ''
              }`}
              onClick={() => activate(id)}
              onAuxClick={(e) => e.button === 1 && void requestCloseTab(id)}
              title={n?.title ? `${n.title} (드래그 또는 Alt+←/→로 탭 이동)` : '드래그 또는 Alt+←/→로 탭 이동'}
            >
              {n?.fileHandle ? <HardDrive size={12} className="shrink-0" /> : <FileText size={12} className="shrink-0" />}
              <span className="min-w-0 flex-1 truncate">{n?.title ?? '…'}</span>
              {splitOpen && isPrimary && (
                <span className={`shrink-0 rounded px-1 text-[10px] font-semibold ${focusedPane === 'primary' ? 'bg-indigo-100 text-indigo-700' : 'bg-slate-100 text-slate-500'}`}>
                  좌
                </span>
              )}
              {splitOpen && isSecondary && (
                <span className={`shrink-0 rounded px-1 text-[10px] font-semibold ${focusedPane === 'secondary' ? 'bg-indigo-100 text-indigo-700' : 'bg-slate-100 text-slate-500'}`}>
                  우
                </span>
              )}
              {dirty && (
                <span className="shrink-0 text-indigo-500" title="저장되지 않음">
                  ●
                </span>
              )}
              <div className="ml-0.5 flex shrink-0 items-center gap-0.5">
                <button
                  type="button"
                  data-testid={`tab-split-${id}`}
                  draggable={false}
                  className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded opacity-0 pointer-events-none transition-opacity hover:bg-slate-200 hover:!opacity-100 group-hover:pointer-events-auto group-hover:opacity-60 focus-visible:pointer-events-auto focus-visible:opacity-100"
                  onMouseDown={(e) => e.stopPropagation()}
                  onDragStart={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                  }}
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
                  data-testid={`tab-close-${id}`}
                  draggable={false}
                  className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded opacity-60 hover:bg-slate-300 hover:opacity-100"
                  onMouseDown={(e) => e.stopPropagation()}
                  onDragStart={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    void requestCloseTab(id);
                  }}
                  title="탭 닫기"
                >
                  <X size={12} />
                </button>
              </div>
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
