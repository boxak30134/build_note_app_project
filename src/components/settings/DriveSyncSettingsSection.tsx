import { useEffect, useState } from 'react';
import {
  Cloud,
  CloudOff,
  FolderOpen,
  FolderPlus,
  Loader2,
  RefreshCw,
  ShieldCheck,
  AlertTriangle,
  LogOut,
} from 'lucide-react';
import { useSettings } from '../../store/settingsStore';
import { loadDriveToken } from '../../storage/secureStore';
import { toast } from '../../store/uiStore';
import {
  authenticateGoogleDrive,
  disconnectGoogleDrive,
} from '../../modules/sync/googleDriveAuth';
import {
  createDedicatedSyncFolder,
  ensureOrCreateDefaultSyncFolder,
} from '../../modules/sync/googleFolderPicker';
import { runDriveSync } from '../../modules/sync/driveSyncEngine';
import { DriveFolderPickerModal } from './DriveFolderPickerModal';

const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  idle: { label: '대기', cls: 'bg-slate-100 text-slate-600' },
  syncing: { label: '동기화 중', cls: 'bg-indigo-100 text-indigo-700' },
  synced: { label: '동기화됨', cls: 'bg-emerald-100 text-emerald-700' },
  offline: { label: '오프라인 대기', cls: 'bg-amber-100 text-amber-800' },
  SYNC_FOLDER_MISSING: { label: '폴더 유실', cls: 'bg-red-100 text-red-700' },
  error: { label: '오류', cls: 'bg-red-100 text-red-700' },
};

