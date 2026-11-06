import Image from '@tiptap/extension-image';
import { Node, mergeAttributes } from '@tiptap/core';
import { attachmentUrl } from '../../storage/opfs';

function isRelative(src: string) {
  return !!src && !/^(https?:|data:|blob:)/i.test(src);
}

export interface NoteImageOptions {
  noteId: string;
}

/** ![](images/...) 상대 경로를 OPFS 에서 해석해 표시하는 이미지 노드 */
export const NoteImage = Image.extend<NoteImageOptions & Record<string, unknown>>({
  addOptions() {
    return { ...this.parent?.(), noteId: '', inline: false, allowBase64: true } as never;
  },
  addNodeView() {
    const noteId = (this.options as unknown as NoteImageOptions).noteId;
    return ({ node }) => {
      const dom = document.createElement('img');
      dom.className = 'note-image';
      dom.draggable = false;
      const apply = (src: string, alt: string) => {
        dom.alt = alt ?? '';
        if (isRelative(src)) {
          dom.src = '';
          void attachmentUrl(noteId, src).then((url) => {
            if (url) dom.src = url;
            else dom.alt = `이미지를 찾을 수 없음: ${src}`;
          });
        } else dom.src = src;
      };
      apply(node.attrs.src, node.attrs.alt);
      return {
        dom,
        update: (n) => {
          if (n.type.name !== 'image') return false;
          apply(n.attrs.src, n.attrs.alt);
          return true;
        },
      };
    };
  },
});

/**
 * 손글씨 페이지 캔버스 템플릿: 가져온 PDF 페이지의 손글씨 벡터만 렌더링한 배경.
 * 문서 흐름 안에 페이지 비율만큼 공간을 차지하고, 그 위로 Layer 2 잉크 캔버스에서 이어서 필기할 수 있다.
 */
export const InkTemplate = Node.create<NoteImageOptions>({
  name: 'inkTemplate',
  group: 'block',
  atom: true,
  selectable: true,

  addOptions() {
    return { noteId: '' };
  },

  addAttributes() {
    return { src: { default: '' }, width: { default: 595 }, height: { default: 842 }, page: { default: 1 } };
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-ink-template]',
        getAttrs: (el) => {
          const e = el as HTMLElement;
          return { src: e.getAttribute('data-src'), width: Number(e.getAttribute('data-width')), height: Number(e.getAttribute('data-height')), page: Number(e.getAttribute('data-page')) };
        },
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, { 'data-ink-template': '', 'data-src': node.attrs.src, 'data-width': node.attrs.width, 'data-height': node.attrs.height, 'data-page': node.attrs.page }),
      `손글씨 페이지 ${node.attrs.page}`,
    ];
  },

  addNodeView() {
    const noteId = this.options.noteId;
    return ({ node }) => {
      const dom = document.createElement('div');
      dom.className = 'ink-template';
      dom.contentEditable = 'false';
      dom.style.aspectRatio = `${node.attrs.width} / ${node.attrs.height}`;
      dom.dataset.inkTemplate = '';
      dom.id = `pdf-page-${node.attrs.page}`;
      dom.dataset.page = String(node.attrs.page);

      const badge = document.createElement('div');
      badge.className = 'ink-template-badge';
      badge.textContent = `${node.attrs.page}쪽`;
      dom.append(badge);

      const img = document.createElement('img');
      img.alt = `페이지 ${node.attrs.page}`;
      img.draggable = false;
      dom.append(img);
      void attachmentUrl(noteId, node.attrs.src).then((url) => {
        if (url) img.src = url;
      });
      return { dom };
    };
  },

  renderMarkdown: (node) => `![손글씨 페이지 ${node.attrs?.page ?? ''}](${node.attrs?.src ?? ''})`,
});

/** OPFS 에 저장된 PDF 임베디드 뷰어 노드 */
export const PdfEmbed = Node.create<NoteImageOptions>({
  name: 'pdfEmbed',
  group: 'block',
  atom: true,
  draggable: true,

  addOptions() {
    return { noteId: '' };
  },

  addAttributes() {
    return { src: { default: '' }, name: { default: 'document.pdf' } };
  },

  parseHTML() {
    return [{ tag: 'div[data-pdf-embed]', getAttrs: (el) => ({ src: (el as HTMLElement).getAttribute('data-src'), name: (el as HTMLElement).getAttribute('data-name') }) }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-pdf-embed': '', 'data-src': node.attrs.src, 'data-name': node.attrs.name }), `📄 ${node.attrs.name}`];
  },

  addNodeView() {
    const noteId = this.options.noteId;
    return ({ node }) => {
      const dom = document.createElement('div');
      dom.className = 'pdf-embed';
      dom.contentEditable = 'false';
      const header = document.createElement('div');
      header.className = 'pdf-embed-header';
      header.textContent = `📄 ${node.attrs.name}`;
      const frame = document.createElement('iframe');
      frame.title = node.attrs.name;
      dom.append(header, frame);
      void attachmentUrl(noteId, node.attrs.src).then((url) => {
        if (url) frame.src = url;
        else header.textContent = `📄 ${node.attrs.name} (파일을 찾을 수 없음)`;
      });
      return { dom };
    };
  },

  renderMarkdown: (node) => `[📄 ${node.attrs?.name ?? 'PDF'}](${node.attrs?.src ?? ''})`,
});
