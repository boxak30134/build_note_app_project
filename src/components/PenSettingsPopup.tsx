import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { X, Check, Minus, Plus } from 'lucide-react';
import { useSettings, PEN_TYPES, PALETTE_COLOR_NAMES, type PenType } from '../store/settingsStore';
import { RgbColorPickerModal, hexToRgb } from './RgbColorPickerModal';

interface Props {
  open: boolean;
  onClose: () => void;
  anchorRef?: React.RefObject<HTMLElement | null>;
}

function getContrastYIQ(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;
  return yiq >= 150 ? '#000000' : '#FFFFFF';
}

/** 1. 끝이 뾰족한 만년필 SVG */
function SharpFountainPenSvg() {
  return (
    <svg width="34" height="74" viewBox="0 0 34 74" fill="none" className="transition-transform duration-200">
      {/* Nib (尖, sharp metallic nib) */}
      <path d="M17 2 L13 22 L21 22 Z" fill="#D1D5DB" stroke="#9CA3AF" strokeWidth="0.8" />
      <path d="M17 2 L17 14" stroke="#4B5563" strokeWidth="0.6" strokeLinecap="round" />
      <circle cx="17" cy="14" r="1.2" fill="#4B5563" />
      {/* Ring / Collar */}
      <rect x="12" y="22" width="10" height="4" rx="0.5" fill="#E5E7EB" stroke="#9CA3AF" strokeWidth="0.5" />
      {/* Grip Section */}
      <rect x="11.5" y="26" width="11" height="14" fill="#F3F4F6" stroke="#D1D5DB" strokeWidth="0.5" />
      {/* Metal Accent Ring */}
      <rect x="11" y="40" width="12" height="3" fill="#9CA3AF" />
      {/* Body / Barrel */}
      <rect x="11" y="43" width="12" height="28" rx="1.5" fill="#4B5563" />
      <rect x="13.5" y="43" width="3" height="28" fill="#6B7280" opacity="0.6" />
      {/* End Cap */}
      <path d="M11 71 L23 71 L21 73 L13 73 Z" fill="#374151" />
    </svg>
  );
}

/** 2. 끝이 뭉툭한 만년필 (캘리그래피 플랫 닙) SVG */
function FlatFountainPenSvg() {
  return (
    <svg width="34" height="74" viewBox="0 0 34 74" fill="none" className="transition-transform duration-200">
      {/* Flat/Chisel Nib */}
      <path d="M13 3 L21 3 L22 22 L12 22 Z" fill="#D1D5DB" stroke="#9CA3AF" strokeWidth="0.8" />
      <line x1="17" y1="3" x2="17" y2="13" stroke="#4B5563" strokeWidth="0.7" />
      <circle cx="17" cy="13" r="1.2" fill="#4B5563" />
      {/* Nib Base */}
      <rect x="12" y="22" width="10" height="4" fill="#E5E7EB" stroke="#9CA3AF" strokeWidth="0.5" />
      {/* Grip */}
      <rect x="11.5" y="26" width="11" height="14" fill="#E5E7EB" stroke="#D1D5DB" strokeWidth="0.5" />
      {/* Ring */}
      <rect x="11" y="40" width="12" height="3" fill="#9CA3AF" />
      {/* Body */}
      <rect x="11" y="43" width="12" height="28" rx="1.5" fill="#6B7280" />
      <rect x="13" y="43" width="3" height="28" fill="#9CA3AF" opacity="0.5" />
      {/* End */}
      <path d="M11 71 L23 71 L21 73 L13 73 Z" fill="#4B5563" />
    </svg>
  );
}

/** 3. 볼펜 (노란색 바디, 둥근 팁) SVG */
function BallpointPenSvg() {
  return (
    <svg width="34" height="74" viewBox="0 0 34 74" fill="none" className="transition-transform duration-200">
      {/* Ball Tip */}
      <circle cx="17" cy="2.5" r="1" fill="#4B5563" />
      <path d="M15.5 3.5 L18.5 3.5 L20 16 L14 16 Z" fill="#E5E7EB" stroke="#9CA3AF" strokeWidth="0.5" />
      {/* Metal Collar */}
      <rect x="13" y="16" width="8" height="5" fill="#9CA3AF" />
      {/* Yellow Barrel */}
      <rect x="12" y="21" width="10" height="46" rx="2" fill="#EAB308" />
      <rect x="14" y="21" width="2.5" height="46" fill="#FDE047" opacity="0.8" />
      {/* Cap/Tail button */}
      <rect x="13.5" y="67" width="7" height="5" rx="1" fill="#4B5563" />
    </svg>
  );
}

