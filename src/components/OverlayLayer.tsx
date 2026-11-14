import { useEffect, useState, useRef, useSyncExternalStore } from 'react';
import { useFloating, autoUpdate, offset, flip, shift, useDismiss, useInteractions, FloatingPortal } from '@floating-ui/react';
import { motion } from 'framer-motion';
import { Move, Copy, Scissors, Trash2, MessageSquare, Loader2, Sparkles, X, Quote, Link2 } from 'lucide-react';
import type { NoteSession } from '../session/NoteSession';
import type { AABB } from '../core/geometry/geometry';
import { useSessionUI, type PendingCitation, type CitationResult } from '../store/sessionStore';
import { Bubble } from '../features/annotations/Bubble';
import type { Annotation } from '../features/annotations/types';
import { lassoCopy, lassoCut, lassoDelete } from '../features/lasso';
import { snippet } from '../core/doc/blocks';

/** 레이아웃 재계산 트리거: 에디터 트랜잭션, 스트로크 변경, 스크롤, 크기 변경 */
function useLayoutTick(session: NoteSession): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let raf = 0;
    const bump = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setTick((t) => t + 1));
    };
    session.editor.on('transaction', bump);
    const unsub = session.strokes.subscribe(bump);
    const scroller = session.scrollEl;
    scroller?.addEventListener('scroll', bump, { passive: true });
    window.addEventListener('resize', bump);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(bump) : null;
    if (session.pageEl) ro?.observe(session.pageEl);
    return () => {
      cancelAnimationFrame(raf);
      session.editor.off('transaction', bump);
      unsub();
      scroller?.removeEventListener('scroll', bump);
      window.removeEventListener('resize', bump);
      ro?.disconnect();
    };
  }, [session]);
  return tick;
}

function pinPosition(session: NoteSession, a: Annotation): { x: number; y: number } | null {
  if (a.customPosition) {
    return a.customPosition;
  }
  const page = session.pageEl;
  if (!page) return null;
  if (a.anchor.type === 'text') {
    const els = page.querySelectorAll(`[data-annotation-id="${CSS.escape(a.id)}"]`);
    if (els.length === 0) return null; // 앵커 텍스트가 삭제됨(Undo 시 복원)
    const last = els[els.length - 1].getBoundingClientRect();
    const pr = page.getBoundingClientRect();
    const zoom = session.ui.zoom || 1;
    return { x: (last.right - pr.left) / zoom, y: (last.top - pr.top) / zoom - 14 };
  }
  if (a.anchor.type === 'strokes') {
    const b = session.strokes.boundsOf(a.anchor.strokeIds);
    if (!b) return null; // 스트로크가 모두 지워짐
    return { x: b.maxX + 2, y: b.minY - 16 };
  }
  return { x: a.anchor.x, y: a.anchor.y - 14 };
}

