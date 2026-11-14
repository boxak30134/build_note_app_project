import { db, emptyNote, uid, type FolderRecord, type NoteRecord } from '../../storage/db';
import { listNoteAttachments, listNoteImages, writeAttachment } from '../../storage/opfs';
import { useSettings } from '../../store/settingsStore';
import { getSession } from '../../session/NoteSession';
import { plainTextOf } from '../../core/doc/blocks';
import { jsonToMarkdown, markdownToJson } from '../../editor/extensions';
import type { Stroke } from '../../core/strokes/StrokeStore';
import type { NotePage } from '../../core/page/pageTypes';
import type { NoteTextObject } from '../../core/text/textObjects';
import type { Annotation } from '../../features/annotations/types';
import {
  assertWithinTargetFolder,
  buildScopedDriveQuery,
  SecurityBoundaryError,
} from './driveFolderGuard';
import { getValidDriveAccessToken } from './googleDriveAuth';

const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const SIDECAR_SUFFIX = '.eduink.json';
const ATTACHMENT_DRIVE_PREFIX = 'att__';

interface NoteSyncSidecar {
  version: 1;
  content?: unknown;
  strokes?: Stroke[];
  pages?: NotePage[];
  annotations?: Annotation[];
  textObjects?: NoteTextObject[];
}

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

function sanitizeSidecarFileName(title: string): string {
  return `${stripMdExt(sanitizeMdFileName(title))}${SIDECAR_SUFFIX}`;
}

function isSidecarFileName(fileName: string): boolean {
  return fileName.toLowerCase().endsWith(SIDECAR_SUFFIX);
}

function stripSidecarExt(fileName: string): string {
  return fileName.slice(0, -SIDECAR_SUFFIX.length);
}

function hasNodeType(node: unknown, targetType: string): boolean {
  if (!node || typeof node !== 'object') return false;
  const obj = node as { type?: unknown; content?: unknown };
  if (obj.type === targetType) return true;
  if (Array.isArray(obj.content)) {
    return obj.content.some((child) => hasNodeType(child, targetType));
  }
  return false;
}

function needsSyncSidecar(note: NoteRecord): boolean {
  if ((note.strokes?.length ?? 0) > 0) return true;
  if ((note.annotations?.length ?? 0) > 0) return true;
  if ((note.textObjects?.length ?? 0) > 0) return true;
  if ((note.pages?.length ?? 0) > 1) return true;
  if (note.pages?.some((p) => p.size !== 'A4' || p.style !== 'plain' || p.orientation !== 'portrait')) {
    return true;
  }
  return hasNodeType(note.content, 'inkTemplate') || hasNodeType(note.content, 'pdfEmbed');
}

function buildSidecarPayload(note: NoteRecord): NoteSyncSidecar {
  return {
    version: 1,
    content: note.content,
    strokes: note.strokes ?? [],
    pages: note.pages ?? [],
    annotations: note.annotations ?? [],
    textObjects: note.textObjects ?? [],
  };
}

