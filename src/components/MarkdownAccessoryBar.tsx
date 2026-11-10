import type { NoteSession } from '../session/NoteSession';
import { isTouchDevice } from '../core/utils/device';
import { useSettings } from '../store/settingsStore';
import {
  Heading1,
  Heading2,
  Heading3,
  Bold,
  Italic,
  Strikethrough,
  List,
  ListOrdered,
  Quote,
  Code2,
} from 'lucide-react';

interface Props {
  session: NoteSession;
  forceShowForTest?: boolean;
}

/**
 * 태블릿/모바일 가상 키보드 환경 마크다운 단축 보조 툴바 (Accessory Bar)
 * - 기호 키패드 전환 없이 원터치로 마크다운 서식 토글 및 기호 삽입 지원
 * - onPointerDown preventDefault를 적용하여 버튼 클릭 시 에디터 포커스 및 selection 보존
 * - 텍스트 입력 모드(tool === 'none')에서만 활성화되어 S-Pen 필기 간섭 완전 배제
 */
export function MarkdownAccessoryBar({ session, forceShowForTest = false }: Props) {
  const isTouch = isTouchDevice();
  const tool = useSettings((s) => s.tool);
  if ((!isTouch || tool !== 'none') && !forceShowForTest) return null;

  const ed = session.editor;
  if (!ed || ed.isDestroyed || session.ui.readOnly) return null;

  const insertMath = () => {
    const { state } = ed;
    const { from, to, empty } = state.selection;
    if (!empty) {
      const selected = state.doc.textBetween(from, to);
      ed.chain().focus().insertContentAt({ from, to }, `$${selected}$`).run();
    } else {
      ed.chain().focus().insertContent('$$').setTextSelection(from + 1).run();
    }
  };

  return (
    <div
      data-testid="markdown-accessory-bar"
      className="markdown-accessory-bar fixed bottom-0 inset-x-0 z-30 flex items-center justify-center gap-1 bg-white/95 backdrop-blur-md border-t border-slate-200/80 px-2 py-1.5 shadow-lg select-none"
      onPointerDown={(e) => e.preventDefault()}
    >
      <div className="flex items-center gap-1 overflow-x-auto max-w-full no-scrollbar py-0.5">
        <button
          type="button"
          data-testid="accessory-btn-h1"
          className="accessory-btn flex items-center justify-center rounded-md px-2 py-1 text-xs font-bold text-slate-700 hover:bg-slate-100 active:bg-slate-200"
          title="제목 1 (H1)"
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => ed.chain().focus().toggleHeading({ level: 1 }).run()}
        >
          <Heading1 size={15} />
        </button>

        <button
          type="button"
          data-testid="accessory-btn-h2"
          className="accessory-btn flex items-center justify-center rounded-md px-2 py-1 text-xs font-bold text-slate-700 hover:bg-slate-100 active:bg-slate-200"
          title="제목 2 (H2)"
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => ed.chain().focus().toggleHeading({ level: 2 }).run()}
        >
          <Heading2 size={15} />
        </button>

        <button
          type="button"
          data-testid="accessory-btn-h3"
          className="accessory-btn flex items-center justify-center rounded-md px-2 py-1 text-xs font-bold text-slate-700 hover:bg-slate-100 active:bg-slate-200"
          title="제목 3 (H3)"
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => ed.chain().focus().toggleHeading({ level: 3 }).run()}
        >
          <Heading3 size={15} />
        </button>

        <div className="h-4 w-px bg-slate-300 mx-0.5" />

        <button
          type="button"
          data-testid="accessory-btn-bold"
          className="accessory-btn flex items-center justify-center rounded-md px-2 py-1 text-xs font-bold text-slate-700 hover:bg-slate-100 active:bg-slate-200"
          title="굵은 글씨 (Bold)"
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => ed.chain().focus().toggleBold().run()}
        >
          <Bold size={15} />
        </button>

        <button
          type="button"
          data-testid="accessory-btn-italic"
          className="accessory-btn flex items-center justify-center rounded-md px-2 py-1 text-xs font-bold text-slate-700 hover:bg-slate-100 active:bg-slate-200"
          title="기울임 (Italic)"
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => ed.chain().focus().toggleItalic().run()}
        >
          <Italic size={15} />
        </button>

        <button
          type="button"
          data-testid="accessory-btn-strike"
          className="accessory-btn flex items-center justify-center rounded-md px-2 py-1 text-xs font-bold text-slate-700 hover:bg-slate-100 active:bg-slate-200"
          title="취소선 (Strike)"
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => ed.chain().focus().toggleStrike().run()}
        >
          <Strikethrough size={15} />
        </button>

        <div className="h-4 w-px bg-slate-300 mx-0.5" />

        <button
          type="button"
          data-testid="accessory-btn-bullet"
          className="accessory-btn flex items-center justify-center rounded-md px-2 py-1 text-xs font-bold text-slate-700 hover:bg-slate-100 active:bg-slate-200"
          title="글머리 기호 (Bullet List)"
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => ed.chain().focus().toggleBulletList().run()}
        >
          <List size={15} />
        </button>

        <button
          type="button"
          data-testid="accessory-btn-ordered"
          className="accessory-btn flex items-center justify-center rounded-md px-2 py-1 text-xs font-bold text-slate-700 hover:bg-slate-100 active:bg-slate-200"
          title="번호 매기기 (Ordered List)"
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => ed.chain().focus().toggleOrderedList().run()}
        >
          <ListOrdered size={15} />
        </button>

        <button
          type="button"
          data-testid="accessory-btn-quote"
          className="accessory-btn flex items-center justify-center rounded-md px-2 py-1 text-xs font-bold text-slate-700 hover:bg-slate-100 active:bg-slate-200"
          title="인용구 (Blockquote)"
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => ed.chain().focus().toggleBlockquote().run()}
        >
          <Quote size={15} />
        </button>

        <button
          type="button"
          data-testid="accessory-btn-code"
          className="accessory-btn flex items-center justify-center rounded-md px-2 py-1 text-xs font-bold text-slate-700 hover:bg-slate-100 active:bg-slate-200"
          title="코드 블록 (CodeBlock)"
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => ed.chain().focus().toggleCodeBlock().run()}
        >
          <Code2 size={15} />
        </button>

        <div className="h-4 w-px bg-slate-300 mx-0.5" />

        <button
          type="button"
          data-testid="accessory-btn-math"
          className="accessory-btn flex items-center justify-center rounded-md px-2 py-1 text-xs font-mono font-bold text-indigo-700 hover:bg-indigo-50 active:bg-indigo-100"
          title="수식 삽입 (LaTeX Math)"
          onPointerDown={(e) => e.preventDefault()}
          onClick={insertMath}
        >
          $수식$
        </button>
      </div>
    </div>
  );
}