/** 4. 연필 (빨간색 바디, 나무 깎임, 흑연 심) SVG */
function PencilPenSvg() {
  return (
    <svg width="34" height="74" viewBox="0 0 34 74" fill="none" className="transition-transform duration-200">
      {/* Graphite Lead Tip */}
      <path d="M17 1.5 L15 10 L19 10 Z" fill="#1F2937" />
      {/* Sharpened Wood Cone */}
      <path d="M15 10 L19 10 L21.5 24 L12.5 24 Z" fill="#FDE68A" stroke="#D97706" strokeWidth="0.5" />
      {/* Red Hexagonal Body */}
      <rect x="12" y="24" width="10" height="42" fill="#DC2626" />
      {/* Hex facets highlight */}
      <rect x="14.5" y="24" width="3.5" height="42" fill="#EF4444" />
      {/* Ferrule / End */}
      <rect x="12" y="66" width="10" height="6" fill="#9CA3AF" />
    </svg>
  );
}

/** 5. 붓 (부드러운 흰색 붓털, 메탈 페룰) SVG */
function BrushPenSvg() {
  return (
    <svg width="34" height="74" viewBox="0 0 34 74" fill="none" className="transition-transform duration-200">
      {/* Brush Hairs Tip (tapered) */}
      <path
        d="M17 1 C14 8, 12 18, 12.5 25 L21.5 25 C22 18, 20 8, 17 1 Z"
        fill="#F9FAFB"
        stroke="#D1D5DB"
        strokeWidth="0.6"
      />
      {/* Hair texture lines */}
      <path d="M15 12 Q16 20 16 25" stroke="#E5E7EB" strokeWidth="0.5" />
      <path d="M19 12 Q18 20 18 25" stroke="#E5E7EB" strokeWidth="0.5" />
      {/* Silver Ferrule */}
      <rect x="12" y="25" width="10" height="10" fill="#9CA3AF" stroke="#6B7280" strokeWidth="0.5" />
      <line x1="12" y1="30" x2="22" y2="30" stroke="#4B5563" strokeWidth="0.6" />
      {/* Handle */}
      <path d="M13 35 L21 35 L20 72 L14 72 Z" fill="#4B5563" />
      <path d="M15.5 35 L17.5 35 L17 72 L16 72 Z" fill="#6B7280" opacity="0.6" />
    </svg>
  );
}

