import { useEffect } from 'react';
import { useFloating, autoUpdate, offset, flip, shift, FloatingPortal } from '@floating-ui/react';
import { FileText, Pilcrow } from 'lucide-react';
import { useWikiSuggest } from '../editor/extensions/wikiLink';

/** [[ 입력 시 내부 노트·단락 검색 팝오버 */
export function WikiSuggestPopup() {
  const { open, items, index, rect, select, query } = useWikiSuggest();
  const { refs, floatingStyles, update } = useFloating({
    placement: 'bottom-start',
    middleware: [offset(6), flip(), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });

  useEffect(() => {
    if (rect) {
      refs.setPositionReference({ getBoundingClientRect: () => rect });
      update();
    }
  }, [rect, refs, update]);

  if (!open || !rect) return null;
  return (
    <FloatingPortal>
      <div ref={refs.setFloating} style={floatingStyles} data-overlay className="z-50 w-96 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl">
        <div className="border-b bg-slate-50 px-3 py-1.5 text-[11px] text-slate-500">
          노트·단락 연결 {query ? `— “${query}”` : '(검색어를 입력하세요)'}
        </div>
        {items.length === 0 && <div className="px-3 py-3 text-xs text-slate-400">일치하는 노트나 단락이 없습니다.</div>}
        <ul className="max-h-72 overflow-y-auto py-1">
          {items.map((it, i) => (
            <li key={`${it.noteId}-${it.blockId ?? 'doc'}-${i}`}>
              <button
                className={`flex w-full items-start gap-2 px-3 py-1.5 text-left text-xs ${i === index ? 'bg-indigo-50' : 'hover:bg-slate-50'}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  select?.(it);
                }}
                onMouseEnter={() => useWikiSuggest.setState({ index: i })}
              >
                {it.text ? <Pilcrow size={13} className="mt-0.5 shrink-0 text-slate-400" /> : <FileText size={13} className="mt-0.5 shrink-0 text-indigo-500" />}
                <span className="min-w-0">
                  <span className="block font-medium text-slate-700">{it.title}</span>
                  {it.text && <span className="line-clamp-2 block text-slate-500">{it.text}</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </FloatingPortal>
  );
}
