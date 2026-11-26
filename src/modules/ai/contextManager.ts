import type { ModelMessage } from 'ai';
import type { NoteSession } from '../../session/NoteSession';
import {
  FALLBACK_MESSAGE_MAX_CHARS,
  FALLBACK_NOTE_CONTEXT_CHARS,
  MAX_NOTE_CONTEXT_CHARS,
  MAX_RECENT_CHAT_MESSAGES,
  ROLLING_SUMMARY_MAX_LINES,
} from './constants';
import type {
  GeminiClientLike,
  GeminiMessagePart,
  GeminiTutorMessage,
  GeminiTutorRequest,
} from './geminiClient';

type AnyChatMessage = ModelMessage | GeminiTutorMessage;

const SUMMARY_SECTION_HEADER = '[이전 대화 핵심 요약]';
const LITE_SUMMARY_MODEL = 'gemini-3.5-flash-lite';

export function extractMessageText(msg: AnyChatMessage): string {
  if (typeof msg.content === 'string') {
    return msg.content;
  }
  if (!Array.isArray(msg.content)) {
    return String(msg.content ?? '');
  }
  const texts: string[] = [];
  for (const part of msg.content) {
    if (!part || typeof part !== 'object') continue;
    if ('text' in part && typeof part.text === 'string' && part.text.trim()) {
      texts.push(part.text.trim());
    }
  }
  return texts.join('\n');
}

