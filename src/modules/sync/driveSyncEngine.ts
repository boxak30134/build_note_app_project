import { db, emptyNote, uid, type NoteRecord } from '../../storage/db';
import { listNoteImages, writeAttachment } from '../../storage/opfs';
import { useSettings } from '../../store/settingsStore';
import { getSession } from '../../session/NoteSession';
import { plainTextOf } from '../../core/doc/blocks';
import {
  assertWithinTargetFolder,
  buildScopedDriveQuery,
  SecurityBoundaryError,
} from './driveFolderGuard';
import { getValidDriveAccessToken } from './googleDriveAuth';

const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

export interface DriveFileMeta {
  id: string;
  name: string;
  mimeType?: string;
  modifiedTime?: string;
  parents?: string[];
  trashed?: boolean;
}

export interface DriveSyncResult {
  status: 'synced' | 'offline' | 'SYNC_FOLDER_MISSING' | 'error';
  uploadedCount: number;
  downloadedCount: number;
  conflictCount: number;
  uploadedImagesCount: number;
  errorMessage?: string;
}

export class SyncFolderMissingError extends Error {
  readonly code = 'SYNC_FOLDER_MISSING';
  constructor(folderId: string) {
    super(`지정된 Google Drive 동기화 폴더(${folderId})가 삭제되었거나 접근할 수 없습니다.`);
    this.name = 'SyncFolderMissingError';
  }
}

