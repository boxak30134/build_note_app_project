import { useEffect, useState } from 'react';
import { useFloating, autoUpdate, offset, flip, shift, FloatingPortal } from '@floating-ui/react';
import { motion } from 'framer-motion';
import { db } from '../storage/db';
import { extractBlocks, snippet } from '../core/doc/blocks';
import { useTabs } from '../store/tabsStore';
import { toast } from '../store/uiStore';
import { getSession } from '../session/NoteSession';

/** 링크 대상 해석: docId 우선, 없으면 제목 일치(외부 [[제목]] 링크 호환) */
async function resolveTarget(docRef: string) {
  const byId = await db.notes.get(docRef);
  if (byId && !byId.deletedAt) return byId;
  const normalized = docRef.replace(/\.md$/i, '').trim().toLowerCase();
  return db.notes
    .filter((n) => !n.deletedAt && (n.title === docRef || n.title.replace(/\.md$/i, '').trim().toLowerCase() === normalized))
    .first();
}

export async function openWikiTarget(docRef: string, blockId: string | null) {
  const note = await resolveTarget(docRef);
  if (!note) {
    toast.error('링크된 노트를 찾을 수 없습니다 (삭제되었거나 이름이 바뀌었을 수 있음).');
    return;
  }
  useTabs.getState().openTab(note.id, blockId ?? undefined);
}

async function loadSnippet(docRef: string, blockId: string | null): Promise<{ title: string; text: string } | null> {
  const note = await resolveTarget(docRef);
  if (!note) return null;
  // 열린 세션이 있으면 최신(미저장) 내용 기준
  const live = getSession(note.id);
  const content = live ? live.editor.getJSON() : note.content;
  const blocks = extractBlocks(content);
  const target = blockId ? blocks.find((b) => b.blockId === blockId) : null;
  const text = target ? target.text : blocks.slice(0, 4).map((b) => b.text).join('\n');
  return { title: note.title, text: snippet(text || '(빈 문서)', 300) };
}

/** 위키링크 호버 미리보기 툴팁 (최대 300자 스니펫) */
export function WikiPreview({ reference, onHoverChange }: { reference: HTMLElement; onHoverChange: (hover: boolean) => void }) {
  const [data, setData] = useState<{ title: string; text: string } | null | undefined>(undefined);
  const { refs, floatingStyles } = useFloating({
    placement: 'bottom-start',
    middleware: [offset(6), flip(), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
    transform: false, // framer-motion 이 transform 을 제어하므로 top/left 위치 지정
    elements: { reference },
  });

  useEffect(() => {
    let alive = true;
    setData(undefined);
    void loadSnippet(reference.dataset.targetDoc ?? '', reference.dataset.targetBlock || null).then((d) => alive && setData(d));
    return () => {
      alive = false;
    };
  }, [reference]);

  return (
    <FloatingPortal>
      <motion.div
        ref={refs.setFloating}
        style={floatingStyles}
        initial={{ opacity: 0, y: -4 }}
        animate={{ opacity: 1, y: 0 }}
        className="z-50 w-80 rounded-xl border border-indigo-100 bg-white p-3 shadow-xl"
        onPointerEnter={() => onHoverChange(true)}
        onPointerLeave={() => onHoverChange(false)}
      >
        {data === undefined && <p className="text-xs text-slate-400">불러오는 중…</p>}
        {data === null && <p className="text-xs text-red-500">링크된 노트를 찾을 수 없습니다.</p>}
        {data && (
          <>
            <div className="mb-1 text-xs font-semibold text-indigo-700">📄 {data.title}</div>
            <p className="whitespace-pre-wrap text-xs leading-relaxed text-slate-600">{data.text}</p>
            <p className="mt-2 text-[10px] text-slate-400">더블클릭하여 열기</p>
          </>
        )}
      </motion.div>
    </FloatingPortal>
  );
}