/** [Layer 3] 플로팅 핀(💬)·말풍선·올가미 액션바·인용 추천 배지 */
export function OverlayLayer({ session }: { session: NoteSession }) {
  useLayoutTick(session);
  const storeUI = useSessionUI(session.id);
  const ui = session?.ui ?? storeUI;
  const strokes = useSyncExternalStore(session.strokes.subscribe, session.strokes.getAll);
  const [pinEls, setPinEls] = useState<Record<string, HTMLElement | null>>({});
  const [dragPin, setDragPin] = useState<{ id: string; x: number; y: number } | null>(null);
  const dragStartRef = useRef<{
    id: string;
    startX: number;
    startY: number;
    initialPinX: number;
    initialPinY: number;
    currentPinX: number;
    currentPinY: number;
    hasMoved: boolean;
  } | null>(null);
  const justDraggedRef = useRef(false);
  void strokes;

  const selBox = ui.lassoIds.length ? session.strokes.boundsOf(ui.lassoIds) : null;

  return (
    <div className="pointer-events-none absolute inset-0 z-20">
      {ui.annotations.map((a) => {
        const basePos = pinPosition(session, a);
        if (!basePos) return null;
        const p = dragPin && dragPin.id === a.id ? { x: dragPin.x, y: dragPin.y } : basePos;
        const open = ui.openAnnotationId === a.id;
        const isDragging = dragPin?.id === a.id;

        const handlePointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
          e.stopPropagation();
          if (typeof (e.currentTarget as HTMLElement).setPointerCapture === 'function') {
            try {
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            } catch {}
          }
          dragStartRef.current = {
            id: a.id,
            startX: e.clientX,
            startY: e.clientY,
            initialPinX: p.x,
            initialPinY: p.y,
            currentPinX: p.x,
            currentPinY: p.y,
            hasMoved: false,
          };
          justDraggedRef.current = false;
        };

        const handlePointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
          if (!dragStartRef.current || dragStartRef.current.id !== a.id) return;
          e.stopPropagation();
          const zoom = session.ui.zoom || 1;
          const dx = (e.clientX - dragStartRef.current.startX) / zoom;
          const dy = (e.clientY - dragStartRef.current.startY) / zoom;
          if (!dragStartRef.current.hasMoved && Math.hypot(dx, dy) >= 4) {
            dragStartRef.current.hasMoved = true;
          }
          if (dragStartRef.current.hasMoved) {
            const newX = Math.max(0, dragStartRef.current.initialPinX + dx);
            const newY = Math.max(0, dragStartRef.current.initialPinY + dy);
            dragStartRef.current.currentPinX = newX;
            dragStartRef.current.currentPinY = newY;
            setDragPin({ id: a.id, x: newX, y: newY });
          }
        };

        const handlePointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
          if (!dragStartRef.current || dragStartRef.current.id !== a.id) return;
          e.stopPropagation();
          if (typeof (e.currentTarget as HTMLElement).releasePointerCapture === 'function') {
            try {
              (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
            } catch {}
          }
          if (dragStartRef.current.hasMoved) {
            justDraggedRef.current = true;
            session.updateAnnotation(a.id, {
              customPosition: {
                x: Math.round(dragStartRef.current.currentPinX),
                y: Math.round(dragStartRef.current.currentPinY),
              },
            });
          }
          dragStartRef.current = null;
          setDragPin(null);
        };

        const handlePointerCancel = (e: React.PointerEvent<HTMLButtonElement>) => {
          e.stopPropagation();
          dragStartRef.current = null;
          setDragPin(null);
        };

        return (
          <button
            key={a.id}
            data-overlay
            data-pin
            data-annotation-id={a.id}
            ref={(el) => {
              if (pinEls[a.id] !== el && el) setPinEls((m) => (m[a.id] === el ? m : { ...m, [a.id]: el }));
            }}
            className={`pin pointer-events-auto absolute ${open ? 'pin-open' : ''} ${
              ui.streamingAnnotationIds?.[a.id] ? 'animate-pulse ring-2 ring-indigo-400' : ''
            } ${
              isDragging ? 'cursor-grabbing shadow-lg scale-110' : 'cursor-grab hover:scale-105'
            } transition-transform select-none touch-none`}
            style={{ left: p.x, top: p.y }}
            title={a.body ? snippet(a.body, 80) : '말풍선 주석 (드래그하여 이동)'}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerCancel}
            onClick={(e) => {
              e.stopPropagation();
              if (justDraggedRef.current) {
                justDraggedRef.current = false;
                return;
              }
              session.patch({ openAnnotationId: open ? null : a.id });
            }}
          >
            💬
          </button>
        );
      })}

      {ui.annotations
        .filter((a) => a.id === ui.openAnnotationId)
        .map((a) => (
          <Bubble key={a.id} session={session} annotation={a} reference={pinEls[a.id] ?? null} onClose={() => session.patch({ openAnnotationId: null })} />
        ))}

      {selBox && <LassoActionBar session={session} selBox={selBox} />}

      {ui.citations?.map((c) => (
        <CitationBadge key={c.id} session={session} citation={c} open={ui.openCitationId === c.id} />
      ))}
    </div>
  );
}

