/**
 * 삼성 노트 PDF 내보내기 가져오기 (pdf.js)
 * - 텍스트 → TipTap 단락/제목 노드
 * - 임베디드 이미지(미디어) → attachments/ 로 분리 저장 후 이미지 노드
 * - 손글씨(벡터 패스)가 있는 페이지 → 텍스트·이미지를 제외하고 렌더링한 '캔버스 템플릿' 노드
 */
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { JSONContent } from '@tiptap/core';
import { classifyOps, isHandwritingPage, itemsToBlocks, templateExcludedOps, type PdfTextItem, type OpsTable } from './pdfAnalysis';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export interface PdfImportPage {
  index: number;
  blocks: JSONContent[];
  images: Blob[];
  template: { blob: Blob; width: number; height: number } | null;
  stats: ReturnType<typeof classifyOps>;
}

export interface PdfImportResult {
  title: string | null;
  pages: PdfImportPage[];
}

const TEMPLATE_SCALE = 2;
const MAX_TEMPLATE_PX = 2400;

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('PNG 변환 실패'))), 'image/png'));
}

interface PdfImageObj {
  width: number;
  height: number;
  kind?: number;
  data?: Uint8ClampedArray | Uint8Array;
  bitmap?: ImageBitmap;
}

/** pdf.js 이미지 객체 → PNG Blob (RGB/RGBA/비트맵 지원) */
async function imageObjToBlob(img: PdfImageObj): Promise<Blob | null> {
  if (!img || !img.width || !img.height) return null;
  if (img.width * img.height < 32 * 32) return null; // 아이콘/장식 무시
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d')!;
  if (img.bitmap) ctx.drawImage(img.bitmap, 0, 0);
  else if (img.data) {
    const px = img.width * img.height;
    const rgba = new Uint8ClampedArray(px * 4);
    if (img.data.length === px * 4) rgba.set(img.data);
    else if (img.data.length === px * 3) {
      for (let i = 0, j = 0; i < px; i++, j += 3) {
        rgba[i * 4] = img.data[j];
        rgba[i * 4 + 1] = img.data[j + 1];
        rgba[i * 4 + 2] = img.data[j + 2];
        rgba[i * 4 + 3] = 255;
      }
    } else return null; // 1bpp 등 미지원 형식
    ctx.putImageData(new ImageData(rgba, img.width, img.height), 0, 0);
  } else return null;
  return canvasToBlob(canvas);
}

function getObj(page: pdfjs.PDFPageProxy, id: string): Promise<PdfImageObj | null> {
  const store = id.startsWith('g_') ? page.commonObjs : page.objs;
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 3000);
    try {
      store.get(id, (obj: PdfImageObj) => {
        clearTimeout(t);
        resolve(obj);
      });
    } catch {
      clearTimeout(t);
      resolve(null);
    }
  });
}

export async function importPdf(data: ArrayBuffer, onProgress?: (page: number, total: number) => void): Promise<PdfImportResult> {
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(data) });
  const doc = await loadingTask.promise;
  const OPS = pdfjs.OPS as unknown as OpsTable;
  const excluded = templateExcludedOps(OPS);
  let title: string | null = null;
  try {
    const meta = await doc.getMetadata();
    const t = (meta.info as { Title?: string })?.Title;
    if (t && t.trim()) title = t.trim();
  } catch {
    /* 메타데이터 없음 */
  }

  const pages: PdfImportPage[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    onProgress?.(i, doc.numPages);
    const page = await doc.getPage(i);
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

    const images: Blob[] = [];
    for (const id of stats.imageIds) {
      const obj = await getObj(page, id);
      const blob = obj ? await imageObjToBlob(obj).catch(() => null) : null;
      if (blob) images.push(blob);
    }

    let template: PdfImportPage['template'] = null;
    if (isHandwritingPage(stats)) {
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(TEMPLATE_SCALE, MAX_TEMPLATE_PX / Math.max(base.width, base.height));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      // 텍스트(→마크다운)와 이미지(→첨부)는 제외하고 손글씨 벡터만 렌더링
      await page.render({
        canvas,
        viewport,
        // pdf.js 는 불투명(alpha:false) 컨텍스트로 그리므로 투명 배경은 검게 나온다 → 흰 배경 + CSS multiply 합성
        background: '#ffffff',
        operationsFilter: (index, list) => !excluded.has(list.fnArray[index]),
      }).promise;
      template = { blob: await canvasToBlob(canvas), width: base.width, height: base.height };
    }
    pages.push({ index: i, blocks, images, template, stats });
    page.cleanup();
  }
  await loadingTask.destroy();
  return { title, pages };
}
