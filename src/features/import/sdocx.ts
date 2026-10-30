/**
 * 삼성 노트(.sdocx) 패키지 파서 — JSZip 으로 압축 해제 후
 * document.xml / text.json 에서 텍스트를, 미디어 엔트리에서 이미지를 추출한다.
 */
import JSZip from 'jszip';

export interface SdocxMedia {
  /** 패키지 내부 경로 */
  path: string;
  /** 저장용 파일명 */
  name: string;
  data: Uint8Array;
  mime: string;
}

export interface SdocxContent {
  title: string | null;
  paragraphs: string[];
  media: SdocxMedia[];
  /** 텍스트를 추출한 원본 엔트리 */
  sources: string[];
}

const IMAGE_EXT: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const TEXT_KEYS = new Set(['text', 'content', 'body', 'string', 'value', 'plaintext', 'plainText']);
const TITLE_KEYS = new Set(['title', 'name', 'subject']);

function basename(p: string) {
  return p.split('/').pop() ?? p;
}

/** text.json: 텍스트 성격의 키를 재귀적으로 수집 (순서 보존) */
export function textFromJson(json: unknown): { title: string | null; paragraphs: string[] } {
  const paragraphs: string[] = [];
  let title: string | null = null;
  const walk = (v: unknown, key: string | null) => {
    if (typeof v === 'string') {
      const s = v.trim();
      if (!s) return;
      if (key && TITLE_KEYS.has(key) && !title) title = s;
      else if (key && TEXT_KEYS.has(key)) paragraphs.push(...s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean));
      return;
    }
    if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(json, null);
  return { title, paragraphs };
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

/** 단락(블록) 요소. span/run 같은 인라인 요소는 부모 단락의 텍스트로 합쳐진다 */
const BLOCK_TAGS = ['p', 'para', 'paragraph', 'text', 'textitem', 'line'];

/** document.xml: 단락 요소(p/paragraph/text …) 단위로 텍스트 추출, 없으면 전체 텍스트 노드 */
export function textFromXml(xml: string): { title: string | null; paragraphs: string[] } {
  if (typeof DOMParser !== 'undefined') {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    if (!doc.querySelector('parsererror')) {
      const all = Array.from(doc.getElementsByTagName('*'));
      const title = all.find((e) => TITLE_KEYS.has(e.localName.toLowerCase()))?.textContent?.trim() || null;
      const isBlock = (e: Element) => BLOCK_TAGS.includes(e.localName.toLowerCase());
      // 블록 요소 중 다른 블록 요소를 포함하지 않는 것만 (인라인 span 등은 부모 단락에 포함)
      const paraEls = all.filter((e) => isBlock(e) && !Array.from(e.getElementsByTagName('*')).some(isBlock));
      const source = paraEls.length ? paraEls : all.filter((e) => e.children.length === 0 && !TITLE_KEYS.has(e.localName.toLowerCase()));
      const paragraphs = source.map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean);
      return { title, paragraphs };
    }
  }
  // DOMParser 미가용 폴백: 정규식
  const title = /<(?:\w+:)?title[^>]*>([\s\S]*?)<\/(?:\w+:)?title>/i.exec(xml)?.[1]?.trim() ?? null;
  const re = /<(?:\w+:)?(?:p|para|paragraph|text)\b[^>]*>([\s\S]*?)<\/(?:\w+:)?(?:p|para|paragraph|text)>/gi;
  const paragraphs: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const t = decodeEntities(m[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    if (t) paragraphs.push(t);
  }
  return { title: title ? decodeEntities(title) : null, paragraphs };
}

/** .sdocx 바이트 → 텍스트 단락 + 미디어 */
export async function parseSdocx(data: ArrayBuffer | Uint8Array): Promise<SdocxContent> {
  const zip = await JSZip.loadAsync(data);
  const entries = Object.values(zip.files).filter((f) => !f.dir);
  const result: SdocxContent = { title: null, paragraphs: [], media: [], sources: [] };

  const byName = (re: RegExp) => entries.filter((f) => re.test(f.name));
  const textJson = byName(/(^|\/)text\.json$/i);
  const docXml = byName(/(^|\/)document\.xml$/i);

  for (const f of textJson) {
    try {
      const r = textFromJson(JSON.parse(await f.async('string')));
      result.title ??= r.title;
      result.paragraphs.push(...r.paragraphs);
      result.sources.push(f.name);
    } catch {
      /* 손상된 JSON 무시 */
    }
  }
  // text.json 에서 본문을 못 얻은 경우에만 document.xml 사용 (중복 방지)
  if (result.paragraphs.length === 0) {
    for (const f of docXml) {
      const r = textFromXml(await f.async('string'));
      result.title ??= r.title;
      result.paragraphs.push(...r.paragraphs);
      result.sources.push(f.name);
    }
  }

  const usedNames = new Set<string>();
  for (const f of entries) {
    const ext = f.name.split('.').pop()?.toLowerCase() ?? '';
    const mime = IMAGE_EXT[ext];
    if (!mime) continue;
    if (/(^|\/)(thumbnail|thumb|preview)[^/]*$/i.test(f.name)) continue; // 미리보기 썸네일 제외
    let name = basename(f.name).replace(/[\\/<>:"|?*\u0000-\u001f]/g, '_');
    let n = 1;
    while (usedNames.has(name)) name = name.replace(/(\.\w+)$/, `-${n++}$1`);
    usedNames.add(name);
    result.media.push({ path: f.name, name, data: await f.async('uint8array'), mime });
  }
  return result;
}

/** 단락 + 미디어 링크 → 마크다운 */
export function sdocxToMarkdown(content: SdocxContent, mediaLinks: string[]): string {
  const esc = (s: string) => s.replace(/^(#{1,6}\s|[-*+]\s|\d+\.\s|>)/, '\\$1');
  const parts = content.paragraphs.map(esc);
  for (const link of mediaLinks) parts.push(`![](${link})`);
  return parts.join('\n\n');
}
