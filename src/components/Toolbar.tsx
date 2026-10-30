import { useEffect, useState } from 'react';
import { useFloating, autoUpdate, offset, flip, shift, useDismiss, useInteractions, FloatingPortal } from '@floating-ui/react';
import { motion } from 'framer-motion';
import { Pencil, Highlighter, Eraser, Lasso, Undo2, Redo2, MousePointer2, Type } from 'lucide-react';
import { useSettings, type Tool } from '../store/settingsStore';
import { useTabs } from '../store/tabsStore';
import { useSessionUI } from '../store/sessionStore';
import { getSession } from '../session/NoteSession';

const TOOLS: Array<{ id: Tool; icon: React.ReactNode; label: string }> = [
  { id: 'none', icon: <Type size={17} />, label: '텍스트 (펜으로 필기하지 않음)' },
  { id: 'pencil', icon: <Pencil size={17} />, label: '펜슬' },
  { id: 'highlighter', icon: <Highlighter size={17} />, label: '형광펜' },
  { id: 'eraser', icon: <Eraser size={17} />, label: '지우개' },
  { id: 'lasso', icon: <Lasso size={17} />, label: '올가미' },
];

/** 툴바: [펜슬][형광펜][지우개][올가미] | [🔴][🟡][⚫] | [↶][↷] */
export function Toolbar() {
  const { tool, setTool, mouseDraw, set, penSize, highlighterSize, eraserSize } = useSettings();
  const activeId = useTabs((s) => s.activeTabId);
  const ui = useSessionUI(activeId);

  const pickTool = (t: Tool) => {
    setTool(t);
    const s = getSession(activeId);
    if (s && t !== 'lasso') s.patch({ lassoIds: [], moveMode: false });
  };

  const sizeKey = tool === 'highlighter' ? 'highlighterSize' : tool === 'eraser' ? 'eraserSize' : 'penSize';
  const sizeVal = tool === 'highlighter' ? highlighterSize : tool === 'eraser' ? eraserSize : penSize;

  return (
    <div className="flex h-11 shrink-0 items-center gap-1 border-b border-slate-200 bg-slate-50/80 px-2">
      {TOOLS.map((t) => (
        <button key={t.id} className={`tool-btn ${tool === t.id ? 'tool-active' : ''}`} onClick={() => pickTool(t.id)} title={t.label}>
          {t.icon}
        </button>
      ))}
      <div className="mx-2 h-6 w-px bg-slate-300" />
      <ColorSlots />
      {(tool === 'pencil' || tool === 'highlighter' || tool === 'eraser') && (
        <label className="ml-2 flex items-center gap-1 text-[11px] text-slate-500" title="굵기">
          굵기
          <input type="range" min={tool === 'highlighter' ? 8 : 1} max={tool === 'highlighter' ? 40 : 24} value={sizeVal} onChange={(e) => set({ [sizeKey]: Number(e.target.value) })} className="w-20 accent-indigo-500" />
        </label>
      )}
      <div className="mx-2 h-6 w-px bg-slate-300" />
      <button className="tool-btn" disabled={!ui.canUndo} onClick={() => getSession(activeId)?.undo()} title="뒤로 가기 (Ctrl+Z)">
        <Undo2 size={17} />
      </button>
      <button className="tool-btn" disabled={!ui.canRedo} onClick={() => getSession(activeId)?.redo()} title="앞으로 가기 (Ctrl+Shift+Z / Ctrl+Y)">
        <Redo2 size={17} />
      </button>
      <div className="flex-1" />
      <button
        className={`flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] ${mouseDraw ? 'bg-indigo-100 text-indigo-700' : 'text-slate-500 hover:bg-slate-200'}`}
        onClick={() => set({ mouseDraw: !mouseDraw })}
        title="S-Pen 이 없는 환경에서 마우스로 필기합니다"
      >
        <MousePointer2 size={13} /> 마우스 필기 {mouseDraw ? 'ON' : 'OFF'}
      </button>
    </div>
  );
}