function sanitizeDriveSegment(name: string): string {
  return (name || '폴더').replace(/[\\/:*?"<>|]/g, '_').trim() || '폴더';
}

function escapeDriveQueryLiteral(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * 노트가 속한 로컬 폴더 트리를 루트 → 리프 순의 폴더명 배열로 변환한다.
 * 순환 참조 및 삭제된 폴더는 안전하게 무시한다.
 */
export function getFolderPathSegments(
  folderId: string | null | undefined,
  folderMap: Map<string, FolderRecord>,
): string[] {
  const segments: string[] = [];
  const visited = new Set<string>();
  let curId = folderId ?? null;
  while (curId) {
    if (visited.has(curId)) break;
    visited.add(curId);
    const folder = folderMap.get(curId);
    if (!folder || folder.deletedAt) break;
    segments.unshift(sanitizeDriveSegment(folder.name));
    curId = folder.parentId ?? null;
  }
  return segments;
}

async function ensureDriveFolderPath(
  targetFolderId: string,
  segments: string[],
  folderCache: Map<string, string>,
  deps?: DriveFetchDeps,
): Promise<string> {
  let parentId = targetFolderId;
  for (const segment of segments) {
    const cacheKey = `${parentId}/${segment}`;
    const cached = folderCache.get(cacheKey);
    if (cached) {
      parentId = cached;
      continue;
    }

    const existing = await listScopedFiles(
      parentId,
      `name = '${escapeDriveQueryLiteral(segment)}' and mimeType = '${FOLDER_MIME}'`,
      deps,
    );
    if (existing.length > 0) {
      assertWithinTargetFolder(existing[0], [parentId]);
      folderCache.set(cacheKey, existing[0].id);
      parentId = existing[0].id;
      continue;
    }

    assertWithinTargetFolder({ name: segment, parents: [parentId] }, [parentId]);
    const res = await driveFetch(
      `${DRIVE_API_BASE}/files?fields=id,name,parents`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: segment,
          mimeType: FOLDER_MIME,
          parents: [parentId],
        }),
      },
      deps,
    );
    if (!res.ok) {
      throw new Error(`Drive 하위 폴더(${segment}) 생성 실패 (${res.status})`);
    }
    const created = (await res.json()) as DriveFileMeta;
    folderCache.set(cacheKey, created.id);
    parentId = created.id;
  }
  return parentId;
}

async function uploadNoteAssetsToImagesFolder(
  noteId: string,
  targetFolderId: string,
  currentImagesFolderId: string | null,
  getRemoteImages: (imgFolderId: string) => Promise<DriveFileMeta[]>,
  downloadedDriveImgIds: Set<string> | null,
  deps?: DriveFetchDeps,
): Promise<{ imagesFolderId: string | null; uploadedCount: number }> {
  const images = await listNoteImages(noteId);
  const attachments = await listNoteAttachments(noteId);
  const allAssets = [
    ...images.map((item) => ({ driveName: item.name, blob: item.blob })),
    ...attachments.map((item) => ({ driveName: `${ATTACHMENT_DRIVE_PREFIX}${item.name}`, blob: item.blob })),
  ];
  if (allAssets.length === 0) {
    return { imagesFolderId: currentImagesFolderId, uploadedCount: 0 };
  }

  const imagesFolderId = currentImagesFolderId ?? (await ensureImagesSubfolder(targetFolderId, deps));
  const existingRemoteImages = await getRemoteImages(imagesFolderId);
  const remoteImgByName = new Map(existingRemoteImages.map((f) => [f.name, f]));
  let uploadedCount = 0;

  for (const asset of allAssets) {
    const existingImg = remoteImgByName.get(asset.driveName) ?? null;
    const uploadedAsset = await createOrUpdateMultipartFile(
      {
        existingFile: existingImg,
        name: asset.driveName,
        mimeType: asset.blob.type || 'application/octet-stream',
        parentId: imagesFolderId,
        body: asset.blob,
        allowedParents: [imagesFolderId],
      },
      deps,
    );
    remoteImgByName.set(asset.driveName, uploadedAsset);
    downloadedDriveImgIds?.add(uploadedAsset.id);
    const idx = existingRemoteImages.findIndex((f) => f.id === uploadedAsset.id || f.name === uploadedAsset.name);
    if (idx >= 0) existingRemoteImages[idx] = uploadedAsset;
    else existingRemoteImages.push(uploadedAsset);
    uploadedCount++;
  }

  return { imagesFolderId, uploadedCount };
}

function resolveUploadMarkdown(note: NoteRecord): string {
  if (note.markdown && note.markdown.length > 0) return note.markdown;
  if (note.content) {
    try {
      return jsonToMarkdown(note.content);
    } catch {
      return '';
    }
  }
  return '';
}

