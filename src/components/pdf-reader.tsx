import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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

// react-pdf's own <Page> isn't memoized, so it (and its TextLayer /
// AnnotationLayer children, which re-sync hundreds of DOM nodes per page)
// would otherwise re-render on every keystroke of caret navigation or every
// pixel of mouse movement over the reader. Memoizing it here — the one thing
// this file controls — means it's skipped entirely unless its own props
// (page number, width, zoom) actually change.
const MemoizedPage = memo(Page);

// A fresh `[]` literal for pages with no annotations would give PageVisual a
// "new" array every render (`[] !== []`), defeating its memoization for
// every annotation-free page in the document — which is most of them.
const NO_ANNOTATIONS: Annotation[] = [];

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

type LineSpan = { el: HTMLElement; left: number; right: number };
type TextLine = { top: number; bottom: number; left: number; right: number; spans: LineSpan[] };
type PageLines = {
  lines: TextLine[];
  bySpan: Map<HTMLElement, number>;
  width: number;
  spanCount: number;
};

/**
 * Groups one page's text-layer spans into visual lines, in DOM order. pdf.js
 * emits text content in reading order, so for a two-column layout that means
 * all of column 1's lines followed by all of column 2's — exactly the order a
 * caret should travel. Only spans holding real text qualify, so overlay
 * elements (links, annotations) can never be mistaken for a line.
 *
 * Geometry is stored relative to the page rather than the viewport, so the
 * result stays valid as the reader scrolls and can be cached across
 * keystrokes — measuring every span costs a forced layout pass per call, and
 * a page holds on the order of a thousand of them.
 */
function buildPageLines(host: HTMLElement, width: number): PageLines {
  const hostBox = host.getBoundingClientRect();
  const all = host.querySelectorAll<HTMLElement>(".textLayer span");
  const lines: TextLine[] = [];
  const bySpan = new Map<HTMLElement, number>();
  for (const el of all) {
    const text = el.firstChild;
    if (!text || text.nodeType !== Node.TEXT_NODE || !text.textContent) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const top = r.top - hostBox.top;
    const bottom = r.bottom - hostBox.top;
    const left = r.left - hostBox.left;
    const right = r.right - hostBox.left;
    const center = (top + bottom) / 2;
    const last = lines[lines.length - 1];
    if (last && Math.abs((last.top + last.bottom) / 2 - center) < r.height * 0.6) {
      last.top = Math.min(last.top, top);
      last.bottom = Math.max(last.bottom, bottom);
      last.left = Math.min(last.left, left);
      last.right = Math.max(last.right, right);
      last.spans.push({ el, left, right });
    } else {
      lines.push({ top, bottom, left, right, spans: [{ el, left, right }] });
    }
    bySpan.set(el, lines.length - 1);
  }
  return { lines, bySpan, width, spanCount: all.length };
}

/**
 * Character offset within a text node nearest a viewport x, by binary search
 * over per-character rects. Range geometry is layout-derived, so unlike
 * document.caretRangeFromPoint this works for text scrolled out of view —
 * which is what lets the caret move onto a page that isn't on screen yet.
 */
function offsetAtX(textNode: Text, x: number): number {
  const len = textNode.length;
  if (len === 0) return 0;
  const range = document.createRange();
  let lo = 0;
  let hi = len - 1;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    range.setStart(textNode, mid);
    range.setEnd(textNode, mid + 1);
    const r = range.getBoundingClientRect();
    if (x < r.left) {
      hi = mid - 1;
      best = mid;
    } else if (x > r.right) {
      lo = mid + 1;
      best = mid + 1;
    } else {
      return x - r.left < r.width / 2 ? mid : mid + 1;
    }
  }
  return Math.min(Math.max(best, 0), len);
}

/**
 * Caret position on a line closest to a given page-relative x. A line can be
 * several spans wide (or, in a byline row, several unrelated ones), so pick
 * whichever actually spans that x and otherwise the nearest.
 */
