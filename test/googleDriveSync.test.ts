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
  DEFAULT_GOOGLE_CLIENT_ID,
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
  uploadSelectedNotesToDrive,
} from '../src/modules/sync/driveSyncEngine';
import { db, emptyNote, type FolderRecord, type NoteRecord } from '../src/storage/db';
import { NoteSession } from '../src/session/NoteSession';
import { markdownToJson } from '../src/editor/extensions';
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

    vi.spyOn(db.notes, 'toArray').mockImplementation((async () => Array.from(noteStore.values())) as any);
    vi.spyOn(db.notes, 'get').mockImplementation(((id: any) => Promise.resolve(typeof id === 'string' ? noteStore.get(id) : undefined)) as any);
    vi.spyOn(db.notes, 'put').mockImplementation((async (rec: NoteRecord) => {
      noteStore.set(rec.id, rec);
      return rec.id;
    }) as any);
    vi.spyOn(db.notes, 'update').mockImplementation((async (id: string, changes: Partial<NoteRecord>) => {
      const existing = noteStore.get(id);
      if (!existing) return 0;
      noteStore.set(id, { ...existing, ...changes });
      return 1;
    }) as any);
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
    const firstBlock = (downloaded?.content as { content?: Array<{ type?: string; attrs?: { level?: number } }> })?.content?.[0];
    expect(firstBlock?.type).toBe('heading');
    expect(firstBlock?.attrs?.level).toBe(1);

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

  it('8. (v2) 고정 기본 Client ID 해석 및 커스텀 입력창 제거(원클릭 연결 UI 단순화)', async () => {
    vi.unstubAllEnvs();
    useSettings.setState({
      driveSyncConfig: {
        ...DEFAULT_DRIVE_SYNC_CONFIG,
        clientId: '',
      },
    });
    vi.spyOn(secureStoreMod, 'loadDriveToken').mockResolvedValue(null);

    // 환경 변수 및 설정이 비어있어도 고정된 내장 Client ID가 반환됨
    expect(resolveGoogleClientId()).toBe(DEFAULT_GOOGLE_CLIENT_ID);
    expect(DEFAULT_GOOGLE_CLIENT_ID).toBe(
      '779568357105-1bv1t4br3tkgekksmu6enu1blhghvkps.apps.googleusercontent.com',
    );

    render(createElement(DriveSyncSettingsSection));

    // 기본 화면에 원클릭 연결 버튼만 노출되고, 커스텀 Client ID 입력 필드는 제거됨
    const connectBtn = await screen.findByTestId('drive-connect-btn');
    expect(connectBtn.textContent).toContain('Google 계정으로 드라이브 연결');
    expect(screen.queryByTestId('drive-pick-folder-btn')).toBeNull();
    expect(screen.queryByTestId('drive-manual-sync-btn')).toBeNull();

    const details = screen.getByTestId('drive-advanced-settings') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(screen.queryByTestId('drive-client-id-input')).toBeNull();
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

  it('11. Drive에서 BOM 포함 마크다운(.md)을 불러오거나 기존 plain 폴백 노트를 열어도 마크다운 문법으로 렌더링된다', async () => {
    const remoteMdWithBom = '\uFEFF# 연구 제목\n**핵심 강조**\n- 첫 번째 항목';
    const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const parsedUrl = new URL(url);
      const qParam = parsedUrl.searchParams.get('q') ?? '';
      if (parsedUrl.pathname.endsWith(`/files/${TARGET_FOLDER_ID}`)) {
        return new Response(
          JSON.stringify({ id: TARGET_FOLDER_ID, name: '내 연구 노트', trashed: false }),
          { status: 200 },
        );
      }
      if (parsedUrl.pathname.endsWith('/files') && qParam.includes(`'${TARGET_FOLDER_ID}' in parents`)) {
        return new Response(
          JSON.stringify({
            files: [
              {
                id: 'remote_md_bom_1',
                name: 'BOM 마크다운 노트.md',
                mimeType: 'text/markdown',
                modifiedTime: '2026-11-14T10:00:00.000Z',
                parents: [TARGET_FOLDER_ID],
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.includes('/files/remote_md_bom_1?alt=media')) {
        return new Response(remoteMdWithBom, { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });

    const result = await runDriveSync({
      fetchImpl: mockFetch as unknown as typeof fetch,
      getToken: async () => 'valid-token',
    });
    expect(result.status).toBe('synced');

    const downloaded = Array.from(noteStore.values()).find((n) => n.title === 'BOM 마크다운 노트');
    expect(downloaded).toBeDefined();

    const session1 = new NoteSession(downloaded!);
    const html1 = session1.editor.getHTML();
    expect(html1).toContain('<h1');
    expect(html1).toContain('<strong>핵심 강조</strong>');
    expect(html1).toContain('<ul');
    expect(html1).not.toContain('# 연구 제목');
    expect(session1.ui.dirty).toBe(false);
    session1.destroy();

    // 이전 버그로 이미 plain paragraph 로 저장되어 있던 Drive 노트도 처음 열 때 마크다운으로 복원됨
    const legacyFallbackNote = emptyNote({
      id: 'legacy_drive_plain_1',
      title: '구버전 동기화 노트',
      driveFileId: 'drive_legacy_1',
      markdown: '# 복원될 제목\n**굵은 글씨**',
      content: {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: '# 복원될 제목' }] },
          { type: 'paragraph', content: [{ type: 'text', text: '**굵은 글씨**' }] },
        ],
      },
    });
    const session2 = new NoteSession(legacyFallbackNote);
    const html2 = session2.editor.getHTML();
    expect(html2).toContain('<h1');
    expect(html2).toContain('<strong>굵은 글씨</strong>');
    expect(session2.ui.dirty).toBe(false);
    session2.destroy();
  });

  it('12. PDF 임포트 문서(inkTemplate + attachments/ 이미지 + 필기)는 Drive 왕복 동기화 후에도 빈 페이지나 깨진 이미지가 되지 않고 온전히 복원된다', async () => {
    // 1) InkTemplate 마크다운 왕복 파싱 자체가 일반 image 가 아닌 inkTemplate 노드를 생성하는지 검증
    const parsedFromMd = markdownToJson('![손글씨 페이지 1](attachments/lecture-p1.jpg)') as {
      content?: Array<{ type?: string; attrs?: Record<string, unknown> }>;
    };
    expect(parsedFromMd.content?.[0]?.type).toBe('inkTemplate');
    expect(parsedFromMd.content?.[0]?.attrs?.src).toBe('attachments/lecture-p1.jpg');

    // 2) PDF 임포트 노트 업로드 시나리오
    const pdfDoc = {
      type: 'doc',
      content: [
        {
          type: 'inkTemplate',
          attrs: { src: 'attachments/lecture-p1.jpg', width: 595, height: 842, page: 1, pageId: 'p1', style: 'plain' },
        },
      ],
    };
    const pdfNote = emptyNote({
      id: 'pdf_note_src',
      title: '선형대수 강의안',
      content: pdfDoc,
      markdown: '![손글씨 페이지 1](attachments/lecture-p1.jpg)',
      pages: [{ id: 'p1', index: 0, size: 'A4', style: 'plain', orientation: 'portrait' }],
      strokes: [
        {
          id: 'stroke_pdf_1',
          pageIndex: 0,
          tool: 'pen',
          color: '#000000',
          size: 2,
          points: [{ x: 10, y: 20, pressure: 0.5 }, { x: 40, y: 60, pressure: 0.6 }],
        },
      ],
      syncDirty: true,
    });
    noteStore.set(pdfNote.id, pdfNote);

    vi.spyOn(opfsMod, 'listNoteImages').mockResolvedValue([]);
    vi.spyOn(opfsMod, 'listNoteAttachments').mockResolvedValue([
      {
        relPath: 'attachments/lecture-p1.jpg',
        name: 'lecture-p1.jpg',
        blob: new Blob(['fake-pdf-jpeg'], { type: 'image/jpeg' }),
      },
    ]);
    const writtenAttachments: Array<{ noteId: string; relPath: string }> = [];
    vi.spyOn(opfsMod, 'writeAttachment').mockImplementation(async (noteId, relPath) => {
      writtenAttachments.push({ noteId, relPath });
    });

    const driveRootFiles: Array<{ id: string; name: string; mimeType: string; body: string | Blob }> = [];
    const driveImagesFiles: Array<{ id: string; name: string; mimeType: string; body: string | Blob }> = [];
    let nextDriveId = 1;

    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const parsedUrl = new URL(url);
      const qParam = parsedUrl.searchParams.get('q') ?? '';

      if (parsedUrl.pathname.endsWith(`/files/${TARGET_FOLDER_ID}`)) {
        return new Response(JSON.stringify({ id: TARGET_FOLDER_ID, name: 'EduInk Sync', trashed: false }), { status: 200 });
      }
      if (parsedUrl.pathname.endsWith('/files') && qParam.includes(`name = 'images'`)) {
        return new Response(
          JSON.stringify({
            files: [{ id: IMAGES_FOLDER_ID, name: 'images', mimeType: 'application/vnd.google-apps.folder', parents: [TARGET_FOLDER_ID] }],
          }),
          { status: 200 },
        );
      }
      if (parsedUrl.pathname.endsWith('/files') && qParam.includes(`'${TARGET_FOLDER_ID}' in parents`)) {
        return new Response(
          JSON.stringify({
            files: driveRootFiles.map((f) => ({
              id: f.id,
              name: f.name,
              mimeType: f.mimeType,
              modifiedTime: '2026-11-14T12:00:00.000Z',
              parents: [TARGET_FOLDER_ID],
            })),
          }),
          { status: 200 },
        );
      }
      if (parsedUrl.pathname.endsWith('/files') && qParam.includes(`'${IMAGES_FOLDER_ID}' in parents`)) {
        return new Response(
          JSON.stringify({
            files: driveImagesFiles.map((f) => ({
              id: f.id,
              name: f.name,
              mimeType: f.mimeType,
              modifiedTime: '2026-11-14T12:00:00.000Z',
              parents: [IMAGES_FOLDER_ID],
            })),
          }),
          { status: 200 },
        );
      }
      if (url.includes('/upload/drive/v3/files') && method === 'POST') {
        const rawText = await (init?.body as Blob).text();
        const nameMatch = rawText.match(/"name":"([^"]+)"/);
        const fileName = nameMatch ? nameMatch[1] : `file_${nextDriveId}`;
        const mimeMatch = rawText.match(/"mimeType":"([^"]+)"/);
        const mimeType = mimeMatch ? mimeMatch[1] : 'application/octet-stream';
        const parts = rawText.split(/\r?\n\r?\n/);
        const contentPart = parts.slice(2).join('\r\n\r\n').replace(/\r\n--eduink_sync_[^\r\n]+--\s*$/, '');
        const id = `drv_${nextDriveId++}`;
        if (rawText.includes(IMAGES_FOLDER_ID)) {
          driveImagesFiles.push({ id, name: fileName, mimeType, body: contentPart });
          return new Response(JSON.stringify({ id, name: fileName, parents: [IMAGES_FOLDER_ID], modifiedTime: '2026-11-14T12:00:00.000Z' }), { status: 200 });
        }
        driveRootFiles.push({ id, name: fileName, mimeType, body: contentPart });
        return new Response(JSON.stringify({ id, name: fileName, parents: [TARGET_FOLDER_ID], modifiedTime: '2026-11-14T12:00:00.000Z' }), { status: 200 });
      }
      if (url.includes('?alt=media')) {
        const fileId = decodeURIComponent(parsedUrl.pathname.split('/').pop() ?? '');
        const found = [...driveRootFiles, ...driveImagesFiles].find((f) => f.id === fileId);
        if (found) return new Response(found.body, { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });

    const uploadRes = await runDriveSync({ fetchImpl: mockFetch as unknown as typeof fetch, getToken: async () => 'valid-token' });
    expect(uploadRes.status).toBe('synced');
    expect(uploadRes.uploadedCount).toBe(1);
    expect(uploadRes.uploadedImagesCount).toBe(1);
    expect(driveRootFiles.some((f) => f.name === '선형대수 강의안.eduink.json')).toBe(true);
    expect(driveImagesFiles.some((f) => f.name === 'att__lecture-p1.jpg')).toBe(true);

    // 3) 다른 기기(빈 로컬 DB + targetImagesFolderId: null)에서 다운로드 동기화
    noteStore.clear();
    useSettings.getState().setDriveSyncConfig({ targetImagesFolderId: null });

    const downloadRes = await runDriveSync({ fetchImpl: mockFetch as unknown as typeof fetch, getToken: async () => 'valid-token' });
    expect(downloadRes.status).toBe('synced');
    expect(downloadRes.downloadedCount).toBe(1);

    const restored = Array.from(noteStore.values());
    expect(restored).toHaveLength(1);
    expect(restored[0].title).toBe('선형대수 강의안');
    expect((restored[0].content as { content?: Array<{ type?: string }> }).content?.[0]?.type).toBe('inkTemplate');
    expect(restored[0].strokes).toHaveLength(1);
    expect(writtenAttachments).toEqual([{ noteId: restored[0].id, relPath: 'attachments/lecture-p1.jpg' }]);
  });

  it('13. 텍스트 없이 손글씨(strokes)로만 이루어진 노트(markdown: "")도 동기화 후 빈 페이지가 아닌 필기 상태로 복원된다', async () => {
    const handwritingNote = emptyNote({
      id: 'handwriting_only_1',
      title: '손글씨 전용 메모',
      markdown: '',
      pages: [{ id: 'hw_p1', index: 0, size: 'A4', style: 'grid', orientation: 'portrait' }],
      strokes: [
        {
          id: 'hw_s1',
          pageIndex: 0,
          tool: 'pen',
          color: '#EF4444',
          size: 3,
          points: [{ x: 50, y: 80, pressure: 0.7 }, { x: 120, y: 140, pressure: 0.8 }],
        },
      ],
      syncDirty: true,
    });
    noteStore.set(handwritingNote.id, handwritingNote);

    vi.spyOn(opfsMod, 'listNoteImages').mockResolvedValue([]);
    vi.spyOn(opfsMod, 'listNoteAttachments').mockResolvedValue([]);

    const driveRootFiles: Array<{ id: string; name: string; mimeType: string; body: string }> = [];
    let nextId = 1;

    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const parsedUrl = new URL(url);
      const qParam = parsedUrl.searchParams.get('q') ?? '';

      if (parsedUrl.pathname.endsWith(`/files/${TARGET_FOLDER_ID}`)) {
        return new Response(JSON.stringify({ id: TARGET_FOLDER_ID, name: 'EduInk Sync', trashed: false }), { status: 200 });
      }
      if (parsedUrl.pathname.endsWith('/files') && qParam.includes(`'${TARGET_FOLDER_ID}' in parents`)) {
        return new Response(
          JSON.stringify({
            files: driveRootFiles.map((f) => ({
              id: f.id,
              name: f.name,
              mimeType: f.mimeType,
              modifiedTime: '2026-11-14T12:10:00.000Z',
              parents: [TARGET_FOLDER_ID],
            })),
          }),
          { status: 200 },
        );
      }
      if (url.includes('/upload/drive/v3/files') && method === 'POST') {
        const rawText = await (init?.body as Blob).text();
        const nameMatch = rawText.match(/"name":"([^"]+)"/);
        const fileName = nameMatch ? nameMatch[1] : `file_${nextId}`;
        const mimeMatch = rawText.match(/"mimeType":"([^"]+)"/);
        const mimeType = mimeMatch ? mimeMatch[1] : 'text/plain';
        const parts = rawText.split(/\r?\n\r?\n/);
        const contentPart = parts.slice(2).join('\r\n\r\n').replace(/\r\n--eduink_sync_[^\r\n]+--\s*$/, '');
        const id = `hw_drv_${nextId++}`;
        driveRootFiles.push({ id, name: fileName, mimeType, body: contentPart });
        return new Response(JSON.stringify({ id, name: fileName, parents: [TARGET_FOLDER_ID], modifiedTime: '2026-11-14T12:10:00.000Z' }), { status: 200 });
      }
      if (url.includes('?alt=media')) {
        const fileId = decodeURIComponent(parsedUrl.pathname.split('/').pop() ?? '');
        const found = driveRootFiles.find((f) => f.id === fileId);
        if (found) return new Response(found.body, { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });

    await runDriveSync({ fetchImpl: mockFetch as unknown as typeof fetch, getToken: async () => 'valid-token' });
    expect(driveRootFiles.some((f) => f.name === '손글씨 전용 메모.eduink.json')).toBe(true);

    noteStore.clear();
    const downRes = await runDriveSync({ fetchImpl: mockFetch as unknown as typeof fetch, getToken: async () => 'valid-token' });
    expect(downRes.status).toBe('synced');
    expect(downRes.downloadedCount).toBe(1);

    const restored = Array.from(noteStore.values());
    expect(restored).toHaveLength(1);
    expect(restored[0].strokes).toHaveLength(1);
    expect(restored[0].strokes[0].id).toBe('hw_s1');
    expect(restored[0].pages[0].style).toBe('grid');
  });

  it('14. uploadSelectedNotesToDrive: 선택 문서를 로컬 폴더 경로(대학원/선형대수)와 동일한 Drive 하위 경로에 저장한다', async () => {
    const folderRows: FolderRecord[] = [
      { id: 'fld_root_1', name: '대학원', parentId: null, createdAt: 1000 },
      { id: 'fld_sub_1', name: '선형대수', parentId: 'fld_root_1', createdAt: 1100 },
    ];
    vi.spyOn(db.folders, 'toArray').mockResolvedValue(folderRows);

    const nestedNote1 = emptyNote({
      id: 'nested_note_1',
      title: '고유값 정리',
      folderId: 'fld_sub_1',
      markdown: '# 고유값 정리\n$Ax = \\lambda x$',
      syncDirty: true,
    });
    const nestedNote2 = emptyNote({
      id: 'nested_note_2',
      title: '특이값 분해',
      folderId: 'fld_sub_1',
      markdown: '# SVD',
      syncDirty: true,
    });
    const rootNote = emptyNote({
      id: 'root_note_1',
      title: '루트 메모',
      folderId: null,
      markdown: '루트 내용',
      syncDirty: true,
    });
    noteStore.set(nestedNote1.id, nestedNote1);
    noteStore.set(nestedNote2.id, nestedNote2);
    noteStore.set(rootNote.id, rootNote);

    vi.spyOn(opfsMod, 'listNoteImages').mockResolvedValue([]);
    vi.spyOn(opfsMod, 'listNoteAttachments').mockResolvedValue([]);

    const createdFolders: Array<{ id: string; name: string; parents: string[] }> = [];
    const uploadedFiles: Array<{ id: string; name: string; parents: string[]; body: string }> = [];
    let seq = 1;

    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const parsedUrl = new URL(url);
      const qParam = parsedUrl.searchParams.get('q') ?? '';

      if (parsedUrl.pathname.endsWith(`/files/${TARGET_FOLDER_ID}`)) {
        return new Response(JSON.stringify({ id: TARGET_FOLDER_ID, name: 'EduInk Sync', trashed: false }), { status: 200 });
      }
      if (parsedUrl.pathname.endsWith('/files') && method === 'GET') {
        const parentMatch = qParam.match(/'([^']+)' in parents/);
        const parentId = parentMatch?.[1] ?? '';
        if (qParam.includes('mimeType = ')) {
          const nameMatch = qParam.match(/name = '([^']+)'/);
          const name = nameMatch?.[1] ?? '';
          const matched = createdFolders.filter((f) => f.parents.includes(parentId) && f.name === name);
          return new Response(JSON.stringify({ files: matched }), { status: 200 });
        }
        const filesInParent = uploadedFiles.filter((f) => f.parents.includes(parentId));
        return new Response(JSON.stringify({ files: filesInParent }), { status: 200 });
      }
      if (!url.includes('/upload/') && parsedUrl.pathname.endsWith('/files') && method === 'POST') {
        const payload = JSON.parse(String(init?.body ?? '{}')) as { name: string; parents: string[] };
        const id = `drv_fld_${seq++}`;
        const folderMeta = { id, name: payload.name, parents: payload.parents };
        createdFolders.push(folderMeta);
        return new Response(JSON.stringify(folderMeta), { status: 200 });
      }
      if (url.includes('/upload/drive/v3/files') && method === 'POST') {
        const rawText = await (init?.body as Blob).text();
        const nameMatch = rawText.match(/"name":"([^"]+)"/);
        const parentsMatch = rawText.match(/"parents":\["([^"]+)"\]/);
        const fileName = nameMatch?.[1] ?? `file_${seq}`;
        const parentId = parentsMatch?.[1] ?? '';
        const parts = rawText.split(/\r?\n\r?\n/);
        const contentPart = parts.slice(2).join('\r\n\r\n').replace(/\r\n--eduink_sync_[^\r\n]+--\s*$/, '');
        const id = `drv_file_${seq++}`;
        const meta = { id, name: fileName, parents: [parentId], body: contentPart, modifiedTime: '2026-11-14T13:00:00.000Z' };
        uploadedFiles.push(meta);
        return new Response(JSON.stringify(meta), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });

    const res = await uploadSelectedNotesToDrive(['nested_note_1', 'nested_note_2', 'root_note_1'], {
      fetchImpl: mockFetch as unknown as typeof fetch,
      getToken: async () => 'valid-token',
    });

    expect(res.status).toBe('synced');
    expect(res.uploadedCount).toBe(3);

    // 대학원 -> 선형대수 폴더가 중복 없이 정확히 1회씩 생성되었는지 확인
    expect(createdFolders).toHaveLength(2);
    const gradFolder = createdFolders.find((f) => f.name === '대학원');
    const mathFolder = createdFolders.find((f) => f.name === '선형대수');
    expect(gradFolder?.parents).toEqual([TARGET_FOLDER_ID]);
    expect(mathFolder?.parents).toEqual([gradFolder!.id]);

    // 각 파일이 올바른 Drive 부모 폴더 아래 저장되었는지 검증
    const f1 = uploadedFiles.find((f) => f.name === '고유값 정리.md');
    const f2 = uploadedFiles.find((f) => f.name === '특이값 분해.md');
    const f3 = uploadedFiles.find((f) => f.name === '루트 메모.md');
    expect(f1?.parents).toEqual([mathFolder!.id]);
    expect(f2?.parents).toEqual([mathFolder!.id]);
    expect(f3?.parents).toEqual([TARGET_FOLDER_ID]);

    expect(noteStore.get('nested_note_1')?.syncDirty).toBe(false);
    expect(noteStore.get('nested_note_1')?.driveFileId).toBe(f1?.id);
  });

  it('15. runDriveSync 시 루트뿐 아니라 하위 폴더를 재귀 탐색하여 내려받고 로컬 하위 폴더 노트도 경로를 유지해 업로드한다', async () => {
    const folderStore = new Map<string, FolderRecord>([
      ['local_fld_1', { id: 'local_fld_1', name: '로컬폴더', parentId: null, createdAt: 1000, deletedAt: null }],
    ]);
    vi.spyOn(db.folders, 'toArray').mockImplementation(async () => Array.from(folderStore.values()));
    vi.spyOn(db.folders, 'put').mockImplementation(async (f: FolderRecord) => {
      folderStore.set(f.id, f);
      return f.id;
    });

    const localSubNote = emptyNote({
      id: 'local_sub_note',
      title: '로컬 하위 노트',
      folderId: 'local_fld_1',
      markdown: '# Local Sub Note',
      content: { type: 'doc', content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Local Sub Note' }] }] },
      plainText: 'Local Sub Note',
      syncDirty: true,
      updatedAt: 5000,
    });
    noteStore.set(localSubNote.id, localSubNote);

    vi.spyOn(opfsMod, 'listNoteImages').mockResolvedValue([]);
    vi.spyOn(opfsMod, 'listNoteAttachments').mockResolvedValue([]);

    const createdFolders: Array<{ id: string; name: string; parents: string[] }> = [];
    const uploadedFiles: Array<{ id: string; name: string; parents: string[]; body: string }> = [];
    let seq = 1;

    const FOLDER_MIME = 'application/vnd.google-apps.folder';
    const remoteEntriesByParent: Record<string, Array<{ id: string; name: string; mimeType: string; parents: string[]; modifiedTime?: string }>> = {
      [TARGET_FOLDER_ID]: [
        { id: IMAGES_FOLDER_ID, name: 'images', mimeType: FOLDER_MIME, parents: [TARGET_FOLDER_ID] },
        { id: 'drv_sub_1', name: '대학원', mimeType: FOLDER_MIME, parents: [TARGET_FOLDER_ID] },
      ],
      drv_sub_1: [
        { id: 'drv_sub_2', name: '선형대수', mimeType: FOLDER_MIME, parents: ['drv_sub_1'] },
      ],
      drv_sub_2: [
        { id: 'drv_nested_md', name: '하위노트.md', mimeType: 'text/markdown', parents: ['drv_sub_2'], modifiedTime: '2026-11-14T12:00:00.000Z' },
        { id: 'drv_nested_sc', name: '하위노트.eduink.json', mimeType: 'application/json', parents: ['drv_sub_2'], modifiedTime: '2026-11-14T12:00:00.000Z' },
      ],
      [IMAGES_FOLDER_ID]: [],
    };

    const sidecarPayload = JSON.stringify({
      version: 1,
      content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '하위 본문' }] }] },
      strokes: [{ id: 's_sub', pageIndex: 0, tool: 'pencil', color: '#000000', width: 2, points: [{ x: 1, y: 2, p: 0.5 }] }],
      annotations: [],
      textObjects: [],
      pages: [],
    });

    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const parsedUrl = new URL(url);
      const qParam = parsedUrl.searchParams.get('q') ?? '';

      if (parsedUrl.pathname.endsWith(`/files/${TARGET_FOLDER_ID}`)) {
        return new Response(JSON.stringify({ id: TARGET_FOLDER_ID, name: 'EduInk Sync', trashed: false }), { status: 200 });
      }
      if (parsedUrl.pathname.endsWith('/files') && method === 'GET') {
        const parentMatch = qParam.match(/'([^']+)' in parents/);
        const parentId = parentMatch?.[1] ?? '';
        if (qParam.includes('mimeType = ')) {
          const nameMatch = qParam.match(/name = '([^']+)'/);
          const name = nameMatch?.[1] ?? '';
          const matched = [
            ...(remoteEntriesByParent[parentId] ?? []).filter((f) => f.mimeType === FOLDER_MIME && f.name === name),
            ...createdFolders.filter((f) => f.parents.includes(parentId) && f.name === name),
          ];
          return new Response(JSON.stringify({ files: matched }), { status: 200 });
        }
        return new Response(JSON.stringify({ files: remoteEntriesByParent[parentId] ?? [] }), { status: 200 });
      }
      if (parsedUrl.pathname.endsWith('/files/drv_nested_md') && parsedUrl.searchParams.get('alt') === 'media') {
        return new Response('# 하위노트\n\n하위 본문', { status: 200 });
      }
      if (parsedUrl.pathname.endsWith('/files/drv_nested_sc') && parsedUrl.searchParams.get('alt') === 'media') {
        return new Response(sidecarPayload, { status: 200 });
      }
      if (!url.includes('/upload/') && parsedUrl.pathname.endsWith('/files') && method === 'POST') {
        const payload = JSON.parse(String(init?.body ?? '{}')) as { name: string; parents: string[] };
        const id = `drv_created_fld_${seq++}`;
        const folderMeta = { id, name: payload.name, parents: payload.parents };
        createdFolders.push(folderMeta);
        return new Response(JSON.stringify(folderMeta), { status: 200 });
      }
      if (url.includes('/upload/drive/v3/files') && method === 'POST') {
        const rawText = await (init?.body as Blob).text();
        const nameMatch = rawText.match(/"name":"([^"]+)"/);
        const parentsMatch = rawText.match(/"parents":\["([^"]+)"\]/);
        const fileName = nameMatch?.[1] ?? `file_${seq}`;
        const parentId = parentsMatch?.[1] ?? '';
        const id = `drv_uploaded_${seq++}`;
        const meta = { id, name: fileName, parents: [parentId], body: rawText, modifiedTime: '2026-11-14T13:10:00.000Z' };
        uploadedFiles.push(meta);
        return new Response(JSON.stringify(meta), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });

    const res = await runDriveSync({
      fetchImpl: mockFetch as unknown as typeof fetch,
      getToken: async () => 'valid-token',
    });

    expect(res.status).toBe('synced');
    expect(res.downloadedCount).toBe(1);
    expect(res.uploadedCount).toBe(1);

    // 1. 로컬 db.folders에 대학원 -> 선형대수 계층이 생성되고 루트 images 폴더는 제외되었는지 확인
    const folders = Array.from(folderStore.values());
    expect(folders.some((f) => f.name === 'images')).toBe(false);
    const grad = folders.find((f) => f.name === '대학원' && f.parentId === null);
    const math = folders.find((f) => f.name === '선형대수' && f.parentId === grad?.id);
    expect(grad).toBeTruthy();
    expect(math).toBeTruthy();

    // 2. 원격 하위노트가 올바른 folderId와 사이드카 strokes를 포함해 로컬 노트로 저장되었는지 확인
    const downloadedNote = Array.from(noteStore.values()).find((n) => n.title === '하위노트');
    expect(downloadedNote).toBeTruthy();
    expect(downloadedNote?.folderId).toBe(math?.id);
    expect(downloadedNote?.strokes).toHaveLength(1);
    expect(downloadedNote?.driveFileId).toBe('drv_nested_md');

    // 3. 로컬 하위 폴더 노트가 Drive의 '로컬폴더' 하위에 업로드되었는지 확인
    const remoteLocalFld = createdFolders.find((f) => f.name === '로컬폴더' && f.parents.includes(TARGET_FOLDER_ID));
    expect(remoteLocalFld).toBeTruthy();
    const uploadedLocalSub = uploadedFiles.find((f) => f.name === '로컬 하위 노트.md');
    expect(uploadedLocalSub?.parents).toEqual([remoteLocalFld!.id]);
  });
});
