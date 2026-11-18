// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { useState, useEffect } from 'react';
import { LeftSidebar } from './LeftSidebar';
import type { FolderRecord, NoteRecord } from '../storage/db';

let currentFolders: FolderRecord[] = [];
let currentNotes: NoteRecord[] = [];
let listeners: Array<() => void> = [];

function notify() {
  listeners.forEach((l) => l());
}

vi.mock('../search/searchClient', () => ({
  indexNote: vi.fn(),
  unindexNote: vi.fn(),
}));

vi.mock('../store/uiStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../store/uiStore')>();
  return {
    ...actual,
    confirmDialog: vi.fn().mockResolvedValue('ok'),
  };
});

vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: (querier: any) => {
    const [val, setVal] = useState(() => {
      const qStr = querier.toString();
      if (qStr.includes('folders')) return currentFolders;
      if (qStr.includes('notes')) return currentNotes;
      return [];
    });

    useEffect(() => {
      const update = () => {
        const qStr = querier.toString();
        if (qStr.includes('folders')) setVal([...currentFolders]);
        else if (qStr.includes('notes')) setVal([...currentNotes]);
      };
      listeners.push(update);
      return () => {
        listeners = listeners.filter((l) => l !== update);
      };
    }, []);

    return val;
  },
}));

vi.mock('../storage/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../storage/db')>();
  return {
    ...actual,
    db: {
      folders: {
        toArray: vi.fn(async () => currentFolders),
        add: vi.fn(async (f: FolderRecord) => {
          currentFolders.push(f);
          notify();
        }),
        update: vi.fn(async (id: string, patch: any) => {
          currentFolders = currentFolders.map((f) => (f.id === id ? { ...f, ...patch } : f));
          notify();
        }),
        bulkDelete: vi.fn(async (ids: string[]) => {
          currentFolders = currentFolders.filter((f) => !ids.includes(f.id));
          notify();
        }),
        where: vi.fn(() => ({
          anyOf: vi.fn((ids: string[]) => ({
            modify: vi.fn(async (patch: any) => {
              currentFolders = currentFolders.map((f) => (ids.includes(f.id) ? { ...f, ...patch } : f));
              notify();
            }),
          })),
        })),
      },
      notes: {
        toArray: vi.fn(async () => currentNotes),
        add: vi.fn(async (n: NoteRecord) => {
          currentNotes.push(n);
          notify();
        }),
        get: vi.fn(async (id: string) => currentNotes.find((n) => n.id === id)),
        update: vi.fn(async (id: string, patch: any) => {
          currentNotes = currentNotes.map((n) => (n.id === id ? { ...n, ...patch } : n));
          notify();
        }),
        delete: vi.fn(async (id: string) => {
          currentNotes = currentNotes.filter((n) => n.id !== id);
          notify();
        }),
        bulkDelete: vi.fn(async (ids: string[]) => {
          currentNotes = currentNotes.filter((n) => !ids.includes(n.id));
          notify();
        }),
      },
    },
  };
});