function positionInLine(
  line: TextLine,
  xRelative: number,
  hostLeft: number,
): { node: Text; offset: number } | null {
  let chosen: LineSpan | undefined = line.spans[0];
  let bestDist = Infinity;
  for (const span of line.spans) {
    if (xRelative >= span.left && xRelative <= span.right) {
      chosen = span;
      break;
    }
    const d = xRelative < span.left ? span.left - xRelative : xRelative - span.right;
    if (d < bestDist) {
      bestDist = d;
      chosen = span;
    }
  }
  const textNode = chosen?.el.firstChild;
  if (!textNode || textNode.nodeType !== Node.TEXT_NODE) return null;
  return { node: textNode as Text, offset: offsetAtX(textNode as Text, xRelative + hostLeft) };
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

// Everything actually expensive per page — the canvas/text/annotation
// layers, the highlight overlay, the caret — lived inline in PdfReader's own
// render, in the same component as caret/hover/pending state. Any one of
// those changing (every keystroke, every mouse pixel moved) re-ran the JSX
// for *every* page in the document, not just the one that actually changed.
// Pulling it into its own memoized component means a page whose own props
// haven't changed — in particular caretHere, which the parent sets to null
// for every page except whichever one the caret is actually on — is skipped
// by React entirely, before even visiting its children.
const PageVisual = memo(function PageVisual({
  n,
  isVisible,
  pageWidth,
  placeholderHeight,
  renderDpr,
  onLoadSuccess,
  pageAnnotations,
  activeId,
  caretHere,
}: {
  n: number;
  isVisible: boolean;
  pageWidth: number;
  placeholderHeight: number;
  renderDpr: number;
  onLoadSuccess: (p: { width: number; height: number; originalHeight: number }) => void;
  pageAnnotations: Annotation[];
  activeId?: string | null;
  caretHere: Caret | null;
}) {
  // Identical footprint whether the page is unmounted, mounting, or fully
  // rendered. react-pdf's own default loading state is a line of text a few
  // pixels tall, so without this a page shrinks by its entire height the
  // instant it mounts and grows back when it finishes — yanking everything
  // below it by ~1000px each time, which threw off scroll positions (a link
  // jump could land a page or more from its target) and made plain scrolling
  // visibly jumpy.
  const placeholder = (
    <div
      className="flex items-center justify-center bg-card"
      style={{ width: pageWidth, height: placeholderHeight }}
    >
      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
    </div>
  );
  return (
    <>
      {isVisible ? (
        <MemoizedPage
          pageNumber={n}
          width={pageWidth}
          devicePixelRatio={renderDpr}
          renderAnnotationLayer
          onLoadSuccess={onLoadSuccess}
          loading={placeholder}
          error={placeholder}
          noData={placeholder}
        />
      ) : (
        placeholder
      )}

      {caretHere && (
        <span
          className="pdf-caret"
          style={{ top: caretHere.top, left: caretHere.left, height: caretHere.height }}
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
                className={cn("pdf-highlight", activeId === a.id && "pdf-highlight-active")}
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
    </>
  );
});

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
  // Mirror of the above, so caret-move logic can read the current position
  // without taking a dependency that would rebuild its callbacks constantly.
  const caretRef = useRef<Caret | null>(null);
  caretRef.current = caret;
  // Tracks "the user is navigating a placed text caret" independent of
  // whether one is currently rendered — Shift+Arrow can turn the caret into
  // a real (non-collapsed) selection, which hides the fake caret, but a
  // further plain Arrow can collapse it back and the caret should reappear.
  const caretModeRef = useRef(false);
  // Sticky horizontal target for Up/Down caret movement (like any text
  // editor: moving down through a shorter line and back up should return to
  // the original column, not wherever the shorter line happened to end).
  // Cleared on click or horizontal movement so it's recomputed fresh.
  const preferredCaretXRef = useRef<number | null>(null);
  // Pending cross-page caret move — the next page's text layer renders
  // asynchronously, so placing the caret there has to wait for it.
  const crossPageRaf = useRef<number | null>(null);
  // Set only for keyboard-driven caret moves, so the scroll-into-view effect
  // ignores carets placed by clicking (see that effect for why).
  const followCaretRef = useRef(false);
  // Per-page line geometry, rebuilt only when a page's rendered width or
  // text layer actually changes — see buildPageLines for why it's worth
  // keeping rather than recomputing on every arrow press.
  const lineCacheRef = useRef(new Map<number, PageLines>());
  // Pending "did the jump actually land?" re-check after a link navigation.
  const scrollSettleTimer = useRef<number | undefined>(undefined);
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

  // Stable identity (via functional state updates, so it never needs
  // pageAspect/pagePointsHeight in its own closure) — required for
  // MemoizedPage's React.memo to actually skip re-rendering pages; an inline
  // arrow recreated every render would defeat that memoization entirely.
  const handlePageLoadSuccess = useCallback((p: { width: number; height: number; originalHeight: number }) => {
    setPageAspect((prev) => prev ?? p.width / p.height);
    setPagePointsHeight((prev) => prev ?? p.originalHeight);
  }, []);

  // Grouping once per annotations change avoids an O(pages × annotations)
  // filter pass on every single render (every keystroke, every mouse move).
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
            const n = Number((entry.target as HTMLElement).dataset.page);
            if (entry.isIntersecting) {
              if (!next.has(n)) {
                next.add(n);
                changed = true;
              }
              // Unmounting a page that scrolls out of range (below) drops its
              // real canvas/text/annotation layers back to a lightweight
              // placeholder. Without this, every page ever scrolled past
              // stays fully rendered for the rest of the session — on a
              // longer paper that's dozens of live canvases and thousands of
              // text-layer spans accumulating in the DOM, which is what was
              // actually making the whole reader feel slower the more of it
              // you'd read, not any one interaction in particular.
            } else if (next.has(n)) {
              next.delete(n);
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      },
      // Keep a page or so loaded above/below the viewport so pages are ready
      // just before they scroll into view, without keeping the whole document
      // mounted (see the unmount branch above).
      { root, rootMargin: "1500px 0px" },
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
  // Target a roughly constant rasterized pixel budget (about baseWidth at
  // 2x) regardless of zoom level. pageWidth already grows with `scale`, so
  // multiplying by a flat devicePixelRatio on top of that compounds: at max
  // zoom (2.5x) that was pageWidth × 2.5 × 2 ≈ 5x the CSS width in actual
  // canvas pixels, several times the pixel *area* of the same page at 100%,
  // which is real, avoidable rasterization cost on every page rendered
  // while zoomed in. Dividing by `scale` cancels that back out.
  const renderDpr = Math.min(4, Math.max(1, Math.max(window.devicePixelRatio || 1, 2) / scale));

  const dismiss = useCallback(() => {
    setPending(null);
    setFocused(null);
    setCaret(null);
    caretModeRef.current = false;
    preferredCaretXRef.current = null;
    setCommenting(false);
    setComment("");
  }, []);

  const scrollToPage = useCallback((n: number, fraction = 0, center = false) => {
    if (!pageRefs.current[n] || !scrollRef.current) return;
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
    const run = (behavior: ScrollBehavior) => {
      const el = pageRefs.current[n];
      const container = scrollRef.current;
      if (!el || !container) return;
      const targetY = el.offsetTop - container.offsetTop + fraction * el.offsetHeight;
      // Precise in-page links (references/figures/equations) center the target
      // in the viewport instead of pinning it to the top edge, so it's visible
      // and unambiguous even if the destination sits low on a short page.
      const top = center ? targetY - container.clientHeight / 2 : targetY - 8;
      if (Math.abs(container.scrollTop - top) < 2) return;
      container.scrollTo({ top, behavior });
    };

    // Measure only after the pages just marked visible have actually mounted:
    // computing the offset against the pre-mount layout aims at a position
    // that stops meaning the same thing once they render.
    requestAnimationFrame(() => {
      run("smooth");
      // A page that finishes rendering after the jump can still nudge the
      // layout — on a cold document that can be a second or two later, well
      // after the animation ends. Keep re-checking briefly, correcting only
      // while the scroll is at rest so this never fights the animation or a
      // deliberate scroll mid-flight. Each check is a no-op once on target.
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

  /**
   * Scrolls the minimum amount needed to bring a viewport-space point into
   * the reading pane, with a little breathing room at the edges. Instant
   * rather than smooth: with a held-down arrow key these arrive faster than
   * an animation can finish, and successive relative scrolls would compose
   * against a moving position and overshoot.
   */
  const revealInView = useCallback((top: number, bottom: number, left: number) => {
    const container = scrollRef.current;
    if (!container) return;
    const box = container.getBoundingClientRect();
    const margin = 48;
    let dy = 0;
    if (top < box.top + margin) dy = top - (box.top + margin);
    else if (bottom > box.bottom - margin) dy = bottom - (box.bottom - margin);
    let dx = 0;
    if (left < box.left + margin) dx = left - (box.left + margin);
    else if (left > box.right - margin) dx = left - (box.right - margin);
    if (dy !== 0 || dx !== 0) container.scrollBy({ top: dy, left: dx, behavior: "auto" });
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
        // No caret means the caret-following effect below can't run, so
        // keyboard-driven extension has to keep its own moving end in view —
        // otherwise Shift+Arrow selects straight off the bottom of the pane
        // with the reader sitting still.
        if (followCaretRef.current && sel.focusNode) {
          followCaretRef.current = false;
          const probe = document.createRange();
          try {
            probe.setStart(sel.focusNode, sel.focusOffset);
          } catch {
            return;
          }
          probe.collapse(true);
          let r = probe.getBoundingClientRect();
          if (r.height === 0) {
            const rects = probe.getClientRects();
            r = rects[0] ?? r;
          }
          if (r.height > 0) revealInView(r.top, r.bottom, r.left);
        }
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
  }, [revealInView]);

  // Keeps the caret in view as it's navigated with the keyboard — including
  // sideways, when a two-column layout jumps the caret from the bottom of
  // one column to the top of the next, which can land it well outside the
  // current scroll position both vertically and horizontally.
  //
  // Strictly keyboard-driven: a caret placed by clicking is already exactly
  // where the user is looking and needs no scrolling, and chasing it there
  // actively fights other deliberate scrolls — a click on an internal link
  // both places a caret and jumps to the link's target, and following the
  // caret would drag the view straight back off the target again.
  useEffect(() => {
    if (!caret || !followCaretRef.current) return;
    followCaretRef.current = false;
    const host = pageRefs.current[caret.page];
    if (!host) return;
    const hostBox = host.getBoundingClientRect();
    revealInView(
      hostBox.top + caret.top,
      hostBox.top + caret.top + caret.height,
      hostBox.left + caret.left,
    );
  }, [caret, revealInView]);

  const applySelection = useCallback((node: Text, offset: number, extend: boolean) => {
    const sel = window.getSelection();
    if (!sel) return;
    if (extend && sel.anchorNode) {
      sel.setBaseAndExtent(sel.anchorNode, sel.anchorOffset, node, offset);
    } else {
      const r = document.createRange();
      r.setStart(node, offset);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
    }
  }, []);

  /** Cached line geometry for a page, rebuilt only when it's actually stale. */
  const getPageLines = useCallback(
    (pageNum: number): PageLines | null => {
      const host = pageRefs.current[pageNum];
      if (!host) return null;
      const spanCount = host.querySelectorAll(".textLayer span").length;
      if (spanCount === 0) return null; // text layer hasn't rendered yet
      const cached = lineCacheRef.current.get(pageNum);
      if (
        cached &&
        cached.width === pageWidth &&
        cached.spanCount === spanCount &&
        // A virtualized page that unmounted and came back has an identical
        // span count but entirely new elements — the cached ones are detached.
        cached.lines[0]?.spans[0]?.el.isConnected
      ) {
        return cached;
      }
      const built = buildPageLines(host, pageWidth);
      if (built.lines.length === 0) return null;
      lineCacheRef.current.set(pageNum, built);
      return built;
    },
    [pageWidth],
  );

  // pdf.js's text layer positions every span absolutely rather than in normal
  // document flow, so the browser's own Selection.modify(..., "line") has no
  // reliable notion of "the line above/below" here. Movement is therefore
  // driven off the page's own line structure (see buildPageLines), and the
  // landing position is measured directly within the target line's text
  // rather than hit-tested by screen point. Screen-point hit-testing was the
  // source of two hard failures it avoids entirely: pdf.js paints the
  // annotation layer (links, reference/figure/equation cross-refs) *on top of*
  // the text layer, so a point over any link resolved to that empty overlay
  // element instead of the text beneath it — leaving the selection somewhere
  // with no text at all, which wedged every subsequent press. And it only
  // works for points inside the viewport, which made moving onto a not-yet-
  // scrolled page impossible.
  const moveCaretVertically = useCallback(
    (direction: "up" | "down", extend: boolean) => {
      if (crossPageRaf.current !== null) {
        cancelAnimationFrame(crossPageRaf.current);
        crossPageRaf.current = null;
      }
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);

      // Move from the selection's *focus* — the end that travels — not from
      // the range's start. A range reports its endpoints in document order,
      // so while extending downward the start is the fixed anchor: measuring
      // from it recomputed the same origin line on every press and re-extended
      // to that line + 1 forever, so a held Shift+Arrow appeared to stop after
      // one line. Using the focus also handles extending upward, where the
      // moving end is the range's start instead.
      const fromNode = extend && sel.focusNode ? sel.focusNode : range.startContainer;
      const fromOffset = extend && sel.focusNode ? sel.focusOffset : range.startOffset;

      const hostEntry = Object.entries(pageRefs.current).find(
        ([, el]) => el && el.contains(fromNode),
      );
      const host = hostEntry?.[1];
      if (!host) return;
      const currentPage = Number(hostEntry![0]);

      const pageLines = getPageLines(currentPage);
      if (!pageLines) return;
      const { lines, bySpan } = pageLines;
      const hostBox = host.getBoundingClientRect();

      // Measure a collapsed probe at the focus rather than the selection's
      // own rect, which for a multi-line selection is the whole bounding box.
      const probe = document.createRange();
      try {
        probe.setStart(fromNode, fromOffset);
      } catch {
        return;
      }
      probe.collapse(true);
      let rect = probe.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        const rects = probe.getClientRects();
        if (rects.length > 0) rect = rects[0]!;
      }
      const hasRect = rect.width > 0 || rect.height > 0;
      // Kept relative to the page so it stays meaningful across scrolling and
      // maps directly onto the same column when moving to another page.
      if (hasRect && preferredCaretXRef.current === null) {
        preferredCaretXRef.current = rect.left - hostBox.left;
      }

      // Two side-by-side columns run at the *same* heights for most of the
      // page, so picking "the current line" by y-position alone is ambiguous —
      // it can just as easily match the other column's line at that height,
      // which made the caret ping-pong between columns. Identify it by the
      // actual span the selection sits in, an exact and column-safe match.
      const startEl =
        fromNode.nodeType === Node.ELEMENT_NODE
          ? (fromNode as Element)
          : fromNode.parentElement;
      const spanEl = startEl?.closest("span") as HTMLElement | null;
      let currentIndex = spanEl ? (bySpan.get(spanEl) ?? -1) : -1;
      if (currentIndex === -1) {
        // Fall back to whichever line is nearest vertically, preferring the
        // live selection's own rect and otherwise the rendered caret's — so a
        // selection sitting somewhere without usable geometry still moves
        // instead of wedging.
        const caretNow = caretRef.current;
        let y: number | null = hasRect ? rect.top + rect.height / 2 - hostBox.top : null;
        if (y === null && caretNow && caretNow.page === currentPage) {
          y = caretNow.top + caretNow.height / 2;
        }
        if (y === null) return;
        let bestDist = Infinity;
        lines.forEach((l, i) => {
          const d = Math.abs((l.top + l.bottom) / 2 - y!);
          if (d < bestDist) {
            bestDist = d;
            currentIndex = i;
          }
        });
      }

      const x = preferredCaretXRef.current ?? lines[currentIndex]!.left;
      const targetIndex = direction === "down" ? currentIndex + 1 : currentIndex - 1;

      if (targetIndex >= 0 && targetIndex < lines.length) {
        const pos = positionInLine(lines[targetIndex]!, x, hostBox.left);
        if (pos) applySelection(pos.node, pos.offset, extend);
        return;
      }

      // Past this page's first/last line — carry on onto the adjacent page
      // rather than stopping dead at the page boundary. The page may still be
      // a virtualized placeholder, and its text layer renders asynchronously
      // even once mounted, so poll for it before placing the caret.
      const nextPage = direction === "down" ? currentPage + 1 : currentPage - 1;
      if (nextPage < 1 || nextPage > numPages) return;
      setVisiblePages((prev) => (prev.has(nextPage) ? prev : new Set(prev).add(nextPage)));

      let tries = 0;
      const attempt = () => {
        crossPageRaf.current = null;
        const nextHost = pageRefs.current[nextPage];
        const next = nextHost ? getPageLines(nextPage) : null;
        if (!next) {
          if (tries++ < 180) crossPageRaf.current = requestAnimationFrame(attempt);
          return;
        }
        const line = direction === "down" ? next.lines[0]! : next.lines[next.lines.length - 1]!;
        const pos = positionInLine(line, x, nextHost!.getBoundingClientRect().left);
        if (pos) applySelection(pos.node, pos.offset, extend);
      };
      attempt();
    },
    [applySelection, getPageLines, numPages],
  );

  useEffect(
    () => () => {
      if (scrollSettleTimer.current !== undefined) window.clearInterval(scrollSettleTimer.current);
      if (crossPageRaf.current !== null) cancelAnimationFrame(crossPageRaf.current);
    },
    [],
  );

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
        followCaretRef.current = true;
        if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          moveCaretVertically(e.key === "ArrowDown" ? "down" : "up", e.shiftKey);
        } else {
          preferredCaretXRef.current = null;
          window.getSelection()?.modify(e.shiftKey ? "extend" : "move", direction, "character");
        }
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
  }, [numPages, page, dismiss, scrollToPage, moveCaretVertically]);

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
    // Scoped to this page's own annotations (via the memoized per-page
    // grouping) rather than scanning the whole document's — this runs on
    // every pixel of mouse movement over the reader, so a full-array scan
    // here scales with total annotation count on every single mousemove.
    const pageAnnotations = annotationsByPage.get(n);
    const hit = pageAnnotations?.find((a) =>
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
          preferredCaretXRef.current = null;
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
        // Pages mount and unmount as they scroll in and out of range, and the
        // browser's scroll anchoring reacts to that by silently adjusting
        // scrollTop to "preserve" what it thinks the user was looking at —
        // which fights deliberate scrolls and can throw a link jump off by a
        // page or more. Placeholders already hold each page's exact height,
        // so nothing actually shifts and there is nothing to anchor against.
        style={{ overflowAnchor: "none" }}
      >
        <Document
          file={src}
          onLoadSuccess={({ numPages: n }) => setNumPages(n)}
          onLoadError={() => setFailed(true)}
          onItemClick={({ dest, pageNumber }) => {
            // Following a link moves the reader somewhere else entirely, so
            // the caret left behind at the link is no longer meaningful —
            // drop it rather than leaving a stale blinking cursor on a page
            // that's now scrolled away.
            setCaret(null);
            caretModeRef.current = false;
            preferredCaretXRef.current = null;
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
              const pageAnnotations = annotationsByPage.get(n) ?? NO_ANNOTATIONS;
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
                  <PageVisual
                    n={n}
                    isVisible={isVisible}
                    pageWidth={pageWidth}
                    placeholderHeight={placeholderHeight}
                    renderDpr={renderDpr}
                    onLoadSuccess={handlePageLoadSuccess}
                    pageAnnotations={pageAnnotations}
                    activeId={activeId}
                    caretHere={caret && caret.page === n ? caret : null}
                  />

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