/** [Layer 3] 올가미 선택 영역 바로 위에 위치하며 다른 손글씨(z-30)보다 앞(z-50)에 표시되는 액션 바 */
function LassoActionBar({ session, selBox }: { session: NoteSession; selBox: AABB }) {
  const storeUI = useSessionUI(session.id);
  const ui = session?.ui ?? storeUI;
  const page = session.pageEl;
  const zoom = session.ui.zoom || 1;

  let left = Math.max(8, selBox.minX - 6);
  let top = Math.max(8, selBox.minY - 52);

  if (page) {
    const pr = page.getBoundingClientRect();
    const rawLeft = pr.left + Math.max(0, selBox.minX - 6) * zoom;
    const rawTop = pr.top + (selBox.minY - 52) * zoom;
    const belowTop = pr.top + (selBox.maxY + 10) * zoom;
    const viewportTopLimit = session.scrollEl ? session.scrollEl.getBoundingClientRect().top + 8 : 56;
    const maxLeft = typeof window !== 'undefined' && window.innerWidth > 340 ? window.innerWidth - 330 : rawLeft;

    left = Math.round(Math.max(8, Math.min(rawLeft, maxLeft)));
    top = Math.round(rawTop < viewportTopLimit ? belowTop : rawTop);
  }

  return (
    <FloatingPortal>
      <div
        data-overlay
        data-testid="lasso-action-bar"
        style={{ left, top }}
        className="pointer-events-auto fixed z-50 flex items-center gap-0.5 rounded-xl border border-indigo-200 bg-white p-1.5 shadow-2xl select-none"
        onPointerDown={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <ActionBtn active={ui.moveMode} onClick={() => session.patch({ moveMode: !ui.moveMode })} icon={<Move size={14} />} label="이동" />
        <ActionBtn onClick={() => lassoCopy(session)} icon={<Copy size={14} />} label="복사" />
        <ActionBtn onClick={() => lassoCut(session)} icon={<Scissors size={14} />} label="잘라내기" />
        <ActionBtn onClick={() => lassoDelete(session)} icon={<Trash2 size={14} />} label="삭제" />
        <ActionBtn onClick={() => session.createAnnotation()} icon={<MessageSquare size={14} />} label="💬 말풍선" />
      </div>
    </FloatingPortal>
  );
}

function ActionBtn({ icon, label, onClick, active }: { icon: React.ReactNode; label: string; onClick: () => void; active?: boolean }) {
  return (
    <button
      type="button"
      className={`flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium transition-colors ${
        active ? 'bg-indigo-100 text-indigo-700 font-semibold' : 'text-slate-700 hover:bg-slate-100 active:bg-slate-200'
      }`}
      onClick={onClick}
    >
      {icon}
      {label}
    </button>
  );
}

function CitationBadge({ session, citation, open }: { session: NoteSession; citation: PendingCitation; open: boolean }) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  let pos: { x: number; y: number } | null = null;
  try {
    const c = session.editor.view.coordsAtPos(Math.min(citation.to, session.editor.state.doc.content.size));
    const pr = session.pageEl!.getBoundingClientRect();
    const zoom = session.ui.zoom || 1;
    pos = { x: (c.right - pr.left) / zoom + 4, y: (c.top - pr.top) / zoom - 4 };
  } catch {
    pos = null;
  }
  if (!pos) return null;
  return (
    <>
      <button
        ref={setEl}
        data-overlay
        className={`citation-badge pointer-events-auto absolute ${citation.status}`}
        style={{ left: pos.x, top: pos.y }}
        title={citation.status === 'pending' ? '연관 문서 검색 중…' : '추천 인용 보기'}
        onClick={() => citation.status !== 'pending' && session.patch({ openCitationId: open ? null : citation.id })}
      >
        {citation.status === 'pending' ? (
          <Loader2 size={12} className="animate-spin" />
        ) : citation.status === 'error' ? (
          '!'
        ) : (
          <>
            <Sparkles size={11} /> {citation.results.length}
          </>
        )}
      </button>
      {open && el && <CitationPopover session={session} citation={citation} reference={el} />}
    </>
  );
}

