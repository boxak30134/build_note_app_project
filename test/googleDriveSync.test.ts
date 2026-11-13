// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  assertMinimalDriveScope,
  assertWithinTargetFolder,
  buildScopedDriveQuery,
  DRIVE_FILE_SCOPE,
  SecurityBoundaryError,
} from '../src/modules/sync/driveFolderGuard';
import {
  authenticateGoogleDrive,
  buildGoogleOAuthUrl,
  disconnectGoogleDrive,
  resolveGoogleClientId,
} from '../src/modules/sync/googleDriveAuth';
import * as googleFolderPickerMod from '../src/modules/sync/googleFolderPicker';
import { DriveSyncSettingsSection } from '../src/components/settings/DriveSyncSettingsSection';
import {
  deleteScopedDriveFile,
  listScopedFiles,
  readScopedDriveFileText,
  runDriveSync,
} from '../src/modules/sync/driveSyncEngine';
import { db, emptyNote, type NoteRecord } from '../src/storage/db';
import * as opfsMod from '../src/storage/opfs';
import * as secureStoreMod from '../src/storage/secureStore';
import { DEFAULT_DRIVE_SYNC_CONFIG, useSettings } from '../src/store/settingsStore';

describe('REQ_google_drive_sync: Google Drive 지정 폴더 격리 동기화', () => {
  const TARGET_FOLDER_ID = 'folder_approved_123';
  const IMAGES_FOLDER_ID = 'folder_images_456';
  const FOREIGN_FOLDER_ID = 'folder_forbidden_999';

  let noteStore: Map<string, NoteRecord>;

  beforeEach(() => {
    vi.restoreAllMocks();
    noteStore = new Map<string, NoteRecord>();

    useSettings.setState({
      driveSyncConfig: {
        ...DEFAULT_DRIVE_SYNC_CONFIG,
        enabled: true,
        targetFolderId: TARGET_FOLDER_ID,
        targetFolderName: 'EduInk Sync',
        targetImagesFolderId: IMAGES_FOLDER_ID,
        clientId: 'test-client-id.apps.googleusercontent.com',
      },
    });

    vi.spyOn(db.notes, 'toArray').mockImplementation(async () => Array.from(noteStore.values()));
    vi.spyOn(db.notes, 'get').mockImplementation(async (id: string) => noteStore.get(id));
    vi.spyOn(db.notes, 'put').mockImplementation(async (rec: NoteRecord) => {
      noteStore.set(rec.id, rec);
      return rec.id;
    });
    vi.spyOn(db.notes, 'update').mockImplementation(async (id: string, changes: Partial<NoteRecord>) => {
      const existing = noteStore.get(id);
      if (!existing) return 0;
      noteStore.set(id, { ...existing, ...changes });
      return 1;
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
    delete (window as unknown as Record<string, unknown>).google;
    vi.restoreAllMocks();
  });

  it('1. OAuth 스코프 제한 검증: drive.file만 포함되고 상위 권한(drive, drive.readonly)은 차단된다', () => {
    const authUrl = buildGoogleOAuthUrl({
      clientId: 'my-client-id.apps.googleusercontent.com',
      redirectUri: 'https://eduink.local/oauth/callback',
    });

    const parsed = new URL(authUrl);
    const scope = parsed.searchParams.get('scope') ?? '';
    const scopes = scope.split(/\s+/);

    expect(scopes).toContain(DRIVE_FILE_SCOPE);
    expect(scopes).not.toContain('https://www.googleapis.com/auth/drive');
    expect(scopes).not.toContain('https://www.googleapis.com/auth/drive.readonly');

    // 상위 스코프 유입 시 즉시 SecurityBoundaryError 발생 검증
    expect(() =>
      assertMinimalDriveScope('https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive'),
    ).toThrow(SecurityBoundaryError);
    expect(() =>
      assertMinimalDriveScope('https://www.googleapis.com/auth/drive.readonly'),
    ).toThrow(SecurityBoundaryError);
  });

  it('2. 지정 폴더 경계 이탈 차단(SecurityBoundaryError): 타 폴더 파일 읽기·삭제 시 API 요청 전 차단된다', async () => {
    const fetchSpy = vi.fn();

    const foreignFile = {
      id: 'foreign_file_1',
      name: 'secret.md',
      parents: [FOREIGN_FOLDER_ID],
    };

    expect(() => assertWithinTargetFolder(foreignFile, [TARGET_FOLDER_ID])).toThrow(
      SecurityBoundaryError,
    );

    await expect(
      readScopedDriveFileText(foreignFile, [TARGET_FOLDER_ID], {
        fetchImpl: fetchSpy as unknown as typeof fetch,
        getToken: async () => 'valid-token',
      }),
    ).rejects.toThrow(SecurityBoundaryError);

    await expect(
      deleteScopedDriveFile(foreignFile, [TARGET_FOLDER_ID], {
        fetchImpl: fetchSpy as unknown as typeof fetch,
        getToken: async () => 'valid-token',
      }),
    ).rejects.toThrow(SecurityBoundaryError);

    // API 호출 자체가 전혀 발생하지 않았음을 보장
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("3. 쿼리 격리 검증: 파일 목록 조회 시 '<targetFolderId>' in parents and trashed = false 조건이 강제된다", async () => {
    const q = buildScopedDriveQuery(TARGET_FOLDER_ID);
    expect(q).toBe(`'${TARGET_FOLDER_ID}' in parents and trashed = false`);

    let capturedUrl = '';
    const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
      capturedUrl = String(input);
      return new Response(
        JSON.stringify({
          files: [
            {
              id: 'file_1',
              name: 'note1.md',
              parents: [TARGET_FOLDER_ID],
              trashed: false,
            },
          ],
        }),
        { status: 200 },
      );
    });

    const files = await listScopedFiles(TARGET_FOLDER_ID, undefined, {
      fetchImpl: mockFetch as unknown as typeof fetch,
      getToken: async () => 'valid-token',
    });

    const urlObj = new URL(capturedUrl);
    expect(urlObj.searchParams.get('q')).toContain(`'${TARGET_FOLDER_ID}' in parents`);
    expect(urlObj.searchParams.get('q')).toContain('trashed = false');
    expect(files).toHaveLength(1);
  });

  it('4. 증분 업로드/다운로드 무결성: 로컬 노트와 images/*.png 첨부 파일 업로드 및 원격 신규 노트 로컬 반영', async () => {
    const localNote = emptyNote({
      id: 'local_note_1',
      title: '로컬 노트',
      markdown: '# 로컬 노트\n![img](images/20261113-120000-1.png)',
      syncDirty: true,
    });
    noteStore.set(localNote.id, localNote);

    vi.spyOn(opfsMod, 'listNoteImages').mockResolvedValue([
      {
        relPath: 'images/20261113-120000-1.png',
        name: '20261113-120000-1.png',
        blob: new Blob(['fake-png-bytes'], { type: 'image/png' }),
      },
    ]);
    vi.spyOn(opfsMod, 'writeAttachment').mockResolvedValue(undefined);

    const uploadedTargets: string[] = [];

    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      // 1) 지정 폴더 존재 확인
      if (url.includes(`/files/${TARGET_FOLDER_ID}?`)) {
        return new Response(
          JSON.stringify({ id: TARGET_FOLDER_ID, name: 'EduInk Sync', trashed: false }),
          { status: 200 },
        );
      }

      const parsedUrl = new URL(url);
      const qParam = parsedUrl.searchParams.get('q') ?? '';

      // 2) 지정 폴더 목록 조회 -> 원격 신규 노트 1개 반환
      if (parsedUrl.pathname.endsWith('/files') && qParam.includes(`'${TARGET_FOLDER_ID}' in parents`)) {
        return new Response(
          JSON.stringify({
            files: [
              {
                id: 'remote_new_1',
                name: '원격 신규 노트.md',
                mimeType: 'text/markdown',
                modifiedTime: '2026-11-13T08:00:00.000Z',
                parents: [TARGET_FOLDER_ID],
                trashed: false,
              },
            ],
          }),
          { status: 200 },
        );
      }

      // 3) images 서브폴더 목록 조회
      if (parsedUrl.pathname.endsWith('/files') && qParam.includes(`'${IMAGES_FOLDER_ID}' in parents`)) {
        return new Response(JSON.stringify({ files: [] }), { status: 200 });
      }

      // 4) 원격 신규 노트 본문 다운로드
      if (url.includes('/files/remote_new_1?alt=media')) {
        return new Response('# 원격에서 온 노트\n내용입니다.', { status: 200 });
      }

      // 5) multipart 업로드 (이미지 + 로컬 노트)
      if (url.includes('/upload/drive/v3/files') && method === 'POST') {
        uploadedTargets.push(url);
        const isImage = uploadedTargets.length === 1;
        return new Response(
          JSON.stringify({
            id: isImage ? 'drive_img_1' : 'drive_note_1',
            name: isImage ? '20261113-120000-1.png' : '로컬 노트.md',
            modifiedTime: '2026-11-13T08:05:00.000Z',
            parents: [isImage ? IMAGES_FOLDER_ID : TARGET_FOLDER_ID],
          }),
          { status: 200 },
        );
      }

      return new Response('{}', { status: 404 });
    });

    const result = await runDriveSync({
      fetchImpl: mockFetch as unknown as typeof fetch,
      getToken: async () => 'valid-token',
    });

    expect(result.status).toBe('synced');
    expect(result.uploadedCount).toBe(1);
    expect(result.uploadedImagesCount).toBe(1);
    expect(result.downloadedCount).toBe(1);

    // 로컬 DB에 원격 신규 노트가 추가되었는지 검증
    const downloaded = Array.from(noteStore.values()).find((n) => n.title === '원격 신규 노트');
    expect(downloaded).toBeDefined();
    expect(downloaded?.markdown).toContain('# 원격에서 온 노트');
    expect(downloaded?.driveFileId).toBe('remote_new_1');

    // 로컬 노트도 업로드 후 driveFileId 기록 및 syncDirty 해제 검증
    const syncedLocal = noteStore.get(localNote.id);
    expect(syncedLocal?.driveFileId).toBe('drive_note_1');
    expect(syncedLocal?.syncDirty).toBe(false);
  });

  it('5. 양방향 동시 수정 충돌 분기: 로컬·원격 모두 수정된 경우 덮어쓰지 않고 (충돌 사본) 파일을 생성한다', async () => {
    const baseSyncTime = Date.parse('2026-11-13T07:00:00.000Z');
    const conflictingNote = emptyNote({
      id: 'conflict_note_1',
      title: '연구 메모',
      markdown: '# 연구 메모\n로컬에서 수정한 문장',
      driveFileId: 'drive_conflict_1',
      lastSyncedAt: baseSyncTime,
      remoteModifiedTime: '2026-11-13T07:00:00.000Z',
      syncDirty: true,
      updatedAt: baseSyncTime + 60_000,
    });
    noteStore.set(conflictingNote.id, conflictingNote);

    vi.spyOn(opfsMod, 'listNoteImages').mockResolvedValue([]);

    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url.includes(`/files/${TARGET_FOLDER_ID}?`)) {
        return new Response(
          JSON.stringify({ id: TARGET_FOLDER_ID, name: 'EduInk Sync', trashed: false }),
          { status: 200 },
        );
      }

      const parsedUrl = new URL(url);
      const qParam = parsedUrl.searchParams.get('q') ?? '';

      if (parsedUrl.pathname.endsWith('/files') && qParam.includes(`'${TARGET_FOLDER_ID}' in parents`)) {
        return new Response(
          JSON.stringify({
            files: [
              {
                id: 'drive_conflict_1',
                name: '연구 메모.md',
                mimeType: 'text/markdown',
                modifiedTime: '2026-11-13T07:30:00.000Z', // 마지막 동기화 이후 원격도 수정됨
                parents: [TARGET_FOLDER_ID],
                trashed: false,
              },
            ],
          }),
          { status: 200 },
        );
      }

      if (parsedUrl.pathname.endsWith('/files') && qParam.includes(`'${IMAGES_FOLDER_ID}' in parents`)) {
        return new Response(JSON.stringify({ files: [] }), { status: 200 });
      }

      if (url.includes('/upload/drive/v3/files') && method === 'POST') {
        return new Response(
          JSON.stringify({
            id: 'drive_conflict_copy_1',
            name: '연구 메모 (충돌 사본 20261113-1720).md',
            modifiedTime: '2026-11-13T08:00:00.000Z',
            parents: [TARGET_FOLDER_ID],
          }),
          { status: 200 },
        );
      }

      if (url.includes('/files/drive_conflict_1?alt=media')) {
        return new Response('# 연구 메모\n원격에서 수정한 문장', { status: 200 });
      }

      return new Response('{}', { status: 404 });
    });

    const result = await runDriveSync({
      fetchImpl: mockFetch as unknown as typeof fetch,
      getToken: async () => 'valid-token',
    });

    expect(result.status).toBe('synced');
    expect(result.conflictCount).toBe(1);

    const allNotes = Array.from(noteStore.values());
    const conflictBranch = allNotes.find((n) => n.title.includes('충돌 사본'));
    expect(conflictBranch).toBeDefined();
    expect(conflictBranch?.markdown).toContain('로컬에서 수정한 문장');

    // 기존 노트는 원격 최신본이 안전하게 반영됨
    expect(noteStore.get(conflictingNote.id)?.markdown).toContain('원격에서 수정한 문장');
  });

  it('6. 지정 폴더 삭제 감지 및 안전 중단: 폴더 404/trashed 시 루트에 새 폴더를 만들지 않고 SYNC_FOLDER_MISSING 전환', async () => {
    const postCalls: string[] = [];

    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST') postCalls.push(url);

      if (url.includes(`/files/${TARGET_FOLDER_ID}?`)) {
        return new Response(
          JSON.stringify({ id: TARGET_FOLDER_ID, name: 'EduInk Sync', trashed: true }),
          { status: 200 },
        );
      }
      return new Response('{}', { status: 404 });
    });

    const result = await runDriveSync({
      fetchImpl: mockFetch as unknown as typeof fetch,
      getToken: async () => 'valid-token',
    });

    expect(result.status).toBe('SYNC_FOLDER_MISSING');
    expect(useSettings.getState().driveSyncConfig.syncStatus).toBe('SYNC_FOLDER_MISSING');
    // 루트 드라이브에 새 폴더 생성 시도(POST)가 전혀 없었음을 보장
    expect(postCalls).toHaveLength(0);
  });

  it('7. 연동 해제(disconnectGoogleDrive) 시 로컬 토큰은 파기되지만 로컬 노트 데이터는 그대로 보존된다', async () => {
    const removeSpy = vi.spyOn(secureStoreMod, 'removeDriveToken').mockResolvedValue(undefined);
    const localNote = emptyNote({ id: 'keep_me', title: '보존될 로컬 노트' });
    noteStore.set(localNote.id, localNote);

    await disconnectGoogleDrive();

    expect(removeSpy).toHaveBeenCalledTimes(1);
    expect(useSettings.getState().driveSyncConfig.enabled).toBe(false);
    expect(useSettings.getState().driveSyncConfig.targetFolderId).toBeNull();
    expect(useSettings.getState().driveSyncConfig.accountName).toBeNull();
    expect(noteStore.get('keep_me')).toBeDefined();
  });

  it('8. (v2) VITE_GOOGLE_CLIENT_ID 기본 해석 및 미연결 UI 단순화(고급 Client ID 접이식 숨김)', async () => {
    vi.stubEnv('VITE_GOOGLE_CLIENT_ID', 'builtin-env-client.apps.googleusercontent.com');
    useSettings.setState({
      driveSyncConfig: {
        ...DEFAULT_DRIVE_SYNC_CONFIG,
        clientId: '',
      },
    });
    vi.spyOn(secureStoreMod, 'loadDriveToken').mockResolvedValue(null);

    expect(resolveGoogleClientId()).toBe('builtin-env-client.apps.googleusercontent.com');

    render(createElement(DriveSyncSettingsSection));

    // 기본 화면에 원클릭 연결 버튼만 노출되고, Client ID 입력 필드는 접힌 <details> 내부에 존재
    const connectBtn = await screen.findByTestId('drive-connect-btn');
    expect(connectBtn.textContent).toContain('Google 계정으로 드라이브 연결');
    expect(screen.queryByTestId('drive-pick-folder-btn')).toBeNull();
    expect(screen.queryByTestId('drive-manual-sync-btn')).toBeNull();

    const details = screen.getByTestId('drive-advanced-settings') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.contains(screen.getByTestId('drive-client-id-input'))).toBe(true);
  });

  it('9. (v2) GIS 기존 세션/login_hint 인증 후 이름·이메일 저장 및 즉시 Picker 연결, 완료 UI 배지 표시', async () => {
    vi.stubEnv('VITE_GOOGLE_CLIENT_ID', 'builtin-env-client.apps.googleusercontent.com');
    useSettings.setState({
      driveSyncConfig: {
        ...DEFAULT_DRIVE_SYNC_CONFIG,
        clientId: '',
        accountEmail: 'saved@gmail.com',
      },
    });

    vi.spyOn(secureStoreMod, 'loadDriveToken').mockResolvedValue(null);
    const saveSpy = vi.spyOn(secureStoreMod, 'saveDriveToken').mockResolvedValue(undefined);

    const requestAccessTokenSpy = vi.fn();
    let capturedCallback: ((resp: { access_token?: string; expires_in?: number; scope?: string }) => Promise<void> | void) | null = null;
    let capturedHint: string | undefined;

    (window as unknown as Record<string, unknown>).google = {
      accounts: {
        oauth2: {
          initTokenClient: vi.fn((cfg: {
            hint?: string;
            callback: (resp: { access_token?: string; expires_in?: number; scope?: string }) => Promise<void> | void;
          }) => {
            capturedHint = cfg.hint;
            capturedCallback = cfg.callback;
            return {
              requestAccessToken: (reqOpts: Record<string, unknown>) => {
                requestAccessTokenSpy(reqOpts);
                void capturedCallback?.({
                  access_token: 'gis-access-token',
                  expires_in: 3600,
                  scope: DRIVE_FILE_SCOPE,
                });
              },
            };
          }),
        },
      },
    };

    const origFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).includes('oauth2/v2/userinfo')) {
        return new Response(
          JSON.stringify({ email: 'alice@gmail.com', name: '김알리스' }),
          { status: 200 },
        );
      }
      return origFetch(input);
    });

    const autoFolderSpy = vi
      .spyOn(googleFolderPickerMod, 'ensureOrCreateDefaultSyncFolder')
      .mockImplementation(async () => {
        useSettings.getState().setDriveSyncConfig({
          enabled: true,
          targetFolderId: 'picked_folder_777',
          targetFolderName: '내 연구 노트',
        });
        return { id: 'picked_folder_777', name: '내 연구 노트' };
      });

    render(createElement(DriveSyncSettingsSection));
    fireEvent.click(await screen.findByTestId('drive-connect-btn'));

    await waitFor(() => {
      expect(autoFolderSpy).toHaveBeenCalledTimes(1);
    });

    // 저장된 login_hint가 GIS 토큰 요청에 전달되고, 사용자 이름/이메일이 저장됨
    expect(capturedHint).toBe('saved@gmail.com');
    expect(requestAccessTokenSpy).toHaveBeenCalledWith(
      expect.objectContaining({ login_hint: 'saved@gmail.com' }),
    );
    expect(saveSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'alice@gmail.com',
        name: '김알리스',
      }),
    );

    // 연결 완료 상태 UI: 이름·이메일 배지 + 폴더명 + [폴더 변경] + [지금 동기화] + [연동 해제]
    const badge = await screen.findByTestId('drive-account-badge');
    expect(badge.textContent).toContain('김알리스 (alice@gmail.com)');
    expect(screen.getByTestId('drive-target-folder-name').textContent).toBe('내 연구 노트');
    expect(screen.getByTestId('drive-pick-folder-btn').textContent).toContain('폴더 변경');
    expect(screen.getByTestId('drive-manual-sync-btn').textContent).toContain('지금 동기화');
    expect(screen.getByTestId('drive-disconnect-btn').textContent).toContain('연동 해제');

    // authenticateGoogleDrive 직접 호출 시에도 login_hint가 없는 경우 select_account 사용 검증
    useSettings.setState({
      driveSyncConfig: { ...DEFAULT_DRIVE_SYNC_CONFIG, clientId: '' },
    });
    requestAccessTokenSpy.mockClear();
    await authenticateGoogleDrive();
    expect(requestAccessTokenSpy).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'select_account' }),
    );
  });

  it('10. (v3) API Key 없이 전용 폴더 자동 생성·재사용 및 [폴더 변경] 인앱 모달 선택 동작', async () => {
    vi.spyOn(secureStoreMod, 'loadDriveToken').mockResolvedValue({
      accessToken: 'valid-token',
      expiresAt: Date.now() + 3600_000,
      email: 'alice@gmail.com',
      name: '김알리스',
    });

    // ensureOrCreateDefaultSyncFolder: 기존 폴더 미존재 시 새 폴더 생성
    const createMockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/drive/v3/files?') && (!init?.method || init.method === 'GET')) {
        return new Response(JSON.stringify({ files: [] }), { status: 200 });
      }
      if (url.includes('/drive/v3/files?fields=id,name') && init?.method === 'POST') {
        return new Response(JSON.stringify({ id: 'auto_folder_1', name: 'EduInk Sync' }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });

    const autoCreated = await googleFolderPickerMod.ensureOrCreateDefaultSyncFolder(
      'EduInk Sync',
      'valid-token',
      createMockFetch as unknown as typeof fetch,
    );
    expect(autoCreated).toEqual({ id: 'auto_folder_1', name: 'EduInk Sync' });
    expect(useSettings.getState().driveSyncConfig.targetFolderId).toBe('auto_folder_1');

    // [폴더 변경] 클릭 시 인앱 모달이 열리고 접근 가능한 폴더 목록에서 선택 가능
    vi.spyOn(googleFolderPickerMod, 'listAppAccessibleFolders').mockResolvedValue([
      { id: 'auto_folder_1', name: 'EduInk Sync' },
      { id: 'custom_folder_2', name: '대학원 강의노트' },
    ]);

    render(createElement(DriveSyncSettingsSection));
    const changeBtn = await screen.findByTestId('drive-pick-folder-btn');
    fireEvent.click(changeBtn);

    const modal = await screen.findByTestId('drive-folder-picker-modal');
    expect(modal).toBeTruthy();

    const secondOption = await screen.findByTestId('drive-folder-option-custom_folder_2');
    fireEvent.click(secondOption);

    await waitFor(() => {
      expect(screen.queryByTestId('drive-folder-picker-modal')).toBeNull();
    });
    expect(useSettings.getState().driveSyncConfig.targetFolderId).toBe('custom_folder_2');
    expect(useSettings.getState().driveSyncConfig.targetFolderName).toBe('대학원 강의노트');
  });
});
