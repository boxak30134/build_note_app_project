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
    return {
      src: { default: '' },
      width: { default: 595 },
      height: { default: 842 },
      page: { default: 1 },
      style: { default: 'plain' },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-ink-template]',
        getAttrs: (el) => {
          const e = el as HTMLElement;
          return {
            src: e.getAttribute('data-src') ?? '',
            width: Number(e.getAttribute('data-width')) || 595,
            height: Number(e.getAttribute('data-height')) || 842,
            page: Number(e.getAttribute('data-page')) || 1,
            style: e.getAttribute('data-style') || 'plain',
          };
        },
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-ink-template': '',
        'data-src': node.attrs.src ?? '',
        'data-width': node.attrs.width,
        'data-height': node.attrs.height,
        'data-page': node.attrs.page,
        'data-style': node.attrs.style ?? 'plain',
      }),
      `손글씨 페이지 ${node.attrs.page}`,
    ];
  },

  addNodeView() {
    const noteId = this.options.noteId;
    return ({ node }) => {
      const dom = document.createElement('div');
      dom.contentEditable = 'false';
      dom.dataset.inkTemplate = '';

      const badge = document.createElement('div');
      badge.className = 'ink-template-badge';
      dom.append(badge);

      let imgEl: HTMLImageElement | null = null;
      let loadedSrc = '';

      const applyAttrs = (attrs: Record<string, unknown>) => {
        const pageNum = Number(attrs.page) || 1;
        const width = Number(attrs.width) || 595;
        const height = Number(attrs.height) || 842;
        const style = String(attrs.style || 'plain');
        const src = String(attrs.src || '');

        dom.className = `ink-template page-canvas-surface page-style-${style}`;
        dom.style.aspectRatio = `${width} / ${height}`;
        dom.style.width = '100%';
        dom.id = `pdf-page-${pageNum}`;
        dom.dataset.page = String(pageNum);
        dom.dataset.src = src;
        dom.dataset.width = String(width);
        dom.dataset.height = String(height);
        dom.dataset.style = style;
        badge.textContent = `${pageNum}쪽`;

        if (src) {
          if (!imgEl) {
            imgEl = document.createElement('img');
            imgEl.draggable = false;
            dom.append(imgEl);
          }
          imgEl.alt = `페이지 ${pageNum}`;
          if (loadedSrc !== src) {
            loadedSrc = src;
            if (isRelative(src)) {
              void attachmentUrl(noteId, src).then((url) => {
                if (url && imgEl && loadedSrc === src) imgEl.src = url;
              });
            } else {
              imgEl.src = src;
            }
          }
        } else if (imgEl) {
          imgEl.remove();
          imgEl = null;
          loadedSrc = '';
        }
      };

      applyAttrs(node.attrs as Record<string, unknown>);

      return {
        dom,
        update: (updatedNode) => {
          if (updatedNode.type.name !== 'inkTemplate') return false;
          applyAttrs(updatedNode.attrs as Record<string, unknown>);
          return true;
        },
      };
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
