import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Edit3 } from 'lucide-react';
import type { AiProviderId } from '../store/settingsStore';
import { findModelMeta, PROVIDER_GROUPS } from '../ai/modelCatalog';
import { PROVIDER_LABEL } from '../ai/aiProviderAdapter';

export interface AiModelSelectorProps {
  /** 현재 선택된 제공자 */
  provider: AiProviderId;
  /** 현재 선택된 모델 ID */
  modelId: string;
  /** 모델(및 필요 시 제공자) 변경 콜백 */
  onChange: (nextModelId: string, nextProvider: AiProviderId) => void;
  /** 특정 제공자 그룹만 필터링할 경우 지정 (미지정 시 3개 제공자 그룹 모두 표시) */
  filterProvider?: AiProviderId;
  /** 컴팩트 모드 여부 (채팅 헤더 등) */
  compact?: boolean;
  /** 테스트 식별자 */
  testId?: string;
}

export function AiModelSelector({
  provider,
  modelId,
  onChange,
  filterProvider,
  compact = false,
  testId = 'ai-model-selector',
}: AiModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const [customMode, setCustomMode] = useState(false);
  const [customInput, setCustomInput] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

  const activeMeta = findModelMeta(modelId, provider);
  const isCustomValue = !activeMeta;

  const groups = filterProvider
    ? PROVIDER_GROUPS.filter((g) => g.provider === filterProvider)
    : PROVIDER_GROUPS;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        setCustomMode(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        setCustomMode(false);
      }
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const applyCustomModel = () => {
    const trimmed = customInput.trim();
    if (!trimmed) return;
    onChange(trimmed, filterProvider ?? provider);
    setCustomMode(false);
    setOpen(false);
  };

  return (
    <div ref={rootRef} className="relative" data-overlay data-testid={testId}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        data-testid={`${testId}-trigger`}
        onClick={() => setOpen((v) => !v)}
        className={`flex w-full items-center justify-between gap-2 rounded-lg border bg-white text-left transition hover:border-indigo-400 focus:border-indigo-500 focus:outline-none ${
          compact ? 'px-2 py-1 text-[11px]' : 'px-2.5 py-2 text-xs'
        }`}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="rounded bg-slate-100 px-1 py-0.5 text-[10px] font-medium text-slate-600">
              {PROVIDER_LABEL[provider]}
            </span>
            <span className="truncate font-semibold text-slate-800">
              {activeMeta ? activeMeta.displayName : modelId || '모델 선택'}
            </span>
            {isCustomValue && (
              <span className="rounded bg-amber-50 px-1 py-0.5 text-[9px] font-medium text-amber-700">
                직접 입력
              </span>
            )}
          </div>
          {!compact && activeMeta && (
            <div className="mt-0.5 flex items-center gap-1.5 truncate text-[10px] text-slate-500">
              <span className="truncate">{activeMeta.description}</span>
              <span className="shrink-0 rounded bg-indigo-50 px-1 py-0.2 font-mono text-[9px] text-indigo-700">
                {activeMeta.estimatedTokenRange}
              </span>
            </div>
          )}
        </div>
        <ChevronDown
          size={compact ? 12 : 14}
          className={`shrink-0 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div
          role="listbox"
          data-testid={`${testId}-dropdown`}
          className="absolute left-0 right-0 z-50 mt-1 max-h-80 min-w-[250px] overflow-y-auto rounded-xl border border-slate-200 bg-white p-1.5 shadow-xl"
        >
          {groups.map((group) => (
            <div key={group.provider} className="mb-1.5 last:mb-0">
              <div className="flex items-center justify-between px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-slate-500">
                <span>{group.label}</span>
                <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[9px] font-medium text-slate-500">
                  {group.badgeText}
                </span>
              </div>
              <div className="space-y-0.5">
                {group.models.map((item) => {
                  const isSelected = provider === item.provider && modelId === item.id;
                  return (
                    <button
                      key={`${item.provider}:${item.id}`}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      data-testid={`${testId}-option-${item.id}`}
                      onClick={() => {
                        onChange(item.id, item.provider);
                        setCustomMode(false);
                        setOpen(false);
                      }}
                      className={`flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition ${
                        isSelected
                          ? 'bg-indigo-50/90 text-indigo-950'
                          : 'text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-xs font-semibold">{item.displayName}</span>
                          <span className="font-mono text-[10px] text-slate-400">{item.id}</span>
                          <span className="rounded bg-indigo-50 px-1.5 py-0.5 font-mono text-[9px] font-medium text-indigo-700">
                            {item.estimatedTokenRange}
                          </span>
                        </div>
                        <p className="mt-0.5 text-[10px] text-slate-500">{item.description}</p>
                      </div>
                      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
                        {isSelected && (
                          <Check
                            size={14}
                            className="text-indigo-600"
                            data-testid={`${testId}-check-${item.id}`}
                          />
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}

          <div className="mt-1.5 border-t border-slate-100 pt-1.5">
            {!customMode ? (
              <button
                type="button"
                data-testid={`${testId}-custom-trigger`}
                onClick={() => {
                  setCustomInput(isCustomValue ? modelId : '');
                  setCustomMode(true);
                }}
                className="flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-[11px] font-medium text-slate-600 hover:bg-slate-50"
              >
                <span className="flex items-center gap-1.5">
                  <Edit3 size={12} className="text-slate-400" />
                  기타 모델 ID 직접 입력
                </span>
                {isCustomValue && (
                  <Check size={13} className="text-indigo-600" />
                )}
              </button>
            ) : (
              <div className="flex items-center gap-1 px-1 py-1" data-testid={`${testId}-custom-box`}>
                <input
                  type="text"
                  autoFocus
                  data-testid={`${testId}-custom-input`}
                  className="min-w-0 flex-1 rounded border border-indigo-300 px-2 py-1 font-mono text-[11px] outline-none focus:border-indigo-500"
                  placeholder="예: gemini-3.9-pro / gpt-5"
                  value={customInput}
                  onChange={(e) => setCustomInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      applyCustomModel();
                    }
                  }}
                />
                <button
                  type="button"
                  data-testid={`${testId}-custom-apply`}
                  onClick={applyCustomModel}
                  disabled={!customInput.trim()}
                  className="rounded bg-indigo-600 px-2 py-1 text-[10px] font-semibold text-white hover:bg-indigo-700 disabled:opacity-40"
                >
                  적용
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

