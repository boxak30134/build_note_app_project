/** 영구 삭제된 노트의 OPFS 첨부 폴더 정리 */
export async function deleteAttachmentsOf(noteId: string): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    const notes = await root.getDirectoryHandle('notes');
    await notes.removeEntry(noteId, { recursive: true });
  } catch {
    /* 첨부 없음 */
  }
}