function clipText(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxChars - 1))}…`;
}

/**
 * 슬라이딩 윈도우 밖으로 밀려난 이전 대화 내역을 3~5줄 핵심 요약으로 즉시 압축한다.
 */
export function buildDeterministicRollingSummary(
  olderMessages: AnyChatMessage[],
  maxLines = ROLLING_SUMMARY_MAX_LINES,
): string {
  const nonEmpty = olderMessages
    .map((m) => ({
      role: m.role === 'assistant' || m.role === 'model' ? '답변' : '질문',
      text: extractMessageText(m).replace(/\s+/g, ' ').trim(),
    }))
    .filter((item) => item.text.length > 0);

  if (nonEmpty.length === 0) return '';

  const limit = Math.max(3, Math.min(5, maxLines));
  const lines: string[] = [];
  if (nonEmpty.length <= limit) {
    for (const item of nonEmpty) {
      lines.push(`- [${item.role}] ${clipText(item.text, 140)}`);
    }
  } else {
    // 첫 질문 + 중간 핵심 + 직전 맥락을 균등 샘플링하여 3~5줄로 압축
    const step = (nonEmpty.length - 1) / (limit - 1);
    const picked = new Set<number>();
    for (let i = 0; i < limit; i++) {
      picked.add(Math.round(i * step));
    }
    for (const idx of Array.from(picked).sort((a, b) => a - b)) {
      const item = nonEmpty[idx];
      lines.push(`- [${item.role}] ${clipText(item.text, 140)}`);
    }
  }
  return lines.slice(0, limit).join('\n');
}

/**
 * 경량 모델(gemini-3.5-flash-lite)로 이전 대화를 3~5줄로 롤링 요약한다.
 * 오프라인/오류/타임아웃 시에는 즉시 결정론적 요약으로 안전 폴백한다.
 */
export async function summarizeOlderHistoryWithLiteModel(
  olderMessages: AnyChatMessage[],
  options: {
    client?: GeminiClientLike;
    maxLines?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<string> {
  const fallbackSummary = buildDeterministicRollingSummary(olderMessages, options.maxLines);
  if (!fallbackSummary || !options.client) {
    return fallbackSummary;
  }

  const digestInput = olderMessages
    .map((m) => `${m.role === 'assistant' || m.role === 'model' ? 'A' : 'U'}: ${clipText(extractMessageText(m), 300)}`)
    .filter((line) => line.length > 3)
    .join('\n')
    .slice(0, 4000);

  if (!digestInput) return fallbackSummary;

  const limit = Math.max(3, Math.min(5, options.maxLines ?? ROLLING_SUMMARY_MAX_LINES));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const stream = await options.client.models.generateContentStream({
      model: LITE_SUMMARY_MODEL,
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: `다음 이전 대화를 핵심 논점·정의·결론 위주로 ${limit}줄 이내 불릿으로 요약하라.\n\n${digestInput}`,
            },
          ],
        },
      ],
      config: {
        systemInstruction: '핵심만 3~5줄 불릿으로 요약한다.',
        temperature: 1.0,
        maxOutputTokens: 250,
        ...(options.signal ? { abortSignal: options.signal } : {}),
      },
    });

    const collectPromise = (async () => {
      let out = '';
      for await (const chunk of stream) {
        if (typeof chunk.text === 'string') {
          out += chunk.text;
        } else if (Array.isArray(chunk.candidates?.[0]?.content?.parts)) {
          for (const part of chunk.candidates[0].content.parts) {
            if (part && !part.thought && typeof part.text === 'string') {
              out += part.text;
            }
          }
        }
      }
      return out.trim();
    })();

    const timeoutPromise = new Promise<string>((resolve) => {
      timer = setTimeout(() => resolve(''), options.timeoutMs ?? 2500);
    });

    const summary = await Promise.race([collectPromise, timeoutPromise]);
    if (!summary) return fallbackSummary;
    return summary
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, limit)
      .join('\n');
  } catch {
    return fallbackSummary;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface SlidingWindowContextResult<M extends AnyChatMessage = AnyChatMessage> {
  recentMessages: M[];
  olderSummary: string;
  systemContext: string;
}

/**
 * 대화 히스토리를 최근 maxRecentMessages(기본 6개, 4~6개 클램핑)만 원문 유지하고,
 * 이전 메시지는 3~5줄 롤링 요약으로 압축해 systemContext에 결합한 뒤 전체 길이를 maxContextChars(12,000자) 이내로 제한한다.
 */
export function applySlidingWindowAndSummary<M extends AnyChatMessage>(
  messages: M[] | undefined,
  systemContext?: string,
  options: {
    maxRecentMessages?: number;
    maxContextChars?: number;
    rollingSummaryOverride?: string;
  } = {},
): SlidingWindowContextResult<M> {
  const maxRecent = Math.max(4, Math.min(6, options.maxRecentMessages ?? MAX_RECENT_CHAT_MESSAGES));
  const maxChars = Math.max(500, options.maxContextChars ?? MAX_NOTE_CONTEXT_CHARS);
  const list = Array.isArray(messages) ? messages : [];

  const recentMessages = list.length > maxRecent ? list.slice(-maxRecent) : list;
  const olderMessages = list.length > maxRecent ? list.slice(0, -maxRecent) : [];

  const olderSummary =
    olderMessages.length > 0
      ? (options.rollingSummaryOverride?.trim() || buildDeterministicRollingSummary(olderMessages))
      : '';

  const baseCtx = (systemContext ?? '').trim();
  let combinedContext = baseCtx;
  if (olderSummary && !baseCtx.includes(SUMMARY_SECTION_HEADER)) {
    const summaryBlock = `${SUMMARY_SECTION_HEADER}\n${olderSummary}`;
    const maxBaseLen = Math.max(300, maxChars - summaryBlock.length - 4);
    const trimmedBase = baseCtx.length > maxBaseLen ? `${baseCtx.slice(0, maxBaseLen)}…` : baseCtx;
    combinedContext = trimmedBase ? `${trimmedBase}\n\n${summaryBlock}` : summaryBlock;
  } else if (combinedContext.length > maxChars) {
    combinedContext = `${combinedContext.slice(0, maxChars - 1)}…`;
  }

  return {
    recentMessages,
    olderSummary,
    systemContext: combinedContext,
  };
}

/**
 * 현재 활성 페이지 또는 선택 영역을 중심으로 최대 12,000자(maxChars)의 노트 본문 컨텍스트를 추출한다.
 */
export function extractFocusedNoteContext(
  session: NoteSession | null | undefined,
  maxChars = MAX_NOTE_CONTEXT_CHARS,
): string {
  if (!session) return '(현재 열린 노트 없음)';
  const title = session.record.title || '제목 없는 노트';
  const markdown = session.editor.getMarkdown() || '';
  if (!markdown.trim()) {
    return `[현재 노트: ${title}]\n(본문 비어 있음)`;
  }

  let selectedText = '';
  let focusAnchorText = '';
  try {
    const { from, to } = session.editor.state.selection;
    if (to > from) {
      selectedText = session.editor.state.doc.textBetween(from, to, ' ').trim();
    } else {
      const docSize = session.editor.state.doc.content.size;
      const start = Math.max(0, from - 120);
      const end = Math.min(docSize, from + 120);
      focusAnchorText = session.editor.state.doc.textBetween(start, end, ' ').trim();
    }
  } catch {
    /* 에디터 selection 미초기화 시 무시 */
  }

  const pageCount = Math.max(1, session.ui.pages.length);
  const currentPageIdx = Math.max(0, Math.min(pageCount - 1, session.ui.currentPageIndex ?? 0));

  let windowStart = 0;
  const anchor = selectedText.slice(0, 60) || focusAnchorText.slice(0, 60);
  if (markdown.length > maxChars) {
    const anchorPos = anchor ? markdown.indexOf(anchor) : -1;
    if (anchorPos >= 0) {
      windowStart = Math.max(0, Math.min(markdown.length - maxChars, anchorPos - Math.floor(maxChars * 0.4)));
    } else if (pageCount > 1) {
      const approxCenter = Math.floor(((currentPageIdx + 0.5) / pageCount) * markdown.length);
      windowStart = Math.max(0, Math.min(markdown.length - maxChars, approxCenter - Math.floor(maxChars * 0.5)));
    }
  }

  const sliced = markdown.slice(windowStart, windowStart + maxChars);
  const prefixEllipsis = windowStart > 0 ? '…\n' : '';
  const suffixEllipsis = windowStart + maxChars < markdown.length ? '\n…' : '';
  const selectionHeader = selectedText
    ? `[현재 선택 영역]\n${clipText(selectedText, 1200)}\n\n`
    : '';
  const header = `[현재 노트: ${title} · ${currentPageIdx + 1}/${pageCount}페이지 (최대 ${maxChars.toLocaleString()}자)]\n`;

  return `${header}${selectionHeader}${prefixEllipsis}${sliced}${suffixEllipsis}`.slice(0, maxChars + 1400);
}

/**
 * 1차 모델이 429/타임아웃/503으로 실패해 폴백 모델로 전환될 때,
 * 과거 히스토리를 제거하고 최신 질문 1건 + 핵심 문맥(최대 3,000자)만 남긴 경량 요청으로 축소한다.
 */
export function trimTutorRequestForFallback<T extends GeminiTutorRequest>(req: T): T {
  let trimmedMessages = req.messages;
  if (req.messages && req.messages.length > 0) {
    const lastUserIdx = [...req.messages].reverse().findIndex((m) => m.role === 'user');
    const latestMsg =
      lastUserIdx >= 0
        ? req.messages[req.messages.length - 1 - lastUserIdx]
        : req.messages[req.messages.length - 1];

    const normalizedRole: GeminiTutorMessage['role'] =
      latestMsg.role === 'assistant' || latestMsg.role === 'model' ? 'model' : 'user';

    if (typeof latestMsg.content === 'string') {
      trimmedMessages = [{ role: normalizedRole, content: clipText(latestMsg.content, FALLBACK_MESSAGE_MAX_CHARS) }];
    } else if (Array.isArray(latestMsg.content)) {
      const compactedParts: GeminiMessagePart[] = [];
      for (const part of latestMsg.content) {
        if (!part || typeof part !== 'object') continue;
        if ('type' in part && part.type === 'text' && typeof part.text === 'string') {
          if (part.text.startsWith('[현재 말풍선 메모]')) {
            continue;
          }
          if (part.text.startsWith('[주석 대상 원문]') || part.text.startsWith('[첨부 문서 조각:')) {
            compactedParts.push({ type: 'text', text: clipText(part.text, 1500) });
            continue;
          }
          compactedParts.push({ type: 'text', text: clipText(part.text, FALLBACK_MESSAGE_MAX_CHARS) });
        } else if ('type' in part && part.type === 'file' && 'data' in part && typeof part.data === 'string') {
          compactedParts.push({
            type: 'file',
            mediaType: typeof part.mediaType === 'string' ? part.mediaType : 'image/png',
            data: part.data,
          });
        } else if ('text' in part && typeof part.text === 'string') {
          compactedParts.push({ text: clipText(part.text, FALLBACK_MESSAGE_MAX_CHARS) });
        } else if ('inlineData' in part) {
          compactedParts.push(part as GeminiMessagePart);
        }
      }
      trimmedMessages = [
        { role: normalizedRole, content: compactedParts.length > 0 ? compactedParts : [{ type: 'text', text: '' }] },
      ];
    } else {
      trimmedMessages = [latestMsg];
    }
  }

  let trimmedSystem = req.systemContext?.trim() ?? '';
  const summaryIdx = trimmedSystem.indexOf(SUMMARY_SECTION_HEADER);
  if (summaryIdx >= 0) {
    trimmedSystem = trimmedSystem.slice(0, summaryIdx).trim();
  }
  if (trimmedSystem.length > FALLBACK_NOTE_CONTEXT_CHARS) {
    trimmedSystem = `${trimmedSystem.slice(0, FALLBACK_NOTE_CONTEXT_CHARS)}…`;
  }

  const trimmedPrompt = req.prompt ? clipText(req.prompt, FALLBACK_MESSAGE_MAX_CHARS) : req.prompt;

  return {
    ...req,
    messages: trimmedMessages,
    prompt: trimmedPrompt,
    systemContext: trimmedSystem || undefined,
  };
}
