import { Mark, mergeAttributes } from '@tiptap/core';
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

export const MIN_INLINE_FONT_SIZE = 8;
export const MAX_INLINE_FONT_SIZE = 72;

export const FONT_SIZE_QUICK_PRESETS = [
  { id: 'small', label: '작게', size: 13 },
  { id: 'large', label: '크게', size: 20 },
  { id: 'xlarge', label: '특대', size: 26 },
] as const;

export interface FontSizeImeState {
  composing: boolean;
  /** undefined: 대기 없음, null: 보통(초기화) 대기, string: 적용할 px 문자열 */
  pendingSize: string | null | undefined;
}

export const fontSizeImePluginKey = new PluginKey<FontSizeImeState>('fontSizeIme');

export function clampFontSizePx(value: number): number {
  if (!Number.isFinite(value)) return 16;
  return Math.max(MIN_INLINE_FONT_SIZE, Math.min(MAX_INLINE_FONT_SIZE, Math.round(value)));
}

export function parseFontSizePx(raw: number | string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? clampFontSizePx(raw) : null;
  }
  const cleaned = raw.trim().replace(/;+$/, '');
  if (!cleaned) return null;
  const match = /^(\d+(?:\.\d+)?)\s*(?:px)?$/i.exec(cleaned);
  if (!match) return null;
  return clampFontSizePx(Number(match[1]));
}

export function normalizeFontSizeCss(raw: number | string | null | undefined): string | null {
  const px = parseFontSizePx(raw);
  return px === null ? null : `${px}px`;
}

/** 현재 선택 범위 또는 커서 storedMarks 에 fontSize 마크를 적용/제거하는 트랜잭션을 생성한다. */
export function buildFontSizeTransaction(
  state: EditorState,
  sizeCss: string | null,
  options: { addToHistory?: boolean } = {},
): Transaction | null {
  const fontSizeType = state.schema.marks.fontSize;
  if (!fontSizeType) return null;

  const { from, to, empty, $from } = state.selection;
  const tr = state.tr;
  if (options.addToHistory === false) {
    tr.setMeta('addToHistory', false);
  }

  if (!empty) {
    if (sizeCss === null) {
      tr.removeMark(from, to, fontSizeType);
      tr.removeStoredMark(fontSizeType);
    } else {
      tr.addMark(from, to, fontSizeType.create({ size: sizeCss }));
    }
    return tr;
  }

  const baseMarks = state.storedMarks ?? $from.marks();
  if (sizeCss === null) {
    tr.setStoredMarks(fontSizeType.removeFromSet(baseMarks));
  } else {
    tr.setStoredMarks(fontSizeType.create({ size: sizeCss }).addToSet(baseMarks));
  }
  return tr;
}

/**
 * IME 조합 중이면 pending queue에 적재하고, 일반 상태에서는 즉시 storedMarks/selection 에 적용한다.
 */
export function applyOrQueueFontSize(view: EditorView, rawSize: number | string | null): boolean {
  const sizeCss = rawSize === null ? null : normalizeFontSizeCss(rawSize);
  if (rawSize !== null && !sizeCss) return false;

  const pluginState = fontSizeImePluginKey.getState(view.state);
  const isComposing = view.composing || Boolean(pluginState?.composing);

  if (isComposing) {
    const tr = view.state.tr
      .setMeta(fontSizeImePluginKey, { composing: true, pendingSize: sizeCss })
      .setMeta('addToHistory', false);
    view.dispatch(tr);
    return true;
  }

  const tr = buildFontSizeTransaction(view.state, sizeCss);
  if (!tr) return false;
  view.dispatch(tr);
  return true;
}

/** 에디터 커서(storedMarks 우선, 없으면 현재 위치 marks)에서 활성화된 fontSize(px)를 조회한다. */
export function readCursorFontSizePx(state: EditorState): number | null {
  const fontSizeType = state.schema.marks.fontSize;
  if (!fontSizeType) return null;
  const marks = state.storedMarks ?? state.selection.$from.marks();
  const mark = marks.find((m) => m.type === fontSizeType);
  return parseFontSizePx(mark?.attrs?.size as string | number | null | undefined);
}

