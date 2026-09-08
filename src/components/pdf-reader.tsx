import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Document, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/TextLayer.css";
import "react-pdf/dist/Page/AnnotationLayer.css";
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { Loader2 } from "lucide-react";
import { type Annotation, type AnnotationColor, type Rect } from "@/lib/paper-types";
import { rectsContain, selectionToPageSelections } from "@/lib/pdf/highlight-rects";
import {
  NO_ANNOTATIONS,
  PdfPageView,
  type PageLoadInfo,
} from "@/components/reader/pdf-page-view";
import {
  EditHighlightMenu,
  HIGHLIGHT_HEX,
  NewHighlightMenu,
} from "@/components/reader/highlight-menu";
import { ReaderToolbar, clampScale } from "@/components/reader/reader-toolbar";
import { useCaretNavigation } from "@/components/reader/use-caret-navigation";

pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

export { HIGHLIGHT_HEX };

/** Roughly how wide the menus are, for keeping them inside the page. */
const MENU_WIDTH = 330;

type Anchor = { page: number; top: number; left: number };

type PendingSelection = {
  groups: { page: number; quote: string; rects: Rect[] }[];
  anchor: Anchor;
  quote: string;
};

type FocusedHighlight = { id: string; anchor: Anchor };

/**
 * Reads a PDF destination array into a fraction of the way down its page.
 *
 * Internal links (references, section/figure/equation cross-refs) point at a
 * page plus a precise offset within it; jumping to just the page leaves the
 * target wherever it happens to fall. Destinations follow the PDF spec —
 * [pageRef, {name: fitType}, ...params] — where the vertical offset, in points
 * measured from the page's bottom, sits at a different index per fit type.
 */
function destTopFraction(dest: unknown, pagePointsHeight: number | null): number {
  if (!pagePointsHeight || !Array.isArray(dest) || dest.length < 2) return 0;
  const fit = dest[1] as { name?: string } | undefined;
  let top: unknown;
  switch (fit?.name) {
    case "XYZ":
      top = dest[3]; // [ref, {XYZ}, left, top, zoom]
      break;
    case "FitH":
    case "FitBH":
      top = dest[2]; // [ref, {FitH}, top]
      break;
    case "FitR":
      top = dest[5]; // [ref, {FitR}, left, bottom, right, top]
      break;
    default:
      top = null; // Fit / FitB / FitV / FitBV carry no vertical offset
  }
  if (typeof top !== "number" || Number.isNaN(top)) return 0;
  return Math.min(1, Math.max(0, 1 - top / pagePointsHeight));
}

