import { Mark, mergeAttributes } from '@tiptap/core';

/** 말풍선 주석 앵커 마크: 텍스트 범위에 data-annotation-id 를 부여해 핀 위치를 추적한다 */
export const AnnotationMark = Mark.create({
  name: 'annotation',
  inclusive: false,
  excludes: '',

  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-annotation-id'),
        renderHTML: (attrs) => ({ 'data-annotation-id': attrs.id }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-annotation-id]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { class: 'annotation-anchor' }), 0];
  },

  // 마크다운에는 주석 표시 없이 원문만 기록 (주석 데이터는 노트 메타데이터로 저장)
  renderMarkdown: (node, h) => h.renderChildren(node),
});
