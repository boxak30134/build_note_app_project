import Dexie, { type EntityTable } from 'dexie';
import type { Stroke } from '../core/strokes/StrokeStore';
import type { EolKind, TextEncodingKind } from '../core/codec/textCodec';
import type { Annotation } from '../features/annotations/types';
import { createPage, type NotePage } from '../core/page/pageTypes';
import type { CustomFontRecord } from '../core/font/fontManager';
import type { UserWordStat } from '../types/adaptiveGlossary';
import { plainTextOf } from '../core/doc/blocks';

export interface UserWordStatRecord extends UserWordStat {
  id: string;
}

export interface FolderRecord {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: number;
  deletedAt?: number | null;
}

export interface NoteRecord {
  id: string;
  title: string;
  folderId: string | null;
  /** TipTap JSON (진실 원본) */
  content: unknown;
  /** 검색·외부 저장용 마크다운 직렬화 */
  markdown: string;
  /** 일반 텍스트 (검색용) */
  plainText: string;
  strokes: Stroke[];
  annotations: Annotation[];
  /** 문서 페이지 목록 (규격·스타일·방향 보존, 기본 A4) */
  pages?: NotePage[];
  encoding: TextEncodingKind;
  eol: EolKind;
  /** 로컬 파일에 연결된 경우 (File System Access API) */
  fileHandle?: FileSystemFileHandle | null;
  fileLastModified?: number | null;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number | null;
}

export interface SecretRecord {
  id: string; // provider id or 'master-key'
  value: unknown;
}

export class EduInkDB extends Dexie {
  notes!: EntityTable<NoteRecord, 'id'>;
  folders!: EntityTable<FolderRecord, 'id'>;
  secrets!: EntityTable<SecretRecord, 'id'>;
  customFonts!: EntityTable<CustomFontRecord, 'id'>;
  glossaryStats!: EntityTable<UserWordStatRecord, 'id'>;

  constructor() {
    super('eduink-studio');
    this.version(1).stores({
      notes: 'id, folderId, title, updatedAt, deletedAt',
      folders: 'id, parentId, name, deletedAt',
      secrets: 'id',
    });
    this.version(2).stores({
      notes: 'id, folderId, title, updatedAt, deletedAt',
      folders: 'id, parentId, name, deletedAt',
      secrets: 'id',
      customFonts: 'id, name, createdAt',
    });
    this.version(3).stores({
      notes: 'id, folderId, title, updatedAt, deletedAt',
      folders: 'id, parentId, name, deletedAt',
      secrets: 'id',
      customFonts: 'id, name, createdAt',
      glossaryStats: 'id, word, contextTag, selectedMeaning, lastUpdated',
    });
  }
}

export const db = new EduInkDB();

export function uid(prefix = 'id'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function emptyNote(partial: Partial<NoteRecord> = {}): NoteRecord {
  const now = Date.now();
  return {
    id: uid('note'),
    title: '제목 없는 노트',
    folderId: null,
    content: { type: 'doc', content: [{ type: 'paragraph' }] },
    markdown: '',
    plainText: '',
    strokes: [],
    annotations: [],
    pages: [createPage()],
    encoding: 'utf-8',
    eol: 'lf',
    fileHandle: null,
    fileLastModified: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    ...partial,
  };
}

/** 최초 실행 시 샘플 데이터 */
export async function seedIfEmpty() {
  const count = await db.notes.count();
  if (count > 0) return;
  const folderA: FolderRecord = { id: uid('folder'), name: '수업 자료', parentId: null, createdAt: Date.now() };
  const folderB: FolderRecord = { id: uid('folder'), name: '개인 연구', parentId: null, createdAt: Date.now() };
  await db.folders.bulkAdd([folderA, folderB]);
  const n1 = emptyNote({
    title: '인지부하 이론',
    folderId: folderA.id,
    markdown: '',
    content: {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: '인지부하 이론 (Cognitive Load Theory)' }] },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Sweller의 인지부하 이론은 작업 기억의 용량이 제한적이라는 전제에서 출발한다. 학습 설계는 외재적 인지 부하를 최소화해야 한다.' },
          ],
        },
        { type: 'paragraph', content: [{ type: 'text', text: '세 가지 부하: 내재적 부하, 외재적 부하, 본유적 부하.' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '관련 노트는 [[ 를 입력해 연결할 수 있다. 수식 예시: ' }, { type: 'inlineMath', attrs: { latex: 'L_{total} = L_i + L_e + L_g' } }] },
      ],
    },
    plainText: 'Sweller의 인지부하 이론은 작업 기억의 용량이 제한적이라는 전제에서 출발한다.',
  });
  const n2 = emptyNote({
    title: '멀티미디어 학습 원리',
    folderId: folderA.id,
    content: {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Mayer의 멀티미디어 학습 원리' }] },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: '공간 근접성 원칙: 관련된 텍스트와 그림은 화면에서 서로 가까이 배치될 때 학습 효과가 높다. 이는 시각적 탐색에 드는 외재적 인지 부하를 줄인다.' }],
        },
        { type: 'paragraph', content: [{ type: 'text', text: '시간 근접성 원칙: 내레이션과 애니메이션은 동시에 제시되어야 한다.' }] },
      ],
    },
  });
  const n3 = emptyNote({
    title: '연구 아이디어',
    folderId: folderB.id,
    content: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: '태블릿 필기와 AI 주석을 결합한 학습 도구의 효과 검증 실험 설계.' }] }],
    },
  });
  for (const n of [n1, n2, n3]) n.plainText = plainTextOf(n.content);
  n1.updatedAt += 2; // 첫 실행 시 가장 먼저 열릴 샘플
  n2.updatedAt += 1;
  await db.notes.bulkAdd([n1, n2, n3]);
}
