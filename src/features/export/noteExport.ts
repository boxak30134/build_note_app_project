import { PDFDocument } from 'pdf-lib';
import type { JSONContent } from '@tiptap/core';
import { encodeText } from '../../core/codec/textCodec';
import { getPageDimensions, type NotePage } from '../../core/page/pageTypes';
import { drawStroke } from '../../canvas/render';
import { readAttachmentBlob } from '../../storage/opfs';
import { downloadBytes } from '../../storage/localFiles';
import type { NoteSession } from '../../session/NoteSession';
import { toast } from '../../store/uiStore';

/** 파일명 금지 문자 제거 및 안전한 내보내기 파일명 생성 */
export function safeExportFileName(title: string | null | undefined, fallback = '제목 없는 노트'): string {
  const cleaned = (title ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 120);
  return cleaned || fallback;
}

type SavePickerWindow = Window & {
  showSaveFilePicker?: (options?: {
    suggestedName?: string;
    types?: Array<{ description?: string; accept: Record<string, string[]> }>;
  }) => Promise<{
    createWritable: () => Promise<{
      write: (data: BufferSource | Blob | string) => Promise<void>;
      close: () => Promise<void>;
    }>;
  }>;
};

/**
 * 사용자가 원하는 경로에 파일을 저장한다.
 * - `showSaveFilePicker` 지원 환경: 파일 저장 다이얼로그로 경로·파일명 직접 선택
 * - 사용자 취소(`AbortError`): false 반환
 * - 미지원 환경(태블릿/모바일 등): 브라우저 다운로드(`downloadBytes`) 폴백
 */
export async function saveBytesWithPicker(
  bytes: Uint8Array,
  suggestedName: string,
  mimeType: string,
  extensions: string[],
): Promise<boolean> {
  const win = typeof window !== 'undefined' ? (window as SavePickerWindow) : undefined;
  if (win?.showSaveFilePicker) {
    try {
      const handle = await win.showSaveFilePicker({
        suggestedName,
        types: [
          {
            description: mimeType === 'application/pdf' ? 'PDF 문서' : 'Markdown 문서',
            accept: { [mimeType]: extensions },
          },
        ],
      });
      const writable = await handle.createWritable();
      await writable.write(bytes as unknown as BufferSource);
      await writable.close();
      return true;
    } catch (err) {
      const name = (err as Error)?.name;
      if (name === 'AbortError') return false;
      // SecurityError 등 파일 피커 호출 제한 시 다운로드 폴백
    }
  }

  downloadBytes(bytes, suggestedName, mimeType);
  return true;
}

/** 활성 노트를 Markdown(.md) 파일로 원하는 경로에 내보낸다 */
export async function exportNoteToMarkdown(session: NoteSession): Promise<boolean> {
  const markdown = session.editor.getMarkdown();
  const encoding = session.record.encoding ?? 'utf-8';
  const eol = session.record.eol ?? 'lf';

  let bytes: Uint8Array;
  try {
    bytes = encodeText(markdown, encoding, eol);
  } catch {
    bytes = encodeText(markdown, 'utf-8', eol);
    toast.info('CP949에 없는 문자가 포함되어 UTF-8로 내보냅니다.');
  }

  const fileName = `${safeExportFileName(session.record.title)}.md`;
  return saveBytesWithPicker(bytes, fileName, 'text/markdown', ['.md']);
}