export function PdfReader({
  url,
  annotations,
  onCreate,
  onUpdate,
  onDelete,
  activeId,
  onSelectAnnotation,
  jumpTo,
}: {
  url: string;
  annotations: Annotation[];
  /**
   * One call per selection, carrying a group per page it covered — a selection
   * running across a page break stores a highlight on each page rather than
   * being clipped to whichever page it started on.
   */
  onCreate: (input: {
    groups: { page: number; quote: string; rects: Rect[] }[];
    color: AnnotationColor;
    comment: string | null;
  }) => Promise<unknown>;
  onUpdate?: (
    id: string,
    patch: { comment?: string | null; color?: AnnotationColor },
  ) => Promise<unknown>;
  onDelete?: (id: string) => Promise<unknown>;
  activeId?: string | null;
  onSelectAnnotation?: (id: string | null) => void;
  /**
   * Set by the sidebar to scroll a highlight into view. The nonce makes
   * asking for the same highlight twice a fresh request rather than a no-op.
   */
  jumpTo?: { id: string; nonce: number } | null;
}) {
  const outerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const observerRef = useRef<IntersectionObserver | null>(null);
  const scrollSettleTimer = useRef<number | undefined>(undefined);

  const [available, setAvailable] = useState(900);
  const [scrollbarWidth, setScrollbarWidth] = useState(0);
  const [numPages, setNumPages] = useState(0);
  const [page, setPage] = useState(1);
  const [scale, setScale] = useState(1);
  const [fitWidth, setFitWidth] = useState(false);
  const [failed, setFailed] = useState(false);

  const [pending, setPending] = useState<PendingSelection | null>(null);
  const [focused, setFocused] = useState<FocusedHighlight | null>(null);
  const [defaultColor, setDefaultColor] = useState<AnnotationColor>("yellow");
  const [busy, setBusy] = useState(false);
  const [hoverPointer, setHoverPointer] = useState(false);

  // Pages render lazily and unmount again once well out of range; keeping the
  // whole document mounted was the main cause of the reader degrading the
  // further through a paper you read.
  const [visiblePages, setVisiblePages] = useState<Set<number>>(() => new Set([1]));
  const [pageAspect, setPageAspect] = useState<number | null>(null);
  const [pagePointsHeight, setPagePointsHeight] = useState<number | null>(null);
  // react-pdf's Document caches onItemClick in a ref on first mount and never
  // refreshes it, so a plain closure here would forever see the value from
  // before any page had loaded.
  const pagePointsHeightRef = useRef<number | null>(null);
  pagePointsHeightRef.current = pagePointsHeight;

  const annotationsByPage = useMemo(() => {
    const map = new Map<number, Annotation[]>();
    for (const a of annotations) {
      if (a.rects.length === 0) continue;
      const list = map.get(a.page);
      if (list) list.push(a);
      else map.set(a.page, [a]);
    }
    return map;
  }, [annotations]);

  const annotationById = useMemo(() => {
    const map = new Map<string, Annotation>();
    for (const a of annotations) map.set(a.id, a);
    return map;
  }, [annotations]);

  useLayoutEffect(() => {
    const el = outerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setAvailable(el.clientWidth));
    ro.observe(el);
    setAvailable(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // Height is measured rather than a fixed vh: at 80vh the reader plus the
  // header, toolbar and footer added up to more than the window, so the page
  // scrolled behind a pane that was itself scrolling — two scrollbars for one
  // document. Filling the space actually left below the pane gives one.
  const [paneHeight, setPaneHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    const measure = () => {
      const el = scrollRef.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top + window.scrollY;
      // Fill the space left below the pane. Reserving the footer as well would
      // cost about a hundred pixels of reading area to save a short scroll
      // that only reveals the footer, so the footer is left below the fold and
      // overscroll containment (see the pane's class) keeps a scroll inside
      // the reader from spilling out to the page.
      setPaneHeight(Math.max(360, Math.round(window.innerHeight - top - 24)));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [available]);

  // The pane reserves its own scrollbar width on platforms that don't overlay
  // them, so the frame can hug the page instead of overflowing by that much.
  useEffect(() => {
    const outer = document.createElement("div");
    outer.style.cssText = "position:absolute;top:-9999px;width:100px;height:100px;overflow:scroll;";
    const inner = document.createElement("div");
    inner.style.cssText = "width:100%;height:100%;";
    outer.appendChild(inner);
    document.body.appendChild(outer);
    setScrollbarWidth(outer.offsetWidth - inner.clientWidth);
    document.body.removeChild(outer);
  }, []);

  // The frame draws a 1px border on each side, and the pane reserves its own
  // scrollbar where the platform doesn't overlay them. Both come out of the
  // width budget; leaving the border out made every page 2px wider than the
  // space it had, so the pane always had a stray horizontal scrollbar.
  const FRAME_BORDER = 2;
  const paneChrome = scrollbarWidth + FRAME_BORDER;
  /** The 100%-zoom reading width; the frame is sized from this, not from zoom. */
  const baseWidth = Math.max(280, Math.min(860, Math.floor(available - paneChrome)));
  const pageWidth = Math.max(
    140,
    Math.floor(fitWidth ? Math.max(280, available - paneChrome) : baseWidth * scale),
  );
  const boxWidth = Math.min(available, (fitWidth ? pageWidth : baseWidth) + paneChrome);
  const shownScale = pageWidth / baseWidth;
  // Keep a roughly constant rasterized pixel budget regardless of zoom:
  // pageWidth already grows with zoom, so a flat devicePixelRatio on top of it
  // compounds into several times the pixel area for the same page.
  const renderDpr = Math.min(4, Math.max(1, Math.max(window.devicePixelRatio || 1, 2) / shownScale));

  const src = useMemo(() => ({ url }), [url]);
  /**
   * Lets pdf.js use the real metrics for the 14 standard PDF fonts instead of
   * substituting a generic sans-serif. The invisible text layer is positioned
   * from those metrics, so with a substitute the characters within a run drift
   * from the glyphs painted underneath and a click lands the caret next to the
   * character it was aimed at. Memoized because react-pdf reloads the document
   * whenever this object's identity changes.
   */
  const documentOptions = useMemo(
    () => ({ standardFontDataUrl: `${import.meta.env.BASE_URL}pdfjs/standard_fonts/` }),
    [],
  );

  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const io = new IntersectionObserver(
      (entries) => {
        setVisiblePages((prev) => {
          let changed = false;
          const next = new Set(prev);
          for (const entry of entries) {
            const n = Number((entry.target as HTMLElement).dataset.page);
            if (entry.isIntersecting) {
              if (!next.has(n)) {
                next.add(n);
                changed = true;
              }
            } else if (next.has(n)) {
              next.delete(n);
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      },
      { root, rootMargin: "1500px 0px" },
    );
    observerRef.current = io;
    for (const el of Object.values(pageRefs.current)) if (el) io.observe(el);
    return () => io.disconnect();
  }, [numPages]);

  const dismiss = useCallback(() => {
    setPending(null);
    setFocused(null);
  }, []);

  const scrollToPage = useCallback((n: number, fraction = 0, center = false) => {
    if (!pageRefs.current[n] || !scrollRef.current) return;
    setVisiblePages((prev) => {
      const next = new Set(prev);
      next.add(n - 1);
      next.add(n);
      next.add(n + 1);
      return next;
    });

    const run = (behavior: ScrollBehavior) => {
      const el = pageRefs.current[n];
      const container = scrollRef.current;
      if (!el || !container) return;
      const targetY = el.offsetTop - container.offsetTop + fraction * el.offsetHeight;
      const top = center ? targetY - container.clientHeight / 2 : targetY - 8;
      if (Math.abs(container.scrollTop - top) < 2) return;
      container.scrollTo({ top, behavior });
    };

    // Measure only once the pages just marked visible have mounted: an offset
    // computed against the pre-mount layout aims at a position that stops
    // meaning the same thing once they render.
    requestAnimationFrame(() => {
      run("smooth");
      // A page finishing later can still nudge the layout, so keep checking
      // briefly and correct only while the scroll is at rest — never fighting
      // the animation or a deliberate scroll. Each check is a no-op on target.
      if (scrollSettleTimer.current !== undefined) window.clearInterval(scrollSettleTimer.current);
      let previousTop = -1;
      let ticks = 0;
      scrollSettleTimer.current = window.setInterval(() => {
        const container = scrollRef.current;
        ticks += 1;
        if (!container || ticks > 12) {
          window.clearInterval(scrollSettleTimer.current);
          scrollSettleTimer.current = undefined;
          return;
        }
        if (container.scrollTop === previousTop) run("auto");
        previousTop = container.scrollTop;
      }, 200);
    });
  }, []);

  useEffect(
    () => () => {
      if (scrollSettleTimer.current !== undefined) window.clearInterval(scrollSettleTimer.current);
    },
    [],
  );

  // Read through a ref rather than a state updater: stepping is a side effect,
  // and running it inside setPage would fire it twice under StrictMode.
  const pageRef = useRef(1);
  pageRef.current = page;
  const stepPage = useCallback(
    (delta: number) => {
      const next = Math.min(Math.max(1, pageRef.current + delta), numPages || pageRef.current);
      if (next !== pageRef.current) scrollToPage(next);
    },
    [numPages, scrollToPage],
  );

  /** Tracks which page is mostly in view so the toolbar counter stays right. */
  const onScroll = useCallback(() => {
    const container = scrollRef.current;
    if (!container) return;
    const mid = container.scrollTop + container.clientHeight / 3;
    let current = 1;
    for (const [key, el] of Object.entries(pageRefs.current)) {
      if (!el) continue;
      if (el.offsetTop - container.offsetTop <= mid) current = Number(key);
    }
    setPage(current);
  }, []);

  const { caret, placeCaretFromClick, clearCaret } = useCaretNavigation({
    pageRefs,
    scrollRef,
    numPages,
    pageWidth,
    setVisiblePages,
    onPageStep: stepPage,
    onEscape: dismiss,
  });

  const handlePageLoadSuccess = useCallback((p: PageLoadInfo) => {
    setPageAspect((prev) => prev ?? p.width / p.height);
    setPagePointsHeight((prev) => prev ?? p.originalHeight);
  }, []);

  /** Turns whatever is selected into per-page highlight groups. */
  const captureSelection = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      setPending(null);
      return;
    }
    const groups = selectionToPageSelections(sel, pageRefs.current).filter(
      (g) => g.rects.length > 0 && g.quote,
    );
    if (groups.length === 0) {
      setPending(null);
      return;
    }
    clearCaret();
    setFocused(null);

    // Anchor the menu under the end of the selection, on the page it ends on.
    const last = groups[groups.length - 1]!;
    const host = pageRefs.current[last.page];
    const lastRect = last.rects[last.rects.length - 1]!;
    const width = host?.clientWidth ?? pageWidth;
    const height = host?.clientHeight ?? 0;
    setPending({
      groups,
      quote: groups.map((g) => g.quote).join(" "),
      anchor: {
        page: last.page,
        top: (lastRect.y + lastRect.h) * height + 8,
        left: Math.max(0, Math.min(lastRect.x * width, width - MENU_WIDTH)),
      },
    });
  }, [clearCaret, pageWidth]);

  // A selection built with Shift+Arrow ends with a key release, not a mouse
  // release, so without this the highlight menu never appeared for one and
  // keyboard-selected text could not be highlighted at all.
  useEffect(() => {
    function onKeyUp(e: KeyboardEvent) {
      if (e.key !== "Shift") return;
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) captureSelection();
    }
    window.addEventListener("keyup", onKeyUp);
    return () => window.removeEventListener("keyup", onKeyUp);
  }, [captureSelection]);

  const hitAnnotation = useCallback(
    (e: { clientX: number; clientY: number }, n: number) => {
      const host = pageRefs.current[n];
      if (!host) return null;
      const box = host.getBoundingClientRect();
      const px = (e.clientX - box.left) / box.width;
      const py = (e.clientY - box.top) / box.height;
      const onPage = annotationsByPage.get(n);
      const hit = onPage?.find((a) => rectsContain(a.rects, px, py));
      return hit ? { hit, box } : null;
    },
    [annotationsByPage],
  );

  const handlePageClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>, n: number) => {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) return; // a drag just made a selection
      const found = hitAnnotation(e, n);
      if (!found) {
        setFocused(null);
        onSelectAnnotation?.(null);
        placeCaretFromClick(n, e.clientX);
        return;
      }
      clearCaret();
      setPending(null);
      const { hit, box } = found;
      const lastRect = hit.rects[hit.rects.length - 1]!;
      onSelectAnnotation?.(hit.id);
      setFocused({
        id: hit.id,
        anchor: {
          page: n,
          top: (lastRect.y + lastRect.h) * box.height + 8,
          left: Math.max(0, Math.min(lastRect.x * box.width, box.width - MENU_WIDTH)),
        },
      });
    },
    [clearCaret, hitAnnotation, onSelectAnnotation, placeCaretFromClick],
  );

  // Scrolls a highlight into view when the sidebar asks for it.
  useEffect(() => {
    if (!jumpTo) return;
    const target = annotationById.get(jumpTo.id);
    if (!target) return;
    const first = target.rects[0];
    scrollToPage(target.page, first ? first.y : 0, true);
    // annotationById is deliberately excluded: it changes on every edit, and
    // re-running then would yank the view back to the last jumped highlight.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpTo, scrollToPage]);

  const createHighlight = useCallback(
    async (color: AnnotationColor, comment: string | null) => {
      if (!pending) return;
      setBusy(true);
      try {
        await onCreate({ groups: pending.groups, color, comment });
        setDefaultColor(color);
        window.getSelection()?.removeAllRanges();
        dismiss();
      } finally {
        setBusy(false);
      }
    },
    [dismiss, onCreate, pending],
  );

  const patchFocused = useCallback(
    async (patch: { comment?: string | null; color?: AnnotationColor }) => {
      if (!focused || !onUpdate) return;
      setBusy(true);
      try {
        if (patch.color) setDefaultColor(patch.color);
        await onUpdate(focused.id, patch);
      } finally {
        setBusy(false);
      }
    },
    [focused, onUpdate],
  );

  const deleteFocused = useCallback(async () => {
    if (!focused || !onDelete) return;
    setBusy(true);
    try {
      await onDelete(focused.id);
      onSelectAnnotation?.(null);
      dismiss();
    } finally {
      setBusy(false);
    }
  }, [dismiss, focused, onDelete, onSelectAnnotation]);

  if (failed) {
    return (
      <div className="space-y-3">
        <p className="rounded-md border border-border bg-card p-3 text-sm text-muted-foreground">
          This PDF could not be loaded for in-page highlighting (the host blocks it). It is shown
          below as a plain document.
        </p>
        <iframe title="PDF" src={url} className="h-[75vh] w-full rounded-md border border-border" />
      </div>
    );
  }

  const focusedAnnotation = focused ? annotationById.get(focused.id) : undefined;
  const placeholderHeight = pageAspect ? pageWidth / pageAspect : pageWidth * 1.3;

  return (
    <div ref={outerRef} className="w-full">
      <div
        style={{ width: boxWidth }}
        className="mx-auto overflow-hidden rounded-md border border-border bg-card"
      >
        <ReaderToolbar
          page={page}
          numPages={numPages}
          scale={shownScale}
          fitWidth={fitWidth}
          onGoToPage={(n) => scrollToPage(n)}
          onStepPage={stepPage}
          onSetScale={(next) => {
            setFitWidth(false);
            setScale(clampScale(next));
          }}
          onFitWidth={() => setFitWidth((v) => !v)}
        />

        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="pdf-scroll-pane overscroll-contain overflow-auto bg-muted/30"
          // Pages mount and unmount as they scroll in and out of range, and the
          // browser's scroll anchoring reacts by silently adjusting scrollTop,
          // which fights deliberate scrolls. Placeholders already hold each
          // page's exact height, so there is nothing to anchor against.
          style={{ overflowAnchor: "none", height: paneHeight ?? undefined }}
        >
          <Document
            file={src}
            options={documentOptions}
            // Links out of a paper open in a new tab: following one in place
            // would replace the reader, losing the page, zoom and scroll
            // position with no way back but the browser's own history.
            externalLinkTarget="_blank"
            externalLinkRel="noopener noreferrer"
            onLoadSuccess={({ numPages: n }) => setNumPages(n)}
            onLoadError={() => setFailed(true)}
            onItemClick={({ dest, pageNumber }) => {
              // Following a link moves the reader elsewhere, so a caret left
              // behind at the link is no longer meaningful.
              clearCaret();
              dismiss();
              scrollToPage(pageNumber, destTopFraction(dest, pagePointsHeightRef.current), true);
            }}
            loading={
              <div className="flex items-center gap-2 p-8 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading PDF…
              </div>
            }
            error={<p className="p-8 text-sm text-muted-foreground">Could not load this PDF.</p>}
          >
            <div className="flex flex-col items-center gap-4">
              {Array.from({ length: numPages }, (_, i) => i + 1).map((n) => (
                <div
                  key={n}
                  data-page={n}
                  ref={(el) => {
                    pageRefs.current[n] = el;
                    if (el) observerRef.current?.observe(el);
                  }}
                  className="pdf-page relative w-fit shadow-sm"
                  onMouseUp={captureSelection}
                  onTouchEnd={captureSelection}
                  onClick={(e) => handlePageClick(e, n)}
                  onMouseMove={(e) => {
                    const sel = window.getSelection();
                    if (sel && !sel.isCollapsed) return;
                    setHoverPointer(hitAnnotation(e, n) !== null);
                  }}
                  onMouseLeave={() => setHoverPointer(false)}
                  style={{ cursor: hoverPointer ? "pointer" : undefined }}
                >
                  <PdfPageView
                    pageNumber={n}
                    isVisible={visiblePages.has(n)}
                    pageWidth={pageWidth}
                    placeholderHeight={placeholderHeight}
                    renderDpr={renderDpr}
                    onLoadSuccess={handlePageLoadSuccess}
                    annotations={annotationsByPage.get(n) ?? NO_ANNOTATIONS}
                    activeId={activeId}
                    caret={caret && caret.page === n ? caret : null}
                  />

                  {pending && pending.anchor.page === n && (
                    <div
                      className="absolute z-20"
                      style={{ top: pending.anchor.top, left: pending.anchor.left }}
                      onMouseUp={(e) => e.stopPropagation()}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <NewHighlightMenu
                        quote={pending.quote}
                        defaultColor={defaultColor}
                        busy={busy}
                        onHighlight={(color, comment) => void createHighlight(color, comment)}
                        onDismiss={() => {
                          window.getSelection()?.removeAllRanges();
                          dismiss();
                        }}
                      />
                    </div>
                  )}

                  {focused && focusedAnnotation && focused.anchor.page === n && (
                    <div
                      className="absolute z-20"
                      style={{ top: focused.anchor.top, left: focused.anchor.left }}
                      onMouseUp={(e) => e.stopPropagation()}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <EditHighlightMenu
                        quote={focusedAnnotation.quote}
                        comment={focusedAnnotation.comment}
                        color={focusedAnnotation.color}
                        busy={busy}
                        onRecolor={(c) => void patchFocused({ color: c })}
                        onSaveComment={(text) => void patchFocused({ comment: text || null })}
                        onDeleteComment={() => void patchFocused({ comment: null })}
                        onDelete={() => void deleteFocused()}
                        onDismiss={dismiss}
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </Document>
        </div>
      </div>
    </div>
  );
}

export default PdfReader;
