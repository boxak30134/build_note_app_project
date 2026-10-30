import { describe, expect, it } from 'vitest';
import { imageFileName, validateFileName, validateImageFiles } from './validation';

describe('validateFileName', () => {
  it('유효한 이름', () => {
    expect(validateFileName('노트 1')).toBeNull();
    expect(validateFileName('a.md')).toBeNull();
  });
  it('거부 규칙', () => {
    expect(validateFileName('')).not.toBeNull();
    expect(validateFileName('   ')).not.toBeNull();
    expect(validateFileName('.')).not.toBeNull();
    expect(validateFileName('..')).not.toBeNull();
    for (const c of ['\\', '/', '<', '>', ':', '"', '|', '?', '*']) expect(validateFileName(`a${c}b`)).not.toBeNull();
    expect(validateFileName('a\u0001b')).not.toBeNull();
    expect(validateFileName('name.')).not.toBeNull();
    expect(validateFileName('name ')).not.toBeNull();
  });
});

describe('이미지 첨부 규칙', () => {
  it('형식/용량/개수', () => {
    expect(validateImageFiles([{ name: 'a.png', size: 10 }])).toBeNull();
    expect(validateImageFiles([{ name: 'a.bmp', size: 10 }])).not.toBeNull();
    expect(validateImageFiles([{ name: 'a.jpg', size: 21 * 1024 * 1024 }])).not.toBeNull();
    expect(validateImageFiles(Array.from({ length: 11 }, (_, i) => ({ name: `${i}.png`, size: 1 })))).not.toBeNull();
  });
  it('파일명 형식', () => {
    expect(imageFileName(new Date(2026, 0, 2, 3, 4, 5), 1)).toBe('images/20260102-030405-1.png');
  });
});
