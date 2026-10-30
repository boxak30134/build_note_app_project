import { useTabs } from '../store/tabsStore';
import { getSession, closeSession } from '../session/NoteSession';
import { confirmDialog } from '../store/uiStore';
import { drafts } from '../storage/drafts';

/** 미저장 탭 닫기 시 한국어 확인 대화상자 */
export async function requestCloseTab(id: string): Promise<boolean> {
  const s = getSession(id);
  if (s?.ui.dirty) {
    const choice = await confirmDialog(
      '저장하지 않은 변경 사항',
      `'${s.record.title}'에 저장하지 않은 변경 사항이 있습니다.\n닫기 전에 저장하시겠습니까?`,
      [
        { label: '취소', value: 'cancel' },
        { label: '저장 안 함', value: 'discard', variant: 'danger' },
        { label: '저장', value: 'save', variant: 'primary' },
      ],
    );
    if (choice === 'cancel') return false;
    if (choice === 'save' && !(await s.save())) return false;
    if (choice === 'discard') drafts.clear(id);
  }
  useTabs.getState().closeTab(id);
  closeSession(id);
  return true;
}

/** 노트가 삭제(휴지통)된 경우 강제 닫기 */
export function forceCloseTab(id: string) {
  drafts.clear(id);
  useTabs.getState().closeTab(id);
  closeSession(id);
}
