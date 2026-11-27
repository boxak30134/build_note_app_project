import Image from '@tiptap/extension-image';
import { Node, mergeAttributes } from '@tiptap/core';
import { attachmentUrl } from '../../storage/opfs';
import { useSettings } from '../../store/settingsStore';
import { useSessions } from '../../store/sessionStore';
import {
  computePdfTilePlan,
  computeTargetPdfScale,
  findFallbackPdfSrc,
  PDF_ZOOM_RERENDER_DEBOUNCE_MS,
  pdfZoomRenderer,
  shouldRerenderForZoom,
  type PdfTileCropRect,
  type PdfTilePlan,
} from '../../features/import/pdfZoomRenderer';

function isRelative(src: string) {
  return !!src && !/^(https?:|data:|blob:)/i.test(src);
}

export interface NoteImageOptions {
  noteId: string;
}

/** ![](images/...) 상대 경로를 OPFS 에서 해석해 표시하는 이미지 노드 */
export const NoteImage = Image.extend<NoteImageOptions & Record<string, unknown>>({
  addOptions() {
    return { ...this.parent?.(), noteId: '', inline: false, allowBase64: true } as never;
  },
  addNodeView() {
    const noteId = (this.options as unknown as NoteImageOptions).noteId;
    return ({ node }) => {
      const dom = document.createElement('img');
      dom.className = 'note-image';
      dom.draggable = false;
      const apply = (src: string, alt: string) => {
        dom.alt = alt ?? '';
        if (isRelative(src)) {
          dom.src = '';
          void attachmentUrl(noteId, src)?.then((url) => {
            if (url) dom.src = url;
            else dom.alt = `이미지를 찾을 수 없음: ${src}`;
          });
        } else dom.src = src;
      };
      apply(node.attrs.src, node.attrs.alt);
      return {
        dom,
        update: (n) => {
          if (n.type.name !== 'image') return false;
          apply(n.attrs.src, n.attrs.alt);
          return true;
        },
      };
    };
  },
});

/**
 * 손글씨 페이지 캔버스 템플릿: 가져온 PDF 페이지의 손글씨 벡터만 렌더링한 배경.
 * 문서 흐름 안에 페이지 비율만큼 공간을 차지하고, 그 위로 Layer 2 잉크 캔버스에서 이어서 필기할 수 있다.
 */
