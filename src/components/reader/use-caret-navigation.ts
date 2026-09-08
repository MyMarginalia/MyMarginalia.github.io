import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import { buildPageLines, positionInLine, type PageLines } from "@/lib/pdf/text-geometry";
import {
  buildLineCursors,
  cursorForSelection,
  nearestCursor,
  type LineCursors,
} from "@/lib/pdf/line-cursors";

export type Caret = { page: number; top: number; left: number; height: number };

type Params = {
  pageRefs: RefObject<Record<number, HTMLDivElement | null>>;
  scrollRef: RefObject<HTMLDivElement | null>;
  numPages: number;
  pageWidth: number;
  setVisiblePages: Dispatch<SetStateAction<Set<number>>>;
  /** Arrow keys with no caret placed page through the document instead. */
  onPageStep: (delta: number) => void;
  onEscape: () => void;
};

/**
 * Text-cursor navigation over a pdf.js text layer.
 *
 * Plain selectable text never gets a real blinking caret from the browser, and
 * browsers don't move a selection with the arrow keys outside editable
 * content, so both are driven explicitly here: a fake caret for feedback, and
 * Selection API calls for movement.
 */
export function useCaretNavigation({
  pageRefs,
  scrollRef,
  numPages,
  pageWidth,
  setVisiblePages,
  onPageStep,
  onEscape,
}: Params) {
  const [caret, setCaret] = useState<Caret | null>(null);
  const caretRef = useRef<Caret | null>(null);
  caretRef.current = caret;

  /** Whether arrow keys should drive the caret rather than page through. */
  const caretModeRef = useRef(false);
  /**
   * Sticky column for up/down movement, page-relative: moving down through a
   * short line and back up should return to the original column, as in any
   * text editor. Cleared by clicking or by horizontal movement.
   */
  const preferredXRef = useRef<number | null>(null);
  /** Pending cross-page move — the next page's text layer renders async. */
  const crossPageRaf = useRef<number | null>(null);
  /** Only keyboard-driven moves scroll the view. */
  const followRef = useRef(false);
  const lineCacheRef = useRef(new Map<number, PageLines>());
  /**
   * Cursor positions per line, keyed page:line:width. Building them measures
   * every character and reads the page's pixels once, so each line is done
   * once and reused until the page re-renders at another width.
   */
  const cursorCacheRef = useRef(new Map<string, LineCursors | null>());
  // The selectionchange listener is installed once; these let it reach the
  // current helpers without tearing it down and rebuilding it.
  const lineCursorsRef = useRef<((page: number, line: number) => LineCursors | null) | null>(null);
  const pageLinesRef = useRef<((page: number) => PageLines | null) | null>(null);

  useEffect(() => {
    lineCacheRef.current.clear();
    cursorCacheRef.current.clear();
  }, [pageWidth]);

  /**
   * Scrolls the minimum amount needed to bring a viewport point into the pane.
   * Instant rather than smooth: with a held-down arrow key these arrive faster
   * than an animation can finish, and successive relative scrolls would
   * compose against a still-moving position and overshoot.
   */
  const revealInView = useCallback(
    (top: number, bottom: number, left: number) => {
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
    },
    [scrollRef],
  );

  const clearCaret = useCallback(() => {
    setCaret(null);
    caretModeRef.current = false;
    preferredXRef.current = null;
    if (crossPageRaf.current !== null) {
      cancelAnimationFrame(crossPageRaf.current);
      crossPageRaf.current = null;
    }
  }, []);

  /** Cached line geometry for a page, rebuilt only when actually stale. */
  const getPageLines = useCallback(
    (pageNumber: number): PageLines | null => {
      const host = pageRefs.current[pageNumber];
      if (!host) return null;
      const spanCount = host.querySelectorAll(".textLayer span").length;
      if (spanCount === 0) return null; // text layer hasn't rendered yet
      const cached = lineCacheRef.current.get(pageNumber);
      if (
        cached &&
        cached.width === pageWidth &&
        cached.spanCount === spanCount &&
        // A virtualized page that unmounted and came back has the same span
        // count but entirely new elements; the cached ones are detached.
        cached.lines[0]?.spans[0]?.el.isConnected
      ) {
        return cached;
      }
      const built = buildPageLines(host, pageWidth);
      if (built.lines.length === 0) return null;
      lineCacheRef.current.set(pageNumber, built);
      return built;
    },
    [pageRefs, pageWidth],
  );

  /** Cursor positions for one line, built once and cached. */
  const getLineCursors = useCallback(
    (pageNumber: number, lineIndex: number): LineCursors | null => {
      const host = pageRefs.current[pageNumber];
      const page = getPageLines(pageNumber);
      const line = page?.lines[lineIndex];
      if (!host || !line) return null;
      const key = `${pageNumber}:${lineIndex}:${pageWidth}`;
      if (cursorCacheRef.current.has(key)) return cursorCacheRef.current.get(key) ?? null;
      const built = buildLineCursors(host, line);
      cursorCacheRef.current.set(key, built);
      return built;
    },
    [getPageLines, pageRefs, pageWidth],
  );

  /** Which line of a page a DOM node belongs to, or -1. */
  const lineOfNode = useCallback(
    (pageNumber: number, node: Node): number => {
      const page = getPageLines(pageNumber);
      if (!page) return -1;
      const element =
        node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
      const span = element?.closest("span") as HTMLElement | null;
      return span ? (page.bySpan.get(span) ?? -1) : -1;
    },
    [getPageLines],
  );

  /**
   * Places the cursor for a click.
   *
   * The browser decides which line the click belongs to — it handles columns
   * and wrapping correctly — and the cursor then goes to the nearest position
   * on that line, chosen from the line's own character boundaries rather than
   * from where the substitute font in the text layer thinks characters are.
   * The DOM selection is moved to the very same boundary, so what is drawn and
   * what a following Shift+Arrow extends from cannot disagree.
   */
  const placeCaretFromClick = useCallback(
    (pageNumber: number, clientX: number) => {
      const host = pageRefs.current[pageNumber];
      const sel = window.getSelection();
      if (!host || !sel || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      if (rect.height <= 0) return;
      const box = host.getBoundingClientRect();

      const lineIndex = lineOfNode(pageNumber, range.startContainer);
      const cursors = lineIndex >= 0 ? getLineCursors(pageNumber, lineIndex) : null;
      caretModeRef.current = true;
      preferredXRef.current = null;

      if (!cursors || cursors.xs.length === 0) {
        setCaret({
          page: pageNumber,
          top: rect.top - box.top,
          left: rect.left - box.left,
          height: rect.height,
        });
        return;
      }

      const index = nearestCursor(cursors, clientX - box.left);
      setCaret({
        page: pageNumber,
        top: rect.top - box.top,
        left: cursors.xs[index]!,
        height: rect.height,
      });
      const collapsed = document.createRange();
      collapsed.setStart(cursors.nodes[index]!, cursors.offsets[index]!);
      collapsed.collapse(true);
      sel.removeAllRanges();
      sel.addRange(collapsed);
    },
    [getLineCursors, lineOfNode, pageRefs],
  );

  lineCursorsRef.current = getLineCursors;
  pageLinesRef.current = getPageLines;


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

  const moveVertically = useCallback(
    (direction: "up" | "down", extend: boolean) => {
      if (crossPageRaf.current !== null) {
        cancelAnimationFrame(crossPageRaf.current);
        crossPageRaf.current = null;
      }
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);

      // Move from the selection's focus — the end that travels — not from the
      // range's start. A range reports endpoints in document order, so while
      // extending downward the start is the fixed anchor; measuring from it
      // recomputed the same origin line every press, so a held Shift+Arrow
      // appeared to stop after one line.
      const fromNode = extend && sel.focusNode ? sel.focusNode : range.startContainer;
      const fromOffset = extend && sel.focusNode ? sel.focusOffset : range.startOffset;

      const entry = Object.entries(pageRefs.current).find(([, el]) => el && el.contains(fromNode));
      const host = entry?.[1];
      if (!host || !entry) return;
      const currentPage = Number(entry[0]);

      const pageLines = getPageLines(currentPage);
      if (!pageLines) return;
      const { lines, bySpan } = pageLines;
      const hostBox = host.getBoundingClientRect();

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
      if (hasRect && preferredXRef.current === null) {
        preferredXRef.current = rect.left - hostBox.left;
      }

      // Two columns run at the same heights for most of a page, so finding the
      // current line by y alone is ambiguous — it can match the other column
      // just as well, which made the caret ping-pong between them. The span
      // the selection actually sits in is exact and column-safe.
      const startEl =
        fromNode.nodeType === Node.ELEMENT_NODE ? (fromNode as Element) : fromNode.parentElement;
      const spanEl = startEl?.closest("span") as HTMLElement | null;
      let currentIndex = spanEl ? (bySpan.get(spanEl) ?? -1) : -1;
      if (currentIndex === -1) {
        const caretNow = caretRef.current;
        let y: number | null = hasRect ? rect.top + rect.height / 2 - hostBox.top : null;
        if (y === null && caretNow && caretNow.page === currentPage) {
          y = caretNow.top + caretNow.height / 2;
        }
        if (y === null) return;
        let bestDist = Infinity;
        const target = y;
        lines.forEach((l, i) => {
          const d = Math.abs((l.top + l.bottom) / 2 - target);
          if (d < bestDist) {
            bestDist = d;
            currentIndex = i;
          }
        });
      }

      const x = preferredXRef.current ?? lines[currentIndex]!.left;
      const targetIndex = direction === "down" ? currentIndex + 1 : currentIndex - 1;

      if (targetIndex >= 0 && targetIndex < lines.length) {
        const pos = positionInLine(lines[targetIndex]!, x, hostBox.left);
        if (pos) applySelection(pos.node, pos.offset, extend);
        return;
      }

      // Past this page's first/last line — carry on onto the adjacent page
      // rather than stopping dead. It may still be a virtualized placeholder,
      // and its text layer renders asynchronously even once mounted.
      const nextPage = direction === "down" ? currentPage + 1 : currentPage - 1;
      if (nextPage < 1 || nextPage > numPages) return;
      setVisiblePages((prev) => (prev.has(nextPage) ? prev : new Set(prev).add(nextPage)));

      let tries = 0;
      const attempt = () => {
        crossPageRaf.current = null;
        const nextHost = pageRefs.current[nextPage];
        const next = nextHost ? getPageLines(nextPage) : null;
        if (!next || !nextHost) {
          if (tries++ < 180) crossPageRaf.current = requestAnimationFrame(attempt);
          return;
        }
        const line = direction === "down" ? next.lines[0]! : next.lines[next.lines.length - 1]!;
        const pos = positionInLine(line, x, nextHost.getBoundingClientRect().left);
        if (pos) applySelection(pos.node, pos.offset, extend);
      };
      attempt();
    },
    [applySelection, getPageLines, numPages, pageRefs, setVisiblePages],
  );

  // Keeps the fake caret in sync with wherever the real selection ends up.
  useEffect(() => {
    function onSelectionChange() {
      if (!caretModeRef.current) return;
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) {
        setCaret(null);
        return;
      }
      if (!sel.isCollapsed) {
        // Shift+Arrow turned it into a real selection: the highlight itself is
        // the indicator now. Caret mode stays on, since a later plain Arrow
        // can collapse it back down and the caret should reappear.
        setCaret(null);
        // With no caret the effect below can't run, so extension has to keep
        // its own moving end in view — otherwise Shift+Arrow selects straight
        // off the bottom of the pane while the reader sits still.
        if (followRef.current && sel.focusNode) {
          followRef.current = false;
          const probe = document.createRange();
          try {
            probe.setStart(sel.focusNode, sel.focusOffset);
          } catch {
            return;
          }
          probe.collapse(true);
          let r = probe.getBoundingClientRect();
          if (r.height === 0) r = probe.getClientRects()[0] ?? r;
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
      let r = range.getBoundingClientRect();
      if (r.height === 0) r = range.getClientRects()[0] ?? r;
      if (r.height === 0) return; // nothing usable — keep the last position
      const box = host.getBoundingClientRect();
      const pageNumber = Number(pageKey);

      // Draw at the cursor position this selection *is*, looked up by DOM
      // position rather than re-derived from coordinates. Whatever moved the
      // selection — a click, an arrow key, the browser itself — the drawn
      // cursor and the selection therefore always agree, so nothing can pull
      // one back after the other has moved.
      let left = r.left - box.left;
      const page = pageLinesRef.current?.(pageNumber);
      const element =
        range.startContainer.nodeType === Node.ELEMENT_NODE
          ? (range.startContainer as Element)
          : range.startContainer.parentElement;
      const span = element?.closest("span") as HTMLElement | null;
      const lineIndex = span && page ? (page.bySpan.get(span) ?? -1) : -1;
      if (lineIndex >= 0) {
        const cursors = lineCursorsRef.current?.(pageNumber, lineIndex);
        if (cursors) {
          const index = cursorForSelection(cursors, range.startContainer, range.startOffset);
          if (index >= 0) left = cursors.xs[index]!;
        }
      }

      setCaret({
        page: pageNumber,
        top: r.top - box.top,
        left,
        height: r.height,
      });
    }
    document.addEventListener("selectionchange", onSelectionChange);
    return () => document.removeEventListener("selectionchange", onSelectionChange);
  }, [pageRefs, revealInView]);

  // Keeps a moving caret in view. Strictly keyboard-driven: a caret placed by
  // clicking is already where the user is looking, and chasing it there fights
  // deliberate scrolls — clicking an internal link both places a caret and
  // jumps to the link's target, and following would undo the jump.
  useEffect(() => {
    if (!caret || !followRef.current) return;
    followRef.current = false;
    const host = pageRefs.current[caret.page];
    if (!host) return;
    const box = host.getBoundingClientRect();
    revealInView(box.top + caret.top, box.top + caret.top + caret.height, box.left + caret.left);
  }, [caret, pageRefs, revealInView]);

  useEffect(() => {
    const ARROWS: Record<string, "left" | "right" | "backward" | "forward"> = {
      ArrowLeft: "left",
      ArrowRight: "right",
      ArrowUp: "backward",
      ArrowDown: "forward",
    };

    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const typing =
        !!target &&
        (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
      if (typing) return;

      if (e.key === "Escape") {
        window.getSelection()?.removeAllRanges();
        clearCaret();
        onEscape();
        return;
      }

      const direction = ARROWS[e.key];
      if (caretModeRef.current && direction && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        followRef.current = true;
        if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          moveVertically(e.key === "ArrowDown" ? "down" : "up", e.shiftKey);
        } else {
          preferredXRef.current = null;
          window.getSelection()?.modify(e.shiftKey ? "extend" : "move", direction, "character");
        }
        return;
      }

      if (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) return;
      if (e.key === "ArrowRight" || e.key === "PageDown") {
        e.preventDefault();
        onPageStep(1);
      } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
        e.preventDefault();
        onPageStep(-1);
      }
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [clearCaret, moveVertically, onEscape, onPageStep]);

  useEffect(
    () => () => {
      if (crossPageRaf.current !== null) cancelAnimationFrame(crossPageRaf.current);
    },
    [],
  );

  return { caret, placeCaretFromClick, clearCaret };
}