function extractNodeLines(node: JSONContent, depth = 0): Array<{ text: string; size: number; bold?: boolean }> {
  const lines: Array<{ text: string; size: number; bold?: boolean }> = [];
  const collectText = (n: JSONContent): string => {
    if (n.type === 'text') return n.text ?? '';
    if (n.type === 'hardBreak') return '\n';
    if (!n.content) return '';
    return n.content.map(collectText).join('');
  };

  if (node.type === 'doc') {
    for (const child of node.content ?? []) {
      lines.push(...extractNodeLines(child, depth));
    }
    return lines;
  }

  if (node.type === 'inkTemplate' || node.type === 'pdfEmbed') {
    return lines;
  }

  if (node.type === 'heading') {
    const level = Number(node.attrs?.level ?? 1);
    const size = level === 1 ? 22 : level === 2 ? 18 : 15;
    lines.push({ text: collectText(node), size, bold: true });
    return lines;
  }

  if (node.type === 'bulletList' || node.type === 'orderedList') {
    (node.content ?? []).forEach((item, idx) => {
      const prefix = node.type === 'orderedList' ? `${idx + 1}. ` : '• ';
      const itemLines = extractNodeLines(item, depth + 1);
      if (itemLines.length > 0) {
        itemLines[0].text = `${'  '.repeat(depth)}${prefix}${itemLines[0].text}`;
        lines.push(...itemLines);
      }
    });
    return lines;
  }

  if (node.type === 'blockquote') {
    for (const child of node.content ?? []) {
      const sub = extractNodeLines(child, depth);
      sub.forEach((l) => lines.push({ ...l, text: `│ ${l.text}` }));
    }
    return lines;
  }

  if (node.type === 'codeBlock') {
    const raw = collectText(node);
    raw.split('\n').forEach((l) => lines.push({ text: l, size: 11 }));
    return lines;
  }

  const txt = collectText(node);
  if (txt.trim() || node.type === 'paragraph') {
    for (const sub of txt.split('\n')) {
      lines.push({ text: sub, size: 13 });
    }
  }
  return lines;
}

function drawPageGridStyle(ctx: CanvasRenderingContext2D, width: number, height: number, style: NotePage['style']) {
  if (style === 'plain') return;
  ctx.save();
  if (style === 'lined') {
    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = 1;
    for (let y = 48; y < height; y += 32) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
  } else if (style === 'grid') {
    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = 0.8;
    for (let x = 24; x < width; x += 24) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
    for (let y = 24; y < height; y += 24) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
  } else if (style === 'dotted') {
    ctx.fillStyle = '#cbd5e1';
    for (let y = 24; y < height; y += 24) {
      for (let x = 24; x < width; x += 24) {
        ctx.fillRect(x - 0.8, y - 0.8, 1.6, 1.6);
      }
    }
  }
  ctx.restore();
}

function wrapCanvasText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  if (!text) return [''];
  const result: string[] = [];
  let line = '';
  for (const ch of text) {
    const test = line + ch;
    if (ctx.measureText(test).width > maxWidth && line.length > 0) {
      result.push(line);
      line = ch;
    } else {
      line = test;
    }
  }
  if (line) result.push(line);
  return result;
}

function canvasToJpegUint8Array(canvas: HTMLCanvasElement, quality = 0.88): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) return reject(new Error('PDF 페이지 이미지 변환에 실패했습니다.'));
        blob
          .arrayBuffer()
          .then((buf) => resolve(new Uint8Array(buf)))
          .catch(reject);
      },
      'image/jpeg',
      quality,
    );
  });
}

function loadImageFromBlob(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('첨부 이미지 로드 실패'));
    };
    img.src = url;
  });
}

/**
 * 활성 노트의 페이지·템플릿·텍스트·S-Pen 스트로크를 합성해 표준 PDF Uint8Array를 생성한다.
 */
