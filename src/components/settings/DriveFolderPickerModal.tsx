import { useEffect, useState } from 'react';
import { Check, Folder, FolderPlus, Loader2, X } from 'lucide-react';
import {
  applySelectedSyncFolder,
  createDedicatedSyncFolder,
  listAppAccessibleFolders,
  type PickedDriveFolder,
} from '../../modules/sync/googleFolderPicker';
import { toast } from '../../store/uiStore';

interface DriveFolderPickerModalProps {
  open: boolean;
  currentFolderId: string | null;
  onClose: () => void;
  onSelected?: (folder: PickedDriveFolder) => void;
}

export function DriveFolderPickerModal({
  open,
  currentFolderId,
  onClose,
  onSelected,
}: DriveFolderPickerModalProps) {
  const [folders, setFolders] = useState<PickedDriveFolder[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    listAppAccessibleFolders()
      .then((list) => {
        if (!cancelled) setFolders(list);
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  if (!open) return null;

  const handleSelect = (folder: PickedDriveFolder) => {
    applySelectedSyncFolder(folder);
    toast.success(`동기화 폴더 지정 완료: ${folder.name}`);
    onSelected?.(folder);
    onClose();
  };

  const handleCreate = async () => {
    const clean = newName.trim() || 'EduInk Sync';
    setCreating(true);
    setError(null);
    try {
      const created = await createDedicatedSyncFolder(clean);
      toast.success(`새 동기화 폴더 생성 및 지정: ${created.name}`);
      onSelected?.(created);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div
      data-testid="drive-folder-picker-modal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Google Drive 동기화 폴더 선택"
    >
      <div className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-4 shadow-xl">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-800">Google Drive 동기화 폴더 선택</h3>
          <button
            type="button"
            data-testid="drive-modal-close-btn"
            onClick={onClose}
            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            <X size={15} />
          </button>
        </div>

        <p className="mb-2 text-[11px] text-slate-500">
          최소 권한(<code className="font-mono">drive.file</code>) 범위 내 폴더를 선택하거나 새 전용 폴더를 만드세요.
        </p>

        <div className="max-h-52 space-y-1 overflow-y-auto rounded-lg border border-slate-200 bg-slate-50 p-1.5">
          {loading ? (
            <div className="flex items-center justify-center py-6 text-xs text-slate-500">
              <Loader2 size={14} className="mr-1.5 animate-spin" /> 폴더 목록 불러오는 중...
            </div>
          ) : error ? (
            <div className="p-2 text-[11px] text-red-600">{error}</div>
          ) : folders.length === 0 ? (
            <div className="py-5 text-center text-[11px] text-slate-500">
              접근 가능한 폴더가 없습니다. 아래에서 새 폴더를 만들어 주세요.
            </div>
          ) : (
            folders.map((folder) => {
              const selected = folder.id === currentFolderId;
              return (
                <button
                  key={folder.id}
                  type="button"
                  data-testid={`drive-folder-option-${folder.id}`}
                  onClick={() => handleSelect(folder)}
                  className={`flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-xs transition ${
                    selected
                      ? 'bg-indigo-50 font-semibold text-indigo-700'
                      : 'bg-white text-slate-700 hover:bg-slate-100'
                  }`}
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <Folder size={13} className="shrink-0 text-amber-500" />
                    <span className="truncate">{folder.name}</span>
                  </span>
                  {selected && <Check size={13} className="shrink-0 text-indigo-600" />}
                </button>
              );
            })
          )}
        </div>

        <div className="mt-3 flex items-center gap-1.5">
          <input
            type="text"
            data-testid="drive-modal-new-folder-input"
            className="min-w-0 flex-1 rounded-md border border-slate-300 px-2 py-1.5 text-xs outline-none focus:border-indigo-400"
            placeholder="새 폴더 이름 (예: EduInk Sync)"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !creating) void handleCreate();
            }}
          />
          <button
            type="button"
            data-testid="drive-modal-create-folder-btn"
            disabled={creating}
            onClick={() => void handleCreate()}
            className="flex shrink-0 items-center gap-1 rounded-md bg-indigo-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-40"
          >
            {creating ? <Loader2 size={12} className="animate-spin" /> : <FolderPlus size={12} />}
            새 폴더 생성
          </button>
        </div>
      </div>
    </div>
  );
}

