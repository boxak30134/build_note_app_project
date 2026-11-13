// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildPdfBytesFromSession,
  exportNoteToMarkdown,
  safeExportFileName,
  saveBytesWithPicker,
} from '../src/features/export/noteExport';
import * as localFilesMod from '../src/storage/localFiles';
import type { NoteSession } from '../src/session/NoteSession';

describe('노트 Markdown / PDF 내보내기 (REQ_note_export_md_pdf)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });

  it('1. safeExportFileName이 OS 금지 문자를 제거하고 빈 제목에 기본값을 적용한다', () => {
    expect(safeExportFileName('강의/노트:1*2?')).toBe('강의 노트 1 2');
    expect(safeExportFileName('   ')).toBe('제목 없는 노트');
  });

  it('2. showSaveFilePicker 지원 시 사용자가 지정한 파일 핸들에 write/close를 수행한다', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    const createWritable = vi.fn().mockResolvedValue({ write, close });
    const showSaveFilePicker = vi.fn().mockResolvedValue({ createWritable });
    (window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = showSaveFilePicker;

    const bytes = new Uint8Array([1, 2, 3]);
    const ok = await saveBytesWithPicker(bytes, 'test.md', 'text/markdown', ['.md']);

    expect(ok).toBe(true);
    expect(showSaveFilePicker).toHaveBeenCalledWith(
      expect.objectContaining({ suggestedName: 'test.md' }),
    );
    expect(write).toHaveBeenCalledWith(bytes);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('3. 사용자가 저장 다이얼로그를 취소(AbortError)하면 false를 반환하고 폴백 다운로드를 실행하지 않는다', async () => {
    const abortErr = new DOMException('The user aborted a request.', 'AbortError');
    (window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = vi
      .fn()
      .mockRejectedValue(abortErr);
    const dlSpy = vi.spyOn(localFilesMod, 'downloadBytes').mockImplementation(() => {});

    const ok = await saveBytesWithPicker(new Uint8Array([1]), 'cancel.md', 'text/markdown', ['.md']);

    expect(ok).toBe(false);
    expect(dlSpy).not.toHaveBeenCalled();
  });

  it('4. showSaveFilePicker 미지원 환경에서는 downloadBytes 폴백으로 저장한다', async () => {
    delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
    const dlSpy = vi.spyOn(localFilesMod, 'downloadBytes').mockImplementation(() => {});

    const bytes = new Uint8Array([10, 20]);
    const ok = await saveBytesWithPicker(bytes, 'fallback.pdf', 'application/pdf', ['.pdf']);

    expect(ok).toBe(true);
    expect(dlSpy).toHaveBeenCalledWith(bytes, 'fallback.pdf', 'application/pdf');
  });

  it('5. exportNoteToMarkdown이 최신 에디터 마크다운과 제목으로 .md 파일을 내보낸다', async () => {
    const dlSpy = vi.spyOn(localFilesMod, 'downloadBytes').mockImplementation(() => {});
    const mockSession = {
      id: 'note-1',
      record: { title: '미적분학 정리', encoding: 'utf-8', eol: 'lf' },
      editor: { getMarkdown: () => '# 미적분학\n본문 테스트' },
    } as unknown as NoteSession;

    const ok = await exportNoteToMarkdown(mockSession);
    expect(ok).toBe(true);
    expect(dlSpy).toHaveBeenCalledTimes(1);
    const [writtenBytes, fileName, mime] = dlSpy.mock.calls[0];
    expect(fileName).toBe('미적분학 정리.md');
    expect(mime).toBe('text/markdown');
    expect(new TextDecoder().decode(writtenBytes)).toBe('# 미적분학\n본문 테스트');
  });

  it('6. buildPdfBytesFromSession이 유효한 PDF 헤더(%PDF-)를 포함한 Uint8Array를 생성한다', async () => {
    // jsdom canvas mock
    const fakeCtx = {
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
      font: '',
      fillRect: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      scale: vi.fn(),
      translate: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      measureText: vi.fn(() => ({ width: 10 })),
      fillText: vi.fn(),
      drawImage: vi.fn(),
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(fakeCtx as unknown as CanvasRenderingContext2D);
    // 1x1 유효 최소 JPEG 바이트 시뮬레이션 (SOI + EOI) -> pdf-lib embedJpg 파싱용 최소 유효 JPEG
    const minimalJpeg = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01, 0x00, 0x48,
      0x00, 0x48, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11,
      0x00, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x7f, 0xff, 0xd9,
    ]);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (cb) {
      cb(new Blob([minimalJpeg], { type: 'image/jpeg' }));
    });

    const mockSession = {
      id: 'note-pdf-1',
      record: { title: 'PDF 테스트', encoding: 'utf-8', eol: 'lf' },
      ui: { pages: [{ id: 'p-1', size: 'A4', style: 'plain', orientation: 'portrait' }] },
      editor: {
        getJSON: () => ({
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: '안녕하세요 PDF' }] }],
        }),
      },
      strokes: { getAll: () => [] },
    } as unknown as NoteSession;

    const progressCalls: Array<[number, number]> = [];
    const pdfBytes = await buildPdfBytesFromSession(mockSession, (p, t) => progressCalls.push([p, t]));

    expect(progressCalls).toEqual([[1, 1]]);
    const header = new TextDecoder().decode(pdfBytes.slice(0, 5));
    expect(header).toBe('%PDF-');
  });
});

