import type { Rect } from "@/lib/paper-types";
import { textSpans } from "@/lib/pdf/text-geometry";

/** One page's worth of a selection, ready to be stored as an annotation. */
export type PageSelection = {
  page: number;
  quote: string;
  /** Page-relative fractions, so they survive zoom and re-render. */
  rects: Rect[];
};

type Box = { left: number; top: number; right: number; bottom: number };

/**
 * Merges rects that sit on the same visual line, but only across small gaps.
 * Wide gaps — the space between two columns, or between widely spaced author
 * names — stay separate so the empty space between them isn't painted.
 */
function mergeLineBoxes(raw: Box[]): Box[] {
  const sorted = [...raw].sort((a, b) => a.top - b.top || a.left - b.left);
  const out: Box[] = [];
  for (const r of sorted) {
    const prev = out[out.length - 1];
    const height = r.bottom - r.top;
    const sameLine =
      prev !== undefined &&
      Math.abs((prev.top + prev.bottom) / 2 - (r.top + r.bottom) / 2) < height * 0.6;
    const gap = prev ? r.left - prev.right : 0;
    if (prev && sameLine && gap < height * 0.6) {
      prev.left = Math.min(prev.left, r.left);
      prev.top = Math.min(prev.top, r.top);
      prev.right = Math.max(prev.right, r.right);
      prev.bottom = Math.max(prev.bottom, r.bottom);
    } else {
      out.push({ ...r });
    }
  }
  return out;
}

/**
 * Drops boxes wholly inside another box. A glyph and its diacritic are two
 * text items in the PDF and can measure to nested rects; the inner one adds
 * nothing to the painted shape, so keeping it only costs DOM nodes.
 */
function dropContained(boxes: Box[]): Box[] {
  return boxes.filter(
    (b, i) =>
      !boxes.some(
        (other, j) =>
          j !== i &&
          other.left <= b.left + 0.5 &&
          other.right >= b.right - 0.5 &&
          other.top <= b.top + 0.5 &&
          other.bottom >= b.bottom - 0.5 &&
          // Keep exactly one of a pair of identical boxes.
          (other.right - other.left) * (other.bottom - other.top) >=
            (b.right - b.left) * (b.bottom - b.top) &&
          !(j > i &&
            other.left === b.left &&
            other.right === b.right &&
            other.top === b.top &&
            other.bottom === b.bottom),
      ),
  );
}

/**
 * Splits a live text selection into one group per page it covers.
 *
 * Rects are measured span by span rather than from the selection's own
 * getClientRects(). pdf.js keeps an invisible `.endOfContent` element inside
 * each text layer that expands to cover the whole page during a drag; letting
 * it into the measurement produced page-sized rectangles, which the old code
 * worked around by rejecting any selection taller than 600px — silently
 * refusing to highlight long passages. Measuring only real text spans removes
 * the artefact at its source, so selections of any length work, and grouping
 * by page means a selection running across a page break is kept whole instead
 * of being clipped to wherever it started.
 */
export function selectionToPageSelections(
  selection: Selection,
  pages: Record<number, HTMLDivElement | null>,
): PageSelection[] {
  if (selection.isCollapsed || selection.rangeCount === 0) return [];
  const range = selection.getRangeAt(0);
  const groups: PageSelection[] = [];

  for (const [key, host] of Object.entries(pages)) {
    if (!host) continue;
    const layer = host.querySelector<HTMLElement>(".textLayer");
    if (!layer) continue;
    let touches = false;
    try {
      touches = range.intersectsNode(layer);
    } catch {
      touches = false;
    }
    if (!touches) continue;

    const hostBox = host.getBoundingClientRect();
    if (hostBox.width === 0 || hostBox.height === 0) continue;

    const boxes: Box[] = [];
    for (const span of textSpans(host)) {
      let inside = false;
      try {
        inside = range.intersectsNode(span);
      } catch {
        inside = false;
      }
      if (!inside) continue;

      const text = span.firstChild as Text;
      const len = text.length;
      const from = span.contains(range.startContainer) ? Math.min(range.startOffset, len) : 0;
      const to = span.contains(range.endContainer) ? Math.min(range.endOffset, len) : len;
      if (to <= from) continue;

      const piece = document.createRange();
      piece.setStart(text, from);
      piece.setEnd(text, to);
      for (const r of piece.getClientRects()) {
        if (r.width <= 0.5 || r.height <= 0.5) continue;
        boxes.push({
          left: r.left - hostBox.left,
          top: r.top - hostBox.top,
          right: r.right - hostBox.left,
          bottom: r.bottom - hostBox.top,
        });
      }
    }
    if (boxes.length === 0) continue;

    // Take the quote from a range clipped to this page so spacing between
    // words matches what the browser itself would copy, rather than
    // concatenating span contents and losing the gaps between them.
    const clipped = range.cloneRange();
    if (!layer.contains(range.startContainer)) clipped.setStart(layer, 0);
    if (!layer.contains(range.endContainer)) clipped.setEnd(layer, layer.childNodes.length);
    const quote = clipped.toString().replace(/\s+/g, " ").trim();

    const rects: Rect[] = dropContained(mergeLineBoxes(boxes)).map((b) => ({
      x: b.left / hostBox.width,
      y: b.top / hostBox.height,
      w: (b.right - b.left) / hostBox.width,
      h: (b.bottom - b.top) / hostBox.height,
    }));

    groups.push({ page: Number(key), quote, rects });
  }

  return groups.sort((a, b) => a.page - b.page);
}

/** Does a page-relative point (0..1) fall inside any of these rects? */
export function rectsContain(rects: Rect[], x: number, y: number): boolean {
  return rects.some((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);
}
