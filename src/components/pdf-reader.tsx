import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/TextLayer.css";
import "react-pdf/dist/Page/AnnotationLayer.css";
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import {
  ChevronLeft,
  ChevronRight,
  Highlighter,
  Loader2,
  MessageSquarePlus,
  Minus,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  ANNOTATION_COLORS,
  type Annotation,
  type AnnotationColor,
  type Rect,
} from "@/lib/annotations";

pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

export const HIGHLIGHT_HEX: Record<AnnotationColor, string> = {
  yellow: "#F5D742",
  orange: "#F0A860",
  green: "#7FBF7F",
  blue: "#6E97D6",
  pink: "#E894B0",
};

type Box = { left: number; top: number; width: number; height: number };

/**
 * Internal PDF links (references, section/figure/equation cross-refs) point
 * at a page PLUS a precise vertical offset within it — jumping to just the
 * page leaves the target wherever it happens to fall, often scrolled well
 * past the top. Destination arrays follow the PDF spec: [pageRef, {name:
 * fitType}, ...params], where the vertical offset (in PDF points, measured
 * from the page's bottom) lives at a different index depending on fitType.
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
      top = null; // Fit / FitB / FitV / FitBV — no meaningful vertical offset
  }
  if (typeof top !== "number" || Number.isNaN(top)) return 0;
  return Math.min(1, Math.max(0, 1 - top / pagePointsHeight));
}

/**
 * Merges selection fragments that sit on the same text line into one span,
 * but only when the horizontal gap between them is small (≤ half a character
 * height). Large whitespace gaps — such as between widely spaced author
 * names — produce separate highlight rectangles so the empty space in
 * between is not painted.
 */
function mergeLineRects(raw: DOMRect[]): Box[] {
  const sorted = [...raw].sort((a, b) => a.top - b.top || a.left - b.left);
  const out: Box[] = [];
  for (const r of sorted) {
    const prev = out[out.length - 1];
    const sameLine =
      prev !== undefined &&
      Math.abs(prev.top + prev.height / 2 - (r.top + r.height / 2)) < r.height * 0.6;
    const gap = prev ? r.left - (prev.left + prev.width) : 0;
    // Only merge when fragments are close together (gap ≤ half the line height).
    // This prevents highlighting large empty spaces between distant text fragments.
    if (prev && sameLine && gap >= 0 && gap < r.height * 0.5) {
      const left = Math.min(prev.left, r.left);
      const top = Math.min(prev.top, r.top);
      const right = Math.max(prev.left + prev.width, r.left + r.width);
      const bottom = Math.max(prev.top + prev.height, r.top + r.height);
      out[out.length - 1] = { left, top, width: right - left, height: bottom - top };
    } else {
      out.push({ left: r.left, top: r.top, width: r.width, height: r.height });
    }
  }
  return out;
}

type Pending = {
  page: number;
  quote: string;
  rects: Rect[];
  top: number;
  left: number;
};

type Focused = {
  annotation: Annotation;
  page: number;
  top: number;
  left: number;
};

type Caret = {
  page: number;
  top: number;
  left: number;
  height: number;
};

