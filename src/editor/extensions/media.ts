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