describe('LeftSidebar Multi-Select (파일/폴더 복수 선택 및 일괄 삭제/이동 & 휴지통 일괄 복원/영구삭제)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentFolders = [];
    currentNotes = [];
    listeners = [];
  });

  afterEach(() => {
    cleanup();
  });

  it('1. 다중 선택 모드 토글 시 파일/폴더 체크박스 및 선택 액션 바가 표시된다', async () => {
    currentFolders = [
      {
        id: 'folder-1',
        name: '대수학',
        parentId: null,
        createdAt: Date.now(),
      },
    ];
    currentNotes = [
      {
        id: 'note-1',
        title: '환론 기초',
        folderId: 'folder-1',
        content: { type: 'doc', content: [] },
        markdown: '',
        plainText: '',
        strokes: [],
        annotations: [],
        encoding: 'utf-8',
        eol: 'lf',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ];

    render(<LeftSidebar />);

    await waitFor(() => {
      expect(screen.getByText('대수학')).toBeDefined();
    });

    expect(screen.queryByTestId('selection-action-bar')).toBeNull();

    const selectToggleBtn = screen.getByTestId('toggle-select-mode-btn');
    fireEvent.click(selectToggleBtn);

    expect(screen.getByTestId('selection-action-bar')).toBeDefined();
    expect(screen.getByTestId('checkbox-folder-folder-1')).toBeDefined();

    fireEvent.click(screen.getByText('대수학'));
    await waitFor(() => {
      expect(screen.getByTestId('checkbox-note-note-1')).toBeDefined();
    });

    fireEvent.click(selectToggleBtn);
    expect(screen.queryByTestId('selection-action-bar')).toBeNull();
  });

  it('2. 복수 개 파일/폴더를 체크하여 일괄 휴지통으로 이동한다', async () => {
    currentNotes = [
      {
        id: 'note-a',
        title: '문서 A',
        folderId: null,
        content: { type: 'doc', content: [] },
        markdown: '',
        plainText: '',
        strokes: [],
        annotations: [],
        encoding: 'utf-8',
        eol: 'lf',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      {
        id: 'note-b',
        title: '문서 B',
        folderId: null,
        content: { type: 'doc', content: [] },
        markdown: '',
        plainText: '',
        strokes: [],
        annotations: [],
        encoding: 'utf-8',
        eol: 'lf',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ];

    render(<LeftSidebar />);

    await waitFor(() => {
      expect(screen.getByText('문서 A')).toBeDefined();
      expect(screen.getByText('문서 B')).toBeDefined();
    });

    fireEvent.click(screen.getByTestId('toggle-select-mode-btn'));

    const selectAllBtn = screen.getByTestId('select-all-live-btn');
    fireEvent.click(selectAllBtn);

    expect(screen.getByText('2개 선택')).toBeDefined();

    const bulkTrashBtn = screen.getByTestId('bulk-trash-btn');
    fireEvent.click(bulkTrashBtn);

    await waitFor(() => {
      const noteA = currentNotes.find((n) => n.id === 'note-a');
      const noteB = currentNotes.find((n) => n.id === 'note-b');
      expect(noteA?.deletedAt).toBeTypeOf('number');
      expect(noteB?.deletedAt).toBeTypeOf('number');
    });
  });

  it('3. 복수 개 파일을 체크하여 다른 폴더로 일괄 이동한다', async () => {
    currentFolders = [
      {
        id: 'target-folder',
        name: '이동목표폴더',
        parentId: null,
        createdAt: Date.now(),
      },
    ];
    currentNotes = [
      {
        id: 'move-note-1',
        title: '이동노트 1',
        folderId: null,
        content: { type: 'doc', content: [] },
        markdown: '',
        plainText: '',
        strokes: [],
        annotations: [],
        encoding: 'utf-8',
        eol: 'lf',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      {
        id: 'move-note-2',
        title: '이동노트 2',
        folderId: null,
        content: { type: 'doc', content: [] },
        markdown: '',
        plainText: '',
        strokes: [],
        annotations: [],
        encoding: 'utf-8',
        eol: 'lf',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ];

    render(<LeftSidebar />);

    await waitFor(() => {
      expect(screen.getByText('이동노트 1')).toBeDefined();
      expect(screen.getByText('이동목표폴더')).toBeDefined();
    });

    fireEvent.click(screen.getByTestId('toggle-select-mode-btn'));

    fireEvent.click(screen.getByTestId('checkbox-note-move-note-1'));
    fireEvent.click(screen.getByTestId('checkbox-note-move-note-2'));

    fireEvent.click(screen.getByTestId('bulk-move-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('target-folder-target-folder')).toBeDefined();
    });
    fireEvent.click(screen.getByTestId('target-folder-target-folder'));
    fireEvent.click(screen.getByTestId('confirm-bulk-move-btn'));

    await waitFor(() => {
      const n1 = currentNotes.find((n) => n.id === 'move-note-1');
      const n2 = currentNotes.find((n) => n.id === 'move-note-2');
      expect(n1?.folderId).toBe('target-folder');
      expect(n2?.folderId).toBe('target-folder');
    });
  });

  it('4. 휴지통에서 복수 개의 항목을 체크하여 일괄 복원한다', async () => {
    const now = Date.now();
    currentNotes = [
      {
        id: 'trash-note-1',
        title: '휴지통 노트 1',
        folderId: null,
        content: { type: 'doc', content: [] },
        markdown: '',
        plainText: '',
        strokes: [],
        annotations: [],
        encoding: 'utf-8',
        eol: 'lf',
        createdAt: now,
        updatedAt: now,
        deletedAt: now,
      },
      {
        id: 'trash-note-2',
        title: '휴지통 노트 2',
        folderId: null,
        content: { type: 'doc', content: [] },
        markdown: '',
        plainText: '',
        strokes: [],
        annotations: [],
        encoding: 'utf-8',
        eol: 'lf',
        createdAt: now,
        updatedAt: now,
        deletedAt: now,
      },
    ];

    render(<LeftSidebar />);

    await waitFor(() => {
      expect(screen.getByText(/휴지통 \(2\)/)).toBeDefined();
    });
    fireEvent.click(screen.getByText(/휴지통 \(2\)/));

    await waitFor(() => {
      expect(screen.getByTestId('trash-checkbox-trash-note-1')).toBeDefined();
      expect(screen.getByTestId('trash-checkbox-trash-note-2')).toBeDefined();
    });

    fireEvent.click(screen.getByTestId('trash-select-all-checkbox'));

    const restoreBtn = screen.getByTestId('bulk-restore-trash-btn');
    expect(restoreBtn).toBeDefined();
    fireEvent.click(restoreBtn);

    await waitFor(() => {
      const n1 = currentNotes.find((n) => n.id === 'trash-note-1');
      const n2 = currentNotes.find((n) => n.id === 'trash-note-2');
      expect(n1?.deletedAt).toBeNull();
      expect(n2?.deletedAt).toBeNull();
    });
  });

  it('5. 휴지통에서 복수 개의 항목을 체크하여 일괄 영구 삭제한다', async () => {
    const now = Date.now();
    currentNotes = [
      {
        id: 'purge-note-1',
        title: '영구삭제 노트 1',
        folderId: null,
        content: { type: 'doc', content: [] },
        markdown: '',
        plainText: '',
        strokes: [],
        annotations: [],
        encoding: 'utf-8',
        eol: 'lf',
        createdAt: now,
        updatedAt: now,
        deletedAt: now,
      },
      {
        id: 'purge-note-2',
        title: '영구삭제 노트 2',
        folderId: null,
        content: { type: 'doc', content: [] },
        markdown: '',
        plainText: '',
        strokes: [],
        annotations: [],
        encoding: 'utf-8',
        eol: 'lf',
        createdAt: now,
        updatedAt: now,
        deletedAt: now,
      },
    ];

    render(<LeftSidebar />);

    await waitFor(() => {
      expect(screen.getByText(/휴지통 \(2\)/)).toBeDefined();
    });
    fireEvent.click(screen.getByText(/휴지통 \(2\)/));

    await waitFor(() => {
      expect(screen.getByTestId('trash-checkbox-purge-note-1')).toBeDefined();
    });

    fireEvent.click(screen.getByTestId('trash-select-all-checkbox'));

    const purgeBtn = screen.getByTestId('bulk-purge-trash-btn');
    fireEvent.click(purgeBtn);

    await waitFor(() => {
      expect(currentNotes.find((n) => n.id === 'purge-note-1')).toBeUndefined();
      expect(currentNotes.find((n) => n.id === 'purge-note-2')).toBeUndefined();
    });
  });

  it('6. 이동 팝업창에서 중첩 폴더가 계층형 트리와 깊이 들여쓰기로 표시되고 접기/펼치기 및 전체 경로가 동작한다', async () => {
    const now = Date.now();
    currentFolders = [
      { id: 'f-root-a', name: '수학', parentId: null, createdAt: now },
      { id: 'f-child-b', name: '미적분', parentId: 'f-root-a', createdAt: now },
      { id: 'f-grand-c', name: '연습문제', parentId: 'f-child-b', createdAt: now },
      { id: 'f-root-z', name: '물리', parentId: null, createdAt: now },
    ];
    currentNotes = [
      {
        id: 'move-note-1',
        title: '이동할 노트',
        folderId: null,
        content: { type: 'doc', content: [] },
        markdown: '',
        plainText: '',
        strokes: [],
        annotations: [],
        encoding: 'utf-8',
        eol: 'lf',
        createdAt: now,
        updatedAt: now,
      },
    ];

    render(<LeftSidebar />);

    await waitFor(() => {
      expect(screen.getByTestId('note-row-move-note-1')).toBeDefined();
    });

    fireEvent.click(screen.getByTestId('toggle-select-mode-btn'));
    fireEvent.click(screen.getByTestId('checkbox-note-move-note-1'));
    fireEvent.click(screen.getByTestId('bulk-move-btn'));

    const modal = await screen.findByTestId('bulk-move-modal');
    const rowA = screen.getByTestId('target-folder-f-root-a').closest('[data-depth]')!;
    const rowB = screen.getByTestId('target-folder-f-child-b').closest('[data-depth]')!;
    const rowC = screen.getByTestId('target-folder-f-grand-c').closest('[data-depth]')!;

    expect(rowA.getAttribute('data-depth')).toBe('0');
    expect(rowB.getAttribute('data-depth')).toBe('1');
    expect(rowC.getAttribute('data-depth')).toBe('2');

    // 최상위(물리/수학) 순서 및 하위(미적분 -> 연습문제) 계층 정렬 확인
    const labels = Array.from(modal.querySelectorAll('[data-testid^="target-folder-f-"]')).map((el) =>
      el.textContent?.trim(),
    );
    expect(labels).toEqual(['물리', '수학', '미적분', '연습문제']);

    // 대상 폴더 클릭 시 전체 경로 미리보기 갱신
    fireEvent.click(screen.getByTestId('target-folder-f-grand-c'));
    expect(screen.getByTestId('move-target-path-preview').textContent).toContain(
      '최상위 (루트) > 수학 > 미적분 > 연습문제',
    );

    // 상위 폴더 접기 클릭 시 하위 폴더 숨김
    fireEvent.click(screen.getByTestId('move-folder-toggle-f-root-a'));
    expect(screen.queryByTestId('target-folder-f-child-b')).toBeNull();
    expect(screen.queryByTestId('target-folder-f-grand-c')).toBeNull();

    // 다시 펼치면 하위 폴더 복원
    fireEvent.click(screen.getByTestId('move-folder-toggle-f-root-a'));
    expect(screen.getByTestId('target-folder-f-child-b')).toBeDefined();
  });
});