function collectReferencedAssetPaths(doc: unknown): string[] {
  const paths = new Set<string>();
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    const obj = node as { type?: unknown; attrs?: Record<string, unknown>; content?: unknown };
    if (
      (obj.type === 'image' || obj.type === 'inkTemplate' || obj.type === 'pdfEmbed') &&
      typeof obj.attrs?.src === 'string'
    ) {
      const src = obj.attrs.src;
      if (src.startsWith('images/') || src.startsWith('attachments/')) {
        paths.add(src);
      }
    }
    if (Array.isArray(obj.content)) {
      obj.content.forEach(walk);
    }
  };
  walk(doc);
  return Array.from(paths);
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

async function findImagesSubfolder(
  targetFolderId: string,
  deps?: DriveFetchDeps,
): Promise<string | null> {
  const folders = await listScopedFiles(
    targetFolderId,
    `name = 'images' and mimeType = '${FOLDER_MIME}'`,
    deps,
  );
  if (folders.length > 0) {
    assertWithinTargetFolder(folders[0], [targetFolderId]);
    return folders[0].id;
  }
  return null;
}

async function ensureImagesSubfolder(
  targetFolderId: string,
  deps?: DriveFetchDeps,
): Promise<string> {
  const existing = await findImagesSubfolder(targetFolderId, deps);
  if (existing) return existing;

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
  const cleanMarkdown = markdown.replace(/^\uFEFF/, '');
  if (!cleanMarkdown.trim()) {
    return { type: 'doc', content: [{ type: 'paragraph' }] };
  }
  try {
    const parsed = markdownToJson(cleanMarkdown) as { type?: string; content?: unknown[] } | null;
    if (parsed && parsed.type === 'doc' && Array.isArray(parsed.content) && parsed.content.length > 0) {
      return parsed;
    }
  } catch {
    // 파서 예외 시에만 아래 줄 단위 단락 폴백으로 안전 복구
  }
  const lines = cleanMarkdown.split(/\r?\n/);
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

    // 2. 지정 폴더 내부 마크다운 파일 및 사이드카(.eduink.json) 목록 조회
    const remoteEntries = await listScopedFiles(
      targetFolderId,
      `mimeType != '${FOLDER_MIME}'`,
      deps,
    );
    const remoteMdFiles: DriveFileMeta[] = [];
    const remoteSidecarsByTitle = new Map<string, DriveFileMeta>();
    for (const entry of remoteEntries) {
      if (isSidecarFileName(entry.name)) {
        remoteSidecarsByTitle.set(stripSidecarExt(entry.name), entry);
      } else {
        remoteMdFiles.push(entry);
      }
    }

    const allowedParents = [targetFolderId];
    let imagesFolderId = cfg.targetImagesFolderId ?? null;
    let cachedRemoteImgs: DriveFileMeta[] | null = null;
    const downloadedDriveImgIds = new Set<string>();

    const getRemoteImages = async (): Promise<DriveFileMeta[]> => {
      if (!imagesFolderId) {
        imagesFolderId = await findImagesSubfolder(targetFolderId, deps);
      }
      if (!imagesFolderId) return [];
      if (!cachedRemoteImgs) {
        cachedRemoteImgs = await listScopedFiles(
          imagesFolderId,
          `mimeType != '${FOLDER_MIME}'`,
          deps,
        );
      }
      return cachedRemoteImgs;
    };

    const readSidecar = async (title: string): Promise<NoteSyncSidecar | null> => {
      const meta = remoteSidecarsByTitle.get(title);
      if (!meta) return null;
      try {
        const raw = await readScopedDriveFileText(meta, allowedParents, deps);
        const parsed = JSON.parse(raw) as NoteSyncSidecar;
        if (parsed && typeof parsed === 'object' && parsed.version === 1) return parsed;
      } catch {
        // 사이드카 손상 시 마크다운 기반 복원으로 안전 폴백
      }
      return null;
    };

    const downloadAssetsForDoc = async (noteId: string, doc: unknown): Promise<void> => {
      const refs = collectReferencedAssetPaths(doc);
      if (refs.length === 0) return;
      const remoteImgs = await getRemoteImages();
      if (!imagesFolderId || remoteImgs.length === 0) return;
      const byName = new Map(remoteImgs.map((f) => [f.name, f]));

      for (const relPath of refs) {
        let targetRemote: DriveFileMeta | undefined;
        if (relPath.startsWith('attachments/')) {
          const baseName = relPath.slice('attachments/'.length);
          targetRemote = byName.get(`${ATTACHMENT_DRIVE_PREFIX}${baseName}`) ?? byName.get(baseName);
        } else if (relPath.startsWith('images/')) {
          const baseName = relPath.slice('images/'.length);
          targetRemote = byName.get(baseName);
        }
        if (!targetRemote) continue;
        const blob = await readScopedDriveFileBlob(targetRemote, [imagesFolderId], deps);
        await writeAttachment(noteId, relPath, blob).catch(() => undefined);
        downloadedDriveImgIds.add(targetRemote.id);
      }
    };

    const uploadNoteAssets = async (noteId: string): Promise<void> => {
      const res = await uploadNoteAssetsToImagesFolder(
        noteId,
        targetFolderId,
        imagesFolderId,
        async (imgFolderId) => {
          imagesFolderId = imgFolderId;
          return getRemoteImages();
        },
        downloadedDriveImgIds,
        deps,
      );
      imagesFolderId = res.imagesFolderId;
      uploadedImagesCount += res.uploadedCount;
    };

    const uploadSidecarIfNeeded = async (note: NoteRecord, titleOverride?: string): Promise<void> => {
      if (!needsSyncSidecar(note)) return;
      const targetTitle = titleOverride ?? note.title;
      const sidecarName = sanitizeSidecarFileName(targetTitle);
      const existingSidecar = remoteSidecarsByTitle.get(targetTitle) ?? null;
      const uploadedSidecar = await createOrUpdateMultipartFile(
        {
          existingFile: existingSidecar,
          name: sidecarName,
          mimeType: 'application/json; charset=UTF-8',
          parentId: targetFolderId,
          body: JSON.stringify(buildSidecarPayload(note)),
          allowedParents,
        },
        deps,
      );
      remoteSidecarsByTitle.set(targetTitle, uploadedSidecar);
    };

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
        // 원격에만 있는 신규 마크다운/필기/PDF 노트 -> 로컬 Dexie DB 및 OPFS 리소스로 가져오기
        const mdText = await readScopedDriveFileText(remote, allowedParents, deps);
        const sidecar = await readSidecar(remoteTitle);
        const contentDoc = sidecar?.content ?? buildContentDocFromMarkdownText(mdText);
        const newNote = emptyNote({
          id: uid('note'),
          title: remoteTitle,
          markdown: mdText,
          content: contentDoc,
          plainText: plainTextOf(contentDoc),
          ...(sidecar?.strokes ? { strokes: sidecar.strokes } : {}),
          ...(sidecar?.pages && sidecar.pages.length > 0 ? { pages: sidecar.pages } : {}),
          ...(sidecar?.annotations ? { annotations: sidecar.annotations } : {}),
          ...(sidecar?.textObjects ? { textObjects: sidecar.textObjects } : {}),
          driveFileId: remote.id,
          lastSyncedAt: now,
          syncDirty: false,
          remoteModifiedTime: remote.modifiedTime ?? new Date(now).toISOString(),
          updatedAt: remoteModifiedMs,
        });
        await downloadAssetsForDoc(newNote.id, contentDoc);
        await db.notes.put(newNote);
        downloadedCount++;
        continue;
      }

      handledNoteIds.add(local.id);
      const lastSynced = local.lastSyncedAt ?? 0;
      const localChanged = Boolean(local.syncDirty) || local.updatedAt > lastSynced;
      const remoteSidecar = remoteSidecarsByTitle.get(remoteTitle);
      const sidecarModifiedMs = remoteSidecar?.modifiedTime ? Date.parse(remoteSidecar.modifiedTime) : 0;
      const remoteChanged =
        (remoteModifiedMs > lastSynced && remote.modifiedTime !== local.remoteModifiedTime) ||
        sidecarModifiedMs > lastSynced;

      if (localChanged && remoteChanged) {
        // 양방향 동시 수정 충돌 -> 덮어쓰지 않고 (충돌 사본 YYYYMMDD-HHmm).md 로 분기 저장
        const conflictFileName = buildConflictFileName(local.title, new Date(now));
        const conflictTitle = stripMdExt(conflictFileName);
        const uploadedConflict = await createOrUpdateMultipartFile(
          {
            name: conflictFileName,
            mimeType: 'text/markdown; charset=UTF-8',
            parentId: targetFolderId,
            body: resolveUploadMarkdown(local),
            allowedParents,
          },
          deps,
        );
        await uploadSidecarIfNeeded(local, conflictTitle);

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
        const sidecar = await readSidecar(remoteTitle);
        const contentDoc = sidecar?.content ?? buildContentDocFromMarkdownText(remoteMd);
        await downloadAssetsForDoc(local.id, contentDoc);
        const activeSession = getSession(local.id);
        if (activeSession) {
          await activeSession.applyRemoteMarkdown(remoteMd, remote.id, remote.modifiedTime ?? null, now, sidecar);
        } else {
          await db.notes.update(local.id, {
            markdown: remoteMd,
            content: contentDoc,
            plainText: plainTextOf(contentDoc),
            ...(sidecar?.strokes ? { strokes: sidecar.strokes } : {}),
            ...(sidecar?.pages && sidecar.pages.length > 0 ? { pages: sidecar.pages } : {}),
            ...(sidecar?.annotations ? { annotations: sidecar.annotations } : {}),
            ...(sidecar?.textObjects ? { textObjects: sidecar.textObjects } : {}),
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
        const sidecar = await readSidecar(remoteTitle);
        const contentDoc = sidecar?.content ?? buildContentDocFromMarkdownText(remoteMd);
        await downloadAssetsForDoc(local.id, contentDoc);
        const activeSession = getSession(local.id);
        if (activeSession) {
          await activeSession.applyRemoteMarkdown(remoteMd, remote.id, remote.modifiedTime ?? null, now, sidecar);
        } else {
          await db.notes.update(local.id, {
            markdown: remoteMd,
            content: contentDoc,
            plainText: plainTextOf(contentDoc),
            ...(sidecar?.strokes ? { strokes: sidecar.strokes } : {}),
            ...(sidecar?.pages && sidecar.pages.length > 0 ? { pages: sidecar.pages } : {}),
            ...(sidecar?.annotations ? { annotations: sidecar.annotations } : {}),
            ...(sidecar?.textObjects ? { textObjects: sidecar.textObjects } : {}),
            driveFileId: remote.id,
            lastSyncedAt: now,
            syncDirty: false,
            remoteModifiedTime: remote.modifiedTime ?? null,
            updatedAt: remoteModifiedMs,
          });
        }
        downloadedCount++;
      } else if (localChanged && !remoteChanged) {
        // 로컬만 변경됨 -> 원격 업데이트 (리소스 + 마크다운 + 사이드카)
        await uploadNoteAssets(local.id);
        const uploaded = await createOrUpdateMultipartFile(
          {
            existingFile: remote,
            name: sanitizeMdFileName(local.title),
            mimeType: 'text/markdown; charset=UTF-8',
            parentId: targetFolderId,
            body: resolveUploadMarkdown(local),
            allowedParents,
          },
          deps,
        );
        await uploadSidecarIfNeeded(local);
        await db.notes.update(local.id, {
          driveFileId: uploaded.id,
          lastSyncedAt: now,
          syncDirty: false,
          remoteModifiedTime: uploaded.modifiedTime ?? null,
        });
        uploadedCount++;
      }
    }

    // 4. 로컬에만 있거나 신규/변경된 노트 + 첨부 이미지(images/*, attachments/*) + 사이드카 업로드
    for (const local of activeLocalNotes) {
      const needsUpload =
        !handledNoteIds.has(local.id) &&
        (!local.driveFileId || Boolean(local.syncDirty) || local.updatedAt > (local.lastSyncedAt ?? 0));

      if (!needsUpload) continue;

      await uploadNoteAssets(local.id);

      const existingMeta = local.driveFileId
        ? remoteMdFiles.find((f) => f.id === local.driveFileId) ?? null
        : null;

      const uploaded = await createOrUpdateMultipartFile(
        {
          existingFile: existingMeta,
          name: sanitizeMdFileName(local.title),
          mimeType: 'text/markdown; charset=UTF-8',
          parentId: targetFolderId,
          body: resolveUploadMarkdown(local),
          allowedParents,
        },
        deps,
      );
      await uploadSidecarIfNeeded(local);

      await db.notes.update(local.id, {
        driveFileId: uploaded.id,
        lastSyncedAt: now,
        syncDirty: false,
        remoteModifiedTime: uploaded.modifiedTime ?? null,
      });
      uploadedCount++;
    }

    // 5. 특정 노트에 매칭되지 않은 잔여 원격 images/ 파일 보조 다운로드 (하위 호환)
    if (imagesFolderId && activeLocalNotes.length > 0) {
      const remoteImgs = await getRemoteImages();
      const unreferencedImgs = remoteImgs.filter(
        (rImg) => !downloadedDriveImgIds.has(rImg.id) && !rImg.name.startsWith(ATTACHMENT_DRIVE_PREFIX),
      );
      if (unreferencedImgs.length > 0) {
        const primaryNote = activeLocalNotes[0];
        for (const rImg of unreferencedImgs) {
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

/**
 * 파일 목록에서 선택한 문서(noteIds)들을 로컬 폴더 계층 구조와 동일한 경로로
 * Google Drive 동기화 폴더(targetFolderId) 하위에 업로드한다.
 */
export async function uploadSelectedNotesToDrive(
  noteIds: string[],
  deps?: DriveFetchDeps,
): Promise<DriveSyncResult> {
  const settings = useSettings.getState();
  const cfg = settings.driveSyncConfig;

  if (!cfg.enabled || !cfg.targetFolderId) {
    return {
      status: 'error',
      uploadedCount: 0,
      downloadedCount: 0,
      conflictCount: 0,
      uploadedImagesCount: 0,
      errorMessage: 'Google Drive 동기화 폴더가 연결되지 않았습니다.',
    };
  }

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return {
      status: 'offline',
      uploadedCount: 0,
      downloadedCount: 0,
      conflictCount: 0,
      uploadedImagesCount: 0,
      errorMessage: '오프라인 상태입니다. 네트워크 연결 후 다시 시도하세요.',
    };
  }

  const uniqueIds = Array.from(new Set(noteIds)).filter(Boolean);
  if (uniqueIds.length === 0) {
    return {
      status: 'synced',
      uploadedCount: 0,
      downloadedCount: 0,
      conflictCount: 0,
      uploadedImagesCount: 0,
    };
  }

  const targetFolderId = cfg.targetFolderId;
  settings.setDriveSyncConfig({ syncStatus: 'syncing', lastError: null });

  let uploadedCount = 0;
  let uploadedImagesCount = 0;

  try {
    await verifyTargetFolderExists(targetFolderId, deps);

    const allFolders = await db.folders.toArray();
    const folderMap = new Map(allFolders.filter((f) => !f.deletedAt).map((f) => [f.id, f]));
    const allNotes = await db.notes.toArray();
    const noteMap = new Map(allNotes.filter((n) => !n.deletedAt).map((n) => [n.id, n]));

    const folderCache = new Map<string, string>();
    const dirFilesCache = new Map<string, DriveFileMeta[]>();
    let imagesFolderId = cfg.targetImagesFolderId ?? null;
    let cachedRemoteImgs: DriveFileMeta[] | null = null;
    const now = Date.now();

    const getDirFiles = async (dirId: string): Promise<DriveFileMeta[]> => {
      const cached = dirFilesCache.get(dirId);
      if (cached) return cached;
      const list = await listScopedFiles(dirId, `mimeType != '${FOLDER_MIME}'`, deps);
      dirFilesCache.set(dirId, list);
      return list;
    };

    for (const id of uniqueIds) {
      const note = noteMap.get(id);
      if (!note) continue;

      const segments = getFolderPathSegments(note.folderId, folderMap);
      const destFolderId = await ensureDriveFolderPath(targetFolderId, segments, folderCache, deps);
      const destFiles = await getDirFiles(destFolderId);

      const assetRes = await uploadNoteAssetsToImagesFolder(
        note.id,
        targetFolderId,
        imagesFolderId,
        async (imgFolderId) => {
          imagesFolderId = imgFolderId;
          if (!cachedRemoteImgs) {
            cachedRemoteImgs = await listScopedFiles(
              imgFolderId,
              `mimeType != '${FOLDER_MIME}'`,
              deps,
            );
          }
          return cachedRemoteImgs;
        },
        null,
        deps,
      );
      imagesFolderId = assetRes.imagesFolderId;
      uploadedImagesCount += assetRes.uploadedCount;

      const mdName = sanitizeMdFileName(note.title);
      const existingMd =
        (note.driveFileId ? destFiles.find((f) => f.id === note.driveFileId) : undefined) ??
        destFiles.find((f) => f.name === mdName) ??
        null;

      const uploadedMd = await createOrUpdateMultipartFile(
        {
          existingFile: existingMd,
          name: mdName,
          mimeType: 'text/markdown; charset=UTF-8',
          parentId: destFolderId,
          body: resolveUploadMarkdown(note),
          allowedParents: [destFolderId],
        },
        deps,
      );
      const mdIdx = destFiles.findIndex((f) => f.id === uploadedMd.id || f.name === uploadedMd.name);
      if (mdIdx >= 0) destFiles[mdIdx] = uploadedMd;
      else destFiles.push(uploadedMd);

      if (needsSyncSidecar(note)) {
        const sidecarName = sanitizeSidecarFileName(note.title);
        const existingSidecar = destFiles.find((f) => f.name === sidecarName) ?? null;
        const uploadedSidecar = await createOrUpdateMultipartFile(
          {
            existingFile: existingSidecar,
            name: sidecarName,
            mimeType: 'application/json; charset=UTF-8',
            parentId: destFolderId,
            body: JSON.stringify(buildSidecarPayload(note)),
            allowedParents: [destFolderId],
          },
          deps,
        );
        const scIdx = destFiles.findIndex((f) => f.id === uploadedSidecar.id || f.name === uploadedSidecar.name);
        if (scIdx >= 0) destFiles[scIdx] = uploadedSidecar;
        else destFiles.push(uploadedSidecar);
      }

      await db.notes.update(note.id, {
        driveFileId: uploadedMd.id,
        lastSyncedAt: now,
        syncDirty: false,
        remoteModifiedTime: uploadedMd.modifiedTime ?? null,
      });
      uploadedCount++;
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
      downloadedCount: 0,
      conflictCount: 0,
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
        downloadedCount: 0,
        conflictCount: 0,
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

    const msg = (err as Error)?.message || '선택 문서 Google Drive 업로드 중 오류가 발생했습니다.';
    settings.setDriveSyncConfig({
      syncStatus: 'error',
      lastError: msg,
    });
    return {
      status: 'error',
      uploadedCount,
      downloadedCount: 0,
      conflictCount: 0,
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

