/**
 * 삼성 노트 PDF 내보내기 가져오기 (pdf.js)
 * - 텍스트 → TipTap 단락/제목 노드
 * - 임베디드 이미지(미디어) → attachments/ 로 분리 저장 후 이미지 노드
 * - 손글씨(벡터 패스)가 있는 페이지 → 텍스트·이미지를 제외하고 렌더링한 '캔버스 템플릿' 노드
 */
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { JSONContent } from '@tiptap/core';
import { classifyOps, itemsToBlocks, type PdfTextItem, type OpsTable } from './pdfAnalysis';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export interface PdfImportPage {
  index: number;
  width: number;
  height: number;
  blocks: JSONContent[];
  images: Blob[];
  template: { blob: Blob; width: number; height: number } | null;
  stats: ReturnType<typeof classifyOps>;
}

export interface PdfImportResult {
  title: string | null;
  pages: PdfImportPage[];
}

const TEMPLATE_SCALE = 1.5;
const MAX_TEMPLATE_PX = 1600;

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((res, rej) =>
    canvas.toBlob(
      (b) => (b ? res(b) : rej(new Error('이미지 변환 실패 (캔버스 메모리 한계 초과 가능성)'))),
      'image/jpeg',
      0.85,
    ),
  );
}

export async function importPdf(data: ArrayBuffer, onProgress?: (page: number, total: number) => void): Promise<PdfImportResult> {
  let loadingTask: ReturnType<typeof pdfjs.getDocument>;
  let doc: pdfjs.PDFDocumentProxy;
  try {
    loadingTask = pdfjs.getDocument({ data: new Uint8Array(data) });
    doc = await loadingTask.promise;
  } catch (err) {
    const msg = (err as Error)?.message || '알 수 없는 오류';
    if (msg.toLowerCase().includes('password')) {
      throw new Error('암호로 보호된 PDF 파일은 가져올 수 없습니다.');
    }
    throw new Error(`PDF 문서를 열 수 없습니다: ${msg}`);
  }

  const OPS = pdfjs.OPS as unknown as OpsTable;
  let title: string | null = null;
  try {
    const meta = await doc.getMetadata();
    const t = (meta.info as { Title?: string })?.Title;
    if (t && t.trim()) title = t.trim();
  } catch {
    /* 메타데이터 없음 */
  }

  const pages: PdfImportPage[] = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      onProgress?.(i, doc.numPages);
      const page = await doc.getPage(i);
      const canvas = document.createElement('canvas');
      try {
        const base = page.getViewport({ scale: 1 });
        const tc = await page.getTextContent();
        const items: PdfTextItem[] = [];
        for (const it of tc.items) {
          if (!('str' in it)) continue;
          const [, , , d, e, f] = it.transform as number[];
          items.push({ str: it.str, x: e, y: f, height: Math.abs(it.height || d || 10), width: it.width, hasEOL: it.hasEOL });
        }
        const blocks = itemsToBlocks(items);

        const opList = await page.getOperatorList();
        const stats = classifyOps(opList.fnArray, opList.argsArray as unknown[][], OPS);

        // page.render()가 배경·텍스트·수식·손글씨(래스터 XObject 및 벡터 획)를 단일 템플릿으로 완전 합성하므로
        // 내부 XObject 이미지를 별도 추출하지 않아 삼성 노트 손글씨 이중 렌더링을 원천 차단한다.
        const images: Blob[] = [];

        const scale = Math.min(TEMPLATE_SCALE, MAX_TEMPLATE_PX / Math.max(base.width, base.height));
        const viewport = page.getViewport({ scale });
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        // 원본 PDF 페이지의 텍스트, 이미지, 수식, 손글씨 벡터를 완전하게 렌더링 (텍스트 제거 필터 미적용)
        await page.render({
          canvas,
          viewport,
          background: '#ffffff',
        }).promise;
        const template = { blob: await canvasToBlob(canvas), width: base.width, height: base.height };

        pages.push({ index: i, width: base.width, height: base.height, blocks, images, template, stats });
      } finally {
        // 태블릿 GPU/RAM 백킹 스토어 고갈 방지를 위해 페이지 변환 직후 캔버스 메모리 즉시 해제
        canvas.width = 0;
        canvas.height = 0;
        page.cleanup();
      }
    }
  } finally {
    await loadingTask.destroy();
  }
  return { title, pages };
}
