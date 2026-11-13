import { useSettings } from '../../store/settingsStore';
import { getValidDriveAccessToken } from './googleDriveAuth';

export interface PickedDriveFolder {
  id: string;
  name: string;
  modifiedTime?: string;
}

const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';

/**
 * Google Picker API를 열어 사용자가 동기화 전용 폴더 1개를 선택하도록 한다.
 * Picker API가 로드되어 있지 않을 경우 null을 반환하거나 오류를 안내한다.
 */
export async function pickGoogleDriveFolder(options?: {
  developerKey?: string;
  accessToken?: string;
}): Promise<PickedDriveFolder | null> {
  const token = options?.accessToken ?? (await getValidDriveAccessToken());
  const w = (typeof window !== 'undefined' ? (window as unknown as Record<string, any>) : null);

  // gapi Picker 동적 로드 대기
  if (w?.gapi?.load && !w?.google?.picker) {
    await new Promise<void>((resolve, reject) => {
      w.gapi.load('picker', {
        callback: () => resolve(),
        onerror: () => reject(new Error('Google Picker API 로드에 실패했습니다.')),
      });
    });
  }

  const pickerNs = w?.google?.picker;
  if (!pickerNs?.PickerBuilder || !pickerNs?.DocsView) {
    throw new Error(
      'Google Picker SDK가 로드되지 않았습니다. 아래 "새 동기화 폴더 생성"으로 전용 폴더를 만들거나 다시 시도하세요.',
    );
  }

  return await new Promise<PickedDriveFolder | null>((resolve) => {
    const view = new pickerNs.DocsView(pickerNs.ViewId?.FOLDERS ?? 'FOLDERS')
      .setIncludeFolders(true)
      .setSelectFolderEnabled(true)
      .setMimeTypes(DRIVE_FOLDER_MIME);

    const builder = new pickerNs.PickerBuilder()
      .addView(view)
      .setOAuthToken(token)
      .setTitle('EduInk 동기화 전용 폴더 선택')
      .setCallback((data: { action?: string; docs?: Array<{ id?: string; name?: string }> }) => {
        if (data?.action === (pickerNs.Action?.PICKED ?? 'picked')) {
          const doc = data.docs?.[0];
          if (doc?.id) {
            const folder: PickedDriveFolder = {
              id: doc.id,
              name: doc.name || '선택된 폴더',
            };
            applySelectedSyncFolder(folder);
            resolve(folder);
            return;
          }
        }
        if (data?.action === (pickerNs.Action?.CANCEL ?? 'cancel')) {
          resolve(null);
        }
      });

    const devKey =
      options?.developerKey ??
      (import.meta.env?.VITE_GOOGLE_PICKER_API_KEY as string | undefined)?.trim();
    if (devKey) {
      builder.setDeveloperKey(devKey);
    }

    const picker = builder.build();
    picker.setVisible(true);
  });
}

/**
 * drive.file 최소 권한 범위 내에서 앱이 접근 가능한 Google Drive 폴더 목록을 조회한다.
 * (별도 Google Picker API Key 없이 인앱 폴더 선택 모달에 사용)
 */
export async function listAppAccessibleFolders(
  accessTokenOverride?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PickedDriveFolder[]> {
  const token = accessTokenOverride ?? (await getValidDriveAccessToken());
  const params = new URLSearchParams({
    q: `mimeType='${DRIVE_FOLDER_MIME}' and trashed=false`,
    fields: 'files(id,name,modifiedTime)',
    orderBy: 'modifiedTime desc',
    pageSize: '50',
  });

  const res = await fetchImpl(`https://www.googleapis.com/drive/v3/files?${params.toString()}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!res.ok) {
    throw new Error(`Google Drive 폴더 목록 조회 실패 (${res.status})`);
  }

  const data = (await res.json()) as { files?: PickedDriveFolder[] };
  return (data.files ?? []).map((f) => ({
    id: f.id,
    name: f.name || '이름 없는 폴더',
    modifiedTime: f.modifiedTime,
  }));
}

/**
 * drive.file 최소 권한으로도 즉시 생성 가능한 전용 동기화 폴더를 생성하고 지정한다.
 */
export async function createDedicatedSyncFolder(
  folderName = 'EduInk Sync',
  accessTokenOverride?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PickedDriveFolder> {
  const token = accessTokenOverride ?? (await getValidDriveAccessToken());
  const cleanName = folderName.trim() || 'EduInk Sync';

  const res = await fetchImpl('https://www.googleapis.com/drive/v3/files?fields=id,name', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: cleanName,
      mimeType: DRIVE_FOLDER_MIME,
    }),
  });

  if (!res.ok) {
    throw new Error(`동기화 전용 폴더 생성 실패 (${res.status})`);
  }

  const created = (await res.json()) as { id: string; name?: string };
  const folder: PickedDriveFolder = {
    id: created.id,
    name: created.name || cleanName,
  };
  applySelectedSyncFolder(folder);
  return folder;
}

/**
 * 로그인 직후 targetFolderId가 비어 있을 때, 기존 전용 폴더를 재사용하거나 자동으로 새로 생성해 지정한다.
 */
export async function ensureOrCreateDefaultSyncFolder(
  folderName = 'EduInk Sync',
  accessTokenOverride?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PickedDriveFolder> {
  const cleanName = folderName.trim() || 'EduInk Sync';
  const token = accessTokenOverride ?? (await getValidDriveAccessToken());

  try {
    const folders = await listAppAccessibleFolders(token, fetchImpl);
    const existing = folders.find((f) => f.name === cleanName);
    if (existing) {
      applySelectedSyncFolder(existing);
      return existing;
    }
  } catch {
    // 목록 조회 실패 시 신규 생성으로 폴백
  }

  return createDedicatedSyncFolder(cleanName, token, fetchImpl);
}

export function applySelectedSyncFolder(folder: PickedDriveFolder): void {
  useSettings.getState().setDriveSyncConfig({
    enabled: true,
    targetFolderId: folder.id,
    targetFolderName: folder.name,
    targetImagesFolderId: null,
    syncStatus: 'idle',
    lastError: null,
  });
}