export function formatConflictTimestamp(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

export function buildConflictFileName(title: string, date = new Date()): string {
  const cleanTitle = (title || '제목 없는 노트').replace(/\.md$/i, '').trim();
  return `${cleanTitle} (충돌 사본 ${formatConflictTimestamp(date)}).md`;
}

function sanitizeMdFileName(title: string): string {
  const clean = (title || '제목 없는 노트')
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim();
  return clean.endsWith('.md') ? clean : `${clean}.md`;
}

function stripMdExt(fileName: string): string {
  return fileName.replace(/\.md$/i, '');
}

export interface DriveFetchDeps {
  fetchImpl?: typeof fetch;
  getToken?: (forceRefresh?: boolean) => Promise<string>;
}

/**
 * 401 응답 시 Access Token 자동 갱신을 1회 재시도하는 Drive fetch 래퍼
 */
async function driveFetch(
  url: string,
  init: RequestInit,
  deps?: DriveFetchDeps,
): Promise<Response> {
  const f = deps?.fetchImpl ?? fetch;
  const getToken = deps?.getToken ?? getValidDriveAccessToken;

  let token = await getToken(false);
  const res = await f(url, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${token}`,
    },
  });

  if (res.status === 401) {
    token = await getToken(true);
    return f(url, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        Authorization: `Bearer ${token}`,
      },
    });
  }

  return res;
}

/**
 * 지정 폴더가 존재하고 휴지통(trashed) 상태가 아닌지 검증한다.
 * 삭제되었거나 404인 경우 루트에 새 폴더를 만들지 않고 SyncFolderMissingError를 발생시킨다.
 */
export async function verifyTargetFolderExists(
  targetFolderId: string,
  deps?: DriveFetchDeps,
): Promise<DriveFileMeta> {
  const url = `${DRIVE_API_BASE}/files/${encodeURIComponent(targetFolderId)}?fields=id,name,mimeType,trashed,parents`;
  const res = await driveFetch(url, { method: 'GET' }, deps);

  if (res.status === 404 || res.status === 403) {
    throw new SyncFolderMissingError(targetFolderId);
  }
  if (!res.ok) {
    throw new Error(`동기화 폴더 상태 확인 실패 (${res.status})`);
  }

  const meta = (await res.json()) as DriveFileMeta;
  if (meta.trashed === true) {
    throw new SyncFolderMissingError(targetFolderId);
  }
  return meta;
}

/**
 * 지정 폴더(targetFolderId) 내부 파일 목록만 조회한다 (`'<targetFolderId>' in parents` 강제).
 */
export async function listScopedFiles(
  targetFolderId: string,
  extraConditions?: string,
  deps?: DriveFetchDeps,
): Promise<DriveFileMeta[]> {
  const q = buildScopedDriveQuery(targetFolderId, extraConditions);
  const params = new URLSearchParams({
    q,
    fields: 'files(id,name,mimeType,modifiedTime,parents,trashed)',
    pageSize: '1000',
  });
  const res = await driveFetch(`${DRIVE_API_BASE}/files?${params.toString()}`, { method: 'GET' }, deps);
  if (!res.ok) {
    throw new Error(`Drive 파일 목록 조회 실패 (${res.status})`);
  }
  const data = (await res.json()) as { files?: DriveFileMeta[] };
  const files = data.files ?? [];
  for (const file of files) {
    assertWithinTargetFolder(file, [targetFolderId]);
  }
  return files;
}

/**
 * 경계 검증(assertWithinTargetFolder) 후 원격 파일 메타데이터/내용 다운로드
 */
export async function readScopedDriveFileText(
  fileMeta: DriveFileMeta,
  allowedParents: string[],
  deps?: DriveFetchDeps,
): Promise<string> {
  assertWithinTargetFolder(fileMeta, allowedParents);
  const url = `${DRIVE_API_BASE}/files/${encodeURIComponent(fileMeta.id)}?alt=media`;
  const res = await driveFetch(url, { method: 'GET' }, deps);
  if (!res.ok) {
    throw new Error(`Drive 파일 다운로드 실패 (${res.status})`);
  }
  return res.text();
}

/**
 * 경계 검증(assertWithinTargetFolder) 후 원격 파일 바이너리 다운로드
 */
export async function readScopedDriveFileBlob(
  fileMeta: DriveFileMeta,
  allowedParents: string[],
  deps?: DriveFetchDeps,
): Promise<Blob> {
  assertWithinTargetFolder(fileMeta, allowedParents);
  const url = `${DRIVE_API_BASE}/files/${encodeURIComponent(fileMeta.id)}?alt=media`;
  const res = await driveFetch(url, { method: 'GET' }, deps);
  if (!res.ok) {
    throw new Error(`Drive 바이너리 다운로드 실패 (${res.status})`);
  }
  return res.blob();
}

/**
 * 경계 검증(assertWithinTargetFolder) 후 원격 파일 삭제(휴지통 이동 또는 삭제)
 */
export async function deleteScopedDriveFile(
  fileMeta: DriveFileMeta,
  allowedParents: string[],
  deps?: DriveFetchDeps,
): Promise<void> {
  assertWithinTargetFolder(fileMeta, allowedParents);
  const url = `${DRIVE_API_BASE}/files/${encodeURIComponent(fileMeta.id)}`;
  const res = await driveFetch(url, { method: 'DELETE' }, deps);
  if (!res.ok && res.status !== 404) {
    throw new Error(`Drive 파일 삭제 실패 (${res.status})`);
  }
}

async function createOrUpdateMultipartFile(
  options: {
    existingFile?: DriveFileMeta | null;
    name: string;
    mimeType: string;
    parentId: string;
    body: Blob | string;
    allowedParents: string[];
  },
  deps?: DriveFetchDeps,
): Promise<DriveFileMeta> {
  const { existingFile, name, mimeType, parentId, body, allowedParents } = options;

  // 생성·수정 전 반드시 대상 부모/파일이 지정 폴더 경계 내부인지 검증
  assertWithinTargetFolder({ id: existingFile?.id, name, parents: [parentId] }, allowedParents);
  if (existingFile) {
    assertWithinTargetFolder(existingFile, allowedParents);
  }

  const boundary = `eduink_sync_${Date.now().toString(36)}`;
  const metadata = existingFile
    ? { name, mimeType }
    : { name, mimeType, parents: [parentId] };

  const headerPart =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${mimeType}\r\n\r\n`;
  const footerPart = `\r\n--${boundary}--`;

  const payload = new Blob([headerPart, body, footerPart], {
    type: `multipart/related; boundary=${boundary}`,
  });

  const url = existingFile
    ? `${DRIVE_UPLOAD_BASE}/files/${encodeURIComponent(existingFile.id)}?uploadType=multipart&fields=id,name,mimeType,modifiedTime,parents`
    : `${DRIVE_UPLOAD_BASE}/files?uploadType=multipart&fields=id,name,mimeType,modifiedTime,parents`;

  const res = await driveFetch(
    url,
    {
      method: existingFile ? 'PATCH' : 'POST',
      headers: {
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body: payload,
    },
    deps,
  );

  if (!res.ok) {
    throw new Error(`Drive 파일 업로드 실패 (${res.status})`);
  }
  return (await res.json()) as DriveFileMeta;
}

async function ensureImagesSubfolder(
  targetFolderId: string,
  deps?: DriveFetchDeps,
): Promise<string> {
  const folders = await listScopedFiles(
    targetFolderId,
    `name = 'images' and mimeType = '${FOLDER_MIME}'`,
    deps,
  );
  if (folders.length > 0) {
    assertWithinTargetFolder(folders[0], [targetFolderId]);
    return folders[0].id;
  }

  assertWithinTargetFolder({ name: 'images', parents: [targetFolderId] }, [targetFolderId]);
  const res = await driveFetch(
    `${DRIVE_API_BASE}/files?fields=id,name,parents`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'images',
        mimeType: FOLDER_MIME,
        parents: [targetFolderId],
      }),
    },
    deps,
  );
  if (!res.ok) {
    throw new Error(`images 서브폴더 생성 실패 (${res.status})`);
  }
  const created = (await res.json()) as DriveFileMeta;
  return created.id;
}

