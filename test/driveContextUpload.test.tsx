// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { LeftSidebar } from '../src/components/LeftSidebar';
import { emptyNote, type FolderRecord, type NoteRecord } from '../src/storage/db';
import { DEFAULT_DRIVE_SYNC_CONFIG, useSettings } from '../src/store/settingsStore';
import * as driveSyncMod from '../src/modules/sync/driveSyncEngine';

let currentFolders: FolderRecord[] = [];
let currentNotes: NoteRecord[] = [];

vi.mock('../src/search/searchClient', () => ({
  indexNote: vi.fn(),
  unindexNote: vi.fn(),
}));

vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: (querier: () => unknown) => {
    const [val, setVal] = useState<unknown>(() => {
      const qStr = querier.toString();
      if (qStr.includes('folders')) return currentFolders;
      if (qStr.includes('notes')) return currentNotes;
      return [];
    });
    useEffect(() => {
      const qStr = querier.toString();
      if (qStr.includes('folders')) setVal([...currentFolders]);
      else if (qStr.includes('notes')) setVal([...currentNotes]);
    }, []);
    return val;
  },
}));

describe('REQ_DRIVE_CONTEXT_UPLOAD_WITH_PATH: 좌측 파일 목록 우클릭 Google Drive 업로드', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    currentFolders = [
      { id: 'f_grad', name: '대학원', parentId: null, createdAt: 1000 },
      { id: 'f_math', name: '선형대수', parentId: 'f_grad', createdAt: 1100 },
    ];
    currentNotes = [
      emptyNote({ id: 'n_1', title: '1주차 필기', folderId: 'f_math' }),
      emptyNote({ id: 'n_2', title: '2주차 필기', folderId: 'f_math' }),
      emptyNote({ id: 'n_3', title: '단독 노트', folderId: null }),
    ];

    useSettings.setState({
      driveSyncConfig: {
        ...DEFAULT_DRIVE_SYNC_CONFIG,
        enabled: true,
        targetFolderId: 'drive_root_folder',
        targetFolderName: 'EduInk Sync',
      },
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('1. 단일 파일을 우클릭하면 Google Drive에 업로드 메뉴가 나타나고 해당 문서만 업로드한다', async () => {
    const uploadSpy = vi.spyOn(driveSyncMod, 'uploadSelectedNotesToDrive').mockResolvedValue({
      status: 'synced',
      uploadedCount: 1,
      downloadedCount: 0,
      conflictCount: 0,
      uploadedImagesCount: 0,
    });

    render(<LeftSidebar />);
    const row = screen.getByTestId('note-row-n_3');
    fireEvent.contextMenu(row, { clientX: 120, clientY: 160 });

    const btn = await screen.findByTestId('ctx-upload-drive-btn');
    expect(btn.textContent).toContain('Google Drive에 업로드');
    fireEvent.click(btn);

    await waitFor(() => {
      expect(uploadSpy).toHaveBeenCalledWith(['n_3']);
    });
  });

  it('2. 다중 선택(선택 모드 또는 Ctrl+클릭) 후 우클릭 시 선택된 모든 문서를 일괄 업로드한다', async () => {
    const uploadSpy = vi.spyOn(driveSyncMod, 'uploadSelectedNotesToDrive').mockResolvedValue({
      status: 'synced',
      uploadedCount: 2,
      downloadedCount: 0,
      conflictCount: 0,
      uploadedImagesCount: 0,
    });

    render(<LeftSidebar />);
    // Ctrl+클릭으로 2개 문서 다중 선택
    fireEvent.click(screen.getByTestId('note-row-n_1'), { ctrlKey: true });
    fireEvent.click(screen.getByTestId('note-row-n_2'), { ctrlKey: true });

    // 선택된 항목 중 하나에서 우클릭
    fireEvent.contextMenu(screen.getByTestId('note-row-n_1'), { clientX: 100, clientY: 200 });

    const btn = await screen.findByTestId('ctx-upload-drive-btn');
    expect(btn.textContent).toContain('Google Drive에 업로드 (2개)');
    fireEvent.click(btn);

    await waitFor(() => {
      expect(uploadSpy).toHaveBeenCalledTimes(1);
      const passedIds = uploadSpy.mock.calls[0][0];
      expect(passedIds).toEqual(expect.arrayContaining(['n_1', 'n_2']));
      expect(passedIds).toHaveLength(2);
    });
  });
});
