import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Document, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/TextLayer.css";
import "react-pdf/dist/Page/AnnotationLayer.css";
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  ANNOTATION_COLORS,
  type Annotation,
  type AnnotationColor,
  type Rect,
} from "@/lib/paper-types";
import { rectsContain, type PageSelection } from "@/lib/pdf/selection-geometry";
import { toolCursor } from "@/lib/pdf/tool-cursors";
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
import {
  HighlightTools,
  ReaderToolbar,
  clampScale,
  nextZoomStop,
  type ReaderTool,
} from "@/components/reader/reader-toolbar";
import { useTextSelection } from "@/components/reader/use-text-selection";

pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

export { HIGHLIGHT_HEX };

/** Roughly how wide the menus are, for keeping them inside the page. */
const MENU_WIDTH = 330;

/** The 100%-zoom page width: a comfortable reading size, never wider than the pane. */
const MAX_READING_WIDTH = 920;

/** How long a zoom or resize must stop before pages are redrawn sharp at the new size. */
const RENDER_DEBOUNCE_MS = 120;

/** Horizontal padding inside the scroll pane (px-4 on each side). */
const PANE_PADDING = 32;

/**
 * Where a popup sits, as fractions of its page so it follows the page through
 * zoom. `above` flips it over the line instead of under it when there is no
 * room below inside the visible pane.
 */
type Anchor = { page: number; x: number; yTop: number; yBottom: number; above: boolean };

type PendingSelection = {
  groups: PageSelection[];
  anchor: Anchor;
  quote: string;
  /** Open straight into the note field. */
  note: boolean;
};

type FocusedHighlight = { id: string; anchor: Anchor };

/** The part of a pdf.js document this component reads: page count and page sizes. */
type PdfDocumentLike = {
  numPages: number;
  getPage: (n: number) => Promise<{
    getViewport: (o: { scale: number }) => { width: number; height: number };
  }>;
};

/** Space a popup needs before it is moved above the line instead. */
const MENU_ROOM = 220;

function menuStyle(a: Anchor): CSSProperties {
  // clamp() keeps the popup inside the page's right edge without measuring it.
  const left = `clamp(0px, ${a.x * 100}%, calc(100% - ${MENU_WIDTH}px))`;
  return a.above
    ? { left, bottom: `calc(${(1 - a.yTop) * 100}% + 8px)` }
    : { left, top: `calc(${a.yBottom * 100}% + 8px)` };
}

/**
 * Pressing a popup button must not collapse the text selection or steal
 * focus; the note field is the one place that should take both.
 */
