/**
 * Google Drive 지정 폴더 격리 및 최소 권한 가드
 * - drive / drive.readonly 스코프 사용을 원천 차단하고 drive.file 만 허용한다.
 * - 모든 조회·업로드·수정·삭제 전 대상 파일의 parents가 승인된 targetFolderId(또는 직계 images 폴더) 내부인지 검증한다.
 */

export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const DRIVE_USERINFO_SCOPE = 'https://www.googleapis.com/auth/userinfo.email';
export const DRIVE_PROFILE_SCOPE = 'https://www.googleapis.com/auth/userinfo.profile';

export const FORBIDDEN_DRIVE_SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.metadata',
  'https://www.googleapis.com/auth/drive.metadata.readonly',
] as const;

export class SecurityBoundaryError extends Error {
  readonly code = 'SECURITY_BOUNDARY_VIOLATION';
  readonly targetId?: string;
  readonly allowedParents?: string[];

  constructor(message: string, details?: { targetId?: string; allowedParents?: string[] }) {
    super(message);
    this.name = 'SecurityBoundaryError';
    this.targetId = details?.targetId;
    this.allowedParents = details?.allowedParents;
  }
}

function escapeDriveQueryLiteral(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * OAuth 요청/토큰 스코프가 최소 권한(drive.file)만 포함하는지 검증한다.
 * 상위 스코프(drive, drive.readonly 등)가 포함되면 즉시 SecurityBoundaryError를 발생시킨다.
 */
export function assertMinimalDriveScope(scopeText: string): string[] {
  const scopes = scopeText
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  for (const s of scopes) {
    if ((FORBIDDEN_DRIVE_SCOPES as readonly string[]).includes(s)) {
      throw new SecurityBoundaryError(
        `허용되지 않은 상위 Google Drive 권한 스코프가 감지되어 차단되었습니다: ${s}`,
      );
    }
  }

  if (!scopes.includes(DRIVE_FILE_SCOPE)) {
    throw new SecurityBoundaryError(
      `필수 최소 권한 스코프(${DRIVE_FILE_SCOPE})가 누락되었습니다.`,
    );
  }

  return scopes;
}

/**
 * 지정 폴더(folderId) 내부만 조회하는 Drive API `q` 파라미터를 생성한다.
 * `'<folderId>' in parents and trashed = false` 조건을 항상 강제한다.
 */
export function buildScopedDriveQuery(targetFolderId: string, extraConditions?: string): string {
  const cleanId = targetFolderId?.trim();
  if (!cleanId) {
    throw new SecurityBoundaryError('동기화 대상 폴더 ID(targetFolderId)가 지정되지 않았습니다.');
  }
  const base = `'${escapeDriveQueryLiteral(cleanId)}' in parents and trashed = false`;
  const extra = extraConditions?.trim();
  return extra ? `${base} and (${extra})` : base;
}

/**
 * 파일 메타데이터의 parents 배열이 승인된 대상 폴더 경계 내부인지 검증한다.
 * 경계를 벗어날 경우 API 호출 전에 즉시 SecurityBoundaryError를 발생시킨다.
 */
export function assertWithinTargetFolder(
  fileMeta: { id?: string; name?: string; parents?: string[] | null },
  allowedParentIds: string | string[],
): void {
  const allowed = (Array.isArray(allowedParentIds) ? allowedParentIds : [allowedParentIds])
    .map((id) => id?.trim())
    .filter((id): id is string => Boolean(id));

  if (allowed.length === 0) {
    throw new SecurityBoundaryError('승인된 동기화 폴더 ID가 비어 있어 작업을 차단합니다.');
  }

  const parents = fileMeta.parents ?? [];
  if (!Array.isArray(parents) || parents.length === 0) {
    throw new SecurityBoundaryError(
      `부모 폴더 정보(parents)가 없는 파일(${fileMeta.id ?? fileMeta.name ?? 'unknown'})에 대한 접근이 차단되었습니다.`,
      { targetId: fileMeta.id, allowedParents: allowed },
    );
  }

  const isInside = parents.some((p) => allowed.includes(p));
  if (!isInside) {
    throw new SecurityBoundaryError(
      `지정 동기화 폴더 경계를 벗어난 파일(${fileMeta.id ?? fileMeta.name ?? 'unknown'}) 접근이 차단되었습니다.`,
      { targetId: fileMeta.id, allowedParents: allowed },
    );
  }
}

/**
 * 하위 디렉토리 탐색은 직계 `images` 폴더까지만 허용하며 경로 탈출(`..`, 중첩 경로)을 차단한다.
 */
export function assertAllowedSubdir(subdir: string): '' | 'images' {
  const normalized = subdir.trim().replace(/^\/+|\/+$/g, '');
  if (normalized === '') return '';
  if (normalized === 'images') return 'images';
  throw new SecurityBoundaryError(
    `지정 폴더 직계의 'images/' 외 하위 디렉토리(${subdir}) 탐색은 허용되지 않습니다.`,
  );
}