function buildContentDocFromMarkdownText(markdown: string): unknown {
  const lines = markdown.split(/\r?\n/);
  return {
    type: 'doc',
    content: lines.map((line) =>
      line
        ? { type: 'paragraph', content: [{ type: 'text', text: line }] }
        : { type: 'paragraph' },
    ),
  };
}

/**
 * 지정 폴더(targetFolderId)와의 로컬 우선(Local-First) 양방향 증분 동기화를 실행한다.
 */
export async function runDriveSync(deps?: DriveFetchDeps): Promise<DriveSyncResult> {
  const settings = useSettings.getState();
  const cfg = settings.driveSyncConfig;

  if (!cfg.enabled || !cfg.targetFolderId) {
    return {
      status: 'error',
      uploadedCount: 0,
      downloadedCount: 0,
      conflictCount: 0,
      uploadedImagesCount: 0,
      errorMessage: 'Google Drive 동기화 폴더가 선택되지 않았습니다.',
    };
  }

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    settings.setDriveSyncConfig({
      syncStatus: 'offline',
      lastError: '오프라인 상태입니다. 네트워크 복구 시 자동 동기화됩니다.',
    });
    return {
      status: 'offline',
      uploadedCount: 0,
      downloadedCount: 0,
      conflictCount: 0,
      uploadedImagesCount: 0,
    };
  }

  const targetFolderId = cfg.targetFolderId;
  settings.setDriveSyncConfig({ syncStatus: 'syncing', lastError: null });

  let uploadedCount = 0;
  let downloadedCount = 0;
  let conflictCount = 0;
  let uploadedImagesCount = 0;

  try {
    // 1. 지정 폴더 존재/삭제 여부 확인 (삭제 시 루트에 새 폴더 생성 절대 금지)
    await verifyTargetFolderExists(targetFolderId, deps);

    // 2. 지정 폴더 내부 마크다운 파일 목록 조회
    const remoteMdFiles = await listScopedFiles(
      targetFolderId,
      `mimeType != '${FOLDER_MIME}'`,
      deps,
    );

    const allowedParents = [targetFolderId];
    let imagesFolderId = cfg.targetImagesFolderId ?? null;

    const allLocalNotes = await db.notes.toArray();
    const activeLocalNotes = allLocalNotes.filter((n) => !n.deletedAt);
    const localByDriveId = new Map<string, NoteRecord>();
    const localByTitle = new Map<string, NoteRecord>();
    for (const n of activeLocalNotes) {
      if (n.driveFileId) localByDriveId.set(n.driveFileId, n);
      localByTitle.set(n.title, n);
    }

    const handledNoteIds = new Set<string>();
    const now = Date.now();

    // 3. 원격 -> 로컬 동기화 및 충돌 해결
    for (const remote of remoteMdFiles) {
      if (!remote.name.toLowerCase().endsWith('.md')) continue;
      assertWithinTargetFolder(remote, allowedParents);

      const remoteTitle = stripMdExt(remote.name);
      const local = localByDriveId.get(remote.id) ?? localByTitle.get(remoteTitle);
      const remoteModifiedMs = remote.modifiedTime ? Date.parse(remote.modifiedTime) : now;

      if (!local) {
        // 원격에만 있는 신규 마크다운 노트 -> 로컬 Dexie DB로 가져오기
        const mdText = await readScopedDriveFileText(remote, allowedParents, deps);
        const contentDoc = buildContentDocFromMarkdownText(mdText);
        const newNote = emptyNote({
          id: uid('note'),
          title: remoteTitle,
          markdown: mdText,
          content: contentDoc,
          plainText: plainTextOf(contentDoc),
          driveFileId: remote.id,
          lastSyncedAt: now,
          syncDirty: false,
          remoteModifiedTime: remote.modifiedTime ?? new Date(now).toISOString(),
          updatedAt: remoteModifiedMs,
        });
        await db.notes.put(newNote);
        downloadedCount++;
        continue;
      }

      handledNoteIds.add(local.id);
      const lastSynced = local.lastSyncedAt ?? 0;
      const localChanged = Boolean(local.syncDirty) || local.updatedAt > lastSynced;
      const remoteChanged =
        remoteModifiedMs > lastSynced &&
        remote.modifiedTime !== local.remoteModifiedTime;

      if (localChanged && remoteChanged) {
        // 양방향 동시 수정 충돌 -> 덮어쓰지 않고 (충돌 사본 YYYYMMDD-HHmm).md 로 분기 저장
        const conflictFileName = buildConflictFileName(local.title, new Date(now));
        const conflictTitle = stripMdExt(conflictFileName);
        const uploadedConflict = await createOrUpdateMultipartFile(
          {
            name: conflictFileName,
            mimeType: 'text/markdown; charset=UTF-8',
            parentId: targetFolderId,
            body: local.markdown ?? '',
            allowedParents,
          },
          deps,
        );

        // 로컬에도 충돌 사본 노트를 별도 보존 (로컬 수정분)
        const conflictNote = emptyNote({
          id: uid('note'),
          title: conflictTitle,
          folderId: local.folderId,
          markdown: local.markdown,
          content: local.content,
          plainText: local.plainText,
          strokes: local.strokes,
          annotations: local.annotations,
          textObjects: local.textObjects,
          pages: local.pages,
          driveFileId: uploadedConflict.id,
          lastSyncedAt: now,
          syncDirty: false,
          remoteModifiedTime: uploadedConflict.modifiedTime ?? new Date(now).toISOString(),
        });
        await db.notes.put(conflictNote);

        // 기존 노트는 원격 최신본 반영 (Undo 스택 무오염)
        const remoteMd = await readScopedDriveFileText(remote, allowedParents, deps);
        const activeSession = getSession(local.id);
        if (activeSession) {
          await activeSession.applyRemoteMarkdown(remoteMd, remote.id, remote.modifiedTime ?? null, now);
        } else {
          const contentDoc = buildContentDocFromMarkdownText(remoteMd);
          await db.notes.update(local.id, {
            markdown: remoteMd,
            content: contentDoc,
            plainText: plainTextOf(contentDoc),
            driveFileId: remote.id,
            lastSyncedAt: now,
            syncDirty: false,
            remoteModifiedTime: remote.modifiedTime ?? null,
            updatedAt: remoteModifiedMs,
          });
        }
        conflictCount++;
        downloadedCount++;
      } else if (remoteChanged && !localChanged) {
        // 원격만 최신 -> 로컬에 반영 (addToHistory: false)
        const remoteMd = await readScopedDriveFileText(remote, allowedParents, deps);
        const activeSession = getSession(local.id);
        if (activeSession) {
          await activeSession.applyRemoteMarkdown(remoteMd, remote.id, remote.modifiedTime ?? null, now);
        } else {
          const contentDoc = buildContentDocFromMarkdownText(remoteMd);
          await db.notes.update(local.id, {
            markdown: remoteMd,
            content: contentDoc,
            plainText: plainTextOf(contentDoc),
            driveFileId: remote.id,
            lastSyncedAt: now,
            syncDirty: false,
            remoteModifiedTime: remote.modifiedTime ?? null,
            updatedAt: remoteModifiedMs,
          });
        }
        downloadedCount++;
      } else if (localChanged && !remoteChanged) {
        // 로컬만 변경됨 -> 원격 업데이트
        const uploaded = await createOrUpdateMultipartFile(
          {
            existingFile: remote,
            name: sanitizeMdFileName(local.title),
            mimeType: 'text/markdown; charset=UTF-8',
            parentId: targetFolderId,
            body: local.markdown ?? '',
            allowedParents,
          },
          deps,
        );
        await db.notes.update(local.id, {
          driveFileId: uploaded.id,
          lastSyncedAt: now,
          syncDirty: false,
          remoteModifiedTime: uploaded.modifiedTime ?? null,
        });
        uploadedCount++;
      }
    }

    // 4. 로컬에만 있거나 신규/변경된 노트 + 첨부 이미지(images/*.png) 업로드
    for (const local of activeLocalNotes) {
      const needsUpload =
        !handledNoteIds.has(local.id) &&
        (!local.driveFileId || Boolean(local.syncDirty) || local.updatedAt > (local.lastSyncedAt ?? 0));

      if (!needsUpload) continue;

      // 첨부 이미지(OPFS images/) 업로드
      const images = await listNoteImages(local.id);
      if (images.length > 0) {
        if (!imagesFolderId) {
          imagesFolderId = await ensureImagesSubfolder(targetFolderId, deps);
        }
        const existingRemoteImages = await listScopedFiles(
          imagesFolderId,
          `mimeType != '${FOLDER_MIME}'`,
          deps,
        );
        const remoteImgByName = new Map(existingRemoteImages.map((f) => [f.name, f]));

        for (const img of images) {
          const existingImg = remoteImgByName.get(img.name) ?? null;
          await createOrUpdateMultipartFile(
            {
              existingFile: existingImg,
              name: img.name,
              mimeType: img.blob.type || 'image/png',
              parentId: imagesFolderId,
              body: img.blob,
              allowedParents: [imagesFolderId],
            },
            deps,
          );
          uploadedImagesCount++;
        }
      }

      const existingMeta = local.driveFileId
        ? remoteMdFiles.find((f) => f.id === local.driveFileId) ?? null
        : null;

      const uploaded = await createOrUpdateMultipartFile(
        {
          existingFile: existingMeta,
          name: sanitizeMdFileName(local.title),
          mimeType: 'text/markdown; charset=UTF-8',
          parentId: targetFolderId,
          body: local.markdown ?? '',
          allowedParents,
        },
        deps,
      );

      await db.notes.update(local.id, {
        driveFileId: uploaded.id,
        lastSyncedAt: now,
        syncDirty: false,
        remoteModifiedTime: uploaded.modifiedTime ?? null,
      });
      uploadedCount++;
    }

    // 5. 원격 images/ 폴더에 새 이미지가 있다면 OPFS로 다운로드 보조
    if (imagesFolderId && activeLocalNotes.length > 0) {
      const remoteImgs = await listScopedFiles(
        imagesFolderId,
        `mimeType != '${FOLDER_MIME}'`,
        deps,
      );
      if (remoteImgs.length > 0) {
        const primaryNote = activeLocalNotes[0];
        for (const rImg of remoteImgs) {
          const blob = await readScopedDriveFileBlob(rImg, [imagesFolderId], deps);
          await writeAttachment(primaryNote.id, `images/${rImg.name}`, blob).catch(() => undefined);
        }
      }
    }

    settings.setDriveSyncConfig({
      syncStatus: 'synced',
      targetImagesFolderId: imagesFolderId,
      lastSyncedAt: now,
      lastError: null,
    });

    return {
      status: 'synced',
      uploadedCount,
      downloadedCount,
      conflictCount,
      uploadedImagesCount,
    };
  } catch (err) {
    if (err instanceof SyncFolderMissingError) {
      settings.setDriveSyncConfig({
        syncStatus: 'SYNC_FOLDER_MISSING',
        lastError: err.message,
      });
      return {
        status: 'SYNC_FOLDER_MISSING',
        uploadedCount,
        downloadedCount,
        conflictCount,
        uploadedImagesCount,
        errorMessage: err.message,
      };
    }

    if (err instanceof SecurityBoundaryError) {
      settings.setDriveSyncConfig({
        syncStatus: 'error',
        lastError: err.message,
      });
      throw err;
    }

    const msg = (err as Error)?.message || 'Google Drive 동기화 중 오류가 발생했습니다.';
    settings.setDriveSyncConfig({
      syncStatus: 'error',
      lastError: msg,
    });
    return {
      status: 'error',
      uploadedCount,
      downloadedCount,
      conflictCount,
      uploadedImagesCount,
      errorMessage: msg,
    };
  }
}

let autoSyncTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 로컬 저장 후 백그라운드 디바운스 동기화 예약 (S-Pen 렌더링 루프 무간섭)
 */
export function scheduleBackgroundDriveSync(delayMs = 2500): void {
  const cfg = useSettings.getState().driveSyncConfig;
  if (!cfg.enabled || !cfg.targetFolderId) return;
  if (autoSyncTimer) clearTimeout(autoSyncTimer);
  autoSyncTimer = setTimeout(() => {
    autoSyncTimer = null;
    void runDriveSync();
  }, delayMs);
}

/**
 * window 'online' 복귀 시 자동 재동기화 리스너 등록
 */
export function registerDriveOnlineSyncListener(): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const onOnline = () => {
    const cfg = useSettings.getState().driveSyncConfig;
    if (cfg.enabled && cfg.targetFolderId) {
      void runDriveSync();
    }
  };
  window.addEventListener('online', onOnline);
  return () => window.removeEventListener('online', onOnline);
}

