// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { parseSdocx, sdocxToMarkdown, textFromJson, textFromXml } from './sdocx';
import { detectImportKind, safeTitle } from './importer';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

describe('.sdocx 텍스트 추출', () => {
  it('text.json 의 텍스트 키를 순서대로 수집', () => {
    const r = textFromJson({ title: '회의록', pages: [{ objects: [{ type: 'text', text: '첫 줄\n둘째 줄' }, { type: 'stroke', points: [1, 2] }] }, { body: '세 번째' }] });
    expect(r.title).toBe('회의록');
    expect(r.paragraphs).toEqual(['첫 줄', '둘째 줄', '세 번째']);
  });

  it('document.xml 의 단락 요소에서 텍스트 추출 (중첩 중복 없음)', () => {
    const xml = '<?xml version="1.0"?><doc><title>수업 노트</title><body><p>인지부하 <span>이론</span></p><p>외재적 &amp; 내재적</p></body></doc>';
    const r = textFromXml(xml);
    expect(r.title).toBe('수업 노트');
    expect(r.paragraphs).toEqual(['인지부하 이론', '외재적 & 내재적']);
  });

  it('패키지 압축 해제: text.json 우선, 미디어 추출, 썸네일 제외', async () => {
    const zip = new JSZip();
    zip.file('text.json', JSON.stringify({ title: '삼성 노트', content: ['본문 A', '본문 B'] }));
    zip.file('document.xml', '<doc><p>중복되면 안 됨</p></doc>');
    zip.file('media/photo.png', PNG);
    zip.file('media/sub/photo.png', PNG);
    zip.file('thumbnail.png', PNG);
    const data = await zip.generateAsync({ type: 'uint8array' });
    const r = await parseSdocx(data);
    expect(r.title).toBe('삼성 노트');
    expect(r.paragraphs).toEqual(['본문 A', '본문 B']);
    expect(r.media.map((m) => m.name)).toEqual(['photo.png', 'photo-1.png']);
    expect(r.media[0].mime).toBe('image/png');
    expect(Array.from(r.media[0].data)).toEqual(Array.from(PNG));
  });

  it('text.json 이 없으면 document.xml 사용', async () => {
    const zip = new JSZip();
    zip.file('contents/document.xml', '<doc><paragraph>XML 본문</paragraph></doc>');
    const r = await parseSdocx(await zip.generateAsync({ type: 'uint8array' }));
    expect(r.paragraphs).toEqual(['XML 본문']);
  });

  it('마크다운 변환: 미디어는 ![](attachments/...) 인라인 링크', () => {
    const md = sdocxToMarkdown({ title: null, paragraphs: ['# 해시로 시작', '일반'], media: [], sources: [] }, ['attachments/photo.png']);
    expect(md).toBe('\\# 해시로 시작\n\n일반\n\n![](attachments/photo.png)');
  });
});

describe('가져오기 유틸', () => {
  it('형식 감지', () => {
    expect(detectImportKind({ name: 'a.sdocx', type: '' })).toBe('sdocx');
    expect(detectImportKind({ name: 'A.PDF', type: '' })).toBe('pdf');
    expect(detectImportKind({ name: 'a.docx', type: '' })).toBeNull();
  });
  it('제목 정리: 금지 문자 제거, 끝 점 제거, 비면 기본값', () => {
    expect(safeTitle('회의: 1/2.', 'x')).toBe('회의 1 2');
    expect(safeTitle('...', '기본')).toBe('기본');
    expect(safeTitle(null, '기본')).toBe('기본');
  });
});