export function PenSettingsPopup({ open, onClose }: Props) {
  const {
    penType,
    setPenType,
    penSize,
    set,
    autoStraighten,
    setAutoStraighten,
    colorSlots,
    activeSlot,
    selectSlot,
    customColor,
    isCustomColorActive,
  } = useSettings();

  const [rgbModalOpen, setRgbModalOpen] = useState(false);

  const activeColorHex = isCustomColorActive && customColor ? customColor : colorSlots[activeSlot] || '#000000';

  const renderPenIcon = (type: PenType) => {
    switch (type) {
      case 'fountain-sharp':
        return <SharpFountainPenSvg />;
      case 'fountain-flat':
        return <FlatFountainPenSvg />;
      case 'ballpoint':
        return <BallpointPenSvg />;
      case 'pencil':
        return <PencilPenSvg />;
      case 'brush':
        return <BrushPenSvg />;
    }
  };

  if (!open) return null;

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-transparent"
        onClick={onClose}
        data-testid="pen-settings-backdrop"
      />
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: -6 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: -6 }}
        transition={{ type: 'spring', damping: 26, stiffness: 360 }}
        className="absolute top-full left-0 mt-2 z-50 w-[350px] max-w-[calc(100vw-24px)] rounded-3xl border border-slate-700/80 bg-[#232429] p-5 text-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        data-testid="pen-settings-popup"
      >
        {/* Top Header & Scribble Preview */}
        <div className="flex items-center justify-between pb-1">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold tracking-wider text-slate-300">펜 설정</span>
          </div>
          <button
            type="button"
            className="rounded-full p-1 text-slate-400 hover:bg-white/10 hover:text-white"
            onClick={onClose}
            title="닫기"
          >
            <X size={17} />
          </button>
        </div>

        {/* Dynamic Pen & Color Scribble Preview */}
        <div className="relative my-2 flex h-14 items-center justify-center">
          <svg width="120" height="36" viewBox="0 0 120 36" fill="none" className="overflow-visible">
            <path
              d="M15 28 C 35 4, 60 34, 85 8 C 98 -4, 110 20, 115 14"
              stroke={activeColorHex}
              strokeWidth={Math.max(2, Math.min(8, penSize / 2))}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>

        {/* 5 Pens Row */}
        <div className="mt-1 flex items-end justify-between border-b border-white/10 pb-4 px-2">
          {PEN_TYPES.map((p) => {
            const isActive = penType === p.id;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => setPenType(p.id)}
                className={`group relative flex flex-col items-center transition-all duration-200 focus:outline-none ${
                  isActive ? '-translate-y-2' : 'hover:-translate-y-1 opacity-70 hover:opacity-100'
                }`}
                title={p.name}
                data-testid={`pen-type-${p.id}`}
              >
                {isActive && (
                  <div
                    className="mb-1 h-1.5 w-1.5 rounded-full"
                    style={{ backgroundColor: activeColorHex }}
                  />
                )}
                {renderPenIcon(p.id)}
                <span className="mt-1 text-[10px] text-slate-400 group-hover:text-slate-200 whitespace-nowrap">
                  {p.name.split(' ')[0]}
                </span>
              </button>
            );
          })}
        </div>

        {/* Thickness Slider */}
        <div className="mt-4 flex items-center justify-between gap-3 px-1">
          <button
            type="button"
            className="rounded-full p-1.5 text-slate-400 hover:bg-white/10 hover:text-white"
            onClick={() => set({ penSize: Math.max(1, penSize - 1) })}
            title="굵기 감소"
          >
            <Minus size={16} />
          </button>
          <div className="relative flex-1 flex items-center">
            <input
              type="range"
              min={1}
              max={50}
              value={penSize}
              onChange={(e) => set({ penSize: Number(e.target.value) })}
              className="w-full h-1.5 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-amber-500"
            />
            <div className="absolute left-1/2 -top-6 -translate-x-1/2 rounded-full bg-slate-700/90 px-2 py-0.5 text-[11px] font-mono font-semibold text-slate-200">
              {penSize}
            </div>
          </div>
          <button
            type="button"
            className="rounded-full p-1.5 text-slate-400 hover:bg-white/10 hover:text-white"
            onClick={() => set({ penSize: Math.min(50, penSize + 1) })}
            title="굵기 증가"
          >
            <Plus size={16} />
          </button>
        </div>

        {/* Straight Line Auto-Correction Toggle */}
        <div className="mt-4 flex items-center justify-between border-t border-white/10 pt-3 px-1">
          <span className="text-xs text-slate-300 font-medium">직선 자동 보정</span>
          <button
            type="button"
            role="switch"
            aria-checked={autoStraighten}
            onClick={() => setAutoStraighten(!autoStraighten)}
            className={`relative inline-flex h-5 w-10 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
              autoStraighten ? 'bg-amber-500' : 'bg-slate-700'
            }`}
          >
            <span
              className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                autoStraighten ? 'translate-x-5' : 'translate-x-0'
              }`}
            />
          </button>
        </div>

        {/* Color Palette Row (빨주노초파남보 검정 + RGB 커스텀 원) */}
        <div className="mt-4 flex items-center justify-between border-t border-white/10 pt-3">
          {colorSlots.slice(0, 8).map((color, idx) => {
            const isSelected = !isCustomColorActive && activeSlot === idx;
            const contrast = getContrastYIQ(color);
            return (
              <button
                key={idx}
                type="button"
                onClick={() => selectSlot(idx)}
                className={`relative flex h-7 w-7 items-center justify-center rounded-full transition-transform duration-150 hover:scale-110 focus:outline-none ${
                  isSelected ? 'ring-2 ring-white/80 ring-offset-2 ring-offset-[#232429]' : ''
                }`}
                style={{ backgroundColor: color }}
                title={`${PALETTE_COLOR_NAMES[idx] || '색상'} (${color})`}
                data-testid={`palette-color-${idx}`}
              >
                {isSelected && <Check size={14} color={contrast} strokeWidth={3} />}
              </button>
            );
          })}

          {/* RGB 사용자 지정 동그라미 (검정의 오른쪽) */}
          <button
            type="button"
            onClick={() => setRgbModalOpen(true)}
            className={`relative flex h-7 w-7 items-center justify-center rounded-full transition-transform duration-150 hover:scale-110 focus:outline-none ${
              isCustomColorActive ? 'ring-2 ring-white/80 ring-offset-2 ring-offset-[#232429]' : ''
            }`}
            style={{
              background: isCustomColorActive && customColor
                ? customColor
                : 'conic-gradient(from 0deg, #ff0000, #ff8800, #ffff00, #00ff00, #00ffff, #0000ff, #8800ff, #ff0088, #ff0000)',
            }}
            title="사용자 지정 RGB 색상 설정"
            data-testid="rgb-color-circle-btn"
          >
            {isCustomColorActive && (
              <Check size={14} color={getContrastYIQ(customColor)} strokeWidth={3} />
            )}
          </button>
        </div>
      </motion.div>

      {/* RGB 지정 모달 창 */}
      <RgbColorPickerModal
        open={rgbModalOpen}
        onClose={() => setRgbModalOpen(false)}
        initialColor={customColor}
      />
    </>
  );
}
