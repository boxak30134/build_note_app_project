import { Node, mergeAttributes, InputRule } from '@tiptap/core';

export type AcademicCalloutType =
  | 'theorem'
  | 'lemma'
  | 'proposition'
  | 'corollary'
  | 'definition'
  | 'proof'
  | 'example'
  | 'remark'
  | 'warning'
  | 'note';

export interface CalloutTypeMeta {
  label: string;
  icon: string;
  className: string;
}

export const CALLOUT_META: Record<AcademicCalloutType, CalloutTypeMeta> = {
  theorem: { label: 'Theorem (정리)', icon: '📐', className: 'callout-theorem' },
  lemma: { label: 'Lemma (보조정리)', icon: '📏', className: 'callout-lemma' },
  proposition: { label: 'Proposition (명제)', icon: '📌', className: 'callout-proposition' },
  corollary: { label: 'Corollary (따름정리)', icon: '🔗', className: 'callout-corollary' },
  definition: { label: 'Definition (정의)', icon: '📖', className: 'callout-definition' },
  proof: { label: 'Proof (증명)', icon: '✒️', className: 'callout-proof' },
  example: { label: 'Example (예제)', icon: '💡', className: 'callout-example' },
  remark: { label: 'Remark (주해)', icon: '💬', className: 'callout-remark' },
  warning: { label: 'Warning (주의)', icon: '⚠️', className: 'callout-warning' },
  note: { label: 'Note (노트)', icon: '📝', className: 'callout-note' },
};

export function resolveCalloutMeta(rawType: string): CalloutTypeMeta {
  const key = (rawType || 'note').trim().toLowerCase() as AcademicCalloutType;
  if (key in CALLOUT_META) {
    return CALLOUT_META[key];
  }
  const capitalized = rawType ? rawType.charAt(0).toUpperCase() + rawType.slice(1).toLowerCase() : 'Note';
  return {
    label: capitalized,
    icon: '📝',
    className: 'callout-note',
  };
}

export interface ParsedCalloutHeader {
  calloutType: string;
  foldMarker: '' | '+' | '-';
  collapsed: boolean;
  title: string;
}

export function parseCalloutHeaderLine(line: string): ParsedCalloutHeader | null {
  const m = /^>[ \t]*\[!([a-zA-Z0-9_-]+)\]([+-])?(?:[ \t]+([^\n]*))?$/.exec(line.trim());
  if (!m) return null;
  const calloutType = m[1].toLowerCase();
  const foldMarker = (m[2] as '+' | '-' | undefined) ?? '';
  const collapsed = foldMarker === '-';
  const title = (m[3] ?? '').trim();
  return { calloutType, foldMarker, collapsed, title };
}

/**
 * 학술 콜아웃 블록 확장: > [!theorem], > [!proof], > [!definition] 및 접기/펼치기(+/-) 지원
 */
