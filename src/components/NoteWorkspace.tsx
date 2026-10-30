import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AlertTriangle, RefreshCw, Lock } from 'lucide-react';
import { openSession, type NoteSession } from '../session/NoteSession';
import { useSessionUI } from '../store/sessionStore';
import { useTabs } from '../store/tabsStore';
import { toast } from '../store/uiStore';
import { InkCanvas } from '../canvas/InkCanvas';
import { OverlayLayer } from './OverlayLayer';
import { SelectionMenu } from './SelectionMenu';
import { WikiPreview, openWikiTarget } from './WikiPreview';

export const PAGE_WIDTH = 840;

/** 탭 하나의 하이브리드 워크스페이스 (Layer1 에디터 / Layer2 캔버스 / Layer3 오버레이) */
export function NoteWorkspace({ noteId, active }: { noteId: string; active: boolean }) {
  const [session, setSession] = useState<NoteSession | null>(null);

  useEffect(() => {
    let alive = true;
    void openSession(noteId).then((s) => {
      if (!alive) return;
      if (!s) {
        toast.error('노트를 찾을 수 없어 탭을 닫았습니다.');
        useTabs.getState().closeTab(noteId);
        return;
      }
      setSession(s);
    });
    return () => {
      alive = false;
    };
  }, [noteId]);

  if (!session) {
    return <div className={active ? 'flex flex-1 items-center justify-center text-sm text-slate-400' : 'hidden'}>불러오는 중…</div>;
  }
  return <LoadedWorkspace session={session} active={active} />;
}

function LoadedWorkspace({ session, active }: { session: NoteSession; active: boolean }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const ui = useSessionUI(session.id);
  const strokes = useSyncExternalStore(session.strokes.subscribe, session.strokes.getAll);
  const [hoverLink, setHoverLink] = useState<HTMLElement | null>(null);
  const pendingScroll = useTabs((s) => s.pendingScroll[session.id]);

  // 에디터 DOM 호스트 부착 (탭 전환 시에도 동일 인스턴스 유지)
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.appendChild(session.host);
    session.pageEl = pageRef.current;
    session.scrollEl = viewportRef.current;
    return () => {
      if (session.host.parentElement === host) host.removeChild(session.host);
    };
  }, [session]);

  // 위키링크 더블클릭 이동 → 타깃 단락 스크롤
  useEffect(() => {
    if (!active || !pendingScroll) return;
    const t = setTimeout(() => {
      const blockId = useTabs.getState().consumeScroll(session.id);
      if (!blockId) return;
      const el = pageRef.current?.querySelector(`[data-block-id="${CSS.escape(blockId)}"]`) as HTMLElement | null;
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        el.classList.add('flash-block');
        setTimeout(() => el.classList.remove('flash-block'), 1600);
      }
    }, 60);
    return () => clearTimeout(t);
  }, [active, pendingScroll, session]);

  // 위키링크 호버 미리보기 / 더블클릭 이동 (이벤트 위임)
  useEffect(() => {
    const page = pageRef.current;
    if (!page) return;
    let hideTimer: ReturnType<typeof setTimeout> | null = null;
    const over = (e: PointerEvent) => {
      const link = (e.target as HTMLElement).closest('.wiki-link') as HTMLElement | null;
      if (link) {
        if (hideTimer) clearTimeout(hideTimer);
        setHoverLink(link);
      }
    };
    const out = (e: PointerEvent) => {
      const link = (e.target as HTMLElement).closest('.wiki-link');
      if (link) {
        hideTimer = setTimeout(() => setHoverLink(null), 220);
      }
    };
    const dbl = (e: MouseEvent) => {
      const link = (e.target as HTMLElement).closest('.wiki-link') as HTMLElement | null;
      if (!link) return;
      e.preventDefault();
      setHoverLink(null);
      void openWikiTarget(link.dataset.targetDoc ?? '', link.dataset.targetBlock || null);
    };
    page.addEventListener('pointerover', over);
    page.addEventListener('pointerout', out);
    page.addEventListener('dblclick', dbl);
    return () => {
      page.removeEventListener('pointerover', over);
      page.removeEventListener('pointerout', out);
      page.removeEventListener('dblclick', dbl);
    };
  }, []);

  useEffect(() => {
    session.editor.setEditable(!ui.readOnly);
  }, [ui.readOnly, session]);

  let maxY = 0;
  for (const s of strokes) for (const p of s.points) if (p[1] > maxY) maxY = p[1];
  const minHeight = Math.max(1400, maxY + 600);

  return (
    <div className={active ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
      {ui.external === 'modified' && (
        <div className="flex items-center gap-3 border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
          <AlertTriangle size={16} />
          <span className="flex-1">이 파일이 다른 프로그램에서 변경되었습니다. 현재 편집 중인 내용과 다릅니다.</span>
          <button className="btn-ghost" onClick={() => void session.reloadFromDisk()}>
            <RefreshCw size={13} /> 디스크 내용으로 다시 불러오기
          </button>
          <button className="btn-ghost" onClick={() => session.keepMine()}>
            내 편집 내용 유지
          </button>
        </div>
      )}
      {ui.external === 'deleted' && (
        <div className="flex items-center gap-3 border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800">
          <Lock size={16} />
          <span className="flex-1">원본 파일이 외부에서 삭제되었습니다. 문서가 읽기 전용으로 전환되었습니다.</span>
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        <div ref={viewportRef} className="note-viewport absolute inset-0 overflow-auto">
          <div ref={pageRef} className="note-page relative mx-auto" style={{ width: PAGE_WIDTH, minHeight }}>
            <div ref={hostRef} className="relative z-10" />
            <OverlayLayer session={session} />
          </div>
        </div>
        <InkCanvas session={session} viewportRef={viewportRef} active={active} />
      </div>
      {active && <SelectionMenu session={session} />}
      {active && hoverLink && <WikiPreview reference={hoverLink} onHoverChange={(h) => !h && setHoverLink(null)} />}
    </div>
  );
}
