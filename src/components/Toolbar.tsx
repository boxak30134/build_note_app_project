import { useEffect, useRef, useState } from 'react';
import { useFloating, autoUpdate, offset, flip, shift, useDismiss, useInteractions, FloatingPortal } from '@floating-ui/react';
import { motion } from 'framer-motion';
import {
  Pencil,
  Highlighter,
  Eraser,
  Lasso,
  Undo2,
  Redo2,
  MousePointer2,
  Type,
  FilePlus2,
  FileSpreadsheet,
  ChevronDown,
  Check,
  Upload,
  Sparkles,
  Trash2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { useSettings, type Tool, PEN_TYPES, PALETTE_COLOR_NAMES } from '../store/settingsStore';
import { PenSettingsPopup } from './PenSettingsPopup';
import { RgbColorPickerModal } from './RgbColorPickerModal';
import { useTabs } from '../store/tabsStore';
import { useSessionUI } from '../store/sessionStore';
import { getSession } from '../session/NoteSession';
import { toast } from '../store/uiStore';
import { db } from '../storage/db';
import {
  DEFAULT_NOTE_ZOOM,
  MAX_NOTE_ZOOM,
  MIN_NOTE_ZOOM,
  NOTE_ZOOM_STEP,
  PAPER_SPECS,
  PAGE_STYLE_LABELS,
  type DocFormatMode,
  type PageOrientation,
  type PageStyleId,
  type PaperSizeId,
} from '../core/page/pageTypes';
import {
  getCategorizedFontList,
  parseCustomFontFile,
  registerCustomFontInDOM,
  resolveFontById,
  type FontItem,
} from '../core/font/fontManager';

const TOOLS: Array<{ id: Tool; icon: React.ReactNode; label: string }> = [
  { id: 'none', icon: <Type size={17} />, label: '텍스트 (펜으로 필기하지 않음)' },
  { id: 'pencil', icon: <Pencil size={17} />, label: '펜 (만년필/볼펜/연필/붓)' },
  { id: 'highlighter', icon: <Highlighter size={17} />, label: '형광펜' },
  { id: 'eraser', icon: <Eraser size={17} />, label: '지우개' },
  { id: 'lasso', icon: <Lasso size={17} />, label: '올가미' },
];

/** 툴바: [펜][형광펜][지우개][올가미] | [빨주노초파남보 검정][🎨 RGB] | [↶][↷] */
export function Toolbar() {
  const { tool, setTool, mouseDraw, set, penSize, highlighterSize, eraserSize, penType } = useSettings();
  const [penPopupOpen, setPenPopupOpen] = useState(false);
  const activeId = useTabs((s) => s.activeTabId);
  const ui = useSessionUI(activeId);
  const activePenDef = PEN_TYPES.find((p) => p.id === penType);

  const pickTool = (t: Tool) => {
    if (t === 'pencil' && tool === 'pencil') {
      setPenPopupOpen((o) => !o);
      return;
    }
    setTool(t);
    const s = getSession(activeId);
    if (s && t !== 'lasso') s.patch({ lassoIds: [], moveMode: false });
  };

  const sizeKey = tool === 'highlighter' ? 'highlighterSize' : tool === 'eraser' ? 'eraserSize' : 'penSize';
  const sizeVal = tool === 'highlighter' ? highlighterSize : tool === 'eraser' ? eraserSize : penSize;

  return (
    <div className="flex h-11 shrink-0 items-center gap-1 border-b border-slate-200 bg-slate-50/80 px-2">
      {TOOLS.map((t) => {
        if (t.id === 'pencil') {
          return (
            <div key={t.id} className="relative flex items-center">
              <button
                className={`tool-btn ${tool === t.id ? 'tool-active' : ''}`}
                onClick={() => pickTool(t.id)}
                title={tool === 'pencil' ? `펜: ${activePenDef?.name} (클릭하여 펜 설정 열기)` : t.label}
                data-testid="tool-pen-btn"
              >
                {t.icon}
              </button>
              {tool === 'pencil' && (
                <button
                  type="button"
                  className="h-7 w-3.5 -ml-1 flex items-center justify-center rounded text-slate-500 hover:bg-slate-200"
                  onClick={() => setPenPopupOpen((o) => !o)}
                  title="펜 종류 및 세부 설정 열기"
                  data-testid="pen-popup-toggle"
                >
                  <ChevronDown size={11} />
                </button>
              )}
              <PenSettingsPopup open={penPopupOpen} onClose={() => setPenPopupOpen(false)} />
            </div>
          );
        }
        return (
          <button key={t.id} className={`tool-btn ${tool === t.id ? 'tool-active' : ''}`} onClick={() => pickTool(t.id)} title={t.label}>
            {t.icon}
          </button>
        );
      })}
      <div className="mx-2 h-6 w-px bg-slate-300" />
      <ColorSlots activeId={activeId} />
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
      <div className="mx-2 h-6 w-px bg-slate-300" />
      <FontSelector activeId={activeId} />
      <FontSizeSelector activeId={activeId} />
      <div className="mx-1.5 h-6 w-px bg-slate-300" />
      <PageFormatControls activeId={activeId} />
      <div className="mx-1.5 h-6 w-px bg-slate-300" />
      <div className="flex items-center gap-0.5 rounded-lg border border-slate-200 bg-white px-1 py-0.5" data-testid="zoom-controls">
        <button
          type="button"
          data-testid="zoom-out-btn"
          className="tool-btn h-6 w-6"
          disabled={!activeId || (ui.zoom || DEFAULT_NOTE_ZOOM) <= MIN_NOTE_ZOOM}
          onClick={() => getSession(activeId)?.zoomBy(-NOTE_ZOOM_STEP)}
          title="노트 축소"
        >
          <ZoomOut size={13} />
        </button>
        <button
          type="button"
          data-testid="zoom-reset-btn"
          className="min-w-[44px] rounded px-1 py-0.5 text-center text-[11px] font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-40"
          disabled={!activeId}
          onClick={() => getSession(activeId)?.resetZoom()}
          title="배율 100% 초기화"
        >
          {Math.round((ui.zoom || DEFAULT_NOTE_ZOOM) * 100)}%
        </button>
        <button
          type="button"
          data-testid="zoom-in-btn"
          className="tool-btn h-6 w-6"
          disabled={!activeId || (ui.zoom || DEFAULT_NOTE_ZOOM) >= MAX_NOTE_ZOOM}
          onClick={() => getSession(activeId)?.zoomBy(NOTE_ZOOM_STEP)}
          title="노트 확대"
        >
          <ZoomIn size={13} />
        </button>
      </div>
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

function getContrastColor(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;
  return yiq >= 150 ? '#000000' : '#FFFFFF';
}

function ColorSlots({ activeId }: { activeId?: string | null }) {
  const { colorSlots, activeSlot, selectSlot, customColor, isCustomColorActive, selectCustomColor } = useSettings();
  const [editing, setEditing] = useState<{ index: number; el: HTMLElement } | null>(null);
  const [rgbModalOpen, setRgbModalOpen] = useState(false);

  const handleSelectSlot = (i: number) => {
    selectSlot(i);
    const color = colorSlots[i];
    const s = getSession(activeId);
    if (s && color) s.applyTextColor(color);
  };

  const handleSelectCustomColor = () => {
    selectCustomColor();
    const s = getSession(activeId);
    if (s && customColor) s.applyTextColor(customColor);
  };

  return (
    <div className="flex items-center gap-1" data-testid="toolbar-color-slots">
      {/* 1~8: 빨주노초파남보 검정 */}
      {colorSlots.slice(0, 8).map((c, i) => {
        const isActive = !isCustomColorActive && activeSlot === i;
        const contrast = getContrastColor(c);
        return (
          <button
            key={i}
            className={`color-slot relative flex items-center justify-center transition-transform hover:scale-110 ${
              isActive ? 'color-slot-active ring-2 ring-indigo-500 ring-offset-1 scale-105' : ''
            }`}
            style={{ background: c }}
            title={`${PALETTE_COLOR_NAMES[i] || '색상'} (${c}) — 클릭: 선택 / 더블클릭: 변경`}
            onClick={() => handleSelectSlot(i)}
            onDoubleClick={(e) => setEditing({ index: i, el: e.currentTarget })}
            data-testid={`color-slot-${i}`}
          >
            {isActive && <Check size={11} color={contrast} strokeWidth={3} />}
          </button>
        );
      })}

      {/* 검정의 오른쪽: RGB 사용자 지정 동그라미 */}
      <button
        type="button"
        className={`color-slot relative flex items-center justify-center transition-transform hover:scale-110 ${
          isCustomColorActive ? 'color-slot-active ring-2 ring-indigo-500 ring-offset-1 scale-105' : ''
        }`}
        style={{
          background: isCustomColorActive && customColor
            ? customColor
            : 'conic-gradient(from 0deg, #ff0000, #ff8800, #ffff00, #00ff00, #00ffff, #0000ff, #8800ff, #ff0088, #ff0000)',
        }}
        title="RGB 사용자 지정 색상 설정 창 열기"
        onClick={() => {
          handleSelectCustomColor();
          setRgbModalOpen(true);
        }}
        data-testid="rgb-custom-picker-btn"
      >
        {isCustomColorActive && (
          <Check size={11} color={getContrastColor(customColor)} strokeWidth={3} />
        )}
      </button>

      {editing && (
        <ColorPickerPopover
          index={editing.index}
          reference={editing.el}
          activeId={activeId}
          onClose={() => setEditing(null)}
        />
      )}
      <RgbColorPickerModal open={rgbModalOpen} onClose={() => setRgbModalOpen(false)} />
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
function ColorPickerPopover({
  index,
  reference,
  activeId,
  onClose,
}: {
  index: number;
  reference: HTMLElement;
  activeId?: string | null;
  onClose: () => void;
}) {
  const { colorSlots, setSlotColor, selectSlot } = useSettings();
  const current = colorSlots[index];
  const [hex, setHex] = useState(current);
  useEffect(() => {
    setHex(current);
  }, [current]);
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
      const upper = c.toUpperCase();
      setSlotColor(index, upper);
      selectSlot(index);
      const s = getSession(activeId);
      if (s) s.applyTextColor(upper);
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

/**
 * 폰트 선택기 & 로컬 폰트(.ttf, .otf) 추가 팝오버
 * - 최근에 선택한 폰트들은 맨 위에 따로 구분하여 표시 및 추천한다.
 */
function FontSelector({ activeId }: { activeId: string | null }) {
  const { selectedFontId, recentFontIds, customFonts, selectFont, addCustomFont, removeCustomFont } = useSettings();
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const currentFont = resolveFontById(selectedFontId, customFonts);
  const { recentFonts, allFonts } = getCategorizedFontList(customFonts, recentFontIds);

  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: 'bottom-start',
    middleware: [offset(6), flip(), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
    transform: false,
    elements: { reference: btnRef.current },
  });
  const { getFloatingProps } = useInteractions([useDismiss(context)]);

  const onChooseFont = (font: FontItem) => {
    selectFont(font.id);
    getSession(activeId)?.applyFontFamily(font.family);
    setOpen(false);
  };

  const onAddFontFiles = async (files: FileList | File[] | null) => {
    if (!files || files.length === 0) return;
    const list = Array.from(files);
    for (const file of list) {
      try {
        const record = await parseCustomFontFile(file);
        registerCustomFontInDOM(record);
        try {
          await db.customFonts.put(record);
        } catch {
          // IndexedDB 미지원 환경에서도 메모리/설정에 추가
        }
        addCustomFont({
          id: record.id,
          name: record.name,
          family: record.family,
          isCustom: true,
          fileName: record.fileName,
          format: record.format,
        });
        getSession(activeId)?.applyFontFamily(record.family);
        toast.success(`폰트 '${record.name}' 이(가) 추가되었습니다.`);
      } catch (e) {
        toast.error((e as Error).message);
      }
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const onRemoveCustomFont = async (e: React.MouseEvent, fontId: string) => {
    e.stopPropagation();
    removeCustomFont(fontId);
    try {
      await db.customFonts.delete(fontId);
    } catch {
      /* noop */
    }
  };

  return (
    <div className="relative flex items-center">
      <button
        ref={btnRef}
        type="button"
        data-testid="font-selector-btn"
        className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
        onClick={() => setOpen((o) => !o)}
        title="폰트 선택 및 로컬 폰트(.ttf, .otf) 추가"
      >
        <Type size={13} className="text-indigo-600" />
        <span className="max-w-[110px] truncate" style={{ fontFamily: currentFont.family }}>
          {currentFont.name}
        </span>
        <ChevronDown size={12} className="text-slate-400" />
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept=".ttf,.otf,.woff,.woff2,font/ttf,font/otf"
        multiple
        className="hidden"
        data-testid="font-file-input"
        onChange={(e) => void onAddFontFiles(e.target.files)}
      />
      {open && (
        <FloatingPortal>
          <motion.div
            ref={refs.setFloating}
            style={floatingStyles}
            {...getFloatingProps()}
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            className="z-50 w-72 rounded-xl border border-slate-200 bg-white p-2 shadow-2xl"
            data-testid="font-selector-popover"
          >
            {/* 최근 선택 및 추천 폰트 상단 구분 영역 */}
            {recentFonts.length > 0 && (
              <div data-testid="recent-fonts-section" className="mb-2 rounded-lg bg-indigo-50/60 p-1.5">
                <div className="mb-1 flex items-center gap-1 px-1.5 text-[11px] font-semibold text-indigo-700">
                  <Sparkles size={11} /> 최근 선택 · 추천 폰트
                </div>
                <div className="flex flex-col gap-0.5">
                  {recentFonts.map((f) => (
                    <button
                      key={`recent-${f.id}`}
                      type="button"
                      data-testid={`recent-font-item-${f.id}`}
                      className={`flex w-full items-center justify-between rounded-md px-2 py-1 text-left text-xs transition ${
                        selectedFontId === f.id ? 'bg-indigo-600 text-white' : 'text-slate-700 hover:bg-indigo-100/70'
                      }`}
                      style={{ fontFamily: f.family }}
                      onClick={() => onChooseFont(f)}
                    >
                      <span className="truncate">{f.name}</span>
                      {selectedFontId === f.id && <Check size={12} />}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="my-1.5 border-t border-slate-200" />

            {/* 전체 폰트 목록 */}
            <div data-testid="all-fonts-section">
              <div className="mb-1 px-1.5 text-[11px] font-semibold text-slate-500">
                전체 폰트 ({allFonts.length})
              </div>
              <div className="max-h-48 overflow-y-auto pr-0.5">
                {allFonts.map((f) => (
                  <div
                    key={f.id}
                    className={`flex items-center justify-between rounded-md px-2 py-1 text-xs transition ${
                      selectedFontId === f.id ? 'bg-slate-100 font-semibold text-indigo-700' : 'text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    <button
                      type="button"
                      data-testid={`all-font-item-${f.id}`}
                      className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                      style={{ fontFamily: f.family }}
                      onClick={() => onChooseFont(f)}
                    >
                      <span className="truncate">{f.name}</span>
                      {f.isCustom && (
                        <span className="shrink-0 rounded bg-emerald-100 px-1 py-0.2 text-[9px] font-medium text-emerald-700">
                          로컬
                        </span>
                      )}
                    </button>
                    <div className="flex items-center gap-1">
                      {selectedFontId === f.id && <Check size={12} className="text-indigo-600" />}
                      {f.isCustom && (
                        <button
                          type="button"
                          className="rounded p-0.5 text-slate-400 hover:bg-red-50 hover:text-red-500"
                          title="사용자 폰트 제거"
                          onClick={(e) => void onRemoveCustomFont(e, f.id)}
                        >
                          <Trash2 size={11} />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-2 border-t border-slate-200 pt-2">
              <button
                type="button"
                data-testid="add-font-btn"
                className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-indigo-300 bg-indigo-50/40 px-2.5 py-1.5 text-xs font-medium text-indigo-700 transition hover:bg-indigo-100/70"
                onClick={() => fileInputRef.current?.click()}
              >
                <Upload size={13} /> 로컬 폰트 추가 (.ttf, .otf)
              </button>
            </div>
          </motion.div>
        </FloatingPortal>
      )}
    </div>
  );
}

const FONT_SIZE_PRESETS = [10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 48];

/**
 * 폰트 크기 조절 메뉴 (스텝퍼 + 드롭다운 + 직접 입력)
 */
function FontSizeSelector({ activeId }: { activeId: string | null }) {
  const { fontSize, setFontSize } = useSettings();
  const [open, setOpen] = useState(false);
  const [customInput, setCustomInput] = useState(String(fontSize));
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setCustomInput(String(fontSize));
  }, [fontSize]);

  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: 'bottom-start',
    middleware: [offset(6), flip(), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
    transform: false,
    elements: { reference: btnRef.current },
  });
  const { getFloatingProps } = useInteractions([useDismiss(context)]);

  const applySize = (size: number) => {
    const clamped = Math.max(8, Math.min(72, Math.round(size)));
    setFontSize(clamped);
    getSession(activeId)?.applyFontSize(clamped);
  };

  const onSelectPreset = (size: number) => {
    applySize(size);
    setOpen(false);
  };

  const onDec = () => {
    const lower = [...FONT_SIZE_PRESETS].reverse().find((s) => s < fontSize);
    applySize(lower ?? Math.max(8, fontSize - 2));
  };

  const onInc = () => {
    const higher = FONT_SIZE_PRESETS.find((s) => s > fontSize);
    applySize(higher ?? Math.min(72, fontSize + 2));
  };

  const onSubmitCustom = (e: React.FormEvent) => {
    e.preventDefault();
    const val = parseInt(customInput, 10);
    if (!isNaN(val)) {
      applySize(val);
      setOpen(false);
    }
  };

  return (
    <div className="flex items-center gap-0.5 rounded-lg border border-slate-200 bg-white px-1 py-0.5" data-testid="font-size-controls">
      <button
        type="button"
        data-testid="font-size-dec-btn"
        className="tool-btn h-6 w-6 text-xs font-bold text-slate-600 hover:bg-slate-100 disabled:opacity-40"
        disabled={fontSize <= 8}
        onClick={onDec}
        title="글자 크기 축소 (-)"
      >
        -
      </button>
      <button
        ref={btnRef}
        type="button"
        data-testid="font-size-dropdown-btn"
        className="flex h-6 min-w-[42px] items-center justify-center gap-0.5 rounded px-1 text-[11px] font-medium text-slate-700 hover:bg-slate-100"
        onClick={() => setOpen((o) => !o)}
        title="글자 크기 선택 및 설정"
      >
        <span>{fontSize}px</span>
        <ChevronDown size={11} className="text-slate-400" />
      </button>
      <button
        type="button"
        data-testid="font-size-inc-btn"
        className="tool-btn h-6 w-6 text-xs font-bold text-slate-600 hover:bg-slate-100 disabled:opacity-40"
        disabled={fontSize >= 72}
        onClick={onInc}
        title="글자 크기 확대 (+)"
      >
        +
      </button>

      {open && (
        <FloatingPortal>
          <motion.div
            ref={refs.setFloating}
            style={floatingStyles}
            {...getFloatingProps()}
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.15 }}
            className="z-50 w-48 rounded-xl border border-slate-200 bg-white p-2.5 shadow-2xl"
            data-testid="font-size-dropdown"
          >
            <div className="mb-2 text-[11px] font-semibold text-slate-500">글자 크기 (폰트 크기)</div>
            <form onSubmit={onSubmitCustom} className="mb-2.5 flex items-center gap-1">
              <input
                type="number"
                min={8}
                max={72}
                value={customInput}
                onChange={(e) => setCustomInput(e.target.value)}
                className="w-16 rounded border border-slate-200 px-2 py-1 text-xs font-medium outline-none focus:border-indigo-400"
                data-testid="font-size-input"
              />
              <span className="text-xs text-slate-500">px</span>
              <button
                type="submit"
                className="ml-auto rounded bg-indigo-50 px-2 py-1 text-[11px] font-medium text-indigo-600 hover:bg-indigo-100"
                data-testid="font-size-apply-btn"
              >
                적용
              </button>
            </form>
            <div className="grid grid-cols-3 gap-1 border-t border-slate-100 pt-2">
              {FONT_SIZE_PRESETS.map((sz) => {
                const isSelected = fontSize === sz;
                return (
                  <button
                    key={sz}
                    type="button"
                    data-testid={`font-size-preset-${sz}`}
                    className={`flex items-center justify-center rounded py-1 text-xs font-medium transition ${
                      isSelected
                        ? 'bg-indigo-600 text-white font-semibold'
                        : 'text-slate-700 hover:bg-slate-100'
                    }`}
                    onClick={() => onSelectPreset(sz)}
                  >
                    {sz}px
                  </button>
                );
              })}
            </div>
          </motion.div>
        </FloatingPortal>
      )}
    </div>
  );
}

/**
 * 페이지 추가 버튼 및 용지 규격(A4/A3 등) · 문서 포맷(페이지 분리형 / 연속형) 설정 팝오버
 */
function PageFormatControls({ activeId }: { activeId: string | null }) {
  const {
    docFormat,
    defaultPaperSize,
    defaultPageStyle,
    defaultOrientation,
    setDocFormat,
    setDefaultPaperSize,
    setDefaultPageStyle,
    setDefaultOrientation,
  } = useSettings();
  const ui = useSessionUI(activeId);
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  const currentPage = ui.pages[ui.currentPageIndex] ?? ui.pages[0] ?? {
    size: defaultPaperSize,
    style: defaultPageStyle,
    orientation: defaultOrientation,
  };

  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: 'bottom-start',
    middleware: [offset(6), flip(), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
    transform: false,
    elements: { reference: btnRef.current },
  });
  const { getFloatingProps } = useInteractions([useDismiss(context)]);

  const handleAddPageBelow = () => {
    const s = getSession(activeId);
    if (!s) {
      toast.info('먼저 노트를 여세요.');
      return;
    }
    const created = s.addPageBelow();
    toast.success(`현재 페이지 아래에 새 페이지(${created.size})를 추가했습니다.`);
  };

  const handleSelectPaperSize = (size: PaperSizeId) => {
    setDefaultPaperSize(size);
    getSession(activeId)?.updateCurrentPageFormat({ size });
  };

  const handleSelectPageStyle = (style: PageStyleId) => {
    setDefaultPageStyle(style);
    getSession(activeId)?.updateCurrentPageFormat({ style });
  };

  const handleSelectOrientation = (orientation: PageOrientation) => {
    setDefaultOrientation(orientation);
    getSession(activeId)?.updateCurrentPageFormat({ orientation });
  };

  const handleSelectDocFormat = (mode: DocFormatMode) => {
    setDocFormat(mode);
  };

  return (
    <div className="flex items-center gap-1">
      {docFormat === 'paginated' && (
        <button
          type="button"
          data-testid="add-page-btn"
          className="flex items-center gap-1 rounded-lg border border-indigo-200 bg-indigo-50 px-2 py-1 text-xs font-medium text-indigo-700 transition hover:bg-indigo-100 disabled:opacity-40"
          disabled={!activeId}
          onClick={handleAddPageBelow}
          title="현재 페이지 바로 밑에 동일한 규격·스타일의 새 페이지 추가"
        >
          <FilePlus2 size={13} /> 페이지 추가
        </button>
      )}
      <button
        ref={btnRef}
        type="button"
        data-testid="page-settings-btn"
        className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
        onClick={() => setOpen((o) => !o)}
        title="용지 규격(A4/A3 등) 및 문서 포맷(페이지 분리형/연속형) 설정"
      >
        <FileSpreadsheet size={13} className="text-indigo-600" />
        <span>
          {currentPage.size} · {docFormat === 'paginated' ? `페이지 분리 (${ui.pages.length}p)` : '연속 페이지'}
        </span>
        <ChevronDown size={12} className="text-slate-400" />
      </button>

      {open && (
        <FloatingPortal>
          <motion.div
            ref={refs.setFloating}
            style={floatingStyles}
            {...getFloatingProps()}
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            className="z-50 w-80 rounded-xl border border-slate-200 bg-white p-3 shadow-2xl"
            data-testid="page-settings-popover"
          >
            {/* 1. 문서 포맷 설정 (페이지 분리형 vs 연속 페이지형) */}
            <div className="mb-3">
              <div className="mb-1.5 text-xs font-semibold text-slate-700">문서 작성 포맷</div>
              <div className="grid grid-cols-2 gap-1.5">
                <button
                  type="button"
                  data-testid="doc-format-paginated"
                  className={`rounded-lg border px-2.5 py-2 text-left text-xs transition ${
                    docFormat === 'paginated'
                      ? 'border-indigo-500 bg-indigo-50 font-semibold text-indigo-700'
                      : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                  }`}
                  onClick={() => handleSelectDocFormat('paginated')}
                >
                  <div>페이지 분리형</div>
                  <div className="mt-0.5 text-[10px] font-normal text-slate-500">표준 용지 단위로 분리</div>
                </button>
                <button
                  type="button"
                  data-testid="doc-format-continuous"
                  className={`rounded-lg border px-2.5 py-2 text-left text-xs transition ${
                    docFormat === 'continuous'
                      ? 'border-indigo-500 bg-indigo-50 font-semibold text-indigo-700'
                      : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                  }`}
                  onClick={() => handleSelectDocFormat('continuous')}
                >
                  <div>연속 단일 페이지</div>
                  <div className="mt-0.5 text-[10px] font-normal text-slate-500">분리 없이 한 페이지에 계속 작성</div>
                </button>
              </div>
            </div>

            {/* 2. 표준 종이 규격 (기본 A4) */}
            <div className="mb-3">
              <div className="mb-1.5 flex items-center justify-between text-xs font-semibold text-slate-700">
                <span>용지 규격 (표준 포맷)</span>
                <div className="flex gap-1 text-[11px] font-normal">
                  <button
                    type="button"
                    data-testid="orientation-portrait"
                    className={`rounded px-1.5 py-0.5 ${
                      currentPage.orientation === 'portrait' ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-600'
                    }`}
                    onClick={() => handleSelectOrientation('portrait')}
                  >
                    세로
                  </button>
                  <button
                    type="button"
                    data-testid="orientation-landscape"
                    className={`rounded px-1.5 py-0.5 ${
                      currentPage.orientation === 'landscape' ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-600'
                    }`}
                    onClick={() => handleSelectOrientation('landscape')}
                  >
                    가로
                  </button>
                </div>
              </div>
              <div className="grid grid-cols-1 gap-1">
                {(Object.keys(PAPER_SPECS) as PaperSizeId[]).map((sizeId) => {
                  const spec = PAPER_SPECS[sizeId];
                  const active = currentPage.size === sizeId;
                  return (
                    <button
                      key={sizeId}
                      type="button"
                      data-testid={`paper-size-${sizeId}`}
                      className={`flex items-center justify-between rounded-lg border px-2.5 py-1.5 text-xs transition ${
                        active
                          ? 'border-indigo-500 bg-indigo-50 font-semibold text-indigo-700'
                          : 'border-slate-200 text-slate-700 hover:bg-slate-50'
                      }`}
                      onClick={() => handleSelectPaperSize(sizeId)}
                    >
                      <span>{spec.label}</span>
                      {active && <Check size={13} />}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* 3. 페이지 배경 스타일 */}
            <div>
              <div className="mb-1.5 text-xs font-semibold text-slate-700">페이지 스타일</div>
              <div className="grid grid-cols-2 gap-1">
                {(Object.keys(PAGE_STYLE_LABELS) as PageStyleId[]).map((styleId) => {
                  const active = currentPage.style === styleId;
                  return (
                    <button
                      key={styleId}
                      type="button"
                      data-testid={`page-style-${styleId}`}
                      className={`rounded-lg border px-2 py-1.5 text-xs transition ${
                        active
                          ? 'border-indigo-500 bg-indigo-50 font-semibold text-indigo-700'
                          : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                      }`}
                      onClick={() => handleSelectPageStyle(styleId)}
                    >
                      {PAGE_STYLE_LABELS[styleId]}
                    </button>
                  );
                })}
              </div>
            </div>
          </motion.div>
        </FloatingPortal>
      )}
    </div>
  );
}
