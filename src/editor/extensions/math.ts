import { Node, mergeAttributes, InputRule } from '@tiptap/core';
import katex from 'katex';

function renderKatex(el: HTMLElement, latex: string, displayMode: boolean) {
  try {
    katex.render(latex || '\\square', el, { throwOnError: false, displayMode });
  } catch {
    el.textContent = latex;
  }
}

function editLatex(current: string): string | null {
  const v = window.prompt('LaTeX 수식 편집', current);
  return v === null ? null : v;
}

/** 인라인 수식 $...$ */
export const InlineMath = Node.create({
  name: 'inlineMath',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return { latex: { default: '' } };
  },

  parseHTML() {
    return [{ tag: 'span[data-inline-math]', getAttrs: (el) => ({ latex: (el as HTMLElement).getAttribute('data-latex') ?? '' }) }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-inline-math': '', 'data-latex': node.attrs.latex }), `$${node.attrs.latex}$`];
  },

  addNodeView() {
    return ({ node, getPos, editor }) => {
      const dom = document.createElement('span');
      dom.className = 'math-inline';
      dom.contentEditable = 'false';
      renderKatex(dom, node.attrs.latex, false);
      dom.addEventListener('dblclick', () => {
        const v = editLatex(node.attrs.latex);
        const pos = typeof getPos === 'function' ? getPos() : null;
        if (v !== null && pos != null) editor.view.dispatch(editor.state.tr.setNodeAttribute(pos, 'latex', v));
      });
      return {
        dom,
        update: (n) => {
          if (n.type.name !== 'inlineMath') return false;
          renderKatex(dom, n.attrs.latex, false);
          node = n;
          return true;
        },
      };
    };
  },

  addInputRules() {
    return [
      new InputRule({
        find: /(?:^|[^$\\])\$([^$\s][^$]*?)\$$/,
        handler: ({ state, range, match }) => {
          const latex = match[1];
          const start = range.from + (match[0].startsWith('$') ? 0 : 1);
          state.tr.replaceWith(start, range.to, this.type.create({ latex }));
        },
      }),
    ];
  },

  markdownTokenizer: {
    name: 'inlineMath',
    level: 'inline',
    start: (src: string) => src.indexOf('$'),
    tokenize: (src: string) => {
      const m = /^\$(?!\$)([^$\n]+?)\$/.exec(src);
      if (!m) return undefined;
      return { type: 'inlineMath', raw: m[0], latex: m[1] };
    },
  },
  markdownTokenName: 'inlineMath',
  parseMarkdown: (token, h) => h.createNode('inlineMath', { latex: token.latex }),
  renderMarkdown: (node) => `$${node.attrs?.latex ?? ''}$`,
});

/** 블록 수식 $$...$$ */
export const BlockMath = Node.create({
  name: 'blockMath',
  group: 'block',
  atom: true,

  addAttributes() {
    return { latex: { default: '' } };
  },

  parseHTML() {
    return [{ tag: 'div[data-block-math]', getAttrs: (el) => ({ latex: (el as HTMLElement).getAttribute('data-latex') ?? '' }) }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-block-math': '', 'data-latex': node.attrs.latex }), `$$${node.attrs.latex}$$`];
  },

  addNodeView() {
    return ({ node, getPos, editor }) => {
      const dom = document.createElement('div');
      dom.className = 'math-block';
      dom.contentEditable = 'false';
      renderKatex(dom, node.attrs.latex, true);
      dom.addEventListener('dblclick', () => {
        const v = editLatex(node.attrs.latex);
        const pos = typeof getPos === 'function' ? getPos() : null;
        if (v !== null && pos != null) editor.view.dispatch(editor.state.tr.setNodeAttribute(pos, 'latex', v));
      });
      return {
        dom,
        update: (n) => {
          if (n.type.name !== 'blockMath') return false;
          renderKatex(dom, n.attrs.latex, true);
          return true;
        },
      };
    };
  },

  addInputRules() {
    return [
      new InputRule({
        find: /^\$\$([^$]+)\$\$$/,
        handler: ({ state, range, match }) => {
          const $from = state.doc.resolve(range.from);
          const start = $from.before();
          const end = $from.after();
          state.tr.replaceWith(start, end, this.type.create({ latex: match[1] }));
        },
      }),
    ];
  },

  markdownTokenizer: {
    name: 'blockMath',
    level: 'block',
    start: (src: string) => src.indexOf('$$'),
    tokenize: (src: string) => {
      const m = /^\$\$\s*\n?([\s\S]+?)\n?\s*\$\$(?:\n|$)/.exec(src);
      if (!m) return undefined;
      return { type: 'blockMath', raw: m[0], latex: m[1].trim() };
    },
  },
  markdownTokenName: 'blockMath',
  parseMarkdown: (token, h) => h.createNode('blockMath', { latex: token.latex }),
  renderMarkdown: (node) => `$$\n${node.attrs?.latex ?? ''}\n$$`,
});
