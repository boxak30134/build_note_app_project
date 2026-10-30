/** OPFS(Origin Private File System) 첨부 파일 저장소: notes/<noteId>/<relativePath> */
import { imageFileName } from '../core/files/validation';

async function root(): Promise<FileSystemDirectoryHandle> {
  if (!navigator.storage?.getDirectory) throw new Error('이 브라우저는 OPFS를 지원하지 않습니다.');
  return navigator.storage.getDirectory();
}

async function dirFor(noteId: string, parts: string[], create: boolean): Promise<FileSystemDirectoryHandle> {
  let dir = await (await root()).getDirectoryHandle('notes', { create });
  dir = await dir.getDirectoryHandle(noteId, { create });
  for (const p of parts) dir = await dir.getDirectoryHandle(p, { create });
  return dir;
}

function split(relPath: string): { dirs: string[]; name: string } {
  const segs = relPath.split('/').filter(Boolean);
  const name = segs.pop() ?? 'file';
  return { dirs: segs, name };
}

async function exists(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch {
    return false;
  }
}

export async function writeAttachment(noteId: string, relPath: string, data: Blob): Promise<void> {
  const { dirs, name } = split(relPath);
  const dir = await dirFor(noteId, dirs, true);
  const fh = await dir.getFileHandle(name, { create: true });
  try {
    const w = await fh.createWritable();
    await w.write(data);
    await w.close();
  } catch (e) {
    // 업로드 실패 시 잔여 임시 파일 즉시 정리
    await dir.removeEntry(name).catch(() => undefined);
    throw e;
  }
}

export async function deleteAttachment(noteId: string, relPath: string): Promise<void> {
  const { dirs, name } = split(relPath);
  const dir = await dirFor(noteId, dirs, false);
  await dir.removeEntry(name);
}

const urlCache = new Map<string, string>();

export async function attachmentUrl(noteId: string, relPath: string): Promise<string | null> {
  const key = `${noteId}/${relPath}`;
  const cached = urlCache.get(key);
  if (cached) return cached;
  try {
    const { dirs, name } = split(relPath);
    const dir = await dirFor(noteId, dirs, false);
    const file = await (await dir.getFileHandle(name)).getFile();
    const url = URL.createObjectURL(file);
    urlCache.set(key, url);
    return url;
  } catch {
    return null;
  }
}

/** images/YYYYMMDD-HHmmss-n.ext 로 배타적(중복 없는) 저장 후 상대 경로 반환 */
export async function saveImageExclusive(noteId: string, blob: Blob, ext = 'png'): Promise<string> {
  const now = new Date();
  const dir = await dirFor(noteId, ['images'], true);
  let n = 1;
  let rel = imageFileName(now, n, ext);
  while (await exists(dir, rel.split('/').pop()!)) {
    n++;
    rel = imageFileName(now, n, ext);
  }
  await writeAttachment(noteId, rel, blob);
  return rel;
}

export async function saveAttachmentExclusive(noteId: string, blob: Blob, fileName: string): Promise<string> {
  const dir = await dirFor(noteId, ['attachments'], true);
  const dot = fileName.lastIndexOf('.');
  const base = (dot > 0 ? fileName.slice(0, dot) : fileName).replace(/[\\/<>:"|?*\u0000-\u001f]/g, '_');
  const ext = dot > 0 ? fileName.slice(dot) : '';
  let name = `${base}${ext}`;
  let n = 1;
  while (await exists(dir, name)) name = `${base}-${n++}${ext}`;
  const rel = `attachments/${name}`;
  await writeAttachment(noteId, rel, blob);
  return rel;
}

export function extOfMime(mime: string): string {
  const m = mime.split('/')[1] ?? 'png';
  return m === 'jpeg' ? 'jpg' : m.replace('svg+xml', 'svg');
}
