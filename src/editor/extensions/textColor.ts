import { Mark, mergeAttributes } from '@tiptap/core';

/** 선택 영역 또는 텍스트에 개별 글자 색상을 적용할 수 있는 인라인 마크 */
export const TextColorMark = Mark.create({
  name: 'textColor',

  addAttributes() {
    return {
      color: {
        default: null,
        parseHTML: (el) => (el as HTMLElement).style?.color || el.getAttribute('data-text-color'),
        renderHTML: (attrs) => {
          if (!attrs.color) return {};
          return {
            'data-text-color': attrs.color,
            style: `color: ${attrs.color}`,
          };
        },
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-text-color]' }, { style: 'color' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes), 0];
  },

  renderMarkdown: (node, h) => h.renderChildren(node),
});