export async function buildPdfBytesFromSession(
  session: NoteSession,
  onProgress?: (page: number, total: number) => void,
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  const docJson = session.editor.getJSON();
  const strokes = session.strokes.getAll();
  const pages: NotePage[] =
    session.ui.pages.length > 0
      ? session.ui.pages
      : [{ id: 'p-1', size: 'A4', style: 'plain', orientation: 'portrait' }];

  // inkTemplate 노드가 있는 경우 페이지별 배경 이미지 소스 매핑
  const templateNodes = (docJson.content ?? []).filter((n) => n.type === 'inkTemplate');
  const textLines = extractNodeLines(docJson);
  const totalPages = Math.max(pages.length, templateNodes.length);

  // 각 페이지의 세로 누적 오프셋 계산 (S-Pen 스트로크 Y좌표 매핑용)
  let currentYOffset = 0;
  let lineCursor = 0;

  for (let i = 0; i < totalPages; i++) {
    onProgress?.(i + 1, totalPages);
    const pageMeta = pages[i] ?? pages[pages.length - 1];
    const dims = getPageDimensions(pageMeta.size, pageMeta.orientation);
    const renderScale = 1.5; // 태블릿/데스크톱 균형 해상도
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(dims.width * renderScale);
    canvas.height = Math.ceil(dims.height * renderScale);

    try {
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('2D 캔버스 컨텍스트를 생성할 수 없습니다.');

      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.save();
      ctx.scale(renderScale, renderScale);

      // 1) 배경 그리드/줄 스타일
      drawPageGridStyle(ctx, dims.width, dims.height, pageMeta.style);

      // 2) PDF 템플릿 이미지가 있으면 배경에 삽입
      const tpl = templateNodes[i];
      if (tpl?.attrs?.src && typeof tpl.attrs.src === 'string') {
        try {
          const blob = await readAttachmentBlob(session.id, tpl.attrs.src);
          if (blob) {
            const img = await loadImageFromBlob(blob);
            ctx.drawImage(img, 0, 0, dims.width, dims.height);
          }
        } catch {
          /* 템플릿 로드 실패 시 빈 배경으로 진행 */
        }
      } else if (i === 0 || lineCursor < textLines.length) {
        // 3) 일반 에디터 텍스트 렌더링
        const marginX = 48;
        let cursorY = 56;
        const maxWidth = dims.width - marginX * 2;
        ctx.fillStyle = '#0f172a';

        while (lineCursor < textLines.length) {
          const item = textLines[lineCursor];
          ctx.font = `${item.bold ? 'bold ' : ''}${item.size}px "Malgun Gothic", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif`;
          const wrapped = wrapCanvasText(ctx, item.text, maxWidth);
          const lineHeight = item.size * 1.5;

          if (cursorY + wrapped.length * lineHeight > dims.height - 48) {
            break;
          }
          for (const wLine of wrapped) {
            ctx.fillText(wLine, marginX, cursorY);
            cursorY += lineHeight;
          }
          cursorY += 4;
          lineCursor++;
        }
      }

      // 4) 해당 페이지 영역의 S-Pen 스트로크 합성
      const pageTop = currentYOffset;
      const pageBottom = currentYOffset + dims.height;
      const pageStrokes = strokes.filter((s) =>
        s.points.some((pt) => pt[1] >= pageTop && pt[1] <= pageBottom),
      );
      if (pageStrokes.length > 0) {
        ctx.save();
        ctx.translate(0, -pageTop);
        for (const s of pageStrokes) {
          drawStroke(ctx, s);
        }
        ctx.restore();
      }
      ctx.restore();

      const jpgBytes = await canvasToJpegUint8Array(canvas, 0.88);
      const jpgImage = await pdfDoc.embedJpg(jpgBytes);
      // 72 DPI PDF 포인트 기준 (dims.width는 4px/mm 기준이므로 pt로 변환)
      const ptWidth = (dims.width / 4) * (72 / 25.4);
      const ptHeight = (dims.height / 4) * (72 / 25.4);
      const pdfPage = pdfDoc.addPage([ptWidth, ptHeight]);
      pdfPage.drawImage(jpgImage, { x: 0, y: 0, width: ptWidth, height: ptHeight });
    } finally {
      canvas.width = 0;
      canvas.height = 0;
    }

    currentYOffset += dims.height + 24;
  }

  return pdfDoc.save();
}

/** 활성 노트를 PDF(.pdf) 파일로 원하는 경로에 내보낸다 */
export async function exportNoteToPdf(
  session: NoteSession,
  onProgress?: (page: number, total: number) => void,
): Promise<boolean> {
  const pdfBytes = await buildPdfBytesFromSession(session, onProgress);
  const fileName = `${safeExportFileName(session.record.title)}.pdf`;
  return saveBytesWithPicker(pdfBytes, fileName, 'application/pdf', ['.pdf']);
}

