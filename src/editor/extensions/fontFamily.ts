import { Mark, mergeAttributes } from '@tiptap/core';

/** 선택 영역에 개별 폰트 패밀리를 적용할 수 있는 인라인 마크 */
export const FontFamilyMark = Mark.create({
  name: 'fontFamily',

  addAttributes() {
    return {
      family: {
        default: null,
        parseHTML: (el) => (el as HTMLElement).style?.fontFamily || el.getAttribute('data-font-family'),
        renderHTML: (attrs) => {
          if (!attrs.family) return {};
          return {
            'data-font-family': attrs.family,
            style: `font-family: ${attrs.family}`,
          };
        },
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-font-family]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes), 0];
  },

  renderMarkdown: (node, h) => h.renderChildren(node),
});
