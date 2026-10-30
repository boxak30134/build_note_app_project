import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { X, Camera, CheckCircle2, AlertCircle, Info } from 'lucide-react';
import { useUi, toast } from '../store/uiStore';
import { useTabs } from '../store/tabsStore';
import { getSession } from '../session/NoteSession';

export function Toasts() {
  const { toasts, dismissToast } = useUi();
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[80] flex w-80 flex-col gap-2">
      <AnimatePresence>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            layout
            initial={{ opacity: 0, y: 16, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, x: 40 }}
            className={`pointer-events-auto flex items-start gap-2 rounded-xl border bg-white p-3 text-xs shadow-xl ${t.kind === 'error' ? 'border-red-200' : t.kind === 'success' ? 'border-emerald-200' : 'border-slate-200'}`}
            role="status"
          >
            {t.kind === 'error' ? <AlertCircle size={15} className="shrink-0 text-red-500" /> : t.kind === 'success' ? <CheckCircle2 size={15} className="shrink-0 text-emerald-500" /> : <Info size={15} className="shrink-0 text-indigo-500" />}
            <div className="min-w-0 flex-1">
              {t.title && <div className="mb-0.5 font-semibold">{t.title}</div>}
              <div className="whitespace-pre-wrap break-words text-slate-700">{t.message}</div>
            </div>
            <button onClick={() => dismissToast(t.id)} className="text-slate-400 hover:text-slate-600">
              <X size={13} />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

function Modal({ children, onClose }: { children: React.ReactNode; onClose?: () => void }) {
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-900/30 p-4" onPointerDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl">
        {children}
      </motion.div>
    </div>
  );
}

export function ConfirmDialog() {
  const req = useUi((s) => s.confirm);
  if (!req) return null;
  return (
    <Modal onClose={() => req.resolve('cancel')}>
      <h3 className="mb-2 text-base font-semibold text-slate-800">{req.title}</h3>
      <p className="mb-5 whitespace-pre-wrap text-sm text-slate-600">{req.message}</p>
      <div className="flex justify-end gap-2">
        {req.buttons.map((b) => (
          <button
            key={b.value}
            autoFocus={b.variant === 'primary'}
            className={b.variant === 'primary' ? 'btn-primary' : b.variant === 'danger' ? 'btn-danger' : 'btn-ghost border border-slate-200'}
            onClick={() => req.resolve(b.value)}
          >
            {b.label}
          </button>
        ))}
      </div>
    </Modal>
  );
}

export function PromptDialog() {
  const req = useUi((s) => s.prompt);
  const [value, setValue] = useState('');
  useEffect(() => setValue(req?.initial ?? ''), [req]);
  if (!req) return null;
  const err = req.validate?.(value) ?? null;
  const submit = () => !err && req.resolve(value);
  return (
    <Modal onClose={() => req.resolve(null)}>
      <h3 className="mb-3 text-base font-semibold text-slate-800">{req.title}</h3>
      <input
        autoFocus
        className={`w-full rounded-lg border px-3 py-2 text-sm outline-none ${err ? 'border-red-400' : 'focus:border-indigo-400'}`}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) submit();
          if (e.key === 'Escape') req.resolve(null);
        }}
      />
      <p className="mt-1 h-4 text-xs text-red-500">{err}</p>
      <div className="mt-3 flex justify-end gap-2">
        <button className="btn-ghost border border-slate-200" onClick={() => req.resolve(null)}>
          취소
        </button>
        <button className="btn-primary" disabled={!!err} onClick={submit}>
          확인
        </button>
      </div>
    </Modal>
  );
}

/** 웹 카메라 촬영 (navigator.mediaDevices.getUserMedia) → 즉시 이미지 노드 삽입 */
export function CameraModal() {
  const open = useUi((s) => s.cameraOpen);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    navigator.mediaDevices
      ?.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      .then((stream) => {
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          void videoRef.current.play();
        }
      })
      .catch((e: Error) => setError(`카메라를 사용할 수 없습니다: ${e.message}`));
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [open]);

  if (!open) return null;
  const close = () => useUi.setState({ cameraOpen: false });
  const shoot = () => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return;
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d')!.drawImage(v, 0, 0);
    c.toBlob(async (blob) => {
      if (!blob) return;
      const s = getSession(useTabs.getState().activeTabId);
      if (!s) return toast.error('열린 노트가 없습니다.');
      await s.insertImageFiles([new File([blob], 'camera.jpg', { type: 'image/jpeg' })]);
      close();
    }, 'image/jpeg', 0.9);
  };

  return (
    <Modal onClose={close}>
      <h3 className="mb-3 flex items-center gap-2 text-base font-semibold">
        <Camera size={18} /> 카메라 촬영
      </h3>
      {error ? <p className="rounded-lg bg-red-50 p-3 text-sm text-red-600">{error}</p> : <video ref={videoRef} className="w-full rounded-lg bg-black" playsInline muted />}
      <div className="mt-4 flex justify-end gap-2">
        <button className="btn-ghost border border-slate-200" onClick={close}>
          취소
        </button>
        <button className="btn-primary" onClick={shoot} disabled={!!error}>
          <Camera size={14} /> 촬영하여 삽입
        </button>
      </div>
    </Modal>
  );
}
