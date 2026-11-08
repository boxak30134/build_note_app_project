import { Node, mergeAttributes } from '@tiptap/core';
import { PluginKey } from '@tiptap/pm/state';
import Suggestion, { type SuggestionProps, type SuggestionKeyDownProps } from '@tiptap/suggestion';
import { create } from 'zustand';
import { db } from '../../storage/db';
import { extractBlocks } from '../../core/doc/blocks';

export interface WikiItem {
  noteId: string;
  blockId: string | null;
  title: string;
  text: string | null; // null 이면 문서 자체
}

interface WikiSuggestState {
  open: boolean;
  items: WikiItem[];
  index: number;
  query: string;
  rect: DOMRect | null;
  select: ((item: WikiItem) => void) | null;
}

export const useWikiSuggest = create<WikiSuggestState>(() => ({
  open: false,
  items: [],
  index: 0,
  query: '',
  rect: null,
  select: null,
}));

/** 내부 노트 + 단락 검색 (제목 일치 문서와 단락을 실시간 필터링) */
export async function searchWikiTargets(query: string, limit = 12): Promise<WikiItem[]> {
  const q = query.trim().toLowerCase();
  const notes = await db.notes.filter((n) => !n.deletedAt).toArray();
  const docs: WikiItem[] = [];
  const blocks: WikiItem[] = [];
  for (const n of notes) {
    const titleHit = !q || n.title.toLowerCase().includes(q);
    if (titleHit) docs.push({ noteId: n.id, blockId: null, title: n.title, text: null });
    if (!q) continue;
    for (const b of extractBlocks(n.content)) {
      if (b.text.toLowerCase().includes(q)) blocks.push({ noteId: n.id, blockId: b.blockId, title: n.title, text: b.text });
      if (blocks.length > 40) break;
    }
  }
  return [...docs.slice(0, 6), ...blocks].slice(0, limit);
}

export const wikiSuggestKey = new PluginKey('wikiLinkSuggestion');

/** <WikiLink targetDocId targetBlockId /> 인라인 노드. 마크다운: [[docId#blockId|label]] */
export const WikiLink = Node.create({
  name: 'wikiLink',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      targetDocId: { default: null, parseHTML: (el) => el.getAttribute('data-target-doc') },
      targetBlockId: { default: null, parseHTML: (el) => el.getAttribute('data-target-block') },
      label: { default: '', parseHTML: (el) => el.textContent ?? '' },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-wiki-link]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-wiki-link': '',
        'data-target-doc': node.attrs.targetDocId,
        'data-target-block': node.attrs.targetBlockId ?? '',
        class: 'wiki-link',
        title: '더블클릭하여 열기',
      }),
      node.attrs.label || '링크',
    ];
  },

  renderText({ node }) {
    return node.attrs.label;
  },

  markdownTokenizer: {
    name: 'wikiLink',
    level: 'inline',
    start: (src: string) => {
      const m = /(?<!!)\[\[/.exec(src);
      return m ? m.index : -1;
    },
    tokenize: (src: string) => {
      const m = /^\[\[([^\]|#\n]+)(?:#([^\]|\n]+))?(?:\|([^\]\n]+))?\]\]/.exec(src);
      if (!m) return undefined;
      return { type: 'wikiLink', raw: m[0], docId: m[1].trim(), blockId: m[2]?.trim() ?? null, label: (m[3] ?? m[1]).trim() };
    },
  },
  markdownTokenName: 'wikiLink',
  parseMarkdown: (token, h) => h.createNode('wikiLink', { targetDocId: token.docId, targetBlockId: token.blockId, label: token.label }),
  renderMarkdown: (node) => {
    const a = node.attrs ?? {};
    return `[[${a.targetDocId}${a.targetBlockId ? `#${a.targetBlockId}` : ''}|${a.label ?? ''}]]`;
  },

  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      Suggestion<WikiItem, WikiItem>({
        editor,
        pluginKey: wikiSuggestKey,
        char: '[[',
        allowSpaces: true,
        allowedPrefixes: null,
        items: ({ query }) => searchWikiTargets(query),
        command: ({ editor: ed, range, props }) => {
          const label = props.text ? `${props.title} › ${props.text.slice(0, 24)}${props.text.length > 24 ? '…' : ''}` : props.title;
          // 자동 닫힘 괄호 ']]' 가 뒤에 있으면 함께 제거
          const after = ed.state.doc.textBetween(range.to, Math.min(range.to + 2, ed.state.doc.content.size), '', '');
          const to = after === ']]' ? range.to + 2 : range.to;
          ed.chain()
            .focus()
            .insertContentAt({ from: range.from, to }, [
              { type: 'wikiLink', attrs: { targetDocId: props.noteId, targetBlockId: props.blockId, label } },
              { type: 'text', text: ' ' },
            ])
            .run();
        },
        render: () => {
          const update = (p: SuggestionProps<WikiItem, WikiItem>) =>
            useWikiSuggest.setState((s) => ({
              open: true,
              items: p.items,
              index: s.query === p.query ? Math.min(s.index, Math.max(0, p.items.length - 1)) : 0,
              query: p.query,
              rect: p.clientRect?.() ?? null,
              select: (item) => p.command(item),
            }));
          return {
            onStart: update,
            onUpdate: update,
            onExit: () => useWikiSuggest.setState({ open: false, items: [], select: null, rect: null }),
            onKeyDown: ({ event }: SuggestionKeyDownProps) => {
              const st = useWikiSuggest.getState();
              if (!st.open) return false;
              if (event.key === 'ArrowDown') {
                useWikiSuggest.setState({ index: (st.index + 1) % Math.max(1, st.items.length) });
                return true;
              }
              if (event.key === 'ArrowUp') {
                useWikiSuggest.setState({ index: (st.index - 1 + st.items.length) % Math.max(1, st.items.length) });
                return true;
              }
              if (event.key === 'Enter' || event.key === 'Tab') {
                const item = st.items[st.index];
                if (item && st.select) {
                  st.select(item);
                  return true;
                }
                return false;
              }
              if (event.key === 'Escape') {
                useWikiSuggest.setState({ open: false });
                return true;
              }
              return false;
            },
          };
        },
      }),
    ];
  },
});
