import { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { CompositeHistoryManager, newCommandId } from '../core/history/CompositeHistoryManager';
import { StrokeStore, newStrokeId, type Stroke } from '../core/strokes/StrokeStore';
import { translatePoints } from '../core/geometry/geometry';
import { newTextObjectId, type NoteTextObject } from '../core/text/textObjects';
import { UnencodableCharError } from '../core/codec/textCodec';
import { validateImageFiles, sanitizeDocumentTitle } from '../core/files/validation';
import { clampBubbleText } from '../core/bubble/limits';
import { plainTextOf } from '../core/doc/blocks';
import { buildExtensions, markdownToJson } from '../editor/extensions';
import { ASSIGN_IDS_META } from '../editor/extensions/blockId';
import { db, uid, type NoteRecord } from '../storage/db';
import { drafts } from '../storage/drafts';
import { readHandle, writeHandle } from '../storage/localFiles';
import { extOfMime, saveAttachmentExclusive, saveImageExclusive } from '../storage/opfs';
import { indexNote, searchRelated } from '../search/searchClient';
import { offlineLinker, type LinkRecommendation } from '../services/offlineDocumentLinker';
import { adaptiveGlossary } from '../services/AdaptiveGlossaryService';
import type { TranslationResolution } from '../types/adaptiveGlossary';
import { getSessionUI, useSessions, type PendingCitation } from '../store/sessionStore';
import { useSettings, type TranslationInsertMode } from '../store/settingsStore';
import { toast, confirmDialog } from '../store/uiStore';
import type { Annotation, AnnotationAnchor } from '../features/annotations/types';
import {
  clampNoteZoom,
  computePdfPageLayout,
  createPage,
  DEFAULT_NOTE_ZOOM,
  extractInkTemplateDimensions,
  getPageDimensions,
  insertPageBelow,
  normalizePdfNoteContent,
  NOTE_ZOOM_STEP,
  PDF_PAGE_GAP_PX,
  type NotePage,
} from '../core/page/pageTypes';
import { getMeasuredPageLayout } from '../core/layout/pageLayout';
import {
  createInitialNavState,
  onNavigateRequest,
  type NavState,
} from '../core/navigation/pageNavigation';

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
  navState: NavState = createInitialNavState(0);

  private cleanDoc: PMNode | null = null;
  private cleanStrokes = '[]';
  private cleanAnnotations = '[]';
  private cleanTextObjects = '[]';
  private cleanPages = '[]';
  private dirtyTimer: ReturnType<typeof setTimeout> | null = null;
  private draftTimer: ReturnType<typeof setTimeout> | null = null;
  private relatedTimer: ReturnType<typeof setTimeout> | null = null;
  private titleSyncTimer: ReturnType<typeof setTimeout> | null = null;
  isManualTitle = false;
  lastAutoTitle: string | null = null;
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
      textObjects: record.textObjects ?? [],
      pages: initialPages,
      currentPageIndex: 0,
      loaded: true,
      readOnly: false,
      external: null,
    });

    let rawContent = record.content;
    if (typeof rawContent === 'string') {
      rawContent = markdownToJson(rawContent);
    } else if (!rawContent && record.markdown) {
      rawContent = markdownToJson(record.markdown);
    }

    const normalizedInitialContent = normalizePdfNoteContent(
      rawContent as { type?: string; content?: Array<{ type?: string; attrs?: Record<string, unknown> }> },
      initialPages,
    );
    this.host.className = 'editor-host';
    this.editor = new Editor({
      element: this.host,
      extensions: buildExtensions({ noteId: record.id, getHistory: () => this.history }),
      content: normalizedInitialContent as never,
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

    const initialHeader = this.extractTopHeader();
    const cleanHeader = initialHeader ? sanitizeDocumentTitle(initialHeader) : null;
    if (record.title === '제목 없는 노트' || !record.title) {
      this.isManualTitle = false;
      if (cleanHeader) {
        this.scheduleTitleSync();
      }
    } else if (cleanHeader && cleanHeader === record.title) {
      this.isManualTitle = false;
      this.lastAutoTitle = cleanHeader;
    } else {
      this.isManualTitle = true;
    }

    this.editor.on('transaction', ({ transaction }) => {
      if (transaction.docChanged) {
        this.mapCitations(transaction.mapping.map.bind(transaction.mapping));
        this.scheduleDirtyCheck();
        this.scheduleRelatedNotesRefresh();
        this.scheduleTitleSync();
      }
    });
    this.unsubs.push(this.strokes.subscribe(() => this.scheduleDirtyCheck()));
    this.unsubs.push(
      this.history.subscribe(() => this.patch({ canUndo: this.history.canUndo, canRedo: this.history.canRedo })),
    );
    this.history.clear();
    this.patch({ canUndo: false, canRedo: false });
  }

  get canUndo(): boolean {
    return this.history.canUndo;
  }

  get canRedo(): boolean {
    return this.history.canRedo;
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
    this.cleanTextObjects = JSON.stringify(this.ui.textObjects ?? []);
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
      JSON.stringify(this.ui.textObjects ?? []) !== this.cleanTextObjects ||
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
        textObjects: this.ui.textObjects ?? [],
        pages: this.ui.pages,
        at: Date.now(),
      });
    }, 600);
  }

  private restoreDraftIfNewer() {
    const d = drafts.get(this.id);
    if (!d || d.at <= this.record.updatedAt) return;
    try {
      const normalizedDraftDoc = normalizePdfNoteContent(
        d.doc as { type?: string; content?: Array<{ type?: string; attrs?: Record<string, unknown> }> },
      );
      this.editor.view.dispatch(
        this.editor.state.tr
          .replaceWith(0, this.editor.state.doc.content.size, this.editor.schema.nodeFromJSON(normalizedDraftDoc).content)
          .setMeta('addToHistory', false),
      );
      this.strokes.reset(d.strokes ?? []);
      this.patch({
        annotations: d.annotations ?? [],
        textObjects: (d as any).textObjects ?? [],
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
   * PDF 문서 및 일반 문서의 페이지 수 및 순서 불변식 검사
   */
  assertPageInvariant(): boolean {
    const isDev = Boolean(import.meta.env?.DEV || import.meta.env?.MODE === 'test');
    if (!isDev) return true;

    if (!this.editor || this.editor.isDestroyed) return true;

    const templateNodes: PMNode[] = [];
    this.editor.state.doc.descendants((node) => {
      if (node.type.name === 'inkTemplate') {
        templateNodes.push(node);
        return false;
      }
      return true;
    });

    if (templateNodes.length === 0) return true;

    const uiCount = this.ui.pages.length;
    const docCount = templateNodes.length;

    let hasOrderViolation = false;
    let hasIdViolation = false;
    for (let i = 0; i < docCount; i++) {
      if (templateNodes[i].attrs.page !== i + 1) {
        hasOrderViolation = true;
        break;
      }
      const nodePageId = templateNodes[i].attrs.pageId;
      if (nodePageId && this.ui.pages[i] && this.ui.pages[i].id !== nodePageId) {
        hasIdViolation = true;
        break;
      }
    }

    if (uiCount !== docCount || hasOrderViolation || hasIdViolation) {
      console.error('[PAGE_INVARIANT_VIOLATION]', {
        uiPagesLength: uiCount,
        docTemplateCount: docCount,
        hasOrderViolation,
        hasIdViolation,
        pages: this.ui.pages,
        templates: templateNodes.map((n) => n.attrs),
        stack: new Error().stack,
      });
      return false;
    }

    return true;
  }

  /**
   * 현재 페이지 바로 밑에 새 페이지를 추가한다.
   * 현재 페이지와 동일한 규격(size, orientation) 및 동일한 스타일(style)로 생성된다.
   */
  addPageBelow(
    fromPageIndex?: number,
    override?: Partial<Omit<NotePage, 'id'>>,
    recordHistory = true,
  ): NotePage {
    const targetIdx = fromPageIndex ?? this.ui.currentPageIndex;
    const { pages, insertedIndex, insertedPage } = insertPageBelow(this.ui.pages, targetIdx, override);

    // PDF 문서(`inkTemplate` 포함)인 경우 에디터 내 대상 페이지 바로 아래에 빈 `inkTemplate` 노드를 삽입하고 쪽수를 재정렬한다.
    if (this.editor && !this.editor.isDestroyed) {
      const templateNodes: Array<{ pos: number; node: PMNode }> = [];
      this.editor.state.doc.descendants((node, pos) => {
        if (node.type.name === 'inkTemplate') {
          templateNodes.push({ pos, node });
          return false;
        }
        return true;
      });

      const inkTemplateType = this.editor.schema.nodes.inkTemplate;
      if (templateNodes.length > 0 && inkTemplateType) {
        const clampedTarget = Math.max(0, Math.min(templateNodes.length - 1, targetIdx));
        const targetEntry = templateNodes[clampedTarget];
        const fallbackDims = getPageDimensions(insertedPage.size, insertedPage.orientation);
        const hasExplicitSize = Boolean(override?.size || override?.orientation);
        const newWidth = hasExplicitSize
          ? fallbackDims.width
          : Number(targetEntry.node.attrs.width) || fallbackDims.width;
        const newHeight = hasExplicitSize
          ? fallbackDims.height
          : Number(targetEntry.node.attrs.height) || fallbackDims.height;

        const newNode = inkTemplateType.create({
          src: '',
          width: newWidth,
          height: newHeight,
          page: clampedTarget + 2,
          pageId: insertedPage.id,
          style: insertedPage.style,
        });

        const insertPos = targetEntry.pos + targetEntry.node.nodeSize;
        let tr = this.editor.state.tr.insert(insertPos, newNode);

        let seq = 0;
        tr.doc.descendants((node, pos) => {
          if (node.type.name === 'inkTemplate') {
            seq += 1;
            if (node.attrs.page !== seq) {
              tr = tr.setNodeMarkup(pos, undefined, { ...node.attrs, page: seq });
            }
            return false;
          }
          return true;
        });

        this.editor.view.dispatch(tr);
        this.record = {
          ...this.record,
          content: this.editor.view.state.doc.toJSON(),
          pages,
        };
      } else {
        this.record = { ...this.record, pages };
      }
    } else {
      this.record = { ...this.record, pages };
    }

    this.patch({ pages, currentPageIndex: insertedIndex });
    this.scheduleDirtyCheck();
    this.assertPageInvariant();

    if (this.scrollEl) {
      setTimeout(() => this.navigateToPage(insertedIndex), 30);
    }

    if (recordHistory) {
      this.history.push({
        id: newCommandId(),
        type: 'page-add',
        timestamp: Date.now(),
        description: `페이지 ${insertedIndex + 1} 생성`,
        undo: () => {
          this.deletePage(insertedIndex, false);
        },
        redo: () => {
          this.insertPageAt(insertedIndex, insertedPage);
        },
      });
    }

    return insertedPage;
  }

  /** 지정한 인덱스에 특정 페이지 객체를 복원/삽입한다 (Undo/Redo 전용) */
  insertPageAt(index: number, page: NotePage): void {
    const nextPages = [...this.ui.pages];
    const clampedIndex = Math.max(0, Math.min(nextPages.length, index));
    nextPages.splice(clampedIndex, 0, page);

    if (this.editor && !this.editor.isDestroyed) {
      const templateNodes: Array<{ pos: number; node: PMNode }> = [];
      this.editor.state.doc.descendants((node, pos) => {
        if (node.type.name === 'inkTemplate') {
          templateNodes.push({ pos, node });
          return false;
        }
        return true;
      });

      const inkTemplateType = this.editor.schema.nodes.inkTemplate;
      if (templateNodes.length > 0 && inkTemplateType) {
        const insertTarget = Math.max(0, Math.min(templateNodes.length - 1, clampedIndex - 1));
        const refEntry = templateNodes[insertTarget] ?? templateNodes[0];
        const dims = getPageDimensions(page.size, page.orientation);
        const newNode = inkTemplateType.create({
          src: '',
          width: dims.width,
          height: dims.height,
          page: clampedIndex + 1,
          pageId: page.id,
          style: page.style,
        });
        const insertPos = clampedIndex === 0 || !refEntry ? 0 : refEntry.pos + refEntry.node.nodeSize;
        let tr = this.editor.state.tr.insert(insertPos, newNode);
        let seq = 0;
        tr.doc.descendants((node, pos) => {
          if (node.type.name === 'inkTemplate') {
            seq += 1;
            if (node.attrs.page !== seq) {
              tr = tr.setNodeMarkup(pos, undefined, { ...node.attrs, page: seq });
            }
            return false;
          }
          return true;
        });
        this.editor.view.dispatch(tr);
        this.record = { ...this.record, content: this.editor.view.state.doc.toJSON(), pages: nextPages };
      } else {
        this.record = { ...this.record, pages: nextPages };
      }
    } else {
      this.record = { ...this.record, pages: nextPages };
    }

    this.patch({ pages: nextPages, currentPageIndex: clampedIndex });
    this.scheduleDirtyCheck();
    this.assertPageInvariant();
    if (this.scrollEl) {
      setTimeout(() => this.navigateToPage(clampedIndex), 30);
    }
  }

  /**
   * 지정한 인덱스의 페이지를 삭제한다 (원자적 트랜잭션).
   * - 최소 1페이지 보장: 단 1개의 페이지만 남은 경우 삭제 불가 (toast 경고 및 false 반환).
   * - Undo 시 삭제된 페이지, 소속 스트로크, 소속 텍스트 객체, 소속 주석, PDF 노드 및 스트로크 위치가 100% 완전 복원된다.
   */
  deletePage(pageIndex: number, recordHistory = true): boolean {
    const totalPages = this.ui.pages.length;
    if (totalPages <= 1) {
      toast.error('문서에는 최소 1개의 페이지가 있어야 합니다.');
      return false;
    }
    const clampedIndex = Math.max(0, Math.min(totalPages - 1, pageIndex));
    const targetPage = this.ui.pages[clampedIndex];
    if (!targetPage) return false;

    // 1. PDF 문서 (`inkTemplate` 포함)인 경우 에디터 내 해당 노드를 삭제하고 쪽수를 재정렬한다.
    let templateAttrs: Record<string, unknown> | null = null;
    if (this.editor && !this.editor.isDestroyed) {
      const templateNodes: Array<{ pos: number; node: PMNode }> = [];
      this.editor.state.doc.descendants((node, pos) => {
        if (node.type.name === 'inkTemplate') {
          templateNodes.push({ pos, node });
          return false;
        }
        return true;
      });

      if (templateNodes.length > clampedIndex) {
        const targetEntry = templateNodes[clampedIndex];
        templateAttrs = { ...targetEntry.node.attrs };
        let tr = this.editor.state.tr.delete(targetEntry.pos, targetEntry.pos + targetEntry.node.nodeSize);
        let seq = 0;
        tr.doc.descendants((node, pos) => {
          if (node.type.name === 'inkTemplate') {
            seq += 1;
            if (node.attrs.page !== seq) {
              tr = tr.setNodeMarkup(pos, undefined, { ...node.attrs, page: seq });
            }
            return false;
          }
          return true;
        });
        this.editor.view.dispatch(tr);
        this.record = { ...this.record, content: this.editor.view.state.doc.toJSON() };
      }
    }

    // 2. 페이지 배열 갱신
    const nextPages = this.ui.pages.filter((_, idx) => idx !== clampedIndex);
    this.record = { ...this.record, pages: nextPages };

    // 3. 해당 페이지의 스트로크 및 텍스트 정리
    const currentWidth = getPageDimensions(targetPage.size, targetPage.orientation).width;
    const pageDimsInput = this.ui.pages.map((p) => {
      const d = getPageDimensions(p.size, p.orientation);
      return { width: d.width, height: d.height };
    });
    const layout = computePdfPageLayout(pageDimsInput, currentWidth);
    const pageTop = layout.yOffsets[clampedIndex] ?? 0;
    const pageHeight = layout.pageHeights[clampedIndex] ?? 0;
    const pageBottom = pageTop + pageHeight + PDF_PAGE_GAP_PX;

    // 삭제된 페이지 영역 내 스트로크 캡처 및 후속 페이지 스트로크 상단 이동
    const allStrokes = this.strokes.getAll();
    const deletedStrokes: Stroke[] = [];
    const toDeleteStrokeIds: string[] = [];
    const toShiftStrokeIds: string[] = [];
    for (const s of allStrokes) {
      const bounds = this.strokes.boundsOf([s.id]);
      if (!bounds) continue;
      if (bounds.minY >= pageTop - 4 && bounds.maxY <= pageBottom + 4) {
        toDeleteStrokeIds.push(s.id);
        deletedStrokes.push(s);
      } else if (bounds.minY >= pageBottom) {
        toShiftStrokeIds.push(s.id);
      }
    }

    const shiftY = -(pageHeight + PDF_PAGE_GAP_PX);
    if (toDeleteStrokeIds.length > 0) {
      this.strokes.rawRemove(toDeleteStrokeIds);
    }
    if (toShiftStrokeIds.length > 0) {
      this.strokes.rawTranslate(toShiftStrokeIds, 0, shiftY);
    }

    // 4. 해당 페이지에 속한 textObjects 캡처 및 제거
    const deletedTextObjects = (this.ui.textObjects ?? []).filter((t) => t.pageId === targetPage.id);
    const remainingTextObjects = (this.ui.textObjects ?? []).filter((t) => t.pageId !== targetPage.id);

    // 5. 활성 페이지 인덱스 재설정
    const nextCurrentIndex = Math.min(nextPages.length - 1, clampedIndex);
    this.patch({
      pages: nextPages,
      textObjects: remainingTextObjects,
      currentPageIndex: nextCurrentIndex,
    });
    this.scheduleDirtyCheck();
    this.assertPageInvariant();
    if (this.scrollEl) {
      setTimeout(() => this.navigateToPage(nextCurrentIndex), 30);
    }

    // 6. 단일 원자적 페이지 삭제 커맨드로 통합 히스토리에 기록
    if (recordHistory) {
      this.history.push({
        id: newCommandId(),
        type: 'page-delete',
        timestamp: Date.now(),
        description: `페이지 ${clampedIndex + 1} 삭제`,
        undo: () => {
          this.restoreDeletedPage({
            targetPage,
            pageIndex: clampedIndex,
            deletedStrokes,
            deletedTextObjects,
            shiftStrokeIds: toShiftStrokeIds,
            shiftY,
            templateAttrs,
          });
        },
        redo: () => {
          this.deletePage(clampedIndex, false);
        },
      });
    }

    return true;
  }

  /** 삭제되었던 페이지와 그에 소속된 모든 스트로크, 텍스트, PDF 노드를 원자적으로 완전 복구한다 (Undo 전용) */
  private restoreDeletedPage(snapshot: {
    targetPage: NotePage;
    pageIndex: number;
    deletedStrokes: Stroke[];
    deletedTextObjects: NoteTextObject[];
    shiftStrokeIds: string[];
    shiftY: number;
    templateAttrs: Record<string, unknown> | null;
  }) {
    const { targetPage, pageIndex, deletedStrokes, deletedTextObjects, shiftStrokeIds, shiftY, templateAttrs } = snapshot;

    // 1. pages 배열의 pageIndex 위치에 targetPage 복원
    const nextPages = [...this.ui.pages];
    nextPages.splice(pageIndex, 0, targetPage);

    // 2. 에디터 inkTemplate 복원
    if (this.editor && !this.editor.isDestroyed && templateAttrs) {
      const templateNodes: Array<{ pos: number; node: PMNode }> = [];
      this.editor.state.doc.descendants((node, pos) => {
        if (node.type.name === 'inkTemplate') {
          templateNodes.push({ pos, node });
          return false;
        }
        return true;
      });

      const inkTemplateType = this.editor.schema.nodes.inkTemplate;
      if (inkTemplateType) {
        const insertTarget = Math.max(0, Math.min(templateNodes.length - 1, pageIndex - 1));
        const refEntry = templateNodes[insertTarget] ?? templateNodes[0];
        const newNode = inkTemplateType.create({
          ...templateAttrs,
          page: pageIndex + 1,
          pageId: targetPage.id,
        });
        const insertPos = pageIndex === 0 || !refEntry ? 0 : refEntry.pos + refEntry.node.nodeSize;
        let tr = this.editor.state.tr.insert(insertPos, newNode);
        let seq = 0;
        tr.doc.descendants((node, pos) => {
          if (node.type.name === 'inkTemplate') {
            seq += 1;
            if (node.attrs.page !== seq) {
              tr = tr.setNodeMarkup(pos, undefined, { ...node.attrs, page: seq });
            }
            return false;
          }
          return true;
        });
        this.editor.view.dispatch(tr);
        this.record = { ...this.record, content: this.editor.view.state.doc.toJSON(), pages: nextPages };
      } else {
        this.record = { ...this.record, pages: nextPages };
      }
    } else {
      this.record = { ...this.record, pages: nextPages };
    }

    // 3. 후속 페이지 스트로크들의 Y좌표를 원래 위치로 복귀 (하향 시프트)
    if (shiftStrokeIds.length > 0) {
      this.strokes.rawTranslate(shiftStrokeIds, 0, -shiftY);
    }

    // 4. 삭제되었던 스트로크 원본 그대로 복원
    if (deletedStrokes.length > 0) {
      this.strokes.rawAdd(deletedStrokes.map((s, idx) => ({ stroke: s, index: idx })));
    }

    // 5. 삭제되었던 텍스트 객체 복원
    const restoredTextObjects = [...(this.ui.textObjects ?? []), ...deletedTextObjects];

    // 6. UI 상태 일괄 반영 및 스크롤
    this.patch({
      pages: nextPages,
      textObjects: restoredTextObjects,
      currentPageIndex: pageIndex,
    });
    this.scheduleDirtyCheck();
    this.assertPageInvariant();
    if (this.scrollEl) {
      setTimeout(() => this.navigateToPage(pageIndex), 30);
    }
  }

  /**
   * 지정한 인덱스의 페이지를 동일한 내용(스트로크, 텍스트)과 함께 복제한다.
   */
  duplicatePage(pageIndex: number, recordHistory = true): NotePage | null {
    const totalPages = this.ui.pages.length;
    if (pageIndex < 0 || pageIndex >= totalPages) return null;
    const sourcePage = this.ui.pages[pageIndex];
    if (!sourcePage) return null;

    // 1. 새 페이지를 대상 페이지 바로 아래에 생성
    const createdPage = this.addPageBelow(
      pageIndex,
      {
        size: sourcePage.size,
        orientation: sourcePage.orientation,
        style: sourcePage.style,
      },
      false,
    );

    // 2. 원본 페이지의 스트로크 복제 (새로운 스트로크 ID 발급 및 Y좌표 오프셋 보정)
    const currentWidth = getPageDimensions(sourcePage.size, sourcePage.orientation).width;
    const pageDimsInput = this.ui.pages.map((p) => {
      const d = getPageDimensions(p.size, p.orientation);
      return { width: d.width, height: d.height };
    });
    const layout = computePdfPageLayout(pageDimsInput, currentWidth);
    const sourceTop = layout.yOffsets[pageIndex] ?? 0;
    const sourceBottom = sourceTop + (layout.pageHeights[pageIndex] ?? 0);
    const targetTop = layout.yOffsets[pageIndex + 1] ?? (sourceBottom + PDF_PAGE_GAP_PX);
    const deltaY = targetTop - sourceTop;

    const sourceStrokes = this.strokes.getAll().filter((s) => {
      const b = this.strokes.boundsOf([s.id]);
      return b && b.minY >= sourceTop - 4 && b.maxY <= sourceBottom + 4;
    });

    const clonedStrokes: Stroke[] = sourceStrokes.map((s) => ({
      ...s,
      id: newStrokeId(),
      points: translatePoints(s.points, 0, deltaY),
    }));
    if (clonedStrokes.length > 0) {
      this.strokes.addStrokes(clonedStrokes, 'stroke-batch');
    }

    // 3. 원본 페이지의 텍스트 객체 복제
    const sourceTexts = (this.ui.textObjects ?? []).filter((t) => t.pageId === sourcePage.id);
    const clonedTexts: NoteTextObject[] = sourceTexts.map((t) => ({
      ...t,
      id: newTextObjectId(),
      pageId: createdPage.id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }));
    if (clonedTexts.length > 0) {
      this.patch({ textObjects: [...(this.ui.textObjects ?? []), ...clonedTexts] });
    }

    // 4. 히스토리 기록
    if (recordHistory) {
      this.history.push({
        id: newCommandId(),
        type: 'page-duplicate',
        timestamp: Date.now(),
        description: `페이지 ${pageIndex + 1} 복제`,
        undo: () => {
          this.deletePage(pageIndex + 1, false);
        },
        redo: () => {
          this.duplicatePage(pageIndex, false);
        },
      });
    }

    return createdPage;
  }

  /**
   * 페이지 순서를 변경한다.
   */
  reorderPages(fromIndex: number, toIndex: number, recordHistory = true): boolean {
    const pages = [...this.ui.pages];
    if (fromIndex < 0 || fromIndex >= pages.length || toIndex < 0 || toIndex >= pages.length || fromIndex === toIndex) {
      return false;
    }
    const [moved] = pages.splice(fromIndex, 1);
    pages.splice(toIndex, 0, moved);
    this.patch({ pages, currentPageIndex: toIndex });
    this.scheduleDirtyCheck();
    if (this.scrollEl && this.pageEl) {
      setTimeout(() => this.scrollToPage(toIndex), 30);
    }

    if (recordHistory) {
      this.history.push({
        id: newCommandId(),
        type: 'page-reorder',
        timestamp: Date.now(),
        description: `페이지 순서 변경 (${fromIndex + 1} -> ${toIndex + 1})`,
        undo: () => {
          this.reorderPages(toIndex, fromIndex, false);
        },
        redo: () => {
          this.reorderPages(fromIndex, toIndex, false);
        },
      });
    }

    return true;
  }

  // ---------- Text Object Management ----------
  addTextObject(obj: Omit<NoteTextObject, 'id' | 'createdAt' | 'updatedAt'>, recordHistory = true): NoteTextObject {
    const fullObj: NoteTextObject = {
      ...obj,
      id: newTextObjectId(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const next = [...(this.ui.textObjects ?? []), fullObj];
    this.patch({ textObjects: next });
    this.scheduleDirtyCheck();

    if (recordHistory) {
      this.recordTextAdd(fullObj);
    }

    return fullObj;
  }

  recordTextAdd(obj: NoteTextObject) {
    this.history.push({
      id: newCommandId(),
      type: 'text-add',
      timestamp: Date.now(),
      undo: () => {
        const remaining = (this.ui.textObjects ?? []).filter((t) => t.id !== obj.id);
        this.patch({ textObjects: remaining });
        this.scheduleDirtyCheck();
      },
      redo: () => {
        const restored = [...(this.ui.textObjects ?? []), obj];
        this.patch({ textObjects: restored });
        this.scheduleDirtyCheck();
      },
    });
  }

  updateTextObject(id: string, patch: Partial<NoteTextObject>, recordHistory = true) {
    const list = this.ui.textObjects ?? [];
    const idx = list.findIndex((t) => t.id === id);
    if (idx === -1) return;
    const prev = list[idx];
    const updated: NoteTextObject = { ...prev, ...patch, updatedAt: Date.now() };
    const next = [...list];
    next[idx] = updated;
    this.patch({ textObjects: next });
    this.scheduleDirtyCheck();

    if (recordHistory) {
      this.history.push({
        id: newCommandId(),
        type: 'text-update',
        timestamp: Date.now(),
        undo: () => {
          const cur = this.ui.textObjects ?? [];
          const i = cur.findIndex((t) => t.id === id);
          if (i !== -1) {
            const revert = [...cur];
            revert[i] = prev;
            this.patch({ textObjects: revert });
            this.scheduleDirtyCheck();
          }
        },
        redo: () => {
          const cur = this.ui.textObjects ?? [];
          const i = cur.findIndex((t) => t.id === id);
          if (i !== -1) {
            const reapply = [...cur];
            reapply[i] = updated;
            this.patch({ textObjects: reapply });
            this.scheduleDirtyCheck();
          }
        },
      });
    }
  }

  deleteTextObject(id: string, recordHistory = true) {
    const list = this.ui.textObjects ?? [];
    const target = list.find((t) => t.id === id);
    if (!target) return;
    const next = list.filter((t) => t.id !== id);
    this.patch({ textObjects: next });
    this.scheduleDirtyCheck();

    if (recordHistory) {
      this.history.push({
        id: newCommandId(),
        type: 'text-delete',
        timestamp: Date.now(),
        undo: () => {
          const restored = [...(this.ui.textObjects ?? []), target];
          this.patch({ textObjects: restored });
          this.scheduleDirtyCheck();
        },
        redo: () => {
          const removed = (this.ui.textObjects ?? []).filter((t) => t.id !== id);
          this.patch({ textObjects: removed });
          this.scheduleDirtyCheck();
        },
      });
    }
  }

  setCurrentPageIndex(index: number) {
    const clamped = Math.max(0, Math.min(this.ui.pages.length - 1, index));
    this.navState = { ...this.navState, visible: clamped };
    if (clamped !== this.ui.currentPageIndex) {
      this.patch({ currentPageIndex: clamped });
    }
  }

  /**
   * 명시적 페이지 이동 요청 (프로그램 스크롤 단 1회 수행 및 목표 페이지 하이라이트 고정)
   */
  navigateToPage(index: number) {
    const maxPages = Math.max(1, this.ui.pages.length);
    const clamped = Math.max(0, Math.min(maxPages - 1, index));

    // 내비게이션 상태 기계 갱신 (target = clamped, programmatic = true)
    this.navState = onNavigateRequest(this.navState, clamped);
    this.patch({ currentPageIndex: clamped });

    const scrollEl = this.scrollEl;
    if (!scrollEl) return;

    // DOM 실측 기반 offset을 목표로 단 1회 스크롤
    const pageEl = this.pageEl || scrollEl;
    const zoom = this.ui.zoom || 1;
    const measured = getMeasuredPageLayout(pageEl, zoom);

    if (measured.offsets.length > clamped) {
      const targetY = measured.offsets[clamped] * zoom;
      scrollEl.scrollTo({ top: targetY, behavior: 'smooth' });
      return;
    }

    // DOM 실측이 아직 준비되지 않은 경우 폴백
    const pdfPage = pageEl.querySelector(
      `[data-ink-template][data-page="${clamped + 1}"], #pdf-page-${clamped + 1}`
    ) as HTMLElement | null;
    if (pdfPage) {
      pdfPage.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }

    const sheet = pageEl.querySelector(`[data-page-index="${clamped}"]`) as HTMLElement | null;
    if (sheet) {
      sheet.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }

    const currentPage = this.ui.pages[clamped] ?? this.ui.pages[0];
    const containerWidth = currentPage ? getPageDimensions(currentPage.size, currentPage.orientation).width : 840;
    const layout = computePdfPageLayout(
      extractInkTemplateDimensions(this.record.content, this.ui.pages),
      containerWidth,
    );
    const targetY = (layout.yOffsets[clamped] ?? 0) * zoom;
    scrollEl.scrollTo({ top: targetY, behavior: 'smooth' });
  }

  /** 특정 페이지로 스크롤 없이 즉시/부드럽게 이동 */
  scrollToPage(index: number) {
    this.navigateToPage(index);
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

    if (this.editor && !this.editor.isDestroyed) {
      let tr = this.editor.state.tr;
      let changed = false;
      let tplIdx = 0;
      this.editor.state.doc.descendants((node, pos) => {
        if (node.type.name === 'inkTemplate') {
          const idx = tplIdx++;
          if (applyToAll || idx === targetIdx) {
            const pageMeta = nextPages[idx] ?? nextPages[0];
            const nextAttrs: Record<string, unknown> = { ...node.attrs };
            if (patch.style) nextAttrs.style = patch.style;
            if (!node.attrs.src && (patch.size || patch.orientation) && pageMeta) {
              const d = getPageDimensions(pageMeta.size, pageMeta.orientation);
              nextAttrs.width = d.width;
              nextAttrs.height = d.height;
            }
            tr = tr.setNodeMarkup(pos, undefined, nextAttrs);
            changed = true;
          }
          return false;
        }
        return true;
      });
      if (changed) {
        this.editor.view.dispatch(tr);
        this.record = { ...this.record, content: this.editor.getJSON(), pages: nextPages };
      }
    }

    this.patch({ pages: nextPages });
    this.scheduleDirtyCheck();
  }

  applyFontFamily(family: string) {
    const { empty } = this.editor.state.selection;
    if (!empty) {
      this.editor.chain().focus().setMark('fontFamily', { family }).run();
    }
  }

  applyFontSize(size: number | string) {
    if (!this.editor) return;
    const sizeStr = typeof size === 'number' ? `${size}px` : size;
    const { empty } = this.editor.state.selection;
    const isTextMode = useSettings.getState().tool === 'none';
    if (!empty) {
      this.editor.chain().focus().setMark('fontSize', { size: sizeStr }).run();
    } else if (isTextMode) {
      this.editor.chain().focus().setMark('fontSize', { size: sizeStr }).run();
    }
  }

  applyTextColor(color: string) {
    if (!this.editor) return;
    const { empty } = this.editor.state.selection;
    const isTextMode = useSettings.getState().tool === 'none';
    if (!empty) {
      this.editor.chain().focus().setMark('textColor', { color }).run();
    } else if (isTextMode) {
      this.editor.chain().focus().setMark('textColor', { color }).run();
    }
  }

  scheduleTitleSync() {
    if (this.titleSyncTimer) clearTimeout(this.titleSyncTimer);
    this.titleSyncTimer = setTimeout(() => void this.syncTitleFromHeader(), 300);
  }

  extractTopHeader(): string | null {
    if (!this.editor) return null;
    const doc = this.editor.state.doc;
    let firstNonEmptyText: string | null = null;
    for (let i = 0; i < doc.childCount; i++) {
      const child = doc.child(i);
      const text = child.textContent.trim();
      if (!text) continue;
      if (child.type.name === 'heading') {
        return text;
      }
      if (!firstNonEmptyText) {
        firstNonEmptyText = text;
      }
      if (i > 3) break;
    }
    return firstNonEmptyText;
  }

  async syncTitleFromHeader() {
    const raw = this.extractTopHeader();
    if (!raw) return;
    const clean = sanitizeDocumentTitle(raw);
    if (!clean) return;
    if (clean === this.lastAutoTitle || clean === this.record.title) return;
    if (this.isManualTitle && this.record.title && this.record.title !== '제목 없는 노트') {
      return;
    }
    this.lastAutoTitle = clean;
    this.record.title = clean;
    await db.notes.update(this.id, { title: clean, updatedAt: Date.now() });
    const fresh = await db.notes.get(this.id);
    if (fresh) indexNote(fresh);
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

  deleteAnnotation(id: string, recordHistory = true) {
    const target = this.ui.annotations.find((a) => a.id === id);
    if (!target) return;

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

    if (recordHistory) {
      this.history.push({
        id: newCommandId(),
        type: 'annotation-delete',
        timestamp: Date.now(),
        description: '말풍선 주석 삭제',
        undo: () => {
          this.setAnnotations((list) => [...list, target]);
          this.patch({ openAnnotationId: id });
          this.scheduleDirtyCheck();
        },
        redo: () => {
          this.deleteAnnotation(id, false);
        },
      });
    }
  }

  /** 텍스트 선택 → 텍스트 앵커, 올가미 선택 → 스트로크 앵커, 그 외 → 지점 앵커 */
  createAnnotation(point?: { x: number; y: number }, recordHistory = true): string {
    const id = uid('ann');
    let anchor: AnnotationAnchor;

    if (point) {
      anchor = { type: 'point', x: point.x, y: point.y };
    } else if (this.ui.lassoIds.length > 0) {
      const box = this.strokes.boundsOf(this.ui.lassoIds)!;
      anchor = { type: 'strokes', strokeIds: this.ui.lassoIds.slice(), fallbackBox: box };
      this.patch({ lassoIds: [], moveMode: false });
    } else {
      const { selection } = this.editor.state;
      const quote = !selection.empty
        ? this.editor.state.doc.textBetween(selection.from, selection.to, ' ').trim()
        : '';
      if (quote.length > 0) {
        // 실제 텍스트가 드래그 선택된 경우에만 텍스트 마크 적용 (스크롤 튐 방지를 위해 focus() 제외)
        this.editor.chain().setMark('annotation', { id }).run();
        anchor = { type: 'text', quote };
      } else {
        const p = this.viewportCenterPoint();
        anchor = { type: 'point', x: p.x, y: p.y };
      }
    }

    const newAnn: Annotation = { id, anchor, body: '', turns: [], createdAt: Date.now() };
    this.setAnnotations((list) => [...list, newAnn]);
    this.patch({ openAnnotationId: id });

    if (recordHistory) {
      this.history.push({
        id: newCommandId(),
        type: 'annotation-add',
        timestamp: Date.now(),
        description: '말풍선 주석 생성',
        undo: () => {
          this.deleteAnnotation(id, false);
        },
        redo: () => {
          this.setAnnotations((list) => [...list, newAnn]);
          this.patch({ openAnnotationId: id });
          this.scheduleDirtyCheck();
        },
      });
    }
    return id;
  }

  /** 현재 뷰포트 화면 중앙 좌표 (페이지 로컬 좌표) - 스크롤 튐 없는 안전한 기본 앵커 */
  viewportCenterPoint(): { x: number; y: number } {
    const scroller = this.scrollEl;
    const page = this.pageEl;
    const zoom = this.ui.zoom || 1;
    if (scroller && page) {
      const sRect = scroller.getBoundingClientRect();
      const pRect = page.getBoundingClientRect();
      if (sRect.width > 0 && sRect.height > 0) {
        const centerX = sRect.left + sRect.width / 2;
        const centerY = sRect.top + sRect.height / 2;
        return {
          x: Math.max(20, Math.round((centerX - pRect.left) / zoom)),
          y: Math.max(20, Math.round((centerY - pRect.top) / zoom)),
        };
      }
    }
    if (scroller) {
      return {
        x: Math.max(20, Math.round((scroller.scrollLeft + (scroller.clientWidth || 600) / 2) / zoom)),
        y: Math.max(20, Math.round((scroller.scrollTop + (scroller.clientHeight || 800) / 2) / zoom)),
      };
    }
    return this.caretPoint();
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
   * - range가 주어지면 에디터 포커스가 변경되어 selection.empty가 되더라도 저장된 범위를 활용합니다.
   */
  recommendByCurrentSelection(
    topK = 5,
    range?: { from: number; to: number; text: string },
  ): { text: string; from: number; to: number; recommendations: LinkRecommendation[] } {
    let from = this.editor.state.selection.from;
    let to = this.editor.state.selection.to;
    let empty = this.editor.state.selection.empty;
    let text = !empty ? this.editor.state.doc.textBetween(from, to, ' ').trim() : '';

    if (!text && range && range.text) {
      from = range.from;
      to = range.to;
      text = range.text.trim();
      empty = false;
    }

    if (empty || !text) return { text: '', from, to, recommendations: [] };
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

  /**
   * 드래그 선택 단어에 대해 오프라인 문맥 스코어링(<1ms)으로 최적 번역어를 즉시 판별한다.
   */
  resolveSelectionTranslation(): {
    from: number;
    to: number;
    targetWord: string;
    surroundingSentence: string;
    activeTag: string;
    resolution: TranslationResolution;
  } | null {
    const { from, to, empty } = this.editor.state.selection;
    if (empty) return null;
    const targetWord = this.editor.state.doc.textBetween(from, to, ' ').trim();
    if (!targetWord || targetWord.length > 60) return null;

    // 주변 문맥 추출 (앞뒤 250자 범위 + 노트 제목)
    const docSize = this.editor.state.doc.content.size;
    const ctxStart = Math.max(0, from - 250);
    const ctxEnd = Math.min(docSize, to + 250);
    const contextSnippet = this.editor.state.doc.textBetween(ctxStart, ctxEnd, ' ');
    const fullText = this.editor.state.doc.textBetween(0, Math.min(docSize, 2000), ' ');
    const tagMatches = fullText.match(/#[a-zA-Z0-9가-힣_-]+/g) || [];
    const activeTags = [...tagMatches.map((t) => t.slice(1)), this.record.title];
    const activeTag = tagMatches[0]?.slice(1) || 'default';
    const surroundingSentence = `${this.record.title} ${contextSnippet}`.trim();

    const resolution = adaptiveGlossary.resolveMeaning(targetWord, surroundingSentence, activeTags);
    return {
      from,
      to,
      targetWord,
      surroundingSentence,
      activeTag,
      resolution,
    };
  }

  /**
   * 선택 영역에 번역 텍스트를 삽입하고 사용자 학습 피드백을 영속화한다.
   * mode에 따라:
   * 1. 'parentheses': 원래 문장 뒤에 괄호로 삽입 (${base} (${trimmed}))
   * 2. 'ruby': <ruby>word<rt>meaning</rt></ruby> (보라색 작은 글씨로 위에 표시)
   * 3. 'replace': 원래 문장을 번역 문장으로 대체(덮어쓰기)
   */
  applyTranslation(
    meaning: string,
    context?: {
      from: number;
      to: number;
      targetWord: string;
      surroundingSentence: string;
      activeTag?: string;
    },
    recordFeedback = true,
    insertMode?: TranslationInsertMode,
  ) {
    const trimmed = meaning.trim();
    if (!trimmed) return;
    const from = context?.from ?? this.editor.state.selection.from;
    const to = context?.to ?? this.editor.state.selection.to;
    const rawText = this.editor.state.doc.textBetween(from, to, ' ');
    const base = (context?.targetWord ?? rawText).trim();
    if (!base) return;

    if (recordFeedback && context) {
      void adaptiveGlossary.saveUserFeedback(
        base,
        trimmed,
        context.surroundingSentence,
        context.activeTag ?? 'default',
      );
    }

    const mode = insertMode ?? useSettings.getState().translationInsertMode ?? 'parentheses';

    if (mode === 'parentheses') {
      const hasLeadingSpace = /^\s/.test(rawText);
      const hasTrailingSpace = /\s$/.test(rawText);
      const leading = hasLeadingSpace ? ' ' : '';
      const trailing = hasTrailingSpace ? ' ' : '';
      this.editor
        .chain()
        .focus()
        .insertContentAt({ from, to }, `${leading}${base} (${trimmed})${trailing}`)
        .run();
    } else if (mode === 'replace') {
      const hasLeadingSpace = /^\s/.test(rawText);
      const hasTrailingSpace = /\s$/.test(rawText);
      const leading = hasLeadingSpace ? ' ' : '';
      const trailing = hasTrailingSpace ? ' ' : '';
      this.editor
        .chain()
        .focus()
        .insertContentAt({ from, to }, `${leading}${trimmed}${trailing}`)
        .run();
    } else {
      this.editor
        .chain()
        .focus()
        .insertContentAt(
          { from, to },
          {
            type: 'rubyText',
            attrs: { base, rt: trimmed },
          },
        )
        .run();
    }
  }

  applyRubyTranslation(
    meaning: string,
    context?: {
      from: number;
      to: number;
      targetWord: string;
      surroundingSentence: string;
      activeTag?: string;
    },
    recordFeedback = true,
  ) {
    this.applyTranslation(meaning, context, recordFeedback);
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
        textObjects: this.ui.textObjects ?? [],
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
    if (this.titleSyncTimer) clearTimeout(this.titleSyncTimer);
    this.editor.destroy();
  }
}
