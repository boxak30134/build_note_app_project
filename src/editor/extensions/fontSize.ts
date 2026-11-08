import { Mark, mergeAttributes } from '@tiptap/core';

/** 선택 영역 또는 텍스트에 개별 폰트 크기를 적용할 수 있는 인라인 마크 */
export const FontSizeMark = Mark.create({
  name: 'fontSize',

  addAttributes() {
    return {
      size: {
        default: null,
        parseHTML: (el) => (el as HTMLElement).style?.fontSize || el.getAttribute('data-font-size'),
        renderHTML: (attrs) => {
          if (!attrs.size) return {};
          const sizeVal = typeof attrs.size === 'number' ? `${attrs.size}px` : attrs.size;
          return {
            'data-font-size': sizeVal,
            style: `font-size: ${sizeVal}`,
          };
        },
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-font-size]' }, { style: 'font-size' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes), 0];
  },

  renderMarkdown: (node, h) => h.renderChildren(node),
});