export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,

  addAttributes() {
    return {
      calloutType: {
        default: 'note',
        parseHTML: (el) => (el as HTMLElement).getAttribute('data-callout-type') ?? 'note',
      },
      title: {
        default: '',
        parseHTML: (el) => (el as HTMLElement).getAttribute('data-callout-title') ?? '',
      },
      collapsed: {
        default: false,
        parseHTML: (el) => (el as HTMLElement).getAttribute('data-collapsed') === 'true',
      },
      foldMarker: {
        default: '',
        parseHTML: (el) => (el as HTMLElement).getAttribute('data-fold-marker') ?? '',
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-callout]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const cType = String(node.attrs.calloutType || 'note').toLowerCase();
    const meta = resolveCalloutMeta(cType);
    const collapsed = Boolean(node.attrs.collapsed);
    const title = String(node.attrs.title || '');
    const foldMarker = String(node.attrs.foldMarker || (collapsed ? '-' : '+'));

    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-callout': '',
        'data-callout-type': cType,
        'data-callout-title': title,
        'data-collapsed': collapsed ? 'true' : 'false',
        'data-fold-marker': foldMarker,
        class: `callout-block ${meta.className} ${collapsed ? 'is-collapsed' : ''}`,
      }),
      0,
    ];
  },

  addNodeView() {
    return ({ node, getPos, editor }) => {
      let currentNode = node;

      const dom = document.createElement('div');
      const header = document.createElement('div');
      header.className = 'callout-header';
      header.contentEditable = 'false';

      const badge = document.createElement('span');
      badge.className = 'callout-badge';

      const titleSpan = document.createElement('span');
      titleSpan.className = 'callout-title';

      const foldBtn = document.createElement('button');
      foldBtn.type = 'button';
      foldBtn.className = 'callout-fold-btn';
      foldBtn.setAttribute('data-testid', 'callout-fold-toggle');

      header.appendChild(badge);
      header.appendChild(titleSpan);
      header.appendChild(foldBtn);

      const contentDOM = document.createElement('div');
      contentDOM.className = 'callout-content';

      dom.appendChild(header);
      dom.appendChild(contentDOM);

      const syncUI = (n: typeof currentNode) => {
        const cType = String(n.attrs.calloutType || 'note').toLowerCase();
        const meta = resolveCalloutMeta(cType);
        const collapsed = Boolean(n.attrs.collapsed);
        const title = String(n.attrs.title || '');
        const foldMarker = String(n.attrs.foldMarker || '');

        dom.className = `callout-block ${meta.className} ${collapsed ? 'is-collapsed' : ''}`;
        dom.setAttribute('data-callout', '');
        dom.setAttribute('data-callout-type', cType);
        dom.setAttribute('data-callout-title', title);
        dom.setAttribute('data-collapsed', collapsed ? 'true' : 'false');
        dom.setAttribute('data-fold-marker', foldMarker);

        badge.textContent = `${meta.icon} ${meta.label}`;
        titleSpan.textContent = title ? ` · ${title}` : '';

        foldBtn.textContent = collapsed ? '+' : '-';
        foldBtn.title = collapsed ? '콜아웃 펼치기 (+)' : '콜아웃 접기 (-)';
        foldBtn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        contentDOM.style.display = collapsed ? 'none' : '';
      };

      syncUI(currentNode);

      foldBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const nextCollapsed = !Boolean(currentNode.attrs.collapsed);
        const nextMarker = nextCollapsed ? '-' : '+';
        const pos = typeof getPos === 'function' ? getPos() : null;
        if (pos != null && !editor.isDestroyed) {
          const tr = editor.state.tr.setNodeMarkup(pos, undefined, {
            ...currentNode.attrs,
            collapsed: nextCollapsed,
            foldMarker: nextMarker,
          });
          editor.view.dispatch(tr);
        } else {
          dom.setAttribute('data-collapsed', nextCollapsed ? 'true' : 'false');
          foldBtn.textContent = nextCollapsed ? '+' : '-';
          contentDOM.style.display = nextCollapsed ? 'none' : '';
        }
      });

      return {
        dom,
        contentDOM,
        update: (updatedNode) => {
          if (updatedNode.type.name !== 'callout') return false;
          currentNode = updatedNode;
          syncUI(currentNode);
          return true;
        },
      };
    };
  },

  addInputRules() {
    return [
      new InputRule({
        find: /^>[ \t]*\[!([a-zA-Z0-9_-]+)\]([+-])?(?:[ \t]+([^\n]+))?\s$/,
        handler: ({ state, range, match }) => {
          const calloutType = match[1].toLowerCase();
          const foldMarker = (match[2] as '+' | '-' | undefined) ?? '';
          const collapsed = foldMarker === '-';
          const title = (match[3] ?? '').trim();
          const $from = state.doc.resolve(range.from);
          const start = $from.before();
          const end = $from.after();
          const paragraphType = state.schema.nodes.paragraph;
          const node = this.type.create(
            { calloutType, foldMarker, collapsed, title },
            paragraphType ? [paragraphType.create()] : [],
          );
          state.tr.replaceWith(start, end, node);
        },
      }),
    ];
  },

  markdownTokenizer: {
    name: 'callout',
    level: 'block',
    start: (src: string) => {
      const m = /(?:^|\n)>[ \t]*\[![a-zA-Z0-9_-]+\]/.exec(src);
      return m ? m.index + (m[0].startsWith('\n') ? 1 : 0) : -1;
    },
    tokenize: (src, _tokens, lexer) => {
      const m = /^>[ \t]*\[!([a-zA-Z0-9_-]+)\]([+-])?(?:[ \t]+([^\n]*))?(?:\n((?:>[ \t]?[^\n]*(?:\n|$))*))?/.exec(src);
      if (!m) return undefined;
      const calloutType = m[1].toLowerCase();
      const foldMarker = (m[2] as '+' | '-' | undefined) ?? '';
      const collapsed = foldMarker === '-';
      const title = (m[3] ?? '').trim();
      const rawBody = m[4] ?? '';
      const strippedBody = rawBody
        .split('\n')
        .map((line) => line.replace(/^>[ \t]?/, ''))
        .join('\n')
        .trim();
      const childTokens = strippedBody ? lexer.blockTokens(strippedBody) : [];
      return {
        type: 'callout',
        raw: m[0],
        calloutType,
        foldMarker,
        collapsed,
        title,
        tokens: childTokens,
      };
    },
  },

  markdownTokenName: 'callout',

  parseMarkdown: (token, h) => {
    const children = Array.isArray(token.tokens) && token.tokens.length > 0
      ? h.parseChildren(token.tokens)
      : [h.createNode('paragraph', {}, [])];
    return h.createNode(
      'callout',
      {
        calloutType: token.calloutType ?? 'note',
        foldMarker: token.foldMarker ?? '',
        collapsed: Boolean(token.collapsed),
        title: token.title ?? '',
      },
      children,
    );
  },

  renderMarkdown: (node, h) => {
    const a = node.attrs ?? {};
    const cType = a.calloutType || 'note';
    const marker = a.collapsed ? '-' : (a.foldMarker || '');
    const titlePart = a.title ? ` ${a.title}` : '';
    const header = `> [!${cType}]${marker}${titlePart}`;
    const renderedBody = h.renderChildren(node.content ?? []).trim();
    if (!renderedBody) {
      return `${header}\n> `;
    }
    const quotedLines = renderedBody
      .split('\n')
      .map((line: string) => (line.trim().length > 0 ? `> ${line}` : '>'))
      .join('\n');
    return `${header}\n${quotedLines}`;
  },
});
