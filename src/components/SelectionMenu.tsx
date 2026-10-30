import { useEffect, useState } from 'react';
import { useFloating, autoUpdate, offset, flip, shift, FloatingPortal } from '@floating-ui/react';
import { Link2, MessageSquare } from 'lucide-react';
import type { NoteSession } from '../session/NoteSession';

/** 텍스트 드래그 시 플로팅 메뉴: [링크 생성] [💬 말풍선] */
export function SelectionMenu({ session }: { session: NoteSession }) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const { refs, floatingStyles, update } = useFloating({
    placement: 'top',
    middleware: [offset(8), flip(), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });

  useEffect(() => {
    const ed = session.editor;
    if (ed.isDestroyed) return;
    // 마운트 시점의 DOM 을 캡처: 정리(cleanup) 시점에는 에디터가 이미 destroy 되었을 수 있다
    const dom = ed.view.dom;
    let pointerDown = false;
    let disposed = false;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const later = (ms: number) => {
      const t = setTimeout(() => {
        timers.delete(t);
        compute();
      }, ms);
      timers.add(t);
    };
    const compute = () => {
      if (disposed || ed.isDestroyed) return;
      const { selection } = ed.state;
      if (selection.empty || !ed.isFocused || pointerDown || !ed.isEditable) {
        setRect(null);
        return;
      }
      try {
        const a = ed.view.coordsAtPos(selection.from);
        const b = ed.view.coordsAtPos(selection.to);
        const left = Math.min(a.left, b.left);
        const right = Math.max(a.right, b.right);
        setRect(new DOMRect(left, Math.min(a.top, b.top), Math.max(1, right - left), Math.max(a.bottom, b.bottom) - Math.min(a.top, b.top)));
      } catch {
        setRect(null);
      }
    };
    const down = () => {
      pointerDown = true;
      setRect(null);
    };
    const up = () => {
      pointerDown = false;
      later(0);
    };
    const blur = () => later(120);
    ed.on('selectionUpdate', compute);
    ed.on('focus', compute);
    ed.on('blur', blur);
    dom.addEventListener('pointerdown', down);
    window.addEventListener('pointerup', up);
    const scroller = session.scrollEl;
    scroller?.addEventListener('scroll', compute, { passive: true });
    return () => {
      disposed = true;
      timers.forEach(clearTimeout);
      ed.off('selectionUpdate', compute);
      ed.off('focus', compute);
      ed.off('blur', blur);
      dom.removeEventListener('pointerdown', down);
      window.removeEventListener('pointerup', up);
      scroller?.removeEventListener('scroll', compute);
    };
  }, [session]);

  useEffect(() => {
    if (rect) {
      refs.setPositionReference({ getBoundingClientRect: () => rect });
      update();
    }
  }, [rect, refs, update]);

  if (!rect) return null;
  return (
    <FloatingPortal>
      <div
        ref={refs.setFloating}
        style={floatingStyles}
        data-overlay
        className="z-40 flex gap-0.5 rounded-xl border border-slate-200 bg-white p-1 shadow-lg"
        onMouseDown={(e) => e.preventDefault()}
      >
        <button
          className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs hover:bg-emerald-50"
          title="선택한 텍스트와 연관된 문서 단락을 백그라운드에서 찾습니다"
          onClick={() => {
            session.requestLinkSuggestions();
            session.editor.commands.setTextSelection(session.editor.state.selection.to);
          }}
        >
          <Link2 size={13} /> 링크 생성
        </button>
        <button className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs hover:bg-amber-50" onClick={() => session.createAnnotation()}>
          <MessageSquare size={13} /> 💬 말풍선
        </button>
      </div>
    </FloatingPortal>
  );
}