export const InkTemplate = Node.create<NoteImageOptions>({
  name: 'inkTemplate',
  group: 'block',
  atom: true,
  selectable: false,

  addOptions() {
    return { noteId: '' };
  },

  addAttributes() {
    return {
      src: { default: '' },
      width: { default: 595 },
      height: { default: 842 },
      page: { default: 1 },
      pageId: { default: null },
      style: { default: 'plain' },
      pdfSrc: { default: '' },
      pdfPage: { default: 0 },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-ink-template]',
        getAttrs: (el) => {
          const e = el as HTMLElement;
          return {
            src: e.getAttribute('data-src') ?? '',
            width: Number(e.getAttribute('data-width')) || 595,
            height: Number(e.getAttribute('data-height')) || 842,
            page: Number(e.getAttribute('data-page')) || 1,
            pageId: e.getAttribute('data-page-id') || null,
            style: e.getAttribute('data-style') || 'plain',
            pdfSrc: e.getAttribute('data-pdf-src') ?? '',
            pdfPage: Number(e.getAttribute('data-pdf-page')) || 0,
          };
        },
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-ink-template': '',
        'data-src': node.attrs.src ?? '',
        'data-width': node.attrs.width,
        'data-height': node.attrs.height,
        'data-page': node.attrs.page,
        'data-page-id': node.attrs.pageId ?? '',
        'data-style': node.attrs.style ?? 'plain',
        ...(node.attrs.pdfSrc ? { 'data-pdf-src': node.attrs.pdfSrc } : {}),
        ...(node.attrs.pdfPage ? { 'data-pdf-page': node.attrs.pdfPage } : {}),
      }),
      `손글씨 페이지 ${node.attrs.page}`,
    ];
  },

  addNodeView() {
    const noteId = (this.options as { noteId?: string })?.noteId ?? '';
    let nodeViewSeq = 0;
    return ({ node }) => {
      const viewId = ++nodeViewSeq;
      const dom = document.createElement('div');
      dom.contentEditable = 'false';
      dom.dataset.inkTemplate = '';

      const badge = document.createElement('div');
      badge.className = 'ink-template-badge';
      badge.dataset.testid = 'pdf-resolution-badge';
      dom.append(badge);

      let imgEl: HTMLImageElement | null = null;
      let hiResCanvas: HTMLCanvasElement | null = null;
      let loadedSrc = '';
      let currentPageNum = 1;
      let currentSrc = '';
      let currentPdfSrc = '';
      let currentPdfPage = 0;
      let currentWidth = 595;
      let currentHeight = 842;
      let currentZoom = noteId ? useSessions.getState().sessions[noteId]?.zoom ?? 1 : 1;
      let isVisible = typeof IntersectionObserver === 'undefined';
      let renderedScale = 0;
      let hasHiRes = false;
      let prevPlan: PdfTilePlan | null = null;
      let rerenderTimer: ReturnType<typeof setTimeout> | null = null;
      let scrollTimer: ReturnType<typeof setTimeout> | null = null;
      let fallbackLookupTried = false;
      let destroyed = false;
      let renderStatus: 'idle' | 'rendering' | 'hires' | 'static' | 'error' = 'idle';
      let renderErrorReason = '';
      let attachedViewport: HTMLElement | null = null;
      let io: IntersectionObserver | null = null;
      let rafAttachId: number | null = null;

      const renderKeyFor = (pdfSrc: string, pdfPage: number) => `${noteId}::${pdfSrc}::${pdfPage}::${viewId}`;

      const updateBadge = () => {
        if (!currentSrc && !currentPdfSrc) {
          badge.textContent = `${currentPageNum}쪽`;
          delete badge.dataset.zoomPct;
          delete badge.dataset.resolution;
          return;
        }
        const zoomPct = Math.round(currentZoom * 100);
        const natW = imgEl?.naturalWidth || 0;
        const natH = imgEl?.naturalHeight || 0;
        let resLabel = '';
        let resData = 'pending';

        if (hasHiRes && prevPlan) {
          if (prevPlan.mode === 'tile') {
            resLabel = `${prevPlan.viewportWidth}x${prevPlan.viewportHeight}px (타일 ${prevPlan.canvasWidth}x${prevPlan.canvasHeight}px)`;
          } else {
            resLabel = `${prevPlan.canvasWidth}x${prevPlan.canvasHeight}px`;
          }
          resData = `${prevPlan.viewportWidth}x${prevPlan.viewportHeight}`;
        } else if (natW > 0 && natH > 0) {
          resLabel = `${natW}x${natH}px${currentPdfSrc ? '' : ' (정적PNG)'}`;
          resData = `${natW}x${natH}`;
        } else {
          resLabel = currentPdfSrc ? '대기중' : '원본PDF없음';
        }

        const statusSuffix =
          renderStatus === 'rendering'
            ? ' · 재렌더중'
            : renderStatus === 'error' && renderErrorReason
              ? ` · 오류(${renderErrorReason})`
              : '';

        badge.textContent = `${currentPageNum}쪽 · [배율: ${zoomPct}% | 해상도: ${resLabel}]${statusSuffix}`;
        badge.dataset.zoomPct = String(zoomPct);
        badge.dataset.resolution = resData;
      };

      const clearHiRes = () => {
        if (rerenderTimer) {
          clearTimeout(rerenderTimer);
          rerenderTimer = null;
        }
        if (scrollTimer) {
          clearTimeout(scrollTimer);
          scrollTimer = null;
        }
        if (currentPdfSrc && currentPdfPage > 0) {
          pdfZoomRenderer.releasePage(renderKeyFor(currentPdfSrc, currentPdfPage));
        }
        if (hiResCanvas) {
          hiResCanvas.width = 0;
          hiResCanvas.height = 0;
          hiResCanvas.style.opacity = '0';
          delete hiResCanvas.dataset.renderScale;
          delete hiResCanvas.dataset.viewportWidth;
          delete hiResCanvas.dataset.viewportHeight;
        }
        hasHiRes = false;
        renderedScale = 0;
        prevPlan = null;
        renderStatus = 'idle';
        updateBadge();
      };

      const computeVisibleCropRect = (): PdfTileCropRect | null => {
        if (!attachedViewport) return null;
        const pageRect = dom.getBoundingClientRect();
        const vpRect = attachedViewport.getBoundingClientRect();
        if (pageRect.width <= 0 || pageRect.height <= 0 || vpRect.width <= 0 || vpRect.height <= 0) {
          return null;
        }
        const pad = 160;
        const visLeft = Math.max(pageRect.left, vpRect.left - pad);
        const visTop = Math.max(pageRect.top, vpRect.top - pad);
        const visRight = Math.min(pageRect.right, vpRect.right + pad);
        const visBottom = Math.min(pageRect.bottom, vpRect.bottom + pad);
        if (visRight <= visLeft || visBottom <= visTop) {
          return null;
        }
        return {
          u0: (visLeft - pageRect.left) / pageRect.width,
          v0: (visTop - pageRect.top) / pageRect.height,
          u1: (visRight - pageRect.left) / pageRect.width,
          v1: (visBottom - pageRect.top) / pageRect.height,
        };
      };

      const onViewportScroll = () => {
        if (destroyed || !isVisible || !currentPdfSrc || prevPlan?.mode !== 'tile') return;
        if (scrollTimer) clearTimeout(scrollTimer);
        scrollTimer = setTimeout(() => {
          scrollTimer = null;
          scheduleZoomRerender();
        }, PDF_ZOOM_RERENDER_DEBOUNCE_MS);
      };

      const attachIntersectionObserver = (rootEl: HTMLElement | null) => {
        io?.disconnect();
        io =
          typeof IntersectionObserver !== 'undefined'
            ? new IntersectionObserver(
                (entries) => {
                  const visible = entries.some((entry) => entry.isIntersecting);
                  if (visible === isVisible) return;
                  isVisible = visible;
                  if (visible) {
                    scheduleZoomRerender();
                  } else {
                    clearHiRes();
                  }
                },
                { root: rootEl, rootMargin: '250px 0px' },
              )
            : null;
        io?.observe(dom);
      };

      const ensureViewportAttached = () => {
        const vp = dom.closest<HTMLElement>('.note-viewport');
        if (vp && vp !== attachedViewport) {
          attachedViewport?.removeEventListener('scroll', onViewportScroll);
          attachedViewport = vp;
          attachedViewport.addEventListener('scroll', onViewportScroll, { passive: true });
          attachIntersectionObserver(vp);
        }
      };

      const scheduleZoomRerender = () => {
        if (destroyed) return;
        ensureViewportAttached();
        if (noteId) {
          const latestZoom = useSessions.getState().sessions[noteId]?.zoom;
          if (latestZoom && latestZoom > 0) {
            currentZoom = latestZoom;
          }
        }

        if (!currentPdfSrc) {
          if (currentSrc && noteId && !fallbackLookupTried) {
            fallbackLookupTried = true;
            void findFallbackPdfSrc(noteId).then((found) => {
              if (destroyed) return;
              if (found && !currentPdfSrc) {
                currentPdfSrc = found;
                currentPdfPage = currentPdfPage || currentPageNum;
                dom.dataset.pdfSrc = found;
                dom.dataset.pdfPage = String(currentPdfPage);
                scheduleZoomRerender();
              } else if (!found) {
                renderStatus = 'static';
                updateBadge();
              }
            });
          } else {
            renderStatus = 'static';
            updateBadge();
          }
          return;
        }

        if (!isVisible || currentPdfPage <= 0 || !noteId) {
          updateBadge();
          return;
        }

        const cssWidth = dom.clientWidth || dom.getBoundingClientRect().width;
        if (cssWidth <= 0) {
          updateBadge();
          return;
        }

        const targetScale = computeTargetPdfScale(
          currentWidth,
          currentHeight,
          cssWidth,
          currentZoom,
          window.devicePixelRatio || 1,
        );
        const crop = computeVisibleCropRect();

        if (!shouldRerenderForZoom(renderedScale, targetScale, hasHiRes, prevPlan, crop)) {
          updateBadge();
          return;
        }

        if (rerenderTimer) clearTimeout(rerenderTimer);
        const reqPdfSrc = currentPdfSrc;
        const reqPdfPage = currentPdfPage;
        const reqKey = renderKeyFor(reqPdfSrc, reqPdfPage);

        rerenderTimer = setTimeout(() => {
          rerenderTimer = null;
          if (destroyed || !isVisible || currentPdfSrc !== reqPdfSrc || currentPdfPage !== reqPdfPage) return;

          if (!hiResCanvas) {
            hiResCanvas = document.createElement('canvas');
            hiResCanvas.className = 'ink-template-hires';
            hiResCanvas.style.opacity = '0';
            dom.append(hiResCanvas);
          }

          renderStatus = 'rendering';
          renderErrorReason = '';
          updateBadge();

          void pdfZoomRenderer
            .renderPageHiRes({
              key: reqKey,
              noteId,
              pdfSrc: reqPdfSrc,
              pageNumber: reqPdfPage,
              canvas: hiResCanvas,
              targetScale,
              crop,
              onEvict: () => {
                hasHiRes = false;
                renderedScale = 0;
                prevPlan = null;
                renderStatus = 'static';
                updateBadge();
              },
            })
            .then((res) => {
              if (destroyed || !hiResCanvas || !isVisible) return;
              if (currentPdfSrc !== reqPdfSrc || currentPdfPage !== reqPdfPage) return;
              if (!res.rendered) {
                if (res.errorReason) {
                  renderStatus = 'error';
                  renderErrorReason = res.errorReason;
                  hasHiRes = false;
                  prevPlan = null;
                  updateBadge();
                }
                return;
              }
              renderedScale = res.scale;
              hasHiRes = true;
              prevPlan =
                res.plan ?? computePdfTilePlan(hiResCanvas.width, hiResCanvas.height, crop);
              renderStatus = 'hires';
              renderErrorReason = '';
              hiResCanvas.style.opacity = '1';
              hiResCanvas.dataset.renderScale = res.scale.toFixed(2);
              hiResCanvas.dataset.viewportWidth = String(prevPlan.viewportWidth);
              hiResCanvas.dataset.viewportHeight = String(prevPlan.viewportHeight);
              updateBadge();
            });
        }, PDF_ZOOM_RERENDER_DEBOUNCE_MS);
      };

      attachIntersectionObserver(null);
      if (typeof requestAnimationFrame === 'function') {
        rafAttachId = requestAnimationFrame(() => {
          rafAttachId = null;
          if (!destroyed) {
            ensureViewportAttached();
          }
        });
      }

      const ro =
        typeof ResizeObserver !== 'undefined'
          ? new ResizeObserver(() => {
              ensureViewportAttached();
              if (isVisible && currentPdfSrc) {
                scheduleZoomRerender();
              }
            })
          : null;
      ro?.observe(dom);

      const unsubZoom = noteId
        ? useSessions.subscribe((st) => {
            const nextZoom = st.sessions[noteId]?.zoom ?? 1;
            if (nextZoom !== currentZoom) {
              currentZoom = nextZoom;
              updateBadge();
              if (isVisible) {
                scheduleZoomRerender();
              }
            }
          })
        : null;

      const applyAttrs = (attrs: Record<string, unknown>) => {
        const pageNum = Number(attrs.page) || 1;
        const pageId = typeof attrs.pageId === 'string' && attrs.pageId ? attrs.pageId : '';
        const width = Number(attrs.width) || 595;
        const height = Number(attrs.height) || 842;
        const style = String(attrs.style || 'plain');
        const src = String(attrs.src || '');
        const nextPdfSrc = String(attrs.pdfSrc || '');
        const nextPdfPage = Number(attrs.pdfPage) || (nextPdfSrc ? pageNum : 0);

        const pdfChanged = nextPdfSrc !== currentPdfSrc || nextPdfPage !== currentPdfPage;
        if (pdfChanged) {
          clearHiRes();
          fallbackLookupTried = false;
        }
        currentPageNum = pageNum;
        currentSrc = src;
        currentWidth = width;
        currentHeight = height;
        currentPdfSrc = nextPdfSrc;
        currentPdfPage = nextPdfPage;

        dom.className = `ink-template page-canvas-surface page-style-${style}`;
        dom.style.aspectRatio = `${width} / ${height}`;
        dom.style.width = '100%';
        dom.id = `pdf-page-${pageNum}`;
        dom.dataset.page = String(pageNum);
        if (pageId) {
          dom.dataset.pageId = pageId;
        } else {
          delete dom.dataset.pageId;
        }
        dom.dataset.src = src;
        dom.dataset.width = String(width);
        dom.dataset.height = String(height);
        dom.dataset.style = style;
        if (nextPdfSrc) {
          dom.dataset.pdfSrc = nextPdfSrc;
          dom.dataset.pdfPage = String(nextPdfPage);
        } else {
          delete dom.dataset.pdfSrc;
          delete dom.dataset.pdfPage;
        }

        if (src) {
          if (!imgEl) {
            imgEl = document.createElement('img');
            imgEl.draggable = false;
            imgEl.addEventListener('load', updateBadge);
            dom.append(imgEl);
          }
          imgEl.alt = `페이지 ${pageNum}`;
          if (loadedSrc !== src) {
            loadedSrc = src;
            if (isRelative(src)) {
              void attachmentUrl(noteId, src)?.then((url) => {
                if (url && imgEl && loadedSrc === src) imgEl.src = url;
              });
            } else {
              imgEl.src = src;
            }
          }
        } else if (imgEl) {
          imgEl.remove();
          imgEl = null;
          loadedSrc = '';
        }

        updateBadge();
        if ((nextPdfSrc || src) && isVisible) {
          scheduleZoomRerender();
        }
      };

      applyAttrs(node.attrs as Record<string, unknown>);

      return {
        dom,
        update: (updatedNode) => {
          if (updatedNode.type.name !== 'inkTemplate') return false;
          applyAttrs(updatedNode.attrs as Record<string, unknown>);
          return true;
        },
        stopEvent: (event) => {
          // REQPDFTEXTCURSORJUMPROOTCAUSE: 텍스트 모드(activeTool === 'none')일 때 ProseMirror selection jump 원천 차단
          // 필기 모드에서도 mousedown/click/touchstart로 인한 에디터 포커스·맨 아래 문단 스크롤 점프를 차단(pointerdown은 S-Pen 경로 보존)
          const type = event.type;
          if (type === 'mousedown' || type === 'click' || type === 'touchstart') {
            return true;
          }
          if (type === 'pointerdown') {
            const currentTool = useSettings.getState().tool;
            if (currentTool === 'none') {
              return true;
            }
          }
          return false;
        },
        ignoreMutation: () => true,
        destroy: () => {
          destroyed = true;
          if (rafAttachId !== null && typeof cancelAnimationFrame === 'function') {
            cancelAnimationFrame(rafAttachId);
            rafAttachId = null;
          }
          attachedViewport?.removeEventListener('scroll', onViewportScroll);
          attachedViewport = null;
          clearHiRes();
          io?.disconnect();
          ro?.disconnect();
          unsubZoom?.();
        },
      };
    };
  },

  markdownTokenizer: {
    name: 'inkTemplate',
    level: 'block',
    start: (src: string) => src.indexOf('![손글씨 페이지 '),
    tokenize: (src: string) => {
      const m = /^!\[손글씨 페이지\s*(\d*)\]\(([^)\n]*)\)[ \t]*(?:\r?\n|$)/.exec(src);
      if (!m) return undefined;
      return {
        type: 'inkTemplate',
        raw: m[0],
        page: Number(m[1]) || 1,
        src: m[2].trim(),
      };
    },
  },

  markdownTokenName: 'inkTemplate',

  parseMarkdown: (token, h) =>
    h.createNode('inkTemplate', {
      page: Number(token.page) || 1,
      src: String(token.src ?? ''),
    }),

  renderMarkdown: (node) => `![손글씨 페이지 ${node.attrs?.page ?? ''}](${node.attrs?.src ?? ''})`,
});