export function DriveSyncSettingsSection() {
  const { driveSyncConfig } = useSettings();
  const [hasToken, setHasToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pickerModalOpen, setPickerModalOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('EduInk Sync');

  useEffect(() => {
    void loadDriveToken().then((t) => setHasToken(Boolean(t?.accessToken)));
  }, []);

  const badge = STATUS_BADGE[driveSyncConfig.syncStatus] ?? STATUS_BADGE.idle;
  const accountDisplay = driveSyncConfig.accountName
    ? driveSyncConfig.accountEmail
      ? `${driveSyncConfig.accountName} (${driveSyncConfig.accountEmail})`
      : driveSyncConfig.accountName
    : driveSyncConfig.accountEmail || '연결된 Google 계정';

  const handleConnect = async () => {
    setBusy(true);
    try {
      const token = await authenticateGoogleDrive();
      setHasToken(Boolean(token.accessToken));
      toast.success('Google 계정 연결 완료 (drive.file 최소 권한)');
      // 인증 직후 동기화 폴더가 미지정이면 별도 Picker API 키 없이 전용 폴더(EduInk Sync) 자동 연결
      if (!useSettings.getState().driveSyncConfig.targetFolderId) {
        try {
          const folder = await ensureOrCreateDefaultSyncFolder('EduInk Sync', token.accessToken);
          toast.success(`동기화 폴더 자동 연결 완료: ${folder.name}`);
        } catch (folderErr) {
          toast.error((folderErr as Error).message, '동기화 폴더 자동 지정');
        }
      }
    } catch (err) {
      const msg = (err as Error).message;
      if (msg !== 'EXTERNAL_BROWSER_AUTH_REDIRECT') {
        toast.error(msg, 'Google Drive 연결');
      } else {
        toast.info('외부 브라우저에서 로그인 완료 후 앱으로 복귀해 주세요.');
      }
    } finally {
      setBusy(false);
    }
  };

  const handlePickFolder = () => {
    setPickerModalOpen(true);
  };

  const handleCreateFolder = async () => {
    setBusy(true);
    try {
      const created = await createDedicatedSyncFolder(newFolderName);
      toast.success(`전용 동기화 폴더 생성: ${created.name}`);
    } catch (err) {
      toast.error((err as Error).message, '폴더 생성');
    } finally {
      setBusy(false);
    }
  };

  const handleManualSync = async () => {
    setBusy(true);
    try {
      const res = await runDriveSync();
      if (res.status === 'synced') {
        toast.success(
          `동기화 완료 (업로드 ${res.uploadedCount}, 다운로드 ${res.downloadedCount}${
            res.conflictCount > 0 ? `, 충돌 사본 ${res.conflictCount}` : ''
          })`,
        );
      } else if (res.status === 'SYNC_FOLDER_MISSING') {
        toast.error('지정된 Google Drive 폴더를 찾을 수 없습니다. 폴더를 다시 지정해 주세요.');
      } else if (res.status === 'offline') {
        toast.info('오프라인 상태입니다. 네트워크 연결 시 자동 동기화됩니다.');
      } else {
        toast.error(res.errorMessage || '동기화 실패');
      }
    } catch (err) {
      toast.error((err as Error).message, '동기화 오류');
    } finally {
      setBusy(false);
    }
  };

  const handleDisconnect = async () => {
    await disconnectGoogleDrive();
    setHasToken(false);
    toast.info('Google Drive 연동을 해제했습니다. 로컬 노트는 그대로 보존됩니다.');
  };

  return (
    <section data-testid="drive-sync-settings-section">
      <div className="mb-2 flex items-center justify-between">
        <h4 className="flex items-center gap-1 font-semibold text-slate-700">
          <Cloud size={13} className="text-indigo-600" /> Google Drive 지정 폴더 동기화
        </h4>
        <span
          data-testid="drive-sync-status-badge"
          className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${badge.cls}`}
        >
          {badge.label}
        </span>
      </div>

      <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50/60 p-2.5">
        {!hasToken ? (
          <button
            type="button"
            data-testid="drive-connect-btn"
            disabled={busy}
            onClick={() => void handleConnect()}
            className="btn-primary w-full justify-center text-[11px]"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Cloud size={12} />}
            Google 계정으로 드라이브 연결
          </button>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span
                data-testid="drive-account-badge"
                className="inline-flex min-w-0 items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 border border-emerald-200"
                title={accountDisplay}
              >
                <ShieldCheck size={12} className="shrink-0 text-emerald-600" />
                <span className="truncate">{accountDisplay}</span>
              </span>
              <button
                type="button"
                data-testid="drive-disconnect-btn"
                disabled={busy}
                onClick={() => void handleDisconnect()}
                className="btn-ghost shrink-0 text-[11px] text-red-600 hover:bg-red-50"
              >
                <LogOut size={12} /> 연동 해제
              </button>
            </div>

            {driveSyncConfig.syncStatus === 'SYNC_FOLDER_MISSING' && (
              <div
                data-testid="drive-folder-missing-alert"
                className="flex items-start gap-1.5 rounded border border-red-200 bg-red-50 p-2 text-[10px] text-red-800"
              >
                <AlertTriangle size={13} className="mt-0.5 shrink-0 text-red-600" />
                <span>
                  지정된 동기화 폴더가 Drive에서 삭제되었거나 접근 권한이 회수되었습니다. 폴더를 다시 선택해 주세요.
                </span>
              </div>
            )}

            <div className="flex items-center justify-between rounded border border-slate-200 bg-white px-2 py-1.5 text-[11px]">
              <span className="text-slate-500">동기화 폴더</span>
              <span data-testid="drive-target-folder-name" className="truncate font-semibold text-slate-800">
                {driveSyncConfig.targetFolderName ?? '미지정'}
              </span>
            </div>

            <div className="flex gap-1.5">
              <button
                type="button"
                data-testid="drive-pick-folder-btn"
                disabled={busy}
                onClick={() => void handlePickFolder()}
                className="flex flex-1 items-center justify-center gap-1 rounded border border-slate-300 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40"
              >
                <FolderOpen size={12} /> 폴더 변경
              </button>
              <button
                type="button"
                data-testid="drive-manual-sync-btn"
                disabled={busy || !driveSyncConfig.targetFolderId}
                onClick={() => void handleManualSync()}
                className="flex flex-1 items-center justify-center gap-1 rounded bg-indigo-600 px-2 py-1 text-[11px] font-semibold text-white hover:bg-indigo-700 disabled:opacity-40"
              >
                {driveSyncConfig.syncStatus === 'syncing' ? (
                  <Loader2 size={11} className="animate-spin" />
                ) : driveSyncConfig.syncStatus === 'offline' ? (
                  <CloudOff size={11} />
                ) : (
                  <RefreshCw size={11} />
                )}
                지금 동기화
              </button>
            </div>

            <div className="text-[10px] text-slate-500">
              {driveSyncConfig.lastSyncedAt
                ? `최근 동기화: ${new Date(driveSyncConfig.lastSyncedAt).toLocaleString()}`
                : '동기화 기록 없음'}
            </div>
          </div>
        )}

        {driveSyncConfig.lastError && (
          <p className="text-[10px] text-red-600">{driveSyncConfig.lastError}</p>
        )}

        <details
          data-testid="drive-advanced-settings"
          className="border-t border-slate-200 pt-1.5 text-[10px] text-slate-500"
        >
          <summary className="cursor-pointer select-none font-medium text-slate-600 hover:text-slate-800">
            고급 설정 (최소 권한 정보 · 폴더 관리)
          </summary>
          <div className="mt-2 space-y-2">
            <div className="flex items-start gap-1.5 rounded bg-white p-1.5 text-[10px] text-slate-600 border border-slate-100">
              <ShieldCheck size={13} className="mt-0.5 shrink-0 text-emerald-600" />
              <span>
                최소 권한(<code className="font-mono">drive.file</code>)만 사용하여 전체 드라이브에 접근하지 않고 지정 폴더 1개만 격리 동기화합니다.
              </span>
            </div>

            {hasToken && (
              <div className="flex items-center gap-1">
                <input
                  type="text"
                  data-testid="drive-new-folder-input"
                  className="min-w-0 flex-1 rounded border bg-white px-1.5 py-1 text-[11px] outline-none focus:border-indigo-400"
                  placeholder="새 동기화 폴더 이름"
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                />
                <button
                  type="button"
                  data-testid="drive-create-folder-btn"
                  disabled={busy}
                  onClick={() => void handleCreateFolder()}
                  className="flex items-center gap-1 rounded border border-indigo-200 bg-indigo-50 px-2 py-1 text-[11px] font-medium text-indigo-700 hover:bg-indigo-100 disabled:opacity-40"
                >
                  <FolderPlus size={12} /> 생성
                </button>
              </div>
            )}
          </div>
        </details>
      </div>

      <DriveFolderPickerModal
        open={pickerModalOpen}
        currentFolderId={driveSyncConfig.targetFolderId}
        onClose={() => setPickerModalOpen(false)}
      />
    </section>
  );
}

