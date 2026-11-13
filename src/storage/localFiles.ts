/** 로컬 파일 열기/저장 (File System Access API, 미지원 시 <input type=file> 폴백) */
import { decodeText, encodeText, type DecodedText, type EolKind, type TextEncodingKind } from '../core/codec/textCodec';
import { isIgnoredDir } from '../core/files/validation';
import { db, emptyNote, uid, type NoteRecord } from './db';

const TEXT_TYPES = [{ description: 'Markdown / Text', accept: { 'text/markdown': ['.md', '.markdown'], 'text/plain': ['.txt'] } }];

export const fsAccessSupported = typeof window !== 'undefined' && !!window.showOpenFilePicker;

export async function readHandle(handle: FileSystemFileHandle): Promise<DecodedText & { lastModified: number }> {
  const file = await handle.getFile();
  const bytes = new Uint8Array(await file.arrayBuffer());
  return { ...decodeText(bytes), lastModified: file.lastModified };
}

export async function ensurePermission(handle: FileSystemHandle, mode: 'read' | 'readwrite'): Promise<boolean> {
  if (!handle.queryPermission) return true;
  if ((await handle.queryPermission({ mode })) === 'granted') return true;
  if (!handle.requestPermission) return false;
  return (await handle.requestPermission({ mode })) === 'granted';
}

/** 원래 인코딩/줄바꿈을 유지하여 저장. CP949 비표현 문자는 UnencodableCharError */
export async function writeHandle(handle: FileSystemFileHandle, markdown: string, encoding: TextEncodingKind, eol: EolKind): Promise<number> {
  const bytes = encodeText(markdown, encoding, eol); // 실패 시 쓰기 전에 예외 → 파일 무손상
  if (!(await ensurePermission(handle, 'readwrite'))) throw new Error('파일 쓰기 권한이 거부되었습니다.');
  const w = await handle.createWritable();
  await w.write(bytes as BufferSource);
  await w.close();
  return (await handle.getFile()).lastModified;
}

function titleFromName(name: string) {
  return name.replace(/\.(md|markdown|txt)$/i, '');
}

export type MarkdownParser = (md: string) => unknown;

async function noteFromText(name: string, decoded: DecodedText, parse: MarkdownParser, extra: Partial<NoteRecord>): Promise<NoteRecord> {
  return emptyNote({
    title: titleFromName(name),
    content: parse(decoded.text),
    markdown: decoded.text,
    plainText: decoded.text,
    encoding: decoded.encoding,
    eol: decoded.eol,
    ...extra,
  });
}

/** 로컬 파일 열기 → 노트로 등록 (핸들 보존 시 원본 파일과 연결) */
export async function openLocalFiles(parse: MarkdownParser, folderId: string | null): Promise<NoteRecord[]> {
  const created: NoteRecord[] = [];
  if (window.showOpenFilePicker) {
    let handles: FileSystemFileHandle[];
    try {
      handles = await window.showOpenFilePicker({ multiple: true, types: TEXT_TYPES });
    } catch {
      return [];
    }
    for (const h of handles) {
      const d = await readHandle(h);
      created.push(await noteFromText(h.name, d, parse, { fileHandle: h, fileLastModified: d.lastModified, folderId }));
    }
  } else {
    const files = await pickFiles('.md,.markdown,.txt', true);
    for (const f of files) {
      const d = decodeText(new Uint8Array(await f.arrayBuffer()));
      created.push(await noteFromText(f.name, d, parse, { folderId }));
    }
  }
  await db.notes.bulkAdd(created);
  return created;
}

/** 폴더 가져오기: 하위 .md/.txt 를 재귀 스캔(숨김/빌드 폴더 제외)하여 폴더 트리로 등록 */
export async function importDirectory(parse: MarkdownParser): Promise<number> {
  if (!window.showDirectoryPicker) throw new Error('이 브라우저는 폴더 열기를 지원하지 않습니다 (Chrome/Edge 권장).');
  let dir: FileSystemDirectoryHandle;
  try {
    dir = await window.showDirectoryPicker({ mode: 'readwrite' });
  } catch {
    return 0;
  }
  let count = 0;
  const walk = async (handle: FileSystemDirectoryHandle, parentId: string | null) => {
    const folderId = uid('folder');
    await db.folders.add({ id: folderId, name: handle.name, parentId, createdAt: Date.now() });
    for await (const entry of handle.values()) {
      if (entry.kind === 'directory') {
        if (isIgnoredDir(entry.name) || entry.name.startsWith('.')) continue;
        await walk(entry as FileSystemDirectoryHandle, folderId);
      } else if (/\.(md|markdown|txt)$/i.test(entry.name)) {
        const fh = entry as FileSystemFileHandle;
        const d = await readHandle(fh);
        await db.notes.add(await noteFromText(fh.name, d, parse, { fileHandle: fh, fileLastModified: d.lastModified, folderId }));
        count++;
      }
    }
  };
  await walk(dir, null);
  return count;
}

export function pickFiles(accept: string, multiple: boolean, capture?: string): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    if (capture) input.setAttribute('capture', capture);
    input.onchange = () => resolve(Array.from(input.files ?? []));
    input.addEventListener('cancel', () => resolve([]));
    input.click();
  });
}

export function downloadBytes(bytes: Uint8Array, name: string, mimeType = 'text/markdown') {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mimeType }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
