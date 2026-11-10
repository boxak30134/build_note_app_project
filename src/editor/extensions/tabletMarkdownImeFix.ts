import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { isTouchDevice } from '../../core/utils/device';

export const tabletMarkdownImeFixPluginKey = new PluginKey('tabletMarkdownImeFix');

/**
 * 에디터의 현재 커서 위치 직전 텍스트를 검사하여 마크다운 규칙(Heading, Blockquote, List, Bold 등)을
 * 모바일/태블릿 가상 키보드 환경에서 강제 평가하고 자동 변환합니다.
 *
 * @returns 변환이 성공적으로 수행되었으면 true, 아니면 false
 */
export function evaluateMarkdownIme(view: EditorView, force = false): boolean {
  // 데스크톱 PC 환경(물리 키보드)에서는 순정 ProseMirror inputRules를 방해하지 않도록 엄격히 차단
  if (!force && !isTouchDevice()) {
    return false;
  }

  const { state } = view;
  const { selection } = state;
  const { $from } = selection;

  // 선택 영역이 텍스트 블록 내부의 단일 커서인지 확인
  if (!$from.sameParent(selection.$to) || !$from.parent.isTextblock) {
    return false;
  }

  const parent = $from.parent;
  const parentOffset = $from.parentOffset;
  if (parentOffset <= 0) return false;

  const textBefore = parent.textBetween(0, parentOffset);
  if (!textBefore) return false;

  // non-breaking space(\u00A0)를 일반 공백(' ')으로 정규화하여 검사
  const normalizedText = textBefore.replace(/\u00a0/g, ' ');

  // 한글 끝 음절이 조합 중인 일반 한글 입력인 경우(공백이나 마크다운 마감 기호가 아님) 즉시 패스
  // 예: '학교', '안녕', '가' -> 트랜잭션 일체 발생 금지 (커서 튐/중복 입력 원천 차단)
  if (/[ㄱ-ㅎㅏ-ㅣ가-힣]$/.test(normalizedText) && !normalizedText.endsWith('*') && !normalizedText.endsWith('~') && !normalizedText.endsWith('`') && !normalizedText.endsWith('_')) {
    return false;
  }

  const startPos = $from.start();
  const currentPos = $from.pos;
  const schema = state.schema;

  // 1. Heading (#, ##, ###, ####, #####, ###### + 공백)
  if (parent.type.name === 'paragraph') {
    const headingMatch = normalizedText.match(/^(#{1,6})\s$/);
    if (headingMatch && schema.nodes.heading) {
      const level = headingMatch[1].length;
      const matchLen = headingMatch[0].length;
      const tr = state.tr
        .delete(startPos, startPos + matchLen)
        .setBlockType(startPos, startPos, schema.nodes.heading, { level });
      view.dispatch(tr);
      return true;
    }
  }

  // 2. Blockquote (> + 공백)
  if (parent.type.name === 'paragraph') {
    const quoteMatch = normalizedText.match(/^>\s$/);
    if (quoteMatch && schema.nodes.blockquote) {
      const matchLen = quoteMatch[0].length;
      const tr = state.tr.delete(startPos, startPos + matchLen);
      const $afterDelete = tr.doc.resolve(startPos);
      const range = $afterDelete.blockRange();
      if (range) {
        tr.wrap(range, [{ type: schema.nodes.blockquote }]);
      }
      view.dispatch(tr);
      return true;
    }
  }

  // 3. BulletList (- 또는 * + 공백)
  if (parent.type.name === 'paragraph') {
    const bulletMatch = normalizedText.match(/^[-*]\s$/);
    if (bulletMatch && schema.nodes.bulletList && schema.nodes.listItem) {
      const matchLen = bulletMatch[0].length;
      const tr = state.tr.delete(startPos, startPos + matchLen);
      const $afterDelete = tr.doc.resolve(startPos);
      const range = $afterDelete.blockRange();
      if (range) {
        tr.wrap(range, [{ type: schema.nodes.bulletList }, { type: schema.nodes.listItem }]);
      }
      view.dispatch(tr);
      return true;
    }
  }

  // 4. OrderedList (1. + 공백)
  if (parent.type.name === 'paragraph') {
    const orderedMatch = normalizedText.match(/^(\d+)\.\s$/);
    if (orderedMatch && schema.nodes.orderedList && schema.nodes.listItem) {
      const matchLen = orderedMatch[0].length;
      const tr = state.tr.delete(startPos, startPos + matchLen);
      const $afterDelete = tr.doc.resolve(startPos);
      const range = $afterDelete.blockRange();
      if (range) {
        tr.wrap(range, [{ type: schema.nodes.orderedList }, { type: schema.nodes.listItem }]);
      }
      view.dispatch(tr);
      return true;
    }
  }

  // 5. CodeBlock (``` + 공백 또는 줄바꿈)
  if (parent.type.name === 'paragraph') {
    const codeBlockMatch = normalizedText.match(/^```\s?$/);
    if (codeBlockMatch && schema.nodes.codeBlock) {
      const matchLen = codeBlockMatch[0].length;
      const tr = state.tr
        .delete(startPos, startPos + matchLen)
        .setBlockType(startPos, startPos, schema.nodes.codeBlock);
      view.dispatch(tr);
      return true;
    }
  }

  // 6. Inline Mark: Bold (**텍스트**)
  if (schema.marks.bold) {
    const boldMatch = normalizedText.match(/(^|\s)\*\*([^*]+)\*\*(\s)?$/);
    if (boldMatch) {
      const prefix = boldMatch[1] || '';
      const content = boldMatch[2];
      const trailingSpace = boldMatch[3] || '';
      const matchIndex = boldMatch.index ?? 0;
      const from = startPos + matchIndex + prefix.length;
      const to = currentPos;

      const boldMark = schema.marks.bold.create();
      const tr = state.tr.replaceWith(
        from,
        to,
        schema.text(content + trailingSpace, [boldMark]),
      );
      view.dispatch(tr);
      return true;
    }
  }

  // 6-1. Inline Mark: Italic (*텍스트* 또는 _텍스트_)
  if (schema.marks.italic) {
    const italicMatch = normalizedText.match(/(^|\s)(?<!\*)\*([^*]+)\*(?!\*)(\s)?$/) ||
                        normalizedText.match(/(^|\s)_([^_]+)_(\s)?$/);
    if (italicMatch) {
      const prefix = italicMatch[1] || '';
      const content = italicMatch[2];
      const trailingSpace = italicMatch[3] || '';
      const matchIndex = italicMatch.index ?? 0;
      const from = startPos + matchIndex + prefix.length;
      const to = currentPos;

      const italicMark = schema.marks.italic.create();
      const tr = state.tr.replaceWith(
        from,
        to,
        schema.text(content + trailingSpace, [italicMark]),
      );
      view.dispatch(tr);
      return true;
    }
  }

  // 7. Inline Mark: Strike (~~텍스트~~)
  if (schema.marks.strike) {
    const strikeMatch = normalizedText.match(/(^|\s)~~([^~]+)~~(\s)?$/);
    if (strikeMatch) {
      const prefix = strikeMatch[1] || '';
      const content = strikeMatch[2];
      const trailingSpace = strikeMatch[3] || '';
      const matchIndex = strikeMatch.index ?? 0;
      const from = startPos + matchIndex + prefix.length;
      const to = currentPos;

      const strikeMark = schema.marks.strike.create();
      const tr = state.tr.replaceWith(
        from,
        to,
        schema.text(content + trailingSpace, [strikeMark]),
      );
      view.dispatch(tr);
      return true;
    }
  }

  // 8. Inline Mark: Code (`코드`)
  if (schema.marks.code) {
    const codeMatch = normalizedText.match(/(^|\s)`([^`]+)`(\s)?$/);
    if (codeMatch) {
      const prefix = codeMatch[1] || '';
      const content = codeMatch[2];
      const trailingSpace = codeMatch[3] || '';
      const matchIndex = codeMatch.index ?? 0;
      const from = startPos + matchIndex + prefix.length;
      const to = currentPos;

      const codeMark = schema.marks.code.create();
      const tr = state.tr.replaceWith(
        from,
        to,
        schema.text(content + trailingSpace, [codeMark]),
      );
      view.dispatch(tr);
      return true;
    }
  }

  return false;
}

export const TabletMarkdownImeFix = Extension.create({
  name: 'tabletMarkdownImeFix',

  addProseMirrorPlugins() {
    let rafId: number | null = null;
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleEval = (view: EditorView) => {
      if (!isTouchDevice()) return;
      if (rafId !== null && typeof cancelAnimationFrame !== 'undefined') {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      if (fallbackTimer !== null) {
        clearTimeout(fallbackTimer);
        fallbackTimer = null;
      }

      const run = () => {
        rafId = null;
        fallbackTimer = null;
        if (!view.isDestroyed) {
          evaluateMarkdownIme(view);
        }
      };

      if (typeof requestAnimationFrame !== 'undefined') {
        rafId = requestAnimationFrame(run);
      } else {
        fallbackTimer = setTimeout(run, 16);
      }
    };

    return [
      new Plugin({
        key: tabletMarkdownImeFixPluginKey,
        props: {
          handleDOMEvents: {
            compositionend(view) {
              scheduleEval(view);
              return false;
            },
            keydown(view, event) {
              if (
                event.key === ' ' ||
                event.key === 'Spacebar' ||
                event.key === 'Enter' ||
                event.keyCode === 32 ||
                event.keyCode === 13 ||
                event.keyCode === 229 // Android IME key code for composition input
              ) {
                scheduleEval(view);
              }
              return false;
            },
            beforeinput(view, event: InputEvent) {
              if (
                event.data === ' ' ||
                event.data === '\n' ||
                event.inputType === 'insertText' ||
                event.inputType === 'insertCompositionText' ||
                event.inputType === 'insertLineBreak' ||
                event.inputType === 'insertParagraph'
              ) {
                scheduleEval(view);
              }
              return false;
            },
          },
        },
      }),
    ];
  },
});