function CitationPopover({ session, citation, reference }: { session: NoteSession; citation: PendingCitation; reference: HTMLElement }) {
  const { refs, floatingStyles, context } = useFloating({
    open: true,
    onOpenChange: (o) => !o && session.patch({ openCitationId: null }),
    placement: 'bottom-start',
    middleware: [offset(6), flip(), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
    transform: false, // framer-motion 이 transform 을 제어하므로 top/left 위치 지정
    elements: { reference },
  });
  const { getFloatingProps } = useInteractions([useDismiss(context)]);

  const insertCitation = (r: CitationResult) => {
    const { editor } = session;
    const $to = editor.state.doc.resolve(Math.min(citation.to, editor.state.doc.content.size));
    const after = $to.depth > 0 ? $to.after(1) : $to.pos;
    editor
      .chain()
      .focus()
      .insertContentAt(after, {
        type: 'blockquote',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: `“${snippet(r.text, 280)}” — ` },
              { type: 'wikiLink', attrs: { targetDocId: r.noteId, targetBlockId: r.blockId, label: r.title } },
            ],
          },
        ],
      })
      .run();
    session.dismissCitation(citation.id);
  };

  const mergeAsLink = (r: CitationResult) => {
    const { editor } = session;
    const label = editor.state.doc.textBetween(citation.from, citation.to, ' ') || citation.text;
    editor
      .chain()
      .focus()
      .insertContentAt({ from: citation.from, to: citation.to }, { type: 'wikiLink', attrs: { targetDocId: r.noteId, targetBlockId: r.blockId, label } })
      .run();
    session.dismissCitation(citation.id);
  };

  return (
    <FloatingPortal>
      <motion.div
        ref={refs.setFloating}
        style={floatingStyles}
        {...getFloatingProps()}
        data-overlay
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="z-50 w-[360px] rounded-2xl border border-emerald-200 bg-white shadow-2xl"
      >
        <div className="flex items-center gap-2 rounded-t-2xl border-b bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
          <Sparkles size={13} />
          <span className="flex-1 truncate">“{snippet(citation.text, 40)}” 연관 단락</span>
          <span className="text-[10px] text-emerald-700">{citation.source === 'elasticsearch' ? 'Elasticsearch' : 'MiniSearch(BM25)'}</span>
          <button className="icon-btn" onClick={() => session.dismissCitation(citation.id)} title="추천 닫기">
            <X size={13} />
          </button>
        </div>
        <div className="max-h-[300px] overflow-y-auto p-2">
          {citation.status === 'error' && <p className="p-2 text-xs text-red-600">검색 실패: {citation.error}</p>}
          {citation.results.length === 0 && citation.status === 'done' && <p className="p-3 text-center text-xs text-slate-500">연관도가 높은 단락을 찾지 못했습니다.</p>}
          {citation.results.map((r, i) => (
            <div key={i} className="mb-2 rounded-xl border border-slate-100 p-2 hover:border-emerald-200">
              <div className="mb-1 text-[11px] font-semibold text-slate-700">📄 {r.title}</div>
              <p className="mb-2 line-clamp-3 text-xs text-slate-600">{r.text}</p>
              <div className="flex gap-1">
                <button className="btn-ghost text-[11px]" onClick={() => insertCitation(r)}>
                  <Quote size={11} /> 인용 삽입
                </button>
                <button className="btn-ghost text-[11px]" onClick={() => mergeAsLink(r)}>
                  <Link2 size={11} /> 위키링크로 병합
                </button>
              </div>
            </div>
          ))}
        </div>
      </motion.div>
    </FloatingPortal>
  );
}
