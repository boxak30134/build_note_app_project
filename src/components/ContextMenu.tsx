import { useEffect } from 'react';
import { Copy, ClipboardPaste, MessageSquare, Link2 } from 'lucide-react';
import { motion } from 'framer-motion';
import { useContextMenu, strokeClipboard } from '../store/contextMenuStore';
import { getSession } from '../session/NoteSession';
import { lassoCopy, pasteStrokes } from '../features/lasso';
import { toast } from '../store/uiStore';

/** 롱프레스(500ms)/우클릭 커스텀 컨텍스트 메뉴 */
export function ContextMenu() {
  const { open, x, y, noteId, pagePoint, hide } = useContextMenu();

  // 키보드 에디터에서 네이티브 복사/잘라내기(Ctrl+C, Ctrl+X) 발생 시 텍스트 클립보드 우선권으로 전환
  useEffect(() => {
    const onNativeCopyOrCut = () => {
      strokeClipboard.active = false;
    };
    window.addEventListener('copy', onNativeCopyOrCut);
    window.addEventListener('cut', onNativeCopyOrCut);
    return () => {
      window.removeEventListener('copy', onNativeCopyOrCut);
      window.removeEventListener('cut', onNativeCopyOrCut);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (!(e.target as HTMLElement).closest('[data-context-menu]')) hide();
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && hide();
    const t = setTimeout(() => window.addEventListener('pointerdown', close), 50);
    window.addEventListener('keydown', esc);
    return () => {
      clearTimeout(t);
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', esc);
    };
  }, [open, hide]);

  if (!open || !noteId) return null;
  const session = getSession(noteId);
  if (!session) return null;
  const hasTextSel = !session.editor.state.selection.empty;
  const hasLasso = session.ui.lassoIds.length > 0;

  const run = (fn: () => void | Promise<void>) => () => {
    hide();
    void fn();
  };

  const copy = async () => {
    if (hasLasso) return lassoCopy(session);
    const { from, to } = session.editor.state.selection;
    const text = session.editor.state.doc.textBetween(from, to, '\n');
    if (!text) return toast.info('복사할 선택 영역이 없습니다.');
    strokeClipboard.active = false;
    await navigator.clipboard.writeText(text).catch(() => document.execCommand('copy'));
    toast.success('복사했습니다.');
  };

  const paste = async () => {
    if (strokeClipboard.active && strokeClipboard.strokes.length > 0 && !hasTextSel) {
      pasteStrokes(session, pagePoint ?? { x: 80, y: 80 });
      return;
    }
    try {
      const text = await navigator.clipboard.readText();
      if (text) session.editor.chain().focus().insertContent(text).run();
    } catch {
      toast.error('클립보드 접근 권한이 없습니다. Ctrl+V 를 사용하세요.');
    }
  };

  const left = Math.min(x, window.innerWidth - 200);
  const top = Math.min(y, window.innerHeight - 220);

  return (
    <motion.div
      data-context-menu
      data-overlay
      initial={{ opacity: 0, scale: 0.92 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.12 }}
      className="fixed z-[60] w-48 rounded-xl border border-slate-200 bg-white py-1 text-sm shadow-2xl"
      style={{ left, top }}
    >
      <button className="menu-item" onClick={run(copy)}>
        <Copy size={14} /> 복사
      </button>
      <button className="menu-item" onClick={run(paste)}>
        <ClipboardPaste size={14} /> 붙여넣기
      </button>
      <div className="my-1 border-t border-slate-100" />
      <button
        className="menu-item"
        onClick={run(() => {
          if (hasTextSel || hasLasso) session.createAnnotation();
          else session.createAnnotation(pagePoint ?? undefined);
        })}
      >
        <MessageSquare size={14} /> 말풍선 주석 달기
      </button>
      <button className="menu-item disabled:opacity-40" disabled={!hasTextSel} onClick={run(() => session.requestLinkSuggestions())} title={hasTextSel ? '' : '텍스트를 먼저 선택하세요'}>
        <Link2 size={14} /> 링크 생성
      </button>
    </motion.div>
  );
}