function ColorSlots() {
  const { colorSlots, activeSlot, selectSlot } = useSettings();
  const [editing, setEditing] = useState<{ index: number; el: HTMLElement } | null>(null);
  return (
    <div className="flex items-center gap-1.5">
      {colorSlots.map((c, i) => (
        <button
          key={i}
          className={`color-slot ${activeSlot === i ? 'color-slot-active' : ''}`}
          style={{ background: c }}
          title="클릭: 선택 / 더블클릭: 색상 변경"
          onClick={() => selectSlot(i)}
          onDoubleClick={(e) => setEditing({ index: i, el: e.currentTarget })}
        />
      ))}
      {editing && <ColorPickerPopover index={editing.index} reference={editing.el} onClose={() => setEditing(null)} />}
    </div>
  );
}

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(r: number, g: number, b: number) {
  return '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, v | 0)).toString(16).padStart(2, '0')).join('').toUpperCase();
}

const PRESETS = ['#EF4444', '#F97316', '#FACC15', '#22C55E', '#14B8A6', '#3B82F6', '#6366F1', '#A855F7', '#EC4899', '#000000', '#64748B', '#FFFFFF'];

/** 더블클릭 시 슬롯 우측(right-start)에 뜨는 플로팅 컬러 피커 — 슬롯 색을 영구 재지정 */
function ColorPickerPopover({ index, reference, onClose }: { index: number; reference: HTMLElement; onClose: () => void }) {
  const { colorSlots, setSlotColor, selectSlot } = useSettings();
  const current = colorSlots[index];
  const [hex, setHex] = useState(current);
  useEffect(() => setHex(current), [current]);
  const { refs, floatingStyles, context } = useFloating({
    open: true,
    onOpenChange: (o) => !o && onClose(),
    placement: 'right-start',
    middleware: [offset(10), flip(), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
    transform: false, // framer-motion 이 transform 을 제어하므로 top/left 위치 지정
    elements: { reference },
  });
  const { getFloatingProps } = useInteractions([useDismiss(context)]);
  const apply = (c: string) => {
    if (/^#[0-9a-f]{6}$/i.test(c)) {
      setSlotColor(index, c.toUpperCase());
      selectSlot(index);
    }
  };
  const [r, g, b] = hexToRgb(current);

  return (
    <FloatingPortal>
      <motion.div
        ref={refs.setFloating}
        style={floatingStyles}
        {...getFloatingProps()}
        initial={{ opacity: 0, x: -6 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ type: 'spring', stiffness: 500, damping: 30 }}
        className="color-picker z-50 w-56 rounded-xl border border-slate-200 bg-white p-3 shadow-2xl"
        data-testid="color-picker"
      >
        <div className="mb-2 text-xs font-semibold text-slate-600">슬롯 {index + 1} 색상</div>
        <input type="color" className="h-24 w-full cursor-pointer rounded" value={current.toLowerCase()} onChange={(e) => apply(e.target.value)} />
        <div className="mt-2 grid grid-cols-6 gap-1">
          {PRESETS.map((p) => (
            <button key={p} className="h-6 w-6 rounded-md border border-slate-200" style={{ background: p }} onClick={() => apply(p)} title={p} />
          ))}
        </div>
        <div className="mt-2 flex items-center gap-1">
          <span className="text-[11px] text-slate-500">HEX</span>
          <input
            className="w-full rounded border px-1.5 py-0.5 font-mono text-xs"
            value={hex}
            onChange={(e) => {
              setHex(e.target.value);
              apply(e.target.value.startsWith('#') ? e.target.value : `#${e.target.value}`);
            }}
          />
        </div>
        <div className="mt-1 flex items-center gap-1">
          <span className="text-[11px] text-slate-500">RGB</span>
          {[r, g, b].map((v, i) => (
            <input
              key={i}
              type="number"
              min={0}
              max={255}
              className="w-full rounded border px-1 py-0.5 text-xs"
              value={v}
              onChange={(e) => {
                const arr: [number, number, number] = [r, g, b];
                arr[i] = Number(e.target.value);
                apply(rgbToHex(...arr));
              }}
            />
          ))}
        </div>
      </motion.div>
    </FloatingPortal>
  );
}
