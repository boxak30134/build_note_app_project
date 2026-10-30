import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';

export const ASSIGN_IDS_META = 'eduinkAssignIds';
const BLOCK_TYPES = ['paragraph', 'heading'];

function newBlockId(): string {
  return `b${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(2, 7)}`;
}

/** 단락/제목에 고유 blockId 부여 (위키링크 단락 타깃·검색용). 히스토리에 기록하지 않는다. */
export const BlockId = Extension.create({
  name: 'blockId',

  addGlobalAttributes() {
    return [
      {
        types: BLOCK_TYPES,
        attributes: {
          blockId: {
            default: null,
            keepOnSplit: false,
            parseHTML: (el) => el.getAttribute('data-block-id'),
            renderHTML: (attrs) => (attrs.blockId ? { 'data-block-id': attrs.blockId } : {}),
          },
        },
      },
    ];
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('eduinkBlockId'),
        appendTransaction(transactions, _old, state) {
          if (!transactions.some((t) => t.docChanged || t.getMeta(ASSIGN_IDS_META))) return null;
          const seen = new Set<string>();
          const tr = state.tr;
          let changed = false;
          state.doc.descendants((node, pos) => {
            if (!BLOCK_TYPES.includes(node.type.name)) return true;
            const id = node.attrs.blockId as string | null;
            if (!id || seen.has(id)) {
              const nid = newBlockId();
              tr.setNodeAttribute(pos, 'blockId', nid);
              seen.add(nid);
              changed = true;
            } else seen.add(id);
            return false;
          });
          if (!changed) return null;
          return tr.setMeta('addToHistory', false);
        },
      }),
    ];
  },
});