/** OPFS 에 저장된 PDF 임베디드 뷰어 노드 */
export const PdfEmbed = Node.create<NoteImageOptions>({
  name: 'pdfEmbed',
  group: 'block',
  atom: true,
  draggable: true,

  addOptions() {
    return { noteId: '' };
  },

  addAttributes() {
    return { src: { default: '' }, name: { default: 'document.pdf' } };
  },

  parseHTML() {
    return [{ tag: 'div[data-pdf-embed]', getAttrs: (el) => ({ src: (el as HTMLElement).getAttribute('data-src'), name: (el as HTMLElement).getAttribute('data-name') }) }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-pdf-embed': '', 'data-src': node.attrs.src, 'data-name': node.attrs.name }), `📄 ${node.attrs.name}`];
  },

  addNodeView() {
    const noteId = (this.options as { noteId?: string })?.noteId ?? '';
    return ({ node }) => {
      const dom = document.createElement('div');
      dom.className = 'pdf-embed';
      dom.contentEditable = 'false';
      const header = document.createElement('div');
      header.className = 'pdf-embed-header';
      header.textContent = `📄 ${node.attrs.name}`;
      const frame = document.createElement('iframe');
      frame.title = node.attrs.name;
      dom.append(header, frame);
      void attachmentUrl(noteId, node.attrs.src).then((url) => {
        if (url) frame.src = url;
        else header.textContent = `📄 ${node.attrs.name} (파일을 찾을 수 없음)`;
      });
      return { dom };
    };
  },

  renderMarkdown: (node) => `[📄 ${node.attrs?.name ?? 'PDF'}](${node.attrs?.src ?? ''})`,
});
