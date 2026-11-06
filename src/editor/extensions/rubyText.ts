import { Node, mergeAttributes } from '@tiptap/core';

/**
 * 인라인 루비 번역 주석 노드: <ruby>원문<rt>번역어</rt></ruby>
 */
export const RubyText = Node.create({
  name: 'rubyText',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      base: { default: '' },
      rt: { default: '' },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'ruby',
        getAttrs: (el) => {
          const e = el as HTMLElement;
          const rtEl = e.querySelector('rt');
          const rt = e.getAttribute('data-rt') || rtEl?.textContent || '';
          let base = e.getAttribute('data-base') || '';
          if (!base) {
            const clone = e.cloneNode(true) as HTMLElement;
            clone.querySelectorAll('rt, rp').forEach((n) => n.remove());
            base = clone.textContent || '';
          }
          return { base, rt };
        },
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'ruby',
      mergeAttributes(HTMLAttributes, {
        'data-ruby': '',
        'data-base': node.attrs.base,
        'data-rt': node.attrs.rt,
        class: 'ruby-annotation',
      }),
      node.attrs.base,
      ['rt', { class: 'ruby-rt' }, node.attrs.rt],
    ];
  },

  renderMarkdown: (node) => `<ruby>${node.attrs?.base ?? ''}<rt>${node.attrs?.rt ?? ''}</rt></ruby>`,
});

