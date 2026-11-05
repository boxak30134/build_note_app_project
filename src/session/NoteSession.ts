import { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { CompositeHistoryManager } from '../core/history/CompositeHistoryManager';
import { StrokeStore, type Stroke } from '../core/strokes/StrokeStore';
import { UnencodableCharError } from '../core/codec/textCodec';
import { validateImageFiles } from '../core/files/validation';
import { clampBubbleText } from '../core/bubble/limits';
import { plainTextOf } from '../core/doc/blocks';
import { buildExtensions } from '../editor/extensions';
import { ASSIGN_IDS_META } from '../editor/extensions/blockId';
import { db, uid, type NoteRecord } from '../storage/db';
import { drafts } from '../storage/drafts';
import { readHandle, writeHandle } from '../storage/localFiles';
import { extOfMime, saveAttachmentExclusive, saveImageExclusive } from '../storage/opfs';
import { indexNote, searchRelated } from '../search/searchClient';
import { offlineLinker, type LinkRecommendation } from '../services/offlineDocumentLinker';
import { getSessionUI, useSessions, type PendingCitation } from '../store/sessionStore';
import { useSettings } from '../store/settingsStore';
import { toast, confirmDialog } from '../store/uiStore';
import type { Annotation, AnnotationAnchor } from '../features/annotations/types';
import {
  clampNoteZoom,
  createPage,
  DEFAULT_NOTE_ZOOM,
  insertPageBelow,
  NOTE_ZOOM_STEP,
  type NotePage,
} from '../core/page/pageTypes';

const sessions = new Map<string, NoteSession>();

export function getSession(id: string | null | undefined): NoteSession | undefined {
  return id ? sessions.get(id) : undefined;
}

export function allSessions(): NoteSession[] {
  return [...sessions.values()];
}

export async function openSession(id: string): Promise<NoteSession | null> {
  const existing = sessions.get(id);
  if (existing) return existing;
  const record = await db.notes.get(id);
  if (!record || record.deletedAt) return null;
  if (sessions.has(id)) return sessions.get(id)!;
  const s = new NoteSession(record);
  sessions.set(id, s);
  return s;
}

export function closeSession(id: string) {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  // 에디터 destroy 는 React 가 해당 탭의 컴포넌트를 모두 언마운트(cleanup)한 뒤로 미룬다.
  // 즉시 destroy 하면 언마운트 중인 컴포넌트가 editor.view 에 접근하다 예외가 발생한다.
  setTimeout(() => {
    s.destroy();
    if (!sessions.has(id)) useSessions.getState().remove(id);
  }, 0);
}

/**
 * 열린 노트 하나의 런타임 상태: TipTap 에디터 + 벡터 스트로크 + 주석 + 통합 히스토리.
 * 탭 전환 시에도 메모리에 유지되어 에디터 상태·스트로크·스크롤 위치가 보존된다.
 */
export class NoteSession {
  readonly id: string;
  readonly history = new CompositeHistoryManager();
  readonly strokes: StrokeStore;
  readonly editor: Editor;
  /** 에디터 DOM 호스트 (React 리렌더와 무관하게 유지) */
  readonly host: HTMLDivElement = document.createElement('div');
  record: NoteRecord;
  pageEl: HTMLElement | null = null;
  scrollEl: HTMLElement | null = null;

  private cleanDoc: PMNode | null = null;
  private cleanStrokes = '[]';
  private cleanAnnotations = '[]';
  private cleanPages = '[]';
  private dirtyTimer: ReturnType<typeof setTimeout> | null = null;
  private draftTimer: ReturnType<typeof setTimeout> | null = null;
  private relatedTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubs: Array<() => void> = [];
  private saving = false;

  constructor(record: NoteRecord) {
    this.id = record.id;
    this.record = record;
    this.strokes = new StrokeStore(this.history, record.strokes ?? []);
    const settings = useSettings.getState();
    const initialPages =
      record.pages && record.pages.length > 0
        ? record.pages
        : [
            createPage({
              size: settings.defaultPaperSize,
              style: settings.defaultPageStyle,
              orientation: settings.defaultOrientation,
            }),
          ];
    this.patch({
      annotations: record.annotations ?? [],
      pages: initialPages,
      currentPageIndex: 0,
      loaded: true,
      readOnly: false,
      external: null,
    });

    this.host.className = 'editor-host';
    this.editor = new Editor({
      element: this.host,
      extensions: buildExtensions({ noteId: record.id, getHistory: () => this.history }),
      content: record.content as never,
      editorProps: {
        attributes: { class: 'prose-note', spellcheck: 'false' },
        handlePaste: (_view, event) => this.handlePaste(event),
        handleDrop: (_view, event) => this.handleDrop(event as DragEvent),
      },
    });

    // 블록 ID 부여 후 "편집 안 함(Clean)" 기준값을 마운트 직후 최초 직렬화 값으로 확정
    this.editor.view.dispatch(this.editor.state.tr.setMeta(ASSIGN_IDS_META, true).setMeta('addToHistory', false));
    this.captureClean();
    this.restoreDraftIfNewer();
    this.refreshRelatedNotes();

    this.editor.on('transaction', ({ transaction }) => {
      if (transaction.docChanged) {
        this.mapCitations(transaction.mapping.map.bind(transaction.mapping));
        this.scheduleDirtyCheck();
        this.scheduleRelatedNotesRefresh();
      }
    });
    this.unsubs.push(this.strokes.subscribe(() => this.scheduleDirtyCheck()));
    this.unsubs.push(
      this.history.subscribe(() => this.patch({ canUndo: this.history.canUndo, canRedo: this.history.canRedo })),
    );
  }

  get ui() {
    return getSessionUI(this.id);
  }

  patch(p: Parameters<ReturnType<typeof useSessions.getState>['patch']>[1]) {
    useSessions.getState().patch(this.id, p);
  }

  // ---------- dirty / clean ----------
  private captureClean() {
    this.cleanDoc = this.editor.state.doc;
    this.cleanStrokes = JSON.stringify(this.strokes.getAll());
    this.cleanAnnotations = JSON.stringify(this.ui.annotations);
    this.cleanPages = JSON.stringify(this.ui.pages);
    this.patch({ dirty: false });
  }

  scheduleDirtyCheck() {
    if (this.dirtyTimer) clearTimeout(this.dirtyTimer);
    this.dirtyTimer = setTimeout(() => this.checkDirty(), 120);
  }

  checkDirty() {
    const dirty =
      !this.cleanDoc ||
      !this.editor.state.doc.eq(this.cleanDoc) ||
      JSON.stringify(this.strokes.getAll()) !== this.cleanStrokes ||
      JSON.stringify(this.ui.annotations) !== this.cleanAnnotations ||
      JSON.stringify(this.ui.pages) !== this.cleanPages;
    if (dirty !== this.ui.dirty) this.patch({ dirty });
    if (dirty) this.scheduleDraft();
    else drafts.clear(this.id);
  }

  private scheduleDraft() {
    if (this.draftTimer) clearTimeout(this.draftTimer);
    this.draftTimer = setTimeout(() => {
      drafts.set(this.id, {
        doc: this.editor.getJSON(),
        strokes: this.strokes.getAll(),
        annotations: this.ui.annotations,
        pages: this.ui.pages,
        at: Date.now(),
      });
    }, 600);
  }

  private restoreDraftIfNewer() {
    const d = drafts.get(this.id);
    if (!d || d.at <= this.record.updatedAt) return;
    try {
      this.editor.view.dispatch(
        this.editor.state.tr
          .replaceWith(0, this.editor.state.doc.content.size, this.editor.schema.nodeFromJSON(d.doc).content)
          .setMeta('addToHistory', false),
      );
      this.strokes.reset(d.strokes ?? []);
      this.patch({
        annotations: d.annotations ?? [],
        ...(d.pages && d.pages.length > 0 ? { pages: d.pages } : {}),
      });
      this.history.clear();
      setTimeout(() => {
        this.checkDirty();
        toast.info(`'${this.record.title}'의 저장되지 않은 임시 내용을 복원했습니다.`);
      }, 0);
    } catch {
      drafts.clear(this.id);
    }
  }

  // ---------- pages & fonts ----------
  /**
   * 현재 페이지 바로 밑에 새 페이지를 추가한다.
   * 현재 페이지와 동일한 규격(size, orientation) 및 동일한 스타일(style)로 생성된다.
   */
  addPageBelow(fromPageIndex?: number, override?: Partial<Omit<NotePage, 'id'>>): NotePage {
    const targetIdx = fromPageIndex ?? this.ui.currentPageIndex;
    const { pages, insertedIndex, insertedPage } = insertPageBelow(this.ui.pages, targetIdx, override);
    this.patch({ pages, currentPageIndex: insertedIndex });
    this.scheduleDirtyCheck();
    return insertedPage;
  }

  setCurrentPageIndex(index: number) {
    const clamped = Math.max(0, Math.min(this.ui.pages.length - 1, index));
    if (clamped !== this.ui.currentPageIndex) {
      this.patch({ currentPageIndex: clamped });
    }
  }

  /** 노트 영역 확대/축소 배율 설정 (0.5x ~ 3.0x) */
  setZoom(zoom: number): number {
    const clamped = clampNoteZoom(zoom);
    if (clamped !== this.ui.zoom) {
      this.patch({ zoom: clamped });
    }
    return clamped;
  }

  /** 노트 배율 증감 (기본 step: 0.1) */
  zoomBy(delta: number = NOTE_ZOOM_STEP): number {
    return this.setZoom((this.ui.zoom || DEFAULT_NOTE_ZOOM) + delta);
  }

  /** 노트 배율 100%(1.0x)로 초기화 */
  resetZoom(): number {
    return this.setZoom(DEFAULT_NOTE_ZOOM);
  }

  updateCurrentPageFormat(patch: Partial<Omit<NotePage, 'id'>>, applyToAll = false) {
    const targetIdx = this.ui.currentPageIndex;
    const nextPages = this.ui.pages.map((p, idx) => (applyToAll || idx === targetIdx ? { ...p, ...patch } : p));
    this.patch({ pages: nextPages });
    this.scheduleDirtyCheck();
  }

  applyFontFamily(family: string) {
    const { empty } = this.editor.state.selection;
    if (!empty) {
      this.editor.chain().focus().setMark('fontFamily', { family }).run();
    }
  }

  // ---------- annotations ----------
  setAnnotations(fn: (a: Annotation[]) => Annotation[]) {
    this.patch((s) => ({ annotations: fn(s.annotations) }));
    this.scheduleDirtyCheck();
  }

  updateAnnotation(id: string, p: Partial<Annotation>) {
    this.setAnnotations((list) =>
      list.map((a) => (a.id === id ? { ...a, ...p, body: p.body !== undefined ? clampBubbleText(p.body) : a.body } : a)),
    );
  }

  deleteAnnotation(id: string) {
    const { state } = this.editor;
    const type = state.schema.marks.annotation;
    const tr = state.tr;
    state.doc.descendants((node, pos) => {
      node.marks.forEach((m) => {
        if (m.type === type && m.attrs.id === id) tr.removeMark(pos, pos + node.nodeSize, m);
      });
    });
    if (tr.docChanged) this.editor.view.dispatch(tr);
    this.setAnnotations((list) => list.filter((a) => a.id !== id));
    this.patch({ openAnnotationId: null });
  }

  /** 텍스트 선택 → 텍스트 앵커, 올가미 선택 → 스트로크 앵커, 그 외 → 지점 앵커 */
  createAnnotation(point?: { x: number; y: number }): string {
    const id = uid('ann');
    const { selection } = this.editor.state;
    let anchor: AnnotationAnchor;
    if (!selection.empty && !point) {
      const quote = this.editor.state.doc.textBetween(selection.from, selection.to, ' ');
      this.editor.chain().focus().setMark('annotation', { id }).run();
      anchor = { type: 'text', quote };
    } else if (this.ui.lassoIds.length > 0 && !point) {
      const box = this.strokes.boundsOf(this.ui.lassoIds)!;
      anchor = { type: 'strokes', strokeIds: this.ui.lassoIds.slice(), fallbackBox: box };
      this.patch({ lassoIds: [], moveMode: false });
    } else {
      const p = point ?? this.caretPoint();
      anchor = { type: 'point', x: p.x, y: p.y };
    }
    this.setAnnotations((list) => [...list, { id, anchor, body: '', turns: [], createdAt: Date.now() }]);
    this.patch({ openAnnotationId: id });
    return id;
  }

  /** 현재 캐럿 위치 (페이지 좌표) */
  caretPoint(): { x: number; y: number } {
    try {
      const c = this.editor.view.coordsAtPos(this.editor.state.selection.to);
      const r = this.pageEl?.getBoundingClientRect();
      if (r) return { x: c.right - r.left, y: c.top - r.top };
    } catch {
      /* noop */
    }
    return { x: 40, y: 40 };
  }

  annotationQuote(a: Annotation): string {
    if (a.anchor.type !== 'text') return '';
    const parts: string[] = [];
    this.editor.state.doc.descendants((node) => {
      if (node.isText && node.marks.some((m) => m.type.name === 'annotation' && m.attrs.id === a.id)) parts.push(node.text ?? '');
    });
    return parts.join('') || a.anchor.quote;
  }

  getStrokesForAnnotation(a: Annotation): Stroke[] {
    return a.anchor.type === 'strokes' ? this.strokes.getMany(a.anchor.strokeIds) : [];
  }

  // ---------- citations (non-blocking link creation) ----------
  private mapCitations(map: (pos: number, assoc?: number) => number) {
    const list = this.ui.citations;
    if (list.length === 0) return;
    this.patch({ citations: list.map((c) => ({ ...c, from: map(c.from, 1), to: map(c.to, -1) })) });
  }

  /** 선택 텍스트를 Web Worker 검색 파이프라인으로 비동기 전송. 즉시 반환(UI 블로킹 없음) */
  requestLinkSuggestions() {
    const { from, to, empty } = this.editor.state.selection;
    if (empty) return;
    const text = this.editor.state.doc.textBetween(from, to, ' ').trim();
    if (!text) return;
    const id = uid('cite');
    const c: PendingCitation = { id, from, to, text, status: 'pending', results: [] };
    this.patch((s) => ({ citations: [...s.citations, c] }));
    searchRelated(text, this.id, 5)
      .then(({ hits, source }) => {
        this.patch((s) => ({
          citations: s.citations.map((x) => (x.id === id ? { ...x, status: 'done', results: hits, source } : x)),
        }));
      })
      .catch((e: unknown) => {
        this.patch((s) => ({
          citations: s.citations.map((x) => (x.id === id ? { ...x, status: 'error', error: String(e) } : x)),
        }));
      });
  }

  dismissCitation(id: string) {
    this.patch((s) => ({ citations: s.citations.filter((c) => c.id !== id), openCitationId: s.openCitationId === id ? null : s.openCitationId }));
  }

  /**
   * 오프라인 문서 링커: 편집이 1000ms 이상 멈추거나 저장될 때 현재 문서 인덱스를 갱신하고 연관 노트를 재계산한다.
   */
  scheduleRelatedNotesRefresh(delayMs = 1000) {
    if (this.relatedTimer) clearTimeout(this.relatedTimer);
    this.relatedTimer = setTimeout(() => {
      this.relatedTimer = null;
      this.refreshRelatedNotes();
    }, delayMs);
  }

  refreshRelatedNotes(): LinkRecommendation[] {
    if (this.editor.isDestroyed) return [];
    const content = this.editor.getMarkdown() || this.record.markdown || plainTextOf(this.record.content);
    offlineLinker.upsertDocument({
      id: this.id,
      title: this.record.title,
      content,
      updatedAt: Date.now(),
    });
    const relatedNotes = offlineLinker.recommendSimilarDocuments(this.id, 5);
    this.patch({ relatedNotes });
    return relatedNotes;
  }

  /**
   * 드래그 선택 영역 기반 즉각 오프라인 연관 문서 추천 (< 10ms)
   */
  recommendByCurrentSelection(topK = 5): { text: string; from: number; to: number; recommendations: LinkRecommendation[] } {
    const { from, to, empty } = this.editor.state.selection;
    if (empty) return { text: '', from, to, recommendations: [] };
    const text = this.editor.state.doc.textBetween(from, to, ' ').trim();
    if (!text) return { text: '', from, to, recommendations: [] };
    return {
      text,
      from,
      to,
      recommendations: offlineLinker.recommendBySelection(text, this.id, topK),
    };
  }

  /**
   * 선택한 추천 노트로 드래그 구절을 [[문서제목|선택된 구절]] 위키링크로 즉시 치환한다.
   */
  applySelectionWikiLink(rec: LinkRecommendation, range?: { from: number; to: number; text: string }) {
    const from = range?.from ?? this.editor.state.selection.from;
    const to = range?.to ?? this.editor.state.selection.to;
    const label = (range?.text ?? this.editor.state.doc.textBetween(from, to, ' ')).trim() || rec.title;
    const cleanTitle = rec.title.replace(/\.md$/i, '').trim() || rec.docId;
    this.editor
      .chain()
      .focus()
      .insertContentAt(
        { from, to },
        {
          type: 'wikiLink',
          attrs: { targetDocId: cleanTitle, targetBlockId: null, label },
        },
      )
      .run();
  }

  // ---------- media insertion ----------
  async insertImageFiles(files: File[], at?: number) {
    const err = validateImageFiles(files);
    if (err) {
      toast.error(err);
      return;
    }
    const nodes = [];
    for (const f of files) {
      try {
        const ext = f.name.split('.').pop()?.toLowerCase() || extOfMime(f.type);
        const rel = await saveImageExclusive(this.id, f, ext === 'jpeg' ? 'jpg' : ext);
        nodes.push({ type: 'image', attrs: { src: rel, alt: '' } });
      } catch (e) {
        toast.error(`이미지 저장 실패: ${(e as Error).message}`);
      }
    }
    if (nodes.length === 0) return;
    const chain = this.editor.chain().focus();
    if (at != null) chain.insertContentAt(at, nodes).run();
    else chain.insertContent(nodes).run();
  }

  async insertPdf(file: File) {
    try {
      const rel = await saveAttachmentExclusive(this.id, file, file.name);
      this.editor.chain().focus().insertContent([{ type: 'pdfEmbed', attrs: { src: rel, name: file.name } }, { type: 'paragraph' }]).run();
    } catch (e) {
      toast.error(`PDF 저장 실패: ${(e as Error).message}`);
    }
  }

  insertTable() {
    this.editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
  }

  private handlePaste(event: ClipboardEvent): boolean {
    const cd = event.clipboardData;
    if (!cd) return false;
    // 텍스트 우선 원칙: 텍스트/HTML 이 함께 있으면 이미지 대신 텍스트를 붙여넣는다
    const text = cd.getData('text/plain');
    const html = cd.getData('text/html');
    if (text || html) return false;
    const images = Array.from(cd.files).filter((f) => f.type.startsWith('image/'));
    if (images.length === 0) return false;
    const named = images.map((f) => (f.name && f.name !== 'image.png' ? f : new File([f], `paste.${extOfMime(f.type)}`, { type: f.type })));
    void this.insertImageFiles(named);
    return true;
  }

  private handleDrop(event: DragEvent): boolean {
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length === 0) return false;
    const images = files.filter((f) => f.type.startsWith('image/'));
    const pdfs = files.filter((f) => f.type === 'application/pdf');
    if (images.length === 0 && pdfs.length === 0) return false;
    event.preventDefault();
    const pos = this.editor.view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
    if (images.length) void this.insertImageFiles(images, pos);
    pdfs.forEach((p) => void this.insertPdf(p));
    return true;
  }

  // ---------- save / file sync ----------
  /** 저장 직전 반드시 에디터 인스턴스에서 최신 마크다운을 직접 확정 획득한다 */
  async save(): Promise<boolean> {
    if (this.saving) return false;
    if (this.ui.readOnly) {
      toast.error('읽기 전용 문서는 저장할 수 없습니다.');
      return false;
    }
    this.saving = true;
    try {
      const markdown = this.editor.getMarkdown();
      const content = this.editor.getJSON();
      const strokes = this.strokes.getAll();
      const annotations = this.ui.annotations;
      const pages = this.ui.pages;
      let fileLastModified = this.record.fileLastModified ?? null;
      if (this.record.fileHandle) {
        try {
          fileLastModified = await writeHandle(this.record.fileHandle, markdown, this.record.encoding, this.record.eol);
        } catch (e) {
          if (e instanceof UnencodableCharError) {
            await confirmDialog(
              'CP949 저장 불가',
              `${e.message}\n\n해당 문자를 제거하거나 다른 문자로 바꾼 뒤 다시 저장하세요. 파일은 변경되지 않았습니다.`,
              [{ label: '확인', value: 'ok', variant: 'primary' }],
            );
            return false;
          }
          toast.error(`파일 저장 실패: ${(e as Error).message}`);
          return false;
        }
      }
      const fresh = (await db.notes.get(this.id)) ?? this.record;
      const updated: NoteRecord = {
        ...fresh,
        content,
        markdown,
        plainText: plainTextOf(content),
        strokes,
        annotations,
        pages,
        fileLastModified,
        updatedAt: Date.now(),
      };
      await db.notes.put(updated);
      this.record = updated;
      drafts.clear(this.id);
      this.captureClean();
      indexNote(updated);
      this.refreshRelatedNotes();
      return true;
    } finally {
      this.saving = false;
    }
  }

  /** 디스크에서 다시 불러오기 (외부 변경 반영) */
  async reloadFromDisk() {
    const h = this.record.fileHandle;
    if (!h) return;
    try {
      const d = await readHandle(h);
      const json = this.editor.markdown!.parse(d.text);
      this.editor.view.dispatch(
        this.editor.state.tr
          .replaceWith(0, this.editor.state.doc.content.size, this.editor.schema.nodeFromJSON(json).content)
          .setMeta('addToHistory', false)
          .setMeta(ASSIGN_IDS_META, true),
      );
      this.history.clear();
      const updated = { ...this.record, content: this.editor.getJSON(), markdown: d.text, encoding: d.encoding, eol: d.eol, fileLastModified: d.lastModified, updatedAt: Date.now() };
      await db.notes.put(updated);
      this.record = updated;
      drafts.clear(this.id);
      this.captureClean();
      this.patch({ external: null });
      indexNote(updated);
    } catch (e) {
      toast.error(`다시 불러오기 실패: ${(e as Error).message}`);
    }
  }

  keepMine() {
    this.patch({ external: null });
    this.ignoreModifiedUntil = this.pendingDiskModified;
  }

  private ignoreModifiedUntil = 0;
  private pendingDiskModified = 0;

  /** File Watcher 폴링 1회 */
  async pollDisk() {
    const h = this.record.fileHandle;
    if (!h || this.saving) return;
    try {
      const file = await h.getFile();
      if (this.ui.external === 'deleted') {
        this.patch({ external: null, readOnly: false });
        this.editor.setEditable(true);
      }
      const lm = file.lastModified;
      if (lm === this.record.fileLastModified || lm <= this.ignoreModifiedUntil) return;
      this.pendingDiskModified = lm;
      if (!this.ui.dirty) await this.reloadFromDisk(); // Clean → 무음 자동 리로드
      else if (this.ui.external !== 'modified') this.patch({ external: 'modified' }); // Dirty → 경고 배너
    } catch (e) {
      const name = (e as DOMException)?.name;
      if (name === 'NotFoundError') {
        if (this.ui.external !== 'deleted') {
          this.patch({ external: 'deleted', readOnly: true });
          this.editor.setEditable(false);
        }
      }
      // NotAllowedError(권한 만료) 등은 조용히 무시
    }
  }

  undo() {
    this.history.undo();
  }

  redo() {
    this.history.redo();
  }

  destroy() {
    if (this.editor.isDestroyed) return;
    this.unsubs.forEach((u) => u());
    if (this.dirtyTimer) clearTimeout(this.dirtyTimer);
    if (this.draftTimer) clearTimeout(this.draftTimer);
    if (this.relatedTimer) clearTimeout(this.relatedTimer);
    this.editor.destroy();
  }
}
