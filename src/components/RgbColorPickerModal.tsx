import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { X, Check, Pipette } from 'lucide-react';
import { useSettings } from '../store/settingsStore';
import { toast } from '../store/uiStore';
import { useTabs } from '../store/tabsStore';
import { getSession } from '../session/NoteSession';

export function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace(/^#/, '');
  if (clean.length === 3) {
    const r = parseInt(clean[0] + clean[0], 16);
    const g = parseInt(clean[1] + clean[1], 16);
    const b = parseInt(clean[2] + clean[2], 16);
    return [isNaN(r) ? 0 : r, isNaN(g) ? 0 : g, isNaN(b) ? 0 : b];
  }
  const m = /^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(clean);
  if (!m) return [0, 0, 0];
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}

export function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return (
    '#' +
    [r, g, b]
      .map((v) => clamp(v).toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()
  );
}

interface Props {
  open: boolean;
  onClose: () => void;
  initialColor?: string;
  onApply?: (hex: string) => void;
}

export function RgbColorPickerModal({ open, onClose, initialColor, onApply }: Props) {
  const { customColor, setCustomColor, selectCustomColor } = useSettings();
  const init = initialColor || customColor || '#E11D48';
  const [initR, initG, initB] = hexToRgb(init);
  const [r, setR] = useState(initR);
  const [g, setG] = useState(initG);
  const [b, setB] = useState(initB);
  const [hexInput, setHexInput] = useState(init);

  useEffect(() => {
    if (open) {
      const startHex = initialColor || customColor || '#E11D48';
      const [sr, sg, sb] = hexToRgb(startHex);
      setR(sr);
      setG(sg);
      setB(sb);
      setHexInput(startHex);
    }
  }, [open, initialColor, customColor]);

  const currentHex = rgbToHex(r, g, b);

  const handleRChange = (val: number) => {
    const clamped = Math.max(0, Math.min(255, val || 0));
    setR(clamped);
    setHexInput(rgbToHex(clamped, g, b));
  };

  const handleGChange = (val: number) => {
    const clamped = Math.max(0, Math.min(255, val || 0));
    setG(clamped);
    setHexInput(rgbToHex(r, clamped, b));
  };

  const handleBChange = (val: number) => {
    const clamped = Math.max(0, Math.min(255, val || 0));
    setB(clamped);
    setHexInput(rgbToHex(r, g, clamped));
  };

  const handleHexChange = (text: string) => {
    setHexInput(text);
    if (/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.test(text)) {
      const [nr, ng, nb] = hexToRgb(text);
      setR(nr);
      setG(ng);
      setB(nb);
    }
  };

  const apply = () => {
    const finalHex = currentHex;
    if (onApply) {
      onApply(finalHex);
    } else {
      setCustomColor(finalHex);
      selectCustomColor();
      const activeId = useTabs.getState().activeTabId;
      const s = getSession(activeId);
      if (s) s.applyTextColor(finalHex);
    }
    toast.success(`사용자 지정 RGB 색상(${finalHex})이 적용되었습니다.`);
    onClose();
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={onClose}
      data-testid="rgb-color-modal-backdrop"
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 10 }}
        transition={{ type: 'spring', damping: 25, stiffness: 350 }}
        className="w-full max-w-sm rounded-2xl border border-slate-700 bg-slate-900 p-5 text-slate-100 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        data-testid="rgb-color-modal"
      >
        <div className="flex items-center justify-between border-b border-slate-800 pb-3">
          <div className="flex items-center gap-2">
            <div
              className="h-4 w-4 rounded-full"
              style={{
                background: 'conic-gradient(from 0deg, #ff0000, #ff8800, #ffff00, #00ff00, #00ffff, #0000ff, #8800ff, #ff0088, #ff0000)',
              }}
            />
            <h3 className="text-sm font-semibold tracking-wide text-white">사용자 지정 RGB 색상</h3>
          </div>
          <button
            type="button"
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-white"
            onClick={onClose}
            title="닫기"
          >
            <X size={18} />
          </button>
        </div>

        {/* Color Preview Swatch */}
        <div className="mt-4 flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-950/60 p-3">
          <div
            className="h-14 w-14 shrink-0 rounded-xl border border-white/20 shadow-inner"
            style={{ backgroundColor: currentHex }}
          />
          <div className="flex-1">
            <div className="text-xs font-medium text-slate-400">선택된 색상</div>
            <div className="font-mono text-base font-bold text-white tracking-wider">{currentHex}</div>
            <div className="font-mono text-[11px] text-slate-400">rgb({r}, {g}, {b})</div>
          </div>
          <label
            className="relative flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-slate-700 bg-slate-800 text-slate-300 hover:bg-slate-700 hover:text-white"
            title="시각적 색상 팔레트 열기"
          >
            <Pipette size={16} />
            <input
              type="color"
              className="absolute inset-0 opacity-0 cursor-pointer"
              value={currentHex}
              onChange={(e) => handleHexChange(e.target.value)}
            />
          </label>
        </div>

        {/* RGB Sliders & Numeric Inputs */}
        <div className="mt-4 space-y-3.5">
          {/* Red */}
          <div>
            <div className="flex items-center justify-between text-xs font-medium text-slate-300 mb-1">
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-red-500" />
                <span className="font-semibold text-red-400">R</span> (빨강)
              </span>
              <input
                type="number"
                min={0}
                max={255}
                value={r}
                onChange={(e) => handleRChange(Number(e.target.value))}
                className="w-16 rounded border border-slate-700 bg-slate-950 px-2 py-0.5 text-right font-mono text-xs text-white focus:border-red-500 focus:outline-none"
              />
            </div>
            <input
              type="range"
              min={0}
              max={255}
              value={r}
              onChange={(e) => handleRChange(Number(e.target.value))}
              className="w-full accent-red-500"
              style={{
                accentColor: '#EF4444',
              }}
            />
          </div>

          {/* Green */}
          <div>
            <div className="flex items-center justify-between text-xs font-medium text-slate-300 mb-1">
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-green-500" />
                <span className="font-semibold text-green-400">G</span> (초록)
              </span>
              <input
                type="number"
                min={0}
                max={255}
                value={g}
                onChange={(e) => handleGChange(Number(e.target.value))}
                className="w-16 rounded border border-slate-700 bg-slate-950 px-2 py-0.5 text-right font-mono text-xs text-white focus:border-green-500 focus:outline-none"
              />
            </div>
            <input
              type="range"
              min={0}
              max={255}
              value={g}
              onChange={(e) => handleGChange(Number(e.target.value))}
              className="w-full accent-green-500"
              style={{
                accentColor: '#22C55E',
              }}
            />
          </div>

          {/* Blue */}
          <div>
            <div className="flex items-center justify-between text-xs font-medium text-slate-300 mb-1">
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-blue-500" />
                <span className="font-semibold text-blue-400">B</span> (파랑)
              </span>
              <input
                type="number"
                min={0}
                max={255}
                value={b}
                onChange={(e) => handleBChange(Number(e.target.value))}
                className="w-16 rounded border border-slate-700 bg-slate-950 px-2 py-0.5 text-right font-mono text-xs text-white focus:border-blue-500 focus:outline-none"
              />
            </div>
            <input
              type="range"
              min={0}
              max={255}
              value={b}
              onChange={(e) => handleBChange(Number(e.target.value))}
              className="w-full accent-blue-500"
              style={{
                accentColor: '#3B82F6',
              }}
            />
          </div>
        </div>

        {/* HEX Input */}
        <div className="mt-4 flex items-center gap-2">
          <span className="text-xs font-semibold text-slate-400">HEX</span>
          <input
            type="text"
            value={hexInput}
            onChange={(e) => handleHexChange(e.target.value)}
            placeholder="#000000"
            className="flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-1 font-mono text-xs text-white focus:border-indigo-500 focus:outline-none"
          />
        </div>

        {/* Quick Presets */}
        <div className="mt-3 flex items-center justify-between">
          <span className="text-[11px] text-slate-400">추천 색상</span>
          <div className="flex items-center gap-1">
            {['#E11D48', '#FF6B6B', '#FFA94D', '#51CF66', '#22B8CF', '#339AF0', '#845EF7', '#F06595'].map((hex) => (
              <button
                key={hex}
                type="button"
                className="h-5 w-5 rounded-full border border-white/20 transition hover:scale-110"
                style={{ backgroundColor: hex }}
                onClick={() => handleHexChange(hex)}
                title={hex}
              />
            ))}
          </div>
        </div>

        {/* Action Buttons */}
        <div className="mt-5 flex items-center justify-end gap-2 border-t border-slate-800 pt-3">
          <button
            type="button"
            className="rounded-lg px-3 py-1.5 text-xs font-medium text-slate-400 hover:bg-slate-800 hover:text-white"
            onClick={onClose}
          >
            취소
          </button>
          <button
            type="button"
            className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-1.5 text-xs font-medium text-white shadow hover:bg-indigo-500"
            onClick={apply}
          >
            <Check size={14} /> 적용
          </button>
        </div>
      </motion.div>
    </div>
  );
}
