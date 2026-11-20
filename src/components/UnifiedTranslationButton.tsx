import React, { useState } from 'react';
import { Settings } from 'lucide-react';
import { unifiedTranslator } from '../services/UnifiedTranslator';
import type { GeminiResilienceStatus } from '../services/geminiResilience';
import type { UnifiedTranslationResponse } from '../types/unifiedTranslation';
import { loadApiKey, saveApiKey, removeApiKey } from '../storage/secureStore';
import { toast } from '../store/uiStore';
import { GeminiKeyModal } from './GeminiKeyModal';

interface Props {
  selectedText: string;
  surroundingSentence: string;
  documentTags?: string[];
  apiKey: string | null;
  onApiKeySaved?: (key: string) => void;
  onModalToggle?: (open: boolean) => void;
  onOpenSettings?: () => void;
  onApplyRuby?: (original: string, translated: string) => void;
  onApplyTranslation?: (original: string, translated: string) => void;
}

export const UnifiedTranslationButton: React.FC<Props> = ({
  selectedText,
  surroundingSentence,
  documentTags = [],
  apiKey,
  onApiKeySaved,
  onModalToggle,
  onApplyRuby,
  onApplyTranslation,
}) => {
  const [showConfigModal, setShowConfigModal] = useState(false);
  const [errorNotice, setErrorNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [resilienceStatus, setResilienceStatus] = useState<GeminiResilienceStatus | null>(null);
  const [fallbackNotice, setFallbackNotice] = useState<{ model: string; requestedModel?: string } | null>(null);

  const openConfigModal = () => {
    setShowConfigModal(true);
    onModalToggle?.(true);
  };

  const closeConfigModal = () => {
    setShowConfigModal(false);
    onModalToggle?.(false);
  };

  const handleTranslate = async () => {
    setErrorNotice(null);
    setFallbackNotice(null);
    setResilienceStatus(null);
    setLoading(true);

    // 사용자의 Gemini Key가 있으면 Tier 2 우선 사용, 없으면 Tier 3 Zero-Config 공개 무키 번역 자동 사용
    const geminiKey = apiKey?.trim() || (await loadApiKey('google'))?.trim() || null;

    const res: UnifiedTranslationResponse = await unifiedTranslator.translate({
      targetText: selectedText,
      surroundingSentence,
      documentTags,
      apiKey: geminiKey,
      onStatusChange: (status) => setResilienceStatus(status),
    });

    setLoading(false);
    setResilienceStatus(null);

    if (res.success && res.translatedText) {
      if (res.usedFallback && res.model) {
        setFallbackNotice({ model: res.model, requestedModel: res.requestedModel });
      }
      const isSingle = !selectedText.trim().includes(' ') && !selectedText.trim().includes('\n');
      if (isSingle) {
        const rec = unifiedTranslator.createLearningRecord(
          selectedText.trim(),
          res.translatedText,
          surroundingSentence
        );
        void unifiedTranslator.saveLearningRecord(rec);
      }

      const applyFn = onApplyTranslation ?? onApplyRuby;
      applyFn?.(selectedText, res.translatedText);
      return;
    }

    setErrorNotice(res.errorMessage || '오프라인 상태이거나 번역을 완료할 수 없습니다.');
  };

  const handleSaveGeminiKey = async (newKey: string) => {
    try {
      if (newKey) {
        await saveApiKey('google', newKey);
        onApiKeySaved?.(newKey);
        toast.success('Gemini AI 키가 등록되었습니다. 이제 정밀 학술 문맥 번역이 적용됩니다.');
      } else {
        await removeApiKey('google');
        onApiKeySaved?.('');
        toast.info('기본 무설정(Zero-Config) 번역 모드로 전환되었습니다.');
      }
    } catch {
      toast.error('키 저장 중 오류가 발생했습니다.');
    }
  };

  return (
    <div className="relative inline-flex items-center gap-0.5 select-none font-sans">
      <button
        type="button"
        data-testid="unified-translate-btn"
        onClick={handleTranslate}
        disabled={loading}
        className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-white bg-blue-600 hover:bg-blue-500 rounded shadow transition-colors disabled:opacity-50"
        title={resilienceStatus?.message || 'Zero-Config 즉시 번역 (Gemini 키 등록 시 정밀 학술 번역 적용)'}
      >
        <span>
          {loading
            ? resilienceStatus?.phase === 'retrying' && resilienceStatus.attempt
              ? `재시도 중... (${resilienceStatus.attempt}/${resilienceStatus.maxRetries ?? 3})`
              : resilienceStatus?.phase === 'fallback'
                ? '경량 모델 전환 중...'
                : resilienceStatus?.phase === 'queued'
                  ? '대기 중...'
                  : '번역 중...'
            : '번역'}
        </span>
      </button>

      {fallbackNotice && (
        <span
          data-testid="unified-translate-fallback-badge"
          className="px-1.5 py-0.5 text-[10px] font-medium text-amber-800 bg-amber-50 border border-amber-300 rounded"
          title={`기본 모델(${fallbackNotice.requestedModel ?? 'gemini-2.5-flash'}) 혼잡으로 ${fallbackNotice.model}로 자동 전환되어 번역되었습니다.`}
        >
          폴백 · {fallbackNotice.model}
        </span>
      )}

      <button
        type="button"
        data-testid="unified-translate-config-btn"
        onClick={openConfigModal}
        className="px-1.5 py-1 text-xs text-blue-600 hover:text-blue-800 bg-blue-50 hover:bg-blue-100 rounded transition-colors"
        title="AI 번역 설정 (신용카드 필요 없는 30초 무료 Gemini 키)"
      >
        <Settings size={12} />
      </button>

      <GeminiKeyModal
        isOpen={showConfigModal}
        onClose={closeConfigModal}
        currentKey={apiKey || ''}
        onSaveKey={handleSaveGeminiKey}
      />

      {/* 에러 피드백 배지 */}
      {errorNotice && (
        <div
          data-testid="unified-translate-error-badge"
          className="absolute left-1/2 -translate-x-1/2 top-full mt-2 w-72 p-2.5 bg-red-950/95 border border-red-500/60 rounded-md shadow-2xl z-50 text-xs text-red-200"
        >
          <div className="flex items-start justify-between">
            <p className="leading-snug">{errorNotice}</p>
            <button
              type="button"
              onClick={() => setErrorNotice(null)}
              className="ml-2 text-red-400 hover:text-red-100 font-bold"
            >
              ×
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