export function PdfReader({
  url,
  annotations,
  onCreate,
  onComment,
  onDelete,
  activeId,
  onSelectAnnotation,
}: {
  url: string;
  annotations: Annotation[];
  onCreate: (input: {
    page: number;
    quote: string;
    comment: string | null;
    color: AnnotationColor;
    rects: Rect[];
  }) => Promise<unknown>;
  onComment?: (id: string, comment: string) => Promise<unknown>;
  onDelete?: (id: string) => Promise<unknown>;
  activeId?: string | null;
  onSelectAnnotation?: (id: string | null) => void;
}) {
  // Always full-width — used only to measure how much horizontal room is
  // available, independent of the reader box below, which is sized to hug
  // its own content rather than stretch to fill this.
  const outerRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const [available, setAvailable] = useState(900);
  const [scrollbarWidth, setScrollbarWidth] = useState(0);
  const [numPages, setNumPages] = useState(0);
  const [page, setPage] = useState(1);
  const [scale, setScale] = useState(1);
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [focused, setFocused] = useState<Focused | null>(null);
  // A fake blinking text caret — plain (non-editable) selectable text never
  // gets a real one from the browser, but proper PDF viewers fake it anyway
  // so a click gives some visual confirmation of exactly where it landed.
  const [caret, setCaret] = useState<Caret | null>(null);
  // Tracks "the user is navigating a placed text caret" independent of
  // whether one is currently rendered — Shift+Arrow can turn the caret into
  // a real (non-collapsed) selection, which hides the fake caret, but a
  // further plain Arrow can collapse it back and the caret should reappear.
  const caretModeRef = useRef(false);
  const [comment, setComment] = useState("");
  const [color, setColor] = useState<AnnotationColor>("yellow");
  const [saving, setSaving] = useState(false);
  const [commenting, setCommenting] = useState(false);
  // Pages actually render lazily (see the IntersectionObserver below) —
  // rendering all of them up front was the main cause of a sluggish reader,
  // since every page forces its own full-resolution canvas paint.
  const [visiblePages, setVisiblePages] = useState<Set<number>>(() => new Set([1]));
  const [pageAspect, setPageAspect] = useState<number | null>(null);
  // Unscaled page height in PDF points — used to convert a link's
  // destination (a PDF-space Y offset) into a fraction of the page.
  const [pagePointsHeight, setPagePointsHeight] = useState<number | null>(null);
  // react-pdf's <Document> caches its onItemClick handler in a useRef on
  // first mount and never refreshes it, so a plain closure over
  // pagePointsHeight would forever see the value from before any page
  // loaded (null). Route through a ref so the frozen closure still reads
  // the latest value at call time.
  const pagePointsHeightRef = useRef<number | null>(null);
  pagePointsHeightRef.current = pagePointsHeight;
  const [hoverPointer, setHoverPointer] = useState(false);
  const observerRef = useRef<IntersectionObserver | null>(null);

  useLayoutEffect(() => {
    const el = outerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setAvailable(el.clientWidth));
    ro.observe(el);
    setAvailable(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const io = new IntersectionObserver(
      (entries) => {
        setVisiblePages((prev) => {
          let changed = false;
          const next = new Set(prev);
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const n = Number((entry.target as HTMLElement).dataset.page);
            if (!next.has(n)) {
              next.add(n);
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      },
      // Preload roughly one extra screen above/below so pages are ready just
      // before they're scrolled into view, instead of popping in late.
      { root, rootMargin: "700px 0px" },
    );
    observerRef.current = io;
    for (const el of Object.values(pageRefs.current)) {
      if (el) io.observe(el);
    }
    return () => io.disconnect();
  }, [numPages]);

  // The reader box is sized to hug the page exactly, but the scroll pane's
  // own vertical scrollbar (always present once a page renders — pages are
  // taller than the viewport) reserves some of its width on platforms with
  // non-overlay scrollbars. Measure that once so the box can reserve the
  // same amount, instead of the page silently overflowing it by that width.
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

  const src = useMemo(() => ({ url }), [url]);
  const paneChrome = scrollbarWidth; // scroll pane has no padding — just its own scrollbar
  // Base (100%-zoom) page width, capped to a comfortable reading size and
  // independent of the zoom level — this is what the surrounding box hugs,
  // so the box's own size only ever reacts to available screen space, never
  // to the zoom control. This also fully determines boxWidth, which must not
  // depend on `scale` — the frame stays put, and the frame only reacts to
  // the *available screen* width, not the zoom control.
  const baseWidth = Math.max(280, Math.min(860, Math.floor(available - paneChrome)));
  const boxWidth = baseWidth + paneChrome;
  // Actual rendered page width: scales with zoom and can exceed the box —
  // the scroll pane's overflow-auto handles panning around it when zoomed
  // in past the frame.
  const pageWidth = Math.max(140, Math.floor(baseWidth * scale));
  // Force at least 2x canvas resolution so text stays sharp even on
  // standard-DPI monitors, instead of matching the display 1:1.
  const renderDpr = Math.max(window.devicePixelRatio || 1, 2);

  const dismiss = useCallback(() => {
    setPending(null);
    setFocused(null);
    setCaret(null);
    caretModeRef.current = false;
    setCommenting(false);
    setComment("");
  }, []);

  const scrollToPage = useCallback((n: number, fraction = 0, center = false) => {
    const el = pageRefs.current[n];
    const container = scrollRef.current;
    if (!el || !container) return;
    // Jumping straight to a page (e.g. a reference/figure link) can land
    // somewhere the lazy-load observer hasn't reached yet — render it (and
    // its immediate neighbors) immediately instead of showing a placeholder
    // until scrolling nudges the observer.
    setVisiblePages((prev) => {
      const next = new Set(prev);
      next.add(n - 1);
      next.add(n);
      next.add(n + 1);
      return next;
    });
    const targetY = el.offsetTop - container.offsetTop + fraction * el.offsetHeight;
    // Precise in-page links (references/figures/equations) center the target
    // in the viewport instead of pinning it to the top edge, so it's visible
    // and unambiguous even if the destination sits low on a short page.
    const top = center ? targetY - container.clientHeight / 2 : targetY - 8;
    container.scrollTo({ top, behavior: "smooth" });
  }, []);

  /** Tracks which page is mostly in view so the toolbar counter stays accurate. */
  const onScroll = useCallback(() => {
    const container = scrollRef.current;
    if (!container) return;
    const mid = container.scrollTop + container.clientHeight / 3;
    let current = 1;
    for (const [key, el] of Object.entries(pageRefs.current)) {
      if (!el) continue;
      const top = el.offsetTop - container.offsetTop;
      if (top <= mid) current = Number(key);
    }
    setPage(current);
  }, []);

  const captureSelection = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      if (!commenting) setPending(null);
      return;
    }
    setCaret(null);
    caretModeRef.current = false;
    const range = sel.getRangeAt(0);
    // Drop the sliver rects browsers emit at line wraps / range edges.
    const raw = Array.from(range.getClientRects()).filter((r) => r.width > 4 && r.height > 6);
    if (raw.length === 0) return;

    // Guard against runaway selections. Releasing the drag just below the
    // last line of a page — easy to do, since text rarely fills all the way
    // to the page edge — can make the browser's selection anchor snap back
    // to the very start of the page's text layer instead of stopping where
    // the drag actually ended, turning a small intended selection into one
    // spanning most of the page. A real highlight is a few lines at most, so
    // reject anything whose vertical span is clearly not that.
    const top = Math.min(...raw.map((r) => r.top));
    const bottom = Math.max(...raw.map((r) => r.bottom));
    if (bottom - top > 600) {
      if (!commenting) setPending(null);
      return;
    }

    // Attribute the selection to whichever page contains its first rect (the
    // visual start of the drag). Using the range's commonAncestorContainer
    // for this breaks the moment a selection is dragged across a page
    // boundary — in a continuous-scroll view that's an easy thing to do by
    // accident — since the common ancestor then sits above every page and
    // matches none of them, silently dropping the whole selection.
    const first = raw[0]!;
    const cx = first.left + first.width / 2;
    const cy = first.top + first.height / 2;
    const entry = Object.entries(pageRefs.current).find(([, el]) => {
      if (!el) return false;
      const box = el.getBoundingClientRect();
      return cx >= box.left && cx <= box.right && cy >= box.top && cy <= box.bottom;
    });
    if (!entry) return;
    const [pageKey, host] = entry;
    if (!host) return;
    const quote = sel.toString().replace(/\s+/g, " ").trim();
    if (!quote) return;

    const box = host.getBoundingClientRect();
    // A selection dragged past this page's edge still reports rects for the
    // next page too — keep only the ones that actually fall on this page,
    // rather than normalizing nonsense coordinates from the wrong page.
    const onThisPage = raw.filter((r) => {
      const rcy = r.top + r.height / 2;
      return rcy >= box.top - 2 && rcy <= box.bottom + 2;
    });
    if (onThisPage.length === 0) return;
    // Merge same-line fragments so punctuation gaps disappear.
    const merged = mergeLineRects(onThisPage);
    const rects: Rect[] = merged.map((r) => ({
      x: (r.left - box.left) / box.width,
      y: (r.top - box.top) / box.height,
      w: r.width / box.width,
      h: r.height / box.height,
    }));
    if (rects.length === 0) return;

    const last = rects[rects.length - 1]!;
    setComment("");
    setCommenting(false);
    setFocused(null);
    setPending({
      page: Number(pageKey),
      quote,
      rects,
      top: (last.y + last.h) * box.height + 8,
      left: Math.max(0, last.x * box.width),
    });
  }, [commenting]);

  // Once a caret is placed (by clicking text) and the user starts navigating
  // it with arrow keys (below, via Selection.modify()), the fake caret
  // overlay has to be kept in sync with wherever the real selection ends up.
  useEffect(() => {
    function onSelectionChange() {
      if (!caretModeRef.current) return;
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) {
        setCaret(null);
        return;
      }
      if (!sel.isCollapsed) {
        // Shift+Arrow turned it into a real selection — the selection
        // highlight itself is the visual indicator now, not a caret. Caret
        // mode stays on, though: a further plain Arrow can collapse the
        // selection back down, and the caret should reappear when it does.
        setCaret(null);
        return;
      }
      const range = sel.getRangeAt(0);
      const entry = Object.entries(pageRefs.current).find(
        ([, el]) => el && el.contains(range.commonAncestorContainer),
      );
      if (!entry) {
        setCaret(null);
        caretModeRef.current = false;
        return;
      }
      const [pageKey, host] = entry;
      if (!host) return;
      // getBoundingClientRect() can come back zero-height right at certain
      // line-boundary caret positions (e.g. just after collapsing a
      // "line"-extended selection) — getClientRects() often still has a
      // usable individual rect even then.
      let r = range.getBoundingClientRect();
      if (r.height === 0) {
        const rects = range.getClientRects();
        r = rects[0] ?? r;
      }
      if (r.height === 0) return; // still nothing usable — keep the last known position
      const box = host.getBoundingClientRect();
      setCaret({ page: Number(pageKey), top: r.top - box.top, left: r.left - box.left, height: r.height });
    }
    document.addEventListener("selectionchange", onSelectionChange);
    return () => document.removeEventListener("selectionchange", onSelectionChange);
  }, []);

  useEffect(() => {
    const ARROW_DIRECTION: Record<string, "left" | "right" | "backward" | "forward"> = {
      ArrowLeft: "left",
      ArrowRight: "right",
      ArrowUp: "backward",
      ArrowDown: "forward",
    };

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        window.getSelection()?.removeAllRanges();
        dismiss();
        return;
      }
      const target = e.target as HTMLElement | null;
      const typing =
        !!target &&
        (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
      if (typing) return;

      // A caret placed in the text (from clicking it) takes over all four
      // arrow keys — plain moves it, Shift+ extends a real selection from
      // it — the same as any ordinary selectable text elsewhere on the web.
      // Browsers don't do this automatically for non-editable content the
      // way they do for an <input>, so it's driven explicitly here via the
      // Selection API's own move/extend rather than reimplementing cursor
      // placement by hand.
      const direction = ARROW_DIRECTION[e.key];
      if (caretModeRef.current && direction && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        const granularity = e.key === "ArrowUp" || e.key === "ArrowDown" ? "line" : "character";
        window.getSelection()?.modify(e.shiftKey ? "extend" : "move", direction, granularity);
        return;
      }

      if (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) return;
      if (e.key === "ArrowRight" || e.key === "PageDown") {
        e.preventDefault();
        scrollToPage(numPages ? Math.min(numPages, page + 1) : page);
      } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
        e.preventDefault();
        scrollToPage(Math.max(1, page - 1));
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [numPages, page, dismiss, scrollToPage]);

  async function save(withComment: boolean) {
    if (!pending) return;
    setSaving(true);
    try {
      await onCreate({
        page: pending.page,
        quote: pending.quote,
        comment: withComment ? comment.trim() || null : null,
        color,
        rects: pending.rects,
      });
      window.getSelection()?.removeAllRanges();
      dismiss();
    } finally {
      setSaving(false);
    }
  }

  async function saveFocusedComment() {
    if (!focused || !onComment) return;
    setSaving(true);
    try {
      await onComment(focused.annotation.id, comment.trim());
      dismiss();
    } finally {
      setSaving(false);
    }
  }

  /**
   * The PDF text layer sits above the highlight layer (so text stays selectable),
   * so highlight clicks are hit-tested here against the stored rects instead.
   */
  function findHitAnnotation(e: { clientX: number; clientY: number }, n: number) {
    const host = pageRefs.current[n];
    if (!host) return null;
    const box = host.getBoundingClientRect();
    const px = (e.clientX - box.left) / box.width;
    const py = (e.clientY - box.top) / box.height;
    const hit = annotations.find(
      (a) =>
        a.page === n &&
        a.rects.some((r) => px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h),
    );
    return hit ? { hit, box } : null;
  }

  function isOverHighlight(e: React.MouseEvent, n: number): boolean {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return false;
    return findHitAnnotation(e, n) !== null;
  }

  function handlePageClick(e: React.MouseEvent<HTMLDivElement>, n: number) {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    const found = findHitAnnotation(e, n);
    if (!found) {
      if (focused) dismiss();
      // A plain click on ordinary text: the browser already collapsed the
      // selection to that exact spot, so read its position back out and
      // show a fake blinking caret there — real text-selection carets only
      // render in editable content, never in plain selectable text like this.
      const host = pageRefs.current[n];
      if (host && sel && sel.rangeCount > 0) {
        const r = sel.getRangeAt(0).getBoundingClientRect();
        if (r.height > 0) {
          const box = host.getBoundingClientRect();
          setCaret({
            page: n,
            top: r.top - box.top,
            left: r.left - box.left,
            height: r.height,
          });
          caretModeRef.current = true;
        }
      }
      return;
    }
    setCaret(null);
    caretModeRef.current = false;
    const { hit, box } = found;
    const lastRect = hit.rects[hit.rects.length - 1]!;
    onSelectAnnotation?.(hit.id);
    setPending(null);
    setCommenting(false);
    setComment(hit.comment ?? "");
    setFocused({
      annotation: hit,
      page: n,
      top: (lastRect.y + lastRect.h) * box.height + 8,
      left: Math.max(0, lastRect.x * box.width),
    });
  }

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

  return (
    <div ref={outerRef} className="w-full">
    <div
      ref={wrapRef}
      style={{ width: boxWidth }}
      className="mx-auto overflow-hidden rounded-md border border-border bg-card"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-sm">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Previous page"
          disabled={page <= 1}
          onClick={() => scrollToPage(page - 1)}
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <span className="tabular-nums text-muted-foreground">
          Page {page} {numPages ? `of ${numPages}` : ""}
        </span>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Next page"
          disabled={!numPages || page >= numPages}
          onClick={() => scrollToPage(page + 1)}
        >
          <ChevronRight className="h-4 w-4" />
        </Button>

        <div className="ml-3 flex items-center gap-1.5 border-l border-border pl-3">
          <span className="text-xs text-muted-foreground">Colour</span>
          {ANNOTATION_COLORS.map((c) => (
            <button
              type="button"
              key={c}
              aria-label={`Highlight colour ${c}`}
              aria-pressed={color === c}
              onClick={() => setColor(c)}
              className={cn(
                "h-5 w-5 rounded-full border border-border transition-transform",
                color === c && "ring-2 ring-primary ring-offset-1 ring-offset-card",
              )}
              style={{ background: HIGHLIGHT_HEX[c] }}
            />
          ))}
        </div>

        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Zoom out"
            onClick={() => setScale((s) => Math.max(0.5, s - 0.1))}
          >
            <Minus className="h-4 w-4" />
          </Button>
          <span className="w-12 text-center text-xs text-muted-foreground">
            {Math.round(scale * 100)}%
          </span>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Zoom in"
            onClick={() => setScale((s) => Math.min(2.5, s + 0.1))}
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="max-h-[80vh] overflow-auto bg-muted/30"
      >
        <Document
          file={src}
          onLoadSuccess={({ numPages: n }) => setNumPages(n)}
          onLoadError={() => setFailed(true)}
          onItemClick={({ dest, pageNumber }) => {
            const fraction = destTopFraction(dest, pagePointsHeightRef.current);
            scrollToPage(pageNumber, fraction, true);
          }}
          loading={
            <div className="flex items-center gap-2 p-8 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading PDF…
            </div>
          }
          error={<p className="p-8 text-sm text-muted-foreground">Could not load this PDF.</p>}
        >
          <div className="flex flex-col items-center gap-4">
            {Array.from({ length: numPages }, (_, i) => i + 1).map((n) => {
              const pageAnnotations = annotations.filter(
                (a) => a.page === n && a.rects.length > 0,
              );
              const isVisible = visiblePages.has(n);
              const placeholderHeight = pageAspect ? pageWidth / pageAspect : pageWidth * 1.3;
              return (
                <div
                  key={n}
                  data-page={n}
                  ref={(el) => {
                    pageRefs.current[n] = el;
                    const io = observerRef.current;
                    if (!io) return;
                    if (el) io.observe(el);
                  }}
                  className="pdf-page relative w-fit shadow-sm"
                  onMouseUp={captureSelection}
                  onTouchEnd={captureSelection}
                  onClick={(e) => handlePageClick(e, n)}
                  onMouseMove={(e) => setHoverPointer(isOverHighlight(e, n))}
                  onMouseLeave={() => setHoverPointer(false)}
                  style={isVisible ? { cursor: hoverPointer ? "pointer" : undefined } : undefined}
                >
                  {isVisible ? (
                    <Page
                      pageNumber={n}
                      width={pageWidth}
                      devicePixelRatio={renderDpr}
                      renderAnnotationLayer
                      onLoadSuccess={(p) => {
                        if (pageAspect === null) setPageAspect(p.width / p.height);
                        if (pagePointsHeight === null) setPagePointsHeight(p.originalHeight);
                      }}
                    />
                  ) : (
                    <div
                      className="flex items-center justify-center bg-card"
                      style={{ width: pageWidth, height: placeholderHeight }}
                    >
                      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                    </div>
                  )}

                  {caret && caret.page === n && (
                    <span
                      className="pdf-caret"
                      style={{ top: caret.top, left: caret.left, height: caret.height }}
                    />
                  )}

                  <div className="pdf-highlight-layer">
                    {pageAnnotations.map((a) => (
                      <div
                        key={a.id}
                        style={{
                          position: "absolute",
                          inset: 0,
                          opacity:
                            (a.color === "yellow" || a.color === "orange" ? 0.18 : 0.32) +
                            (activeId === a.id ? 0.12 : 0),
                          pointerEvents: "none",
                        }}
                      >
                        {a.rects.map((r, idx) => (
                          <span
                            key={idx}
                            title={a.comment ?? a.quote ?? "Highlight"}
                            className={cn(
                              "pdf-highlight",
                              activeId === a.id && "pdf-highlight-active",
                            )}
                            style={{
                              left: `${r.x * 100}%`,
                              top: `${r.y * 100}%`,
                              width: `${r.w * 100}%`,
                              height: `${r.h * 100}%`,
                              background: HIGHLIGHT_HEX[a.color] ?? HIGHLIGHT_HEX.yellow,
                              opacity: 1,
                            }}
                          />
                        ))}
                      </div>
                    ))}
                  </div>

                  {pending && pending.page === n && (
                    <div
                      className="absolute z-20"
                      style={{ top: pending.top, left: pending.left }}
                      onMouseUp={(e) => e.stopPropagation()}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {!commenting ? (
                        <div className="flex items-center gap-1 rounded-md border border-border bg-popover p-1 shadow-lg">
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={saving}
                            onClick={() => void save(false)}
                            className="h-8 gap-1.5 px-2 text-xs"
                          >
                            {saving ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Highlighter
                                className="h-3.5 w-3.5"
                                style={{ color: HIGHLIGHT_HEX[color] }}
                              />
                            )}
                            Highlight
                          </Button>
                          <span className="h-5 w-px bg-border" />
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setCommenting(true)}
                            className="h-8 gap-1.5 px-2 text-xs"
                          >
                            <MessageSquarePlus className="h-3.5 w-3.5" /> Comment
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            aria-label="Dismiss"
                            onClick={dismiss}
                            className="h-8 w-8"
                          >
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      ) : (
                        <div className="w-72 rounded-md border border-border bg-popover p-3 shadow-lg">
                          <p className="line-clamp-3 border-l-2 border-primary pl-2 text-xs italic text-muted-foreground">
                            {pending.quote}
                          </p>
                          <Textarea
                            autoFocus
                            className="mt-2"
                            rows={3}
                            placeholder="Your comment…"
                            value={comment}
                            onChange={(e) => setComment(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void save(true);
                            }}
                          />
                          <div className="mt-2 flex justify-end gap-2">
                            <Button size="sm" variant="ghost" onClick={dismiss}>
                              Cancel
                            </Button>
                            <Button
                              size="sm"
                              disabled={saving || !comment.trim()}
                              onClick={() => void save(true)}
                            >
                              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Save
                              comment
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {focused && focused.page === n && (
                    <div
                      className="absolute z-20"
                      style={{ top: focused.top, left: focused.left }}
                      onMouseUp={(e) => e.stopPropagation()}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {!commenting ? (
                        <div className="flex items-center gap-1 rounded-md border border-border bg-popover p-1 shadow-lg">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setCommenting(true)}
                            className="h-8 gap-1.5 px-2 text-xs"
                          >
                            <MessageSquarePlus className="h-3.5 w-3.5" />
                            {focused.annotation.comment ? "Edit comment" : "Comment"}
                          </Button>
                          <span className="h-5 w-px bg-border" />
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={saving}
                            onClick={async () => {
                              setSaving(true);
                              try {
                                await onDelete?.(focused.annotation.id);
                                dismiss();
                              } finally {
                                setSaving(false);
                              }
                            }}
                            className="h-8 gap-1.5 px-2 text-xs text-destructive"
                          >
                            <Trash2 className="h-3.5 w-3.5" /> Delete
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            aria-label="Dismiss"
                            onClick={dismiss}
                            className="h-8 w-8"
                          >
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      ) : (
                        <div className="w-72 rounded-md border border-border bg-popover p-3 shadow-lg">
                          {focused.annotation.quote && (
                            <p className="line-clamp-3 border-l-2 border-primary pl-2 text-xs italic text-muted-foreground">
                              {focused.annotation.quote}
                            </p>
                          )}
                          <Textarea
                            autoFocus
                            className="mt-2"
                            rows={3}
                            placeholder="Your comment…"
                            value={comment}
                            onChange={(e) => setComment(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && (e.metaKey || e.ctrlKey))
                                void saveFocusedComment();
                            }}
                          />
                          <div className="mt-2 flex justify-end gap-2">
                            <Button size="sm" variant="ghost" onClick={dismiss}>
                              Cancel
                            </Button>
                            <Button
                              size="sm"
                              disabled={saving || !comment.trim()}
                              onClick={() => void saveFocusedComment()}
                            >
                              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Save
                              comment
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Document>
      </div>
    </div>
    </div>
  );
}

export default PdfReader;
