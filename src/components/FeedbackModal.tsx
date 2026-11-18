import { useState, type FormEvent } from 'react';
import { Loader2, MessageSquarePlus, Send, X } from 'lucide-react';
import { toast } from '../store/uiStore';

export type FeedbackCategory = '버그 제보' | '불편사항' | '기능 제안';

export interface FeedbackEnvInfo {
  userAgent: string;
  resolution: string;
  viewport: string;
  pwaStandalone: boolean;
}

interface Props {
  open: boolean;
  onClose: () => void;
}

const CATEGORIES: readonly FeedbackCategory[] = ['버그 제보', '불편사항', '기능 제안'];

/** 현재 실행 환경(User-Agent, 화면 해상도, PWA standalone 여부)을 수집한다. */
export function collectFeedbackEnvInfo(): FeedbackEnvInfo {
  const userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown';
  const screenW = typeof window !== 'undefined' ? window.screen?.width ?? 0 : 0;
  const screenH = typeof window !== 'undefined' ? window.screen?.height ?? 0 : 0;
  const viewW = typeof window !== 'undefined' ? window.innerWidth ?? 0 : 0;
  const viewH = typeof window !== 'undefined' ? window.innerHeight ?? 0 : 0;

  let pwaStandalone = false;
  if (typeof window !== 'undefined') {
    const mediaStandalone =
      typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches;
    const iosStandalone =
      typeof navigator !== 'undefined' && (navigator as { standalone?: boolean }).standalone === true;
    pwaStandalone = Boolean(mediaStandalone || iosStandalone);
  }

  return {
    userAgent,
    resolution: `${screenW}x${screenH}`,
    viewport: `${viewW}x${viewH}`,
    pwaStandalone,
  };
}

export function FeedbackModal({ open, onClose }: Props) {
  const [category, setCategory] = useState<FeedbackCategory>('버그 제보');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [author, setAuthor] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  if (!open) return null;

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (submitting) return;

    const cleanTitle = title.trim();
    const cleanDescription = description.trim();
    if (!cleanTitle) {
      setErrorMsg('제목을 입력해 주세요.');
      return;
    }
    if (!cleanDescription) {
      setErrorMsg('상세 내용을 입력해 주세요.');
      return;
    }

    setSubmitting(true);
    setErrorMsg(null);
    try {
      const envInfo = collectFeedbackEnvInfo();
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category,
          title: cleanTitle,
          description: cleanDescription,
          author: author.trim() || '익명 사용자',
          envInfo,
        }),
      });

      const contentType = res.headers?.get?.('content-type') ?? '';
      const payload = contentType.includes('application/json')
        ? ((await res.json().catch(() => ({}))) as { error?: string; issueNumber?: number })
        : {};

      if (!res.ok) {
        const msg = payload.error || `피드백 전송에 실패했습니다. (HTTP ${res.status})`;
        setErrorMsg(msg);
        toast.error(msg);
        return;
      }

      toast.success(
        payload.issueNumber
          ? `피드백이 등록되었습니다 (#${payload.issueNumber}). 감사합니다!`
          : '피드백이 GitHub Issues에 성공적으로 등록되었습니다. 감사합니다!',
      );
      setTitle('');
      setDescription('');
      setAuthor('');
      setCategory('버그 제보');
      setErrorMsg(null);
      onClose();
    } catch (err) {
      const msg = `네트워크 오류로 피드백을 전송하지 못했습니다: ${(err as Error).message || '알 수 없는 오류'}`;
      setErrorMsg(msg);
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      data-testid="feedback-modal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={() => !submitting && onClose()}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between border-b border-slate-100 pb-2.5">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
            <MessageSquarePlus size={16} className="text-indigo-600" />
            <span>앱 피드백 / 버그 제보</span>
          </div>
          <button
            type="button"
            className="icon-btn"
            disabled={submitting}
            onClick={onClose}
            aria-label="피드백 창 닫기"
          >
            <X size={15} />
          </button>
        </div>

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-3 text-xs">
          <div>
            <label className="mb-1 block font-medium text-slate-600">카테고리</label>
            <div className="grid grid-cols-3 gap-1.5" role="group" aria-label="피드백 카테고리">
              {CATEGORIES.map((cat) => (
                <button
                  key={cat}
                  type="button"
                  data-testid={`feedback-category-${cat}`}
                  onClick={() => setCategory(cat)}
                  className={`rounded-lg border px-2 py-1.5 font-medium transition ${
                    category === cat
                      ? 'border-indigo-500 bg-indigo-50 text-indigo-700'
                      : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  {cat}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label htmlFor="feedback-title" className="mb-1 block font-medium text-slate-600">
              제목 <span className="text-red-500">*</span>
            </label>
            <input
              id="feedback-title"
              data-testid="feedback-title-input"
              type="text"
              maxLength={150}
              placeholder="문제 또는 제안 요약을 입력하세요"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs outline-none focus:border-indigo-400"
            />
          </div>

          <div>
            <label htmlFor="feedback-description" className="mb-1 block font-medium text-slate-600">
              상세 내용 <span className="text-red-500">*</span>
            </label>
            <textarea
              id="feedback-description"
              data-testid="feedback-description-input"
              rows={4}
              maxLength={5000}
              placeholder="발생한 상황, 재현 방법, 기대 동작 등을 자세히 적어 주세요"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full resize-none rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs leading-relaxed outline-none focus:border-indigo-400"
            />
          </div>

          <div>
            <label htmlFor="feedback-author" className="mb-1 block font-medium text-slate-600">
              작성자 (선택)
            </label>
            <input
              id="feedback-author"
              data-testid="feedback-author-input"
              type="text"
              maxLength={60}
              placeholder="미입력 시 '익명 사용자'로 등록됩니다"
              value={author}
              onChange={(e) => setAuthor(e.target.value)}
              className="w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs outline-none focus:border-indigo-400"
            />
          </div>

          <p className="rounded-lg bg-slate-50 px-2.5 py-1.5 text-[11px] text-slate-500">
            전송 시 브라우저 정보(User-Agent), 화면 해상도, PWA 실행 여부가 자동 첨부됩니다.
          </p>

          {errorMsg && (
            <div data-testid="feedback-error-msg" className="rounded-lg bg-red-50 px-2.5 py-1.5 text-[11px] text-red-600">
              {errorMsg}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              disabled={submitting}
              onClick={onClose}
              className="rounded-lg px-3 py-1.5 text-slate-600 hover:bg-slate-100"
            >
              취소
            </button>
            <button
              type="submit"
              data-testid="feedback-submit-btn"
              disabled={submitting || !title.trim() || !description.trim()}
              className="btn-primary px-3 py-1.5 disabled:opacity-50"
            >
              {submitting ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
              {submitting ? '전송 중...' : '보내기'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