const FONT_SIZE_SPAN_RE =
  /^<span\b(?=[^>]*?(?:data-font-size=["']([^"']+)["']|style=["'][^"']*font-size\s*:\s*([^;"']+)[^"']*["']))[^>]*>([\s\S]*?)<\/span>/i;

/** 선택 영역 또는 커서 위치 텍스트에 개별 폰트 크기를 적용할 수 있는 인라인 마크 */
export const FontSizeMark = Mark.create({
  name: 'fontSize',

  inclusive: true,

  addAttributes() {
    return {
      size: {
        default: null,
        parseHTML: (el) => {
          const htmlEl = el as HTMLElement;
          return normalizeFontSizeCss(htmlEl.style?.fontSize || htmlEl.getAttribute('data-font-size'));
        },
        renderHTML: (attrs) => {
          const sizeVal = normalizeFontSizeCss(attrs.size as string | number | null | undefined);
          if (!sizeVal) return {};
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

  markdownTokenName: 'fontSizeSpan',

  markdownTokenizer: {
    name: 'fontSizeSpan',
    level: 'inline',
    start: (src: string) => {
      const idx = src.indexOf('<span');
      return idx >= 0 ? idx : -1;
    },
    tokenize: (src: string, _tokens, lexer) => {
      const match = FONT_SIZE_SPAN_RE.exec(src);
      if (!match) return undefined;
      const sizeCss = normalizeFontSizeCss(match[1] || match[2]);
      if (!sizeCss) return undefined;
      const inner = match[3] ?? '';
      return {
        type: 'fontSizeSpan',
        raw: match[0],
        size: sizeCss,
        tokens: lexer.inlineTokens(inner),
      };
    },
  },

  parseMarkdown: (token, h) => {
    const sizeCss = normalizeFontSizeCss((token as { size?: string }).size);
    const children = h.parseInline(token.tokens ?? []);
    if (!sizeCss) return children;
    return h.applyMark('fontSize', children, { size: sizeCss });
  },

  renderMarkdown: (node, h) => {
    const sizeVal = normalizeFontSizeCss(node.attrs?.size as string | number | null | undefined);
    const content = h.renderChildren(node);
    if (!sizeVal || !content) return content;

    // 줄바꿈(HardBreak 등)이 포함된 경우 줄 경계 전후로 span 태그를 닫고 열어 마크다운 블록 구조를 보호한다.
    if (content.includes('\n')) {
      return content
        .split('\n')
        .map((segment) => {
          if (!segment) return '';
          const hardBreakMatch = segment.match(/^([\s\S]*?)( {2,})$/);
          if (hardBreakMatch && hardBreakMatch[1]) {
            return `<span style="font-size: ${sizeVal};">${hardBreakMatch[1]}</span>${hardBreakMatch[2]}`;
          }
          if (!segment.trim()) return segment;
          return `<span style="font-size: ${sizeVal};">${segment}</span>`;
        })
        .join('\n');
    }

    return `<span style="font-size: ${sizeVal};">${content}</span>`;
  },

  addProseMirrorPlugins() {
    return [
      new Plugin<FontSizeImeState>({
        key: fontSizeImePluginKey,
        state: {
          init: () => ({ composing: false, pendingSize: undefined }),
          apply(tr, prev) {
            const meta = tr.getMeta(fontSizeImePluginKey) as Partial<FontSizeImeState> | undefined;
            if (!meta) return prev;
            return {
              composing: meta.composing !== undefined ? meta.composing : prev.composing,
              pendingSize: 'pendingSize' in meta ? meta.pendingSize : prev.pendingSize,
            };
          },
        },
        props: {
          handleDOMEvents: {
            compositionstart(view) {
              const tr = view.state.tr
                .setMeta(fontSizeImePluginKey, { composing: true })
                .setMeta('addToHistory', false);
              view.dispatch(tr);
              return false;
            },
            compositionend(view) {
              const current = fontSizeImePluginKey.getState(view.state);
              const pending = current?.pendingSize;
              const clearTr = view.state.tr
                .setMeta(fontSizeImePluginKey, { composing: false, pendingSize: undefined })
                .setMeta('addToHistory', false);
              view.dispatch(clearTr);

              if (pending !== undefined && !view.isDestroyed) {
                const applyTr = buildFontSizeTransaction(view.state, pending);
                if (applyTr) {
                  view.dispatch(applyTr);
                }
              }
              return false;
            },
          },
        },
      }),
    ];
  },
});

