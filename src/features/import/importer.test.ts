import { describe, expect, it } from 'vitest';
import { detectImportKind, safeTitle, IMPORT_MAX_BYTES } from './importer';

describe('PDF 가져오기 유틸 및 형식 감지', () => {
  it('PDF 파일만 감지하고 .sdocx 는 지원하지 않는다', () => {
    expect(detectImportKind({ name: 'document.pdf', type: 'application/pdf' })).toBe('pdf');
    expect(detectImportKind({ name: 'lecture.PDF', type: '' })).toBe('pdf');
    expect(detectImportKind({ name: 'note.sdocx', type: '' })).toBeNull();
    expect(detectImportKind({ name: 'image.png', type: 'image/png' })).toBeNull();
  });

  it('안전한 노트 제목으로 정리', () => {
    expect(safeTitle('수학 / 1. 군의 정의: (기초)*?', 'fallback')).toBe('수학 1. 군의 정의 (기초)');
    expect(safeTitle('', '기본제목')).toBe('기본제목');
    expect(safeTitle(null, '기본제목')).toBe('기본제목');
  });

  it('가져오기 최대 바이트는 200MB', () => {
    expect(IMPORT_MAX_BYTES).toBe(200 * 1024 * 1024);
  });
});
