import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { motion, AnimatePresence } from 'framer-motion';
import { PanelLeft, PanelRight, Plus, FileText, Image as ImageIcon, Camera, Table, MessageSquare, Save, Bot, HardDrive } from 'lucide-react';
import { Capacitor } from '@capacitor/core';
import { useSettings } from '../store/settingsStore';
import { useTabs } from '../store/tabsStore';
import { useSessionUI } from '../store/sessionStore';
import { useUi, toast } from '../store/uiStore';
import { db } from '../storage/db';
import { getSession } from '../session/NoteSession';
import { validateFileName } from '../core/files/validation';
import { pickFiles } from '../storage/localFiles';

export async function captureFromCamera() {
  const s = getSession(useTabs.getState().activeTabId);
  if (!s) return toast.info('먼저 노트를 여세요.');
  if (Capacitor.isNativePlatform()) {
    try {
      const { Camera: Cam, CameraResultType } = await import('@capacitor/camera');
      const photo = await Cam.getPhoto({ resultType: CameraResultType.Base64, quality: 85 });
      const bytes = Uint8Array.from(atob(photo.base64String ?? ''), (c) => c.charCodeAt(0));
      await s.insertImageFiles([new File([bytes], `camera.${photo.format || 'jpg'}`, { type: `image/${photo.format || 'jpeg'}` })]);
    } catch (e) {
      toast.error(`카메라 오류: ${(e as Error).message}`);
    }
    return;
  }
  useUi.setState({ cameraOpen: true });
}

/** 헤더: [☰ Left] [노트 제목 실시간 입력] [저장] [+ 첨부] [🤖 Right] */
export function Header() {
  const { toggleLeft, toggleRight, leftOpen, rightOpen } = useSettings();
  const activeId = useTabs((s) => s.activeTabId);
  const note = useLiveQuery(() => (activeId ? db.notes.get(activeId) : undefined), [activeId]);
  const ui = useSessionUI(activeId);
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const editingRef = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!editingRef.current) setTitle(note?.title ?? '');
  }, [note?.title, activeId]);

  const onTitle = (v: string) => {
    setTitle(v);
    const err = validateFileName(v);
    setError(err);
    if (timer.current) clearTimeout(timer.current);
    if (err || !activeId) return;
    const id = activeId;
    // 디바운스 300ms → 탭 타이틀·스토리지 문서 제목 동기화
    timer.current = setTimeout(() => {
      void db.notes.update(id, { title: v });
      const s = getSession(id);
      if (s) {
        s.record.title = v;
        s.isManualTitle = v !== '제목 없는 노트' && v.trim() !== '';
      }
    }, 300);
  };

  const save = async () => {
    const s = getSession(activeId);
    if (s && (await s.save())) toast.success('저장했습니다.');
  };

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-slate-200 bg-white px-2">
      <button className={`icon-btn ${leftOpen ? 'text-indigo-600' : ''}`} onClick={toggleLeft} title="왼쪽 사이드바 열기/닫기">
        <PanelLeft size={18} />
      </button>
      <div className="mr-2 hidden select-none items-center gap-1 text-sm font-bold text-indigo-600 md:flex">✒️ EduInk</div>
      <div className="relative mx-auto flex min-w-0 max-w-xl flex-1 items-center gap-2">
        <input
          type="text"
          inputMode="text"
          lang="ko"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className={`w-full rounded-lg border px-3 py-1.5 text-center text-sm font-medium outline-none transition ${error ? 'border-red-400 bg-red-50' : 'border-transparent hover:border-slate-200 focus:border-indigo-300'}`}
          value={title}
          disabled={!activeId}
          placeholder={activeId ? '노트 제목' : '열린 노트가 없습니다'}
          onFocus={() => (editingRef.current = true)}
          onBlur={() => {
            editingRef.current = false;
            if (error) {
              setTitle(note?.title ?? '');
              setError(null);
            }
          }}
          onChange={(e) => onTitle(e.target.value)}
          title={error ?? ''}
        />
        {error && <span className="absolute -bottom-5 left-0 right-0 truncate text-center text-[10px] text-red-500">{error}</span>}
        {note?.fileHandle && (
          <span className="flex shrink-0 items-center gap-1 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500" title="로컬 파일과 연결됨 (원본 인코딩/줄바꿈 보존)">
            <HardDrive size={10} /> {note.encoding.toUpperCase()} · {note.eol.toUpperCase()}
          </span>
        )}
      </div>
      <button className={`btn-ghost ${ui.dirty ? 'text-indigo-600' : 'text-slate-400'}`} onClick={() => void save()} disabled={!activeId} title="저장 (Ctrl+S)">
        <Save size={15} /> {ui.dirty ? '저장' : '저장됨'}
      </button>
      <AttachMenu />
      <button className={`icon-btn ${rightOpen ? 'text-indigo-600' : ''}`} onClick={toggleRight} title="AI 사이드바 열기/닫기">
        <Bot size={18} />
        <PanelRight size={14} className="-ml-1" />
      </button>
    </header>
  );
}

function AttachMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);

  const withSession = (fn: (s: NonNullable<ReturnType<typeof getSession>>) => void | Promise<void>) => async () => {
    setOpen(false);
    const s = getSession(useTabs.getState().activeTabId);
    if (!s) return toast.info('먼저 노트를 여세요.');
    await fn(s);
  };

  const items = [
    {
      icon: <FileText size={15} />,
      label: 'PDF',
      run: withSession(async (s) => {
        const [f] = await pickFiles('application/pdf', false);
        if (f) await s.insertPdf(f);
      }),
    },
    {
      icon: <ImageIcon size={15} />,
      label: '이미지',
      run: withSession(async (s) => {
        const files = await pickFiles('image/png,image/jpeg,image/gif,image/webp', true);
        if (files.length) await s.insertImageFiles(files);
      }),
    },
    { icon: <Camera size={15} />, label: '카메라', run: withSession(() => captureFromCamera()) },
    { icon: <Table size={15} />, label: '표 (3×3)', run: withSession((s) => s.insertTable()) },
    { icon: <MessageSquare size={15} />, label: '말풍선', run: withSession((s) => void s.createAnnotation()) },
  ];

  return (
    <div className="relative" ref={ref}>
      <button className="btn-primary" onClick={() => setOpen((o) => !o)} title="첨부" onMouseDown={(e) => e.preventDefault()}>
        <Plus size={16} /> 첨부
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.96 }}
            transition={{ type: 'spring', stiffness: 500, damping: 32 }}
            className="absolute right-0 top-full z-50 mt-1 w-44 rounded-xl border border-slate-200 bg-white py-1 shadow-xl"
          >
            {items.map((it) => (
              <button key={it.label} className="menu-item" onMouseDown={(e) => e.preventDefault()} onClick={() => void it.run()}>
                {it.icon} {it.label}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
