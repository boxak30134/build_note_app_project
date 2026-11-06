// src/components/GeminiKeyModal.tsx
import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { useSettings } from '../store/settingsStore';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  currentKey: string;
  onSaveKey: (key: string) => void;
}

export const GeminiKeyModal: React.FC<Props> = ({
  isOpen,
  onClose,
  currentKey,
  onSaveKey,
}) => {
  const [inputKey, setInputKey] = useState(currentKey);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const { translationInsertMode, setTranslationInsertMode } = useSettings();

  if (!isOpen) return null;

  const handleSave = () => {
    const trimmed = inputKey.trim();
    onSaveKey(trimmed);
    setStatusMsg('키가 안전하게 저장되었습니다.');
    setTimeout(() => {
      setStatusMsg(null);
      onClose();
    }, 600);
  };

  const handleClear = () => {
    setInputKey('');
    onSaveKey('');
    setStatusMsg('키가 초기화되었습니다. 기본 무설정 엔진으로 전환됩니다.');
  };

  return createPortal(
    <div
      data-testid="gemini-key-modal"
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 font-sans"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="w-full max-w-md bg-zinc-900 border border-zinc-800 rounded-xl p-5 shadow-2xl text-zinc-100"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <h3 className="text-base font-semibold mb-2 flex items-center justify-between">
          <span>AI 번역 설정 (선택 사항)</span>
          <button
            type="button"
            onClick={onClose}
            className="text-zinc-400 hover:text-white text-sm"
          >
            ✕
          </button>
        </h3>

        <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-3 mb-4 text-xs text-blue-200 leading-relaxed">
          <p className="font-semibold text-blue-100 mb-1">💡 키를 입력하지 않아도 번역은 기본 작동합니다!</p>
          더 정교한 학술 문맥(수학/과학 논문) 번역을 원하실 때만 <strong>신용카드 필요 없는 무료 키</strong>를 등록하세요.
        </div>

        {/* 번역 결과 삽입 형식 선택 */}
        <div className="bg-zinc-800/80 border border-zinc-700/60 rounded-lg p-3 mb-4 text-xs space-y-2">
          <label className="block text-xs font-semibold text-zinc-100 mb-1.5">
            번역 결과 삽입 방식
          </label>
          <label className="flex items-start gap-2 cursor-pointer hover:text-white">
            <input
              type="radio"
              name="modalTranslationMode"
              value="parentheses"
              checked={translationInsertMode === 'parentheses'}
              onChange={() => setTranslationInsertMode('parentheses')}
              data-testid="mode-parentheses-radio"
              className="mt-0.5 accent-blue-500"
            />
            <div>
              <span className="font-medium text-zinc-100">1. 원문 뒤 괄호 삽입 (기본)</span>
              <p className="text-[11px] text-zinc-400">원문 뒤에 괄호로 번역을 삽입합니다 (예: apple (사과)). 뒤에 다른 문장이 있어도 그 사이에 삽입됩니다.</p>
            </div>
          </label>
          <label className="flex items-start gap-2 cursor-pointer hover:text-white">
            <input
              type="radio"
              name="modalTranslationMode"
              value="ruby"
              checked={translationInsertMode === 'ruby'}
              onChange={() => setTranslationInsertMode('ruby')}
              data-testid="mode-ruby-radio"
              className="mt-0.5 accent-blue-500"
            />
            <div>
              <span className="font-medium text-zinc-100">2. 루비 주석 표시</span>
              <p className="text-[11px] text-zinc-400">원문 위에 보라색 작은 글씨로 표시합니다.</p>
            </div>
          </label>
          <label className="flex items-start gap-2 cursor-pointer hover:text-white">
            <input
              type="radio"
              name="modalTranslationMode"
              value="replace"
              checked={translationInsertMode === 'replace'}
              onChange={() => setTranslationInsertMode('replace')}
              data-testid="mode-replace-radio"
              className="mt-0.5 accent-blue-500"
            />
            <div>
              <span className="font-medium text-zinc-100">3. 원문 대체 (덮어쓰기)</span>
              <p className="text-[11px] text-zinc-400">원래 문장을 번역 문장으로 대체/덮어씌웁니다.</p>
            </div>
          </label>
        </div>

        {/* 30초 무료 발급 3단계 가이드 */}
        <div className="bg-zinc-800/60 rounded-lg p-3 mb-4 text-xs text-zinc-300 space-y-1.5">
          <p className="font-medium text-zinc-200">무료 키 발급 순서 (약 30초 소요):</p>
          <p>1. <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer" className="text-blue-400 underline">Google AI Studio 키 발급 페이지</a> 접속 (구글 로그인)</p>
          <p>2. <strong>[Create API key]</strong> 버튼 클릭</p>
          <p>3. 생성된 키 문자열(<code>AIzaSy...</code>)을 복사하여 아래에 붙여넣기</p>
        </div>

        <div className="mb-4">
          <label className="block text-xs font-medium text-zinc-400 mb-1.5">Gemini API Key</label>
          <input
            type="password"
            data-testid="gemini-key-input"
            value={inputKey}
            onChange={(e) => setInputKey(e.target.value)}
            placeholder="AIzaSy..."
            autoFocus
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="w-full px-3 py-2 bg-zinc-950 border border-zinc-700 rounded-md text-xs text-white focus:outline-none focus:border-blue-500 font-mono"
          />
        </div>

        {statusMsg && (
          <p className="text-xs text-emerald-400 mb-3" data-testid="gemini-key-status">{statusMsg}</p>
        )}

        <div className="flex justify-between items-center">
          <button
            type="button"
            data-testid="gemini-key-clear-btn"
            onClick={handleClear}
            className="text-xs text-zinc-500 hover:text-zinc-300 underline"
          >
            기본 모드로 초기화
          </button>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-xs text-zinc-400 hover:text-white"
            >
              닫기
            </button>
            <button
              type="button"
              data-testid="gemini-key-save-btn"
              onClick={handleSave}
              className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 text-white font-medium text-xs rounded-md shadow"
            >
              저장
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};

