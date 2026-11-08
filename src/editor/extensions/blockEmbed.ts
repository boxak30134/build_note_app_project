import { Node, mergeAttributes, InputRule } from '@tiptap/core';
import type { JSONContent } from '@tiptap/core';
import { db } from '../../storage/db';
import { extractBlocks, snippet } from '../../core/doc/blocks';
import { useTabs } from '../../store/tabsStore';

export const MAX_EMBED_DEPTH = 3;

export interface EmbedTargetDoc {
  id: string;
  title: string;
  content: unknown;
  deletedAt?: number | null;
}

export interface TransclusionResult {
  status: 'ok' | 'cycle_blocked' | 'max_depth_exceeded' | 'not_found' | 'block_fallback';
  targetDocId: string | null;
  targetTitle: string;
  blockHeading: string | null;
  excerpt: string;
  warningMessage?: string;
  chain: string[];
}

interface NestedEmbedRef {
  targetDocId: string;
  targetBlockId: string | null;
}

function collectNestedEmbeds(doc: unknown): NestedEmbedRef[] {
  const refs: NestedEmbedRef[] = [];
  const walk = (n: JSONContent) => {
    if (n.type === 'blockEmbed' && n.attrs?.targetDocId) {
      refs.push({
        targetDocId: String(n.attrs.targetDocId),
        targetBlockId: n.attrs.targetBlockId ? String(n.attrs.targetBlockId) : null,
      });
    }
    if (n.type === 'text' && typeof n.text === 'string') {
      const re = /!\[\[([^\]|#\n]+)(?:#([^\]|\n]+))?(?:\|([^\]\n]+))?\]\]/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(n.text)) !== null) {
        refs.push({
          targetDocId: m[1].trim(),
          targetBlockId: m[2]?.trim() ?? null,
        });
      }
    }
    n.content?.forEach(walk);
  };
  if (doc && typeof doc === 'object') {
    walk(doc as JSONContent);
  }
  return refs;
}

/**
 * 동기 트랜스클루전 해석기 (순환 참조 A->A, A->B->A 및 최대 깊이 MAX_EMBED_DEPTH 방어 포함)
 */
export function resolveTransclusionSync(
  sourceDocKey: string,
  targetDocQuery: string,
  targetBlockQuery: string | null,
  docs: EmbedTargetDoc[],
  ancestors: Iterable<string> = [],
  depth = 0,
): TransclusionResult {
  const normSource = sourceDocKey.trim().toLowerCase();
  const normTarget = targetDocQuery.trim().toLowerCase();

  const visited = new Set<string>();
  for (const a of ancestors) {
    if (a.trim()) visited.add(a.trim().toLowerCase());
  }
  if (normSource) {
    visited.add(normSource);
  }

  const activeDocs = docs.filter((d) => !d.deletedAt);
  const sourceDoc = activeDocs.find(
    (d) => d.id.toLowerCase() === normSource || d.title.toLowerCase() === normSource,
  );
  if (sourceDoc) {
    visited.add(sourceDoc.id.toLowerCase());
    visited.add(sourceDoc.title.toLowerCase());
  }

  const chainLabels = [...new Set([sourceDoc?.title || sourceDocKey, targetDocQuery].filter(Boolean))];

  // 1. 직접 자기 참조 또는 이미 방문한 조상 문서 재참조 차단
  if (normTarget && visited.has(normTarget)) {
    return {
      status: 'cycle_blocked',
      targetDocId: targetDocQuery,
      targetTitle: targetDocQuery,
      blockHeading: targetBlockQuery,
      excerpt: '',
      warningMessage: `⚠️ 순환 참조 방어: [${chainLabels.join(' → ')}] 임베드가 차단되었습니다.`,
      chain: chainLabels,
    };
  }

  // 2. 최대 중첩 깊이(MAX_EMBED_DEPTH) 초과 방어
  if (depth >= MAX_EMBED_DEPTH) {
    return {
      status: 'max_depth_exceeded',
      targetDocId: targetDocQuery,
      targetTitle: targetDocQuery,
      blockHeading: targetBlockQuery,
      excerpt: '',
      warningMessage: `⚠️ 최대 임베드 깊이(${MAX_EMBED_DEPTH}단계)를 초과하여 임베드를 생략했습니다.`,
      chain: chainLabels,
    };
  }

  // 3. 대상 문서 검색
  const targetDoc = activeDocs.find(
    (d) => d.id.toLowerCase() === normTarget || d.title.toLowerCase() === normTarget,
  );
  if (!targetDoc) {
    return {
      status: 'not_found',
      targetDocId: null,
      targetTitle: targetDocQuery,
      blockHeading: targetBlockQuery,
      excerpt: '',
      warningMessage: `⚠️ 참조된 문서를 찾을 수 없습니다: ${targetDocQuery}`,
      chain: chainLabels,
    };
  }

  // 대상 문서의 ID 또는 제목이 조상 집합에 존재하는지 재확인
  if (visited.has(targetDoc.id.toLowerCase()) || visited.has(targetDoc.title.toLowerCase())) {
    const fullChain = [...chainLabels];
    return {
      status: 'cycle_blocked',
      targetDocId: targetDoc.id,
      targetTitle: targetDoc.title,
      blockHeading: targetBlockQuery,
      excerpt: '',
      warningMessage: `⚠️ 순환 참조 방어: [${fullChain.join(' → ')}] 임베드가 차단되었습니다.`,
      chain: fullChain,
    };
  }

  // 4. 대상 문서 내부의 하위 임베드(A -> B -> A 등 다중 홉) 검사
  const nextVisited = new Set(visited);
  nextVisited.add(targetDoc.id.toLowerCase());
  nextVisited.add(targetDoc.title.toLowerCase());

  const nestedRefs = collectNestedEmbeds(targetDoc.content);
  for (const ref of nestedRefs) {
    const subRes = resolveTransclusionSync(
      targetDoc.id,
      ref.targetDocId,
      ref.targetBlockId,
      activeDocs,
      nextVisited,
      depth + 1,
    );
    if (subRes.status === 'cycle_blocked' || subRes.status === 'max_depth_exceeded') {
      const fullChain = [sourceDoc?.title || sourceDocKey, targetDoc.title, ref.targetDocId].filter(Boolean);
      return {
        status: subRes.status,
        targetDocId: targetDoc.id,
        targetTitle: targetDoc.title,
        blockHeading: targetBlockQuery,
        excerpt: '',
        warningMessage:
          subRes.status === 'cycle_blocked'
            ? `⚠️ 순환 참조 방어: [${fullChain.join(' → ')}] 임베드가 차단되었습니다.`
            : subRes.warningMessage,
        chain: fullChain,
      };
    }
  }

  // 5. 단락(#block) 추출
  const blocks = extractBlocks(targetDoc.content);
  if (targetBlockQuery && targetBlockQuery.trim()) {
    const bq = targetBlockQuery.trim().toLowerCase();
    const matched = blocks.find(
      (b) => (b.blockId && b.blockId.toLowerCase() === bq) || b.text.toLowerCase().includes(bq),
    );
    if (matched) {
      return {
        status: 'ok',
        targetDocId: targetDoc.id,
        targetTitle: targetDoc.title,
        blockHeading: targetBlockQuery,
        excerpt: snippet(matched.text, 360),
        chain: [...chainLabels],
      };
    }
    return {
      status: 'block_fallback',
      targetDocId: targetDoc.id,
      targetTitle: targetDoc.title,
      blockHeading: targetBlockQuery,
      excerpt: snippet(blocks[0]?.text ?? '(빈 문서)', 360),
      warningMessage: `요청한 단락(#${targetBlockQuery})을 찾을 수 없어 문서 요약으로 표시합니다.`,
      chain: [...chainLabels],
    };
  }

  const combined = blocks.map((b) => b.text).join('\n');
  return {
    status: 'ok',
    targetDocId: targetDoc.id,
    targetTitle: targetDoc.title,
    blockHeading: null,
    excerpt: snippet(combined || '(빈 문서)', 360),
    chain: [...chainLabels],
  };
}

export async function resolveTransclusionFromDb(
  sourceDocKey: string,
  targetDocQuery: string,
  targetBlockQuery: string | null,
  ancestors: Iterable<string> = [],
  depth = 0,
): Promise<TransclusionResult> {
  const notes = await db.notes.filter((n) => !n.deletedAt).toArray();
  return resolveTransclusionSync(sourceDocKey, targetDocQuery, targetBlockQuery, notes, ancestors, depth);
}

/**
 * 블록 인라인 임베드(Transclusion) 확장: ![[문서제목#단락|표시라벨]]
 */
export const BlockEmbed = Node.create<{ noteId: string }>({
  name: 'blockEmbed',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addOptions() {
    return {
      noteId: '',
    };
  },

  addAttributes() {
    return {
      targetDocId: {
        default: null,
        parseHTML: (el) => (el as HTMLElement).getAttribute('data-embed-doc'),
      },
      targetBlockId: {
        default: null,
        parseHTML: (el) => (el as HTMLElement).getAttribute('data-embed-block') || null,
      },
      label: {
        default: '',
        parseHTML: (el) => (el as HTMLElement).getAttribute('data-embed-label') ?? '',
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-block-embed]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const docId = String(node.attrs.targetDocId ?? '');
    const blockId = node.attrs.targetBlockId ? String(node.attrs.targetBlockId) : '';
    const label = String(node.attrs.label || (blockId ? `${docId}#${blockId}` : docId));

    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-block-embed': '',
        'data-embed-doc': docId,
        'data-embed-block': blockId,
        'data-embed-label': label,
        class: 'block-embed-card',
      }),
      `![[${label}]]`,
    ];
  },

  addNodeView() {
    return ({ node }) => {
      const sourceNoteId = this.options.noteId || '';
      const docQuery = String(node.attrs.targetDocId ?? '');
      const blockQuery = node.attrs.targetBlockId ? String(node.attrs.targetBlockId) : null;
      const customLabel = String(node.attrs.label ?? '');

      const dom = document.createElement('span');
      dom.className = 'block-embed-card';
      dom.contentEditable = 'false';
      dom.setAttribute('data-block-embed', '');
      dom.setAttribute('data-embed-doc', docQuery);
      dom.setAttribute('data-embed-block', blockQuery ?? '');

      const header = document.createElement('span');
      header.className = 'block-embed-header';

      const titleEl = document.createElement('span');
      titleEl.className = 'block-embed-title';
      titleEl.textContent = `📑 ${customLabel || (blockQuery ? `${docQuery} › #${blockQuery}` : docQuery)}`;

      const actionsEl = document.createElement('span');
      actionsEl.className = 'block-embed-actions';

      const openSplitBtn = document.createElement('button');
      openSplitBtn.type = 'button';
      openSplitBtn.className = 'block-embed-split-btn';
      openSplitBtn.textContent = '◫ 분할 열기';
      openSplitBtn.title = '우측 분할 패널에서 원본 문서 열기';

      actionsEl.appendChild(openSplitBtn);
      header.appendChild(titleEl);
      header.appendChild(actionsEl);

      const body = document.createElement('span');
      body.className = 'block-embed-body';
      body.textContent = '불러오는 중…';

      dom.appendChild(header);
      dom.appendChild(body);

      let resolvedDocId: string | null = null;

      void resolveTransclusionFromDb(sourceNoteId, docQuery, blockQuery).then((res) => {
        resolvedDocId = res.targetDocId;
        if (res.status === 'cycle_blocked' || res.status === 'max_depth_exceeded' || res.status === 'not_found') {
          dom.classList.add('is-embed-warning');
          body.textContent = res.warningMessage ?? '임베드를 표시할 수 없습니다.';
          return;
        }
        titleEl.textContent = `📑 ${res.targetTitle}${res.blockHeading ? ` › #${res.blockHeading}` : ''}`;
        body.textContent = res.warningMessage ? `${res.warningMessage} — ${res.excerpt}` : res.excerpt;
      });

      titleEl.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const targetId = resolvedDocId ?? docQuery;
        if (targetId) {
          useTabs.getState().openTab(targetId, blockQuery ?? undefined);
        }
      });

      openSplitBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const targetId = resolvedDocId ?? docQuery;
        if (targetId) {
          useTabs.getState().openInSecondary(targetId, blockQuery ?? undefined);
        }
      });

      return { dom };
    };
  },

  addInputRules() {
    return [
      new InputRule({
        find: /!\[\[([^\]|#\n]+)(?:#([^\]|\n]+))?(?:\|([^\]\n]+))?\]\]$/,
        handler: ({ state, range, match }) => {
          const targetDocId = match[1].trim();
          const targetBlockId = match[2]?.trim() ?? null;
          const label = (match[3] ?? (targetBlockId ? `${targetDocId}#${targetBlockId}` : targetDocId)).trim();
          state.tr.replaceWith(range.from, range.to, this.type.create({ targetDocId, targetBlockId, label }));
        },
      }),
    ];
  },

  markdownTokenizer: {
    name: 'blockEmbed',
    level: 'inline',
    start: (src: string) => src.indexOf('![['),
    tokenize: (src: string) => {
      const m = /^!\[\[([^\]|#\n]+)(?:#([^\]|\n]+))?(?:\|([^\]\n]+))?\]\]/.exec(src);
      if (!m) return undefined;
      const docId = m[1].trim();
      const blockId = m[2]?.trim() ?? null;
      const defaultLabel = blockId ? `${docId}#${blockId}` : docId;
      const label = (m[3] ?? defaultLabel).trim();
      return {
        type: 'blockEmbed',
        raw: m[0],
        docId,
        blockId,
        label,
      };
    },
  },

  markdownTokenName: 'blockEmbed',

  parseMarkdown: (token, h) =>
    h.createNode('blockEmbed', {
      targetDocId: token.docId,
      targetBlockId: token.blockId ?? null,
      label: token.label ?? '',
    }),

  renderMarkdown: (node) => {
    const a = node.attrs ?? {};
    const docPart = a.targetDocId ?? '';
    const blockPart = a.targetBlockId ? `#${a.targetBlockId}` : '';
    const defaultLabel = `${docPart}${blockPart}`;
    const labelPart = a.label && a.label !== defaultLabel ? `|${a.label}` : '';
    return `![[${docPart}${blockPart}${labelPart}]]`;
  },
});