function keepSelection(e: React.MouseEvent) {
  if ((e.target as HTMLElement).closest("textarea, input")) return;
  e.preventDefault();
}

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
  header,
  actions,
  storageKey,
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
  /** Shown at the left of the toolbar (back link, title). */
  header?: ReactNode;
  /** Shown at the right of the toolbar. */
  actions?: ReactNode;
  /** When set, the reading position is saved here and restored on open. */
  storageKey?: string;
}) {
  const outerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const observerRef = useRef<IntersectionObserver | null>(null);

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
  const [tool, setTool] = useState<ReaderTool>(null);
  // Highlighter or note cursor, tinted with the armed colour.
  const toolCursorValue = useMemo(
    () => (tool ? toolCursor(tool, HIGHLIGHT_HEX[defaultColor]) : undefined),
    [tool, defaultColor],
  );
  const [busy, setBusy] = useState(false);

  // Pages render lazily and unmount again once well out of range; keeping the
  // whole document mounted was the main cause of the reader degrading the
  // further through a paper you read.
  const [visiblePages, setVisiblePages] = useState<Set<number>>(() => new Set([1]));
  const [pageAspect, setPageAspect] = useState<number | null>(null);
  // Pages that aren't shaped like the first one (a landscape figure page).
  const [pageAspects, setPageAspects] = useState<Record<number, number>>({});
  const pageAspectRef = useRef<number | null>(null);
  pageAspectRef.current = pageAspect;
  const [pagePointsHeight, setPagePointsHeight] = useState<number | null>(null);
  // react-pdf's Document caches onItemClick in a ref on first mount and never
  // refreshes it, so a plain closure here would forever see the value from
  // before any page had loaded.
  const pagePointsHeightRef = useRef<number | null>(null);
  pagePointsHeightRef.current = pagePointsHeight;
  // Every page's height in PDF points, for turning a link destination into a
  // fraction of its page. Filled by loadPageSizes.
  const pagePointsRef = useRef<Record<number, number>>({});
  // Bumped to abandon a size load whose document has gone.
  const loadToken = useRef(0);
  useEffect(
    () => () => {
      loadToken.current += 1;
    },
    [],
  );

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

  // The pane reserves its own scrollbar width on platforms that don't overlay
  // them, so the page width budget has to leave room for it.
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

  /** Width available to a page once the pane's padding and scrollbar are out. */
  const usable = Math.max(280, Math.floor(available - scrollbarWidth - PANE_PADDING));
  const baseWidth = Math.min(MAX_READING_WIDTH, usable);
  const pageWidth = Math.max(140, Math.floor(fitWidth ? usable : baseWidth * scale));
  const shownScale = pageWidth / baseWidth;
  const shownScaleRef = useRef(shownScale);
  shownScaleRef.current = shownScale;
  // Pages are laid out at pageWidth straight away, but only redrawn at
  // renderWidth, which catches up once zooming or resizing has stopped. Until
  // then the bitmap already on screen is stretched to fit (see PdfPageView).
  // At the very start it just follows pageWidth, so the first pages are drawn
  // once at the measured width rather than at a guess followed by a redraw.
  const [settledWidth, setSettledWidth] = useState<number | null>(null);
  // When the wheel last turned. The wait is measured from here rather than just
  // from the last width change: on a busy machine the next zoom step can be
  // late, and a timer that only looked at the last step would take that gap for
  // "zooming has stopped" and start a redraw in the middle of it.
  const lastWheelAt = useRef(0);
  useEffect(() => {
    let timer: number | undefined;
    const wait = (ms: number) => {
      timer = window.setTimeout(() => {
        const idle = performance.now() - lastWheelAt.current;
        if (idle < RENDER_DEBOUNCE_MS) wait(RENDER_DEBOUNCE_MS - idle);
        else setSettledWidth(pageWidth);
      }, ms);
    };
    wait(RENDER_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [pageWidth]);
  const renderWidth = settledWidth ?? pageWidth;
  const renderScale = renderWidth / baseWidth;
  // Keep a roughly constant rasterized pixel budget regardless of zoom:
  // the width already grows with zoom, so a flat devicePixelRatio on top of it
  // compounds into several times the pixel area for the same page.
  const renderDpr = Math.min(4, Math.max(1, Math.max(window.devicePixelRatio || 1, 2) / renderScale));

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

  const scrollToPage = useCallback(
    (n: number, fraction = 0, center = false, behavior: ScrollBehavior = "smooth") => {
      const el = pageRefs.current[n];
      const container = scrollRef.current;
      if (!el || !container) return;
      // Mount the target and its neighbours. Every page's box is sized by the
      // reader, not by what is inside it, so mounting changes no position and
      // the target can be measured right now.
      setVisiblePages((prev) => {
        const next = new Set(prev);
        next.add(n - 1);
        next.add(n);
        next.add(n + 1);
        return next;
      });
      const targetY = el.offsetTop - container.offsetTop + fraction * el.offsetHeight;
      const top = center ? targetY - container.clientHeight / 2 : targetY - 8;
      container.scrollTo({ top, behavior });
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

  const storageKeyRef = useRef(storageKey);
  storageKeyRef.current = storageKey;
  const saveTimer = useRef<number | undefined>(undefined);
  /**
   * Where the viewport sits as a fraction of the scrollable content. Page
   * heights scale with zoom, so restoring the same fractions after a zoom or
   * resize keeps the reader on the passage they were reading instead of
   * leaving scrollTop at a pixel offset that now means somewhere else.
   */
  const anchorRef = useRef({ y: 0, x: 0.5 });
  /**
   * The page, and how far down it, at a third of the way down the pane. Page
   * sizes can still change after a position is set (a size arriving late), and
   * pinning the view to "this part of this page" rather than to a pixel offset
   * keeps the reader on the same text when that happens.
   */
  const viewAnchorRef = useRef<{ page: number; fraction: number } | null>(null);

  /** Tracks which page is mostly in view so the toolbar counter stays right. */
  const onScroll = useCallback(() => {
    const container = scrollRef.current;
    if (!container) return;
    anchorRef.current = {
      y: container.scrollTop / Math.max(1, container.scrollHeight),
      x: (container.scrollLeft + container.clientWidth / 2) / Math.max(1, container.scrollWidth),
    };
    const mid = container.scrollTop + container.clientHeight / 3;
    let current = 1;
    for (const [key, el] of Object.entries(pageRefs.current)) {
      if (!el) continue;
      if (el.offsetTop - container.offsetTop <= mid) current = Number(key);
    }
    setPage(current);
    const currentHost = pageRefs.current[current];
    if (currentHost) {
      viewAnchorRef.current = {
        page: current,
        fraction: (mid - (currentHost.offsetTop - container.offsetTop)) / Math.max(1, currentHost.offsetHeight),
      };
    }

    if (!storageKeyRef.current) return;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      const key = storageKeyRef.current;
      const host = pageRefs.current[current];
      const pane = scrollRef.current;
      if (!key || !host || !pane) return;
      const fraction = (pane.scrollTop - (host.offsetTop - pane.offsetTop)) / Math.max(1, host.offsetHeight);
      try {
        localStorage.setItem(
          key,
          JSON.stringify({ page: current, fraction: Math.min(1, Math.max(0, fraction)) }),
        );
      } catch {
        /* storage unavailable: losing the position is fine */
      }
    }, 400);
  }, []);

  useEffect(() => () => window.clearTimeout(saveTimer.current), []);

  /**
   * A spot on a page that should stay put under a given point of the pane
   * through a zoom: which page, how far across and down it (as fractions, so
   * they hold at any scale), and where in the pane it was.
   */
  const zoomAnchorRef = useRef<{
    page: number;
    fx: number;
    fy: number;
    cx: number;
    cy: number;
  } | null>(null);
  // Bumped by every zoom so the layout effect below runs for it even if the
  // page width ends up unchanged (a zoom clamped at its limit), and so an
  // anchor is always used by the commit of the zoom that captured it.
  const [zoomTick, setZoomTick] = useState(0);
  const pageWidthRef = useRef(pageWidth);
  pageWidthRef.current = pageWidth;

  /**
   * Remembers the part of the document at a screen point — the mouse for a
   * wheel zoom, the middle of the pane for buttons and keys — so the layout
   * effect below can put that same part back under that point after the zoom.
   */
  const captureZoomAnchor = useCallback((clientX?: number, clientY?: number) => {
    const pane = scrollRef.current;
    if (!pane) return;
    const box = pane.getBoundingClientRect();
    const x = clientX ?? box.left + box.width / 2;
    const y = clientY ?? box.top + box.height / 2;
    // The page under the point; between pages, the one being read.
    const under = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-page]");
    const n = under ? Number(under.dataset.page) : pageRef.current;
    const host = pageRefs.current[n];
    if (!host) return;
    const h = host.getBoundingClientRect();
    if (h.width === 0 || h.height === 0) return;
    zoomAnchorRef.current = {
      page: n,
      fx: (x - h.left) / h.width,
      fy: (y - h.top) / h.height,
      cx: x - box.left,
      cy: y - box.top,
    };
  }, []);

  // A page narrower than the pane sits in the middle with nowhere to scroll
  // to, so a zoom could only ever grow it around its centre and the mouse
  // would be left behind. While zooming with the wheel the pane therefore
  // gets extra room at both sides, which is handed back once the zooming
  // stops. Content is `slack` px further from each edge in the meantime.
  const [slack, setSlack] = useState(0);
  const slackRef = useRef(0);
  const slackTimer = useRef<number | undefined>(undefined);
  const glideRef = useRef(0);
  // Where the page's left edge was in the pane when slack was being dropped.
  const slackFixRef = useRef<number | null>(null);

  const releaseSlack = useCallback(() => {
    const pane = scrollRef.current;
    const room = slackRef.current;
    if (!pane || room === 0) return;
    const drop = () => {
      // Dropping the slack moves the page; note where it is, and the layout
      // effect on `slack` puts it back.
      const host = pageRefs.current[pageRef.current];
      slackFixRef.current = host
        ? host.getBoundingClientRect().left - pane.getBoundingClientRect().left
        : null;
      slackRef.current = 0;
      setSlack(0);
    };
    // Without the slack the page can only sit in one of the places it could
    // sit with no extra room: centred if it is narrower than the pane, else
    // anywhere that keeps it covering the pane. If it isn't in such a place
    // now, glide it to the nearest one first so letting go of the wheel
    // doesn't make it jump.
    const host = pageRefs.current[pageRef.current];
    const width = pageWidthRef.current;
    const viewport = pane.clientWidth;
    if (!host) {
      drop();
      return;
    }
    const left = host.getBoundingClientRect().left - pane.getBoundingClientRect().left;
    const edge = PANE_PADDING / 2;
    const target =
      width + PANE_PADDING <= viewport
        ? (viewport - width) / 2
        : Math.min(edge, Math.max(viewport - width - edge, left));
    if (Math.abs(target - left) < 1) {
      drop();
      return;
    }
    // Scrolling right moves the page left, hence the sign.
    const from = pane.scrollLeft;
    const to = Math.max(0, Math.min(from + (left - target), pane.scrollWidth - pane.clientWidth));
    const start = performance.now();
    const step = (now: number) => {
      const k = Math.min(1, (now - start) / 200);
      pane.scrollLeft = from + (to - from) * (1 - (1 - k) ** 3);
      if (k < 1) glideRef.current = requestAnimationFrame(step);
      else drop();
    };
    glideRef.current = requestAnimationFrame(step);
  }, []);

  /**
   * Every zoom goes through here. With a `pointer` (a wheel zoom) the part of
   * the page under the mouse stays under it; without one, the middle of the
   * pane stays put.
   */
  const applyZoom = useCallback(
    (change: () => void, pointer?: { x: number; y: number }) => {
      const pane = scrollRef.current;
      window.cancelAnimationFrame(glideRef.current);
      window.clearTimeout(slackTimer.current);
      captureZoomAnchor(pointer?.x, pointer?.y);
      if (pointer && pane && slackRef.current === 0) {
        slackRef.current = pane.clientWidth;
        setSlack(pane.clientWidth);
      }
      change();
      setZoomTick((t) => t + 1);
      if (slackRef.current > 0) slackTimer.current = window.setTimeout(releaseSlack, 500);
    },
    [captureZoomAnchor, releaseSlack],
  );

  useEffect(
    () => () => {
      window.clearTimeout(slackTimer.current);
      window.cancelAnimationFrame(glideRef.current);
    },
    [],
  );

  // Zoom and resize change every page's size. After a zoom, scroll so the
  // captured spot is back under the pointer; after a plain resize, put the
  // viewport back on the same part of the document.
  useLayoutEffect(() => {
    const pane = scrollRef.current;
    if (!pane) return;
    const anchor = zoomAnchorRef.current;
    zoomAnchorRef.current = null;
    const host = anchor ? pageRefs.current[anchor.page] : null;
    if (anchor && host) {
      const box = pane.getBoundingClientRect();
      const h = host.getBoundingClientRect();
      pane.scrollLeft += h.left + anchor.fx * h.width - box.left - anchor.cx;
      pane.scrollTop += h.top + anchor.fy * h.height - box.top - anchor.cy;
      return;
    }
    if (anchorRef.current.y <= 0) return;
    pane.scrollTop = anchorRef.current.y * pane.scrollHeight;
    pane.scrollLeft = anchorRef.current.x * pane.scrollWidth - pane.clientWidth / 2;
  }, [pageWidth, zoomTick]);

  // When the slack is dropped, keep the page where the reader last saw it.
  useLayoutEffect(() => {
    const pane = scrollRef.current;
    const left = slackFixRef.current;
    slackFixRef.current = null;
    if (!pane || left === null) return;
    const host = pageRefs.current[pageRef.current];
    if (!host) return;
    pane.scrollLeft += host.getBoundingClientRect().left - pane.getBoundingClientRect().left - left;
  }, [slack]);

  // A page size arriving late (see loadPageSizes) moves everything below it;
  // pin the view to the same part of the same page.
  useLayoutEffect(() => {
    const pane = scrollRef.current;
    const anchor = viewAnchorRef.current;
    const host = anchor ? pageRefs.current[anchor.page] : null;
    if (!pane || !anchor || !host) return;
    const top =
      host.offsetTop - pane.offsetTop + anchor.fraction * host.offsetHeight - pane.clientHeight / 3;
    if (Math.abs(pane.scrollTop - top) >= 1) pane.scrollTop = top;
  }, [pageAspect, pageAspects]);

  // Reopen where the reader left off.
  const restoredRef = useRef(false);
  useEffect(() => {
    if (!storageKey || numPages === 0 || restoredRef.current) return;
    restoredRef.current = true;
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? "null") as {
        page?: number;
        fraction?: number;
      } | null;
      if (saved?.page && (saved.page > 1 || (saved.fraction ?? 0) > 0.02)) {
        scrollToPage(Math.min(saved.page, numPages), saved.fraction ?? 0, false, "auto");
      }
    } catch {
      /* unreadable saved position: start at the top */
    }
  }, [numPages, scrollToPage, storageKey]);

  const zoomStep = useCallback(
    (dir: 1 | -1) => {
      const next = clampScale(nextZoomStop(shownScaleRef.current, dir));
      applyZoom(() => {
        shownScaleRef.current = next;
        setFitWidth(false);
        setScale(next);
      });
    },
    [applyZoom],
  );

  // Ctrl/Cmd + wheel, and trackpad pinch (which browsers report the same way),
  // zoom the document towards the mouse rather than the whole browser page.
  // Applied in short batches because each zoom re-rasterizes the visible pages.
  useEffect(() => {
    const pane = scrollRef.current;
    if (!pane) return;
    let pending = 1;
    let timer: number | undefined;
    let pointer = { x: 0, y: 0 };
    const flush = () => {
      timer = undefined;
      const next = clampScale(shownScaleRef.current * pending);
      pending = 1;
      applyZoom(() => {
        shownScaleRef.current = next;
        setFitWidth(false);
        setScale(next);
      }, pointer);
    };
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      lastWheelAt.current = performance.now();
      // The mouse as it is when the batch is applied, not when it began.
      pointer = { x: e.clientX, y: e.clientY };
      pending *= Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.005));
      timer ??= window.setTimeout(flush, 70);
    };
    pane.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      pane.removeEventListener("wheel", onWheel);
      window.clearTimeout(timer);
    };
  }, [applyZoom]);

  // + / - / 0 to zoom, unless the person is typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === "+" || e.key === "=") zoomStep(1);
      else if (e.key === "-") zoomStep(-1);
      else if (e.key === "0")
        applyZoom(() => {
          shownScaleRef.current = 1;
          setFitWidth(false);
          setScale(1);
        });
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [applyZoom, zoomStep]);

  /**
   * Reads every page's size as soon as the document opens: the first page
   * before anything is drawn, the rest in the background.
   *
   * A page's height sets where every page below it sits, so with sizes known
   * only as pages happened to load, jumping to somewhere unvisited aimed at an
   * estimate and then lurched when the real sizes arrived. Knowing them up
   * front makes a jump land once. Sizes that still arrive late shift nothing
   * the reader can see (see the layout effect on `pageAspects`).
   */
  const loadPageSizes = useCallback(async (pdf: PdfDocumentLike) => {
    loadToken.current += 1;
    const token = loadToken.current;
    const stale = () => token !== loadToken.current;
    const sizeOf = async (n: number) => {
      const v = (await pdf.getPage(n)).getViewport({ scale: 1 });
      return { w: v.width, h: v.height };
    };

    let baseAspect: number | null = null;
    try {
      const first = await sizeOf(1);
      if (stale()) return;
      baseAspect = first.w / first.h;
      pagePointsRef.current = { 1: first.h };
      setPageAspect(baseAspect);
      setPagePointsHeight(first.h);
    } catch {
      // No size for page 1: sizes will be learned as pages load instead.
    }
    setNumPages(pdf.numPages);
    if (baseAspect === null) return;

    for (let from = 2; from <= pdf.numPages; from += 8) {
      const numbers = Array.from({ length: Math.min(8, pdf.numPages - from + 1) }, (_, i) => from + i);
      const sizes = await Promise.all(
        numbers.map((n) => sizeOf(n).then((s) => ({ n, ...s }), () => null)),
      );
      if (stale()) return;
      const differing: Record<number, number> = {};
      for (const size of sizes) {
        if (!size) continue;
        pagePointsRef.current[size.n] = size.h;
        const aspect = size.w / size.h;
        // Only a page unlike the first needs a height of its own.
        if (Math.abs(aspect - baseAspect) >= 0.002) differing[size.n] = aspect;
      }
      if (Object.keys(differing).length > 0) setPageAspects((prev) => ({ ...prev, ...differing }));
    }
  }, []);

  const handlePageLoadSuccess = useCallback((p: PageLoadInfo) => {
    const aspect = p.width / p.height;
    setPageAspect((prev) => prev ?? aspect);
    setPagePointsHeight((prev) => prev ?? p.originalHeight);
    // Only a page unlike the first needs a height of its own.
    setPageAspects((prev) => {
      if (Math.abs(aspect - (pageAspectRef.current ?? aspect)) < 0.002) return prev;
      const known = prev[p.pageNumber];
      return known !== undefined && Math.abs(known - aspect) < 0.002
        ? prev
        : { ...prev, [p.pageNumber]: aspect };
    });
  }, []);

  /** Places a popup under the last line of `rects` on page `n`, or above it near the pane's foot. */
  const anchorFor = useCallback((n: number, rects: Rect[]): Anchor | null => {
    const host = pageRefs.current[n];
    const pane = scrollRef.current;
    const last = rects[rects.length - 1];
    if (!host || !pane || !last) return null;
    const hostBox = host.getBoundingClientRect();
    const paneBox = pane.getBoundingClientRect();
    const lineTop = hostBox.top + last.y * hostBox.height;
    const lineBottom = hostBox.top + (last.y + last.h) * hostBox.height;
    const roomBelow = paneBox.bottom - lineBottom;
    const roomAbove = lineTop - paneBox.top;
    return {
      page: n,
      x: last.x,
      yTop: last.y,
      yBottom: last.y + last.h,
      above: roomBelow < MENU_ROOM && roomAbove > roomBelow,
    };
  }, []);

  /** Saves highlights at once, with no popup. The selection goes first so nothing re-captures it. */
  const saveHighlight = useCallback(
    async (groups: PageSelection[], color: AnnotationColor) => {
      window.getSelection()?.removeAllRanges();
      try {
        await onCreate({ groups, color, comment: null });
        setDefaultColor(color);
      } catch {
        toast.error("Couldn't save that highlight.");
      }
    },
    [onCreate],
  );

  /** Opens the highlight popup under the last line of a selection. */
  const openPopup = useCallback(
    (groups: PageSelection[], note: boolean) => {
      const last = groups[groups.length - 1];
      if (!last) return;
      const anchor = anchorFor(last.page, last.rects);
      if (!anchor) return;
      setFocused(null);
      setPending({ groups, anchor, quote: groups.map((g) => g.quote).join(" "), note });
    },
    [anchorFor],
  );

  // A finished selection does whatever the toolbar's tool says: highlight it
  // outright, open the note field, or (no tool) offer the popup. A new press or
  // Escape closes the popup. See useTextSelection for what "finished" means.
  const handleSelect = useCallback(
    (groups: PageSelection[]) => {
      if (tool === "highlight") void saveHighlight(groups, defaultColor);
      else openPopup(groups, tool === "note");
    },
    [defaultColor, openPopup, saveHighlight, tool],
  );
  const { readSelection } = useTextSelection({
    paneRef: scrollRef,
    pageRefs,
    onSelect: handleSelect,
    onDismiss: dismiss,
    instant: tool === "highlight",
  });

  const defaultColorRef = useRef(defaultColor);
  defaultColorRef.current = defaultColor;

  /** A toolbar colour: applies to selected text if there is any, otherwise arms (or disarms) the highlighter. */
  const pickColor = useCallback(
    (color: AnnotationColor) => {
      const selected = readSelection();
      if (selected.length > 0) {
        void saveHighlight(selected, color);
        return;
      }
      setDefaultColor(color);
      setTool((t) => (t === "highlight" && defaultColorRef.current === color ? null : "highlight"));
    },
    [readSelection, saveHighlight],
  );

  const toggleNote = useCallback(() => {
    const selected = readSelection();
    if (selected.length > 0) {
      openPopup(selected, true);
      return;
    }
    setTool((t) => (t === "note" ? null : "note"));
  }, [openPopup, readSelection]);

  // 1-5 pick a colour, N arms the note tool, Escape closes a popup and then
  // the tool. (The popup half of Escape is handled in useTextSelection.)
  const popupOpenRef = useRef(false);
  popupOpenRef.current = pending !== null || focused !== null;
  const shortcutsRef = useRef({ pickColor, toggleNote });
  shortcutsRef.current = { pickColor, toggleNote };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
      const index = Number(e.key) - 1;
      const color = Number.isInteger(index) ? ANNOTATION_COLORS[index] : undefined;
      if (color) shortcutsRef.current.pickColor(color);
      else if (e.key === "n" || e.key === "N") shortcutsRef.current.toggleNote();
      else if (e.key === "Escape" && !popupOpenRef.current) setTool(null);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Left/Right and PageUp/PageDown turn pages; everything else is left to the
  // browser, so arrow keys scroll the pane and Shift+Arrow selects as usual.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) return;
      if (e.key === "ArrowRight" || e.key === "PageDown") {
        e.preventDefault();
        stepPage(1);
      } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
        e.preventDefault();
        stepPage(-1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stepPage]);

  // Focus the pane once there is a document, so arrow keys scroll it straight away.
  const loaded = numPages > 0;
  useEffect(() => {
    if (loaded) scrollRef.current?.focus({ preventScroll: true });
  }, [loaded]);

  /** The highlight under a pointer, newest first so the latest of two overlapping ones wins. */
  const hitAnnotation = useCallback(
    (e: { clientX: number; clientY: number }, n: number): Annotation | null => {
      const host = pageRefs.current[n];
      const onPage = annotationsByPage.get(n);
      if (!host || !onPage) return null;
      const box = host.getBoundingClientRect();
      const px = (e.clientX - box.left) / box.width;
      const py = (e.clientY - box.top) / box.height;
      for (let i = onPage.length - 1; i >= 0; i--) {
        const a = onPage[i]!;
        if (rectsContain(a.rects, px, py)) return a;
      }
      return null;
    },
    [annotationsByPage],
  );

  const handlePageClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>, n: number) => {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) return; // this click ended a drag-selection
      const hit = hitAnnotation(e, n);
      if (!hit) {
        onSelectAnnotation?.(null);
        return;
      }
      const anchor = anchorFor(n, hit.rects);
      if (!anchor) return;
      setPending(null);
      onSelectAnnotation?.(hit.id);
      setFocused({ id: hit.id, anchor });
    },
    [anchorFor, hitAnnotation, onSelectAnnotation],
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
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-card px-3">
          <div className="flex min-w-0 flex-1 items-center">{header}</div>
          <div className="flex items-center gap-1">{actions}</div>
        </div>
        <p className="border-b border-border bg-card px-3 py-2 text-sm text-muted-foreground">
          This PDF could not be loaded for in-page highlighting (the host blocks it). It is shown
          below as a plain document.
        </p>
        <iframe title="PDF" src={url} className="min-h-0 w-full flex-1 border-0 bg-white" />
      </div>
    );
  }

  const focusedAnnotation = focused ? annotationById.get(focused.id) : undefined;
  /**
   * A page's height at the current zoom, from its shape rather than from its
   * canvas. The canvas only takes its new size a moment after a zoom, so a box
   * sized by it would still be measuring the old zoom when the scroll position
   * is corrected, and the document would lurch instead of zooming towards the
   * pointer. Sized here, every page changes in the same frame.
   */
  const pageHeightFor = (n: number) => {
    const aspect = pageAspects[n] ?? pageAspect;
    return aspect ? pageWidth / aspect : pageWidth * 1.3;
  };

  return (
    <div ref={outerRef} className="flex h-full min-h-0 w-full flex-col bg-background">
      <ReaderToolbar
        page={page}
        numPages={numPages}
        scale={shownScale}
        fitWidth={fitWidth}
        onGoToPage={(n) => scrollToPage(n)}
        onStepPage={stepPage}
        onSetScale={(next) =>
          applyZoom(() => {
            const clamped = clampScale(next);
            shownScaleRef.current = clamped;
            setFitWidth(false);
            setScale(clamped);
          })
        }
        onFitWidth={() => applyZoom(() => setFitWidth((v) => !v))}
        header={header}
        tools={
          <HighlightTools
            tool={tool}
            color={defaultColor}
            onPickColor={pickColor}
            onToggleNote={toggleNote}
          />
        }
        actions={actions}
      />

      <div
        ref={scrollRef}
        onScroll={onScroll}
        tabIndex={0}
        data-tool={tool ?? undefined}
        className="pdf-scroll-pane min-h-0 flex-1 overscroll-contain overflow-auto bg-muted outline-none"
        // Pages mount and unmount as they scroll in and out of range, and the
        // browser's scroll anchoring reacts by silently adjusting scrollTop,
        // which fights deliberate scrolls. Placeholders already hold each
        // page's exact height, so there is nothing to anchor against.
        style={
          {
            overflowAnchor: "none",
            // While zooming the pane has spare room at the sides (see `slack`);
            // hidden stays scrollable from code but shows no scrollbar flicker.
            overflowX: slack > 0 ? "hidden" : undefined,
            // While a colour is armed, the drag selection previews that colour.
            "--selection-colour": tool ? HIGHLIGHT_HEX[defaultColor] : undefined,
            "--tool-cursor": toolCursorValue,
          } as CSSProperties
        }
      >
        <Document
          file={src}
          options={documentOptions}
          // Links out of a paper open in a new tab: following one in place
          // would replace the reader, losing the page, zoom and scroll
          // position with no way back but the browser's own history.
          externalLinkTarget="_blank"
          externalLinkRel="noopener noreferrer"
          onLoadSuccess={(pdf) => void loadPageSizes(pdf)}
          onLoadError={() => setFailed(true)}
          onItemClick={({ dest, pageNumber }) => {
            dismiss();
            // A link is a jump, not a scroll: a smooth animation across several
            // pages is slow and, mid-flight, shows pages that are still loading.
            scrollToPage(
              pageNumber,
              destTopFraction(dest, pagePointsRef.current[pageNumber] ?? pagePointsHeightRef.current),
              true,
              "instant",
            );
          }}
          loading={
            <div className="flex items-center gap-2 p-8 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading PDF…
            </div>
          }
          error={<p className="p-8 text-sm text-muted-foreground">Could not load this PDF.</p>}
        >
          {/* w-fit + min-w-full: when a zoomed page is wider than the pane the
              column grows with it, so the page stays fully scrollable. A
              plain centred column overflows equally on both sides and the
              left edge becomes unreachable. */}
          <div
            className="flex w-fit min-w-full flex-col items-center gap-3 py-4"
            style={{ paddingLeft: PANE_PADDING / 2 + slack, paddingRight: PANE_PADDING / 2 + slack }}
          >
            {Array.from({ length: numPages }, (_, i) => i + 1).map((n) => (
              <div
                key={n}
                data-page={n}
                ref={(el) => {
                  pageRefs.current[n] = el;
                  if (el) observerRef.current?.observe(el);
                }}
                className="pdf-page relative shrink-0 bg-white shadow-[0_1px_3px_rgba(0,0,0,0.2),0_6px_20px_rgba(0,0,0,0.12)]"
                style={{ width: pageWidth, height: pageHeightFor(n) }}
                onClick={(e) => handlePageClick(e, n)}
                onMouseMove={(e) => {
                  const sel = window.getSelection();
                  if (sel && !sel.isCollapsed) return;
                  // Toggled on the element directly: a hover shouldn't re-render the reader.
                  e.currentTarget.classList.toggle("is-over-highlight", !tool && hitAnnotation(e, n) !== null);
                }}
                onMouseLeave={(e) => e.currentTarget.classList.remove("is-over-highlight")}
              >
                <PdfPageView
                  pageNumber={n}
                  isVisible={visiblePages.has(n)}
                  pageWidth={pageWidth}
                  renderWidth={renderWidth}
                  placeholderHeight={pageHeightFor(n)}
                  renderDpr={renderDpr}
                  onLoadSuccess={handlePageLoadSuccess}
                  annotations={annotationsByPage.get(n) ?? NO_ANNOTATIONS}
                  activeId={activeId}
                />

                {pending && pending.anchor.page === n && (
                  <div
                    data-highlight-menu=""
                    className="absolute z-20"
                    style={menuStyle(pending.anchor)}
                    onMouseDown={keepSelection}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <NewHighlightMenu
                      quote={pending.quote}
                      defaultColor={defaultColor}
                      busy={busy}
                      startNoting={pending.note}
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
                    data-highlight-menu=""
                    className="absolute z-20"
                    style={menuStyle(focused.anchor)}
                    onMouseDown={keepSelection}
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
  );
}

export default PdfReader;