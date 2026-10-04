import type { Rect } from "@/lib/paper-types";

/** One page's worth of a selection, ready to be stored as an annotation. */
export type PageSelection = {
  page: number;
  quote: string;
  /** Page-relative fractions (0..1), so they survive zoom and re-render. */
  rects: Rect[];
};

type Box = { left: number; top: number; right: number; bottom: number };

/** Ignore slivers: collapsed ranges and zero-width fragments report these. */
const MIN_SIZE = 0.5;

/**
 * Text nodes that belong to a text run, in document (reading) order. Only text
 * inside a <span> counts: any whitespace that happens to sit loose between
 * the runs is layout, not content.
 */
function textNodesIn(layer: Element): Text[] {
  const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n as Text;
    if (text.length > 0 && text.parentElement?.tagName === "SPAN") nodes.push(text);
  }
  return nodes;
}

/**
 * The slice of a text node that a range covers, as [from, to) offsets.
 *
 * Offsets are only meaningful on the range's own start/end container when
 * that container is the text node itself. When an endpoint sits on an element
 * (a drag that begins between two spans, a triple-click) its offset counts
 * child nodes, not characters, so every other node is either wholly inside or
 * wholly outside the range. Treating that child index as a character offset
 * shifted highlights by a letter or two.
 */
function coveredSlice(range: Range, node: Text): [number, number] | null {
  let touches = false;
  try {
    touches = range.intersectsNode(node);
  } catch {
    touches = false;
  }
  if (!touches) return null;
  const from = node === range.startContainer ? range.startOffset : 0;
  const to = node === range.endContainer ? range.endOffset : node.length;
  return to > from ? [from, to] : null;
}

/** Page-relative boxes for the characters [from, to) of a text node. */
function sliceBoxes(node: Text, from: number, to: number, host: DOMRect): Box[] {
  const piece = document.createRange();
  piece.setStart(node, from);
  piece.setEnd(node, to);
  const out: Box[] = [];
  for (const r of piece.getClientRects()) {
    if (r.width <= MIN_SIZE || r.height <= MIN_SIZE) continue;
    out.push({
      left: r.left - host.left,
      top: r.top - host.top,
      right: r.right - host.left,
      bottom: r.bottom - host.top,
    });
  }
  return out;
}

/**
 * Turns many per-span boxes into one rectangle per visual line segment.
 *
 * Boxes are first grouped into lines by vertical position, and only then
 * sorted left to right and merged across small gaps. Doing it the other way
 * round — sort by top edge, merge neighbours — broke whenever two boxes on one
 * line differed by a fraction of a pixel in height: the sort interleaved the
 * two columns of a paper, and the "gap" between a box and the one before it
 * came out negative, which counted as small and fused both columns (and the
 * gutter between them) into a single wide bar.
 */
function toLineRects(boxes: Box[]): Box[] {
  type Line = { cy: number; h: number; items: Box[] };
  const lines: Line[] = [];

  for (const b of boxes) {
    const h = b.bottom - b.top;
    const cy = (b.top + b.bottom) / 2;
    let best: Line | undefined;
    let bestDistance = Infinity;
    for (const line of lines) {
      const d = Math.abs(line.cy - cy);
      if (d < 0.5 * Math.max(h, line.h) && d < bestDistance) {
        best = line;
        bestDistance = d;
      }
    }
    if (best) {
      best.items.push(b);
      best.cy += (cy - best.cy) / best.items.length;
    } else {
      lines.push({ cy, h, items: [b] });
    }
  }

  const out: Box[] = [];
  for (const line of lines) {
    line.items.sort((a, b) => a.left - b.left);
    let current: Box = { ...line.items[0]! };
    for (const b of line.items.slice(1)) {
      // A word space is ~0.3em; the gutter between two columns is much wider
      // and stays unpainted.
      if (b.left - current.right <= 0.8 * line.h) {
        current.right = Math.max(current.right, b.right);
        current.top = Math.min(current.top, b.top);
        current.bottom = Math.max(current.bottom, b.bottom);
      } else {
        out.push(current);
        current = { ...b };
      }
    }
    out.push(current);
  }
  return out.sort((a, b) => a.top - b.top || a.left - b.left);
}

/** Tidies text pulled from a text layer: joins hyphenated line breaks, collapses space. */
function tidyQuote(raw: string): string {
  return raw
    .replace(/\u00ad/g, "")
    .replace(/(\p{L})-[ \t]*\n[ \t]*(?=\p{Ll})/gu, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

const round = (n: number) => Math.round(n * 1e5) / 1e5;
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/**
 * Splits a selection into one group per page it covers.
 *
 * Only real text nodes are measured. pdf.js keeps an invisible
 * `.endOfContent` element in every text layer that grows to cover the page
 * during a drag, and measuring the selection as a whole picks it up as a
 * page-sized rectangle; walking text nodes never sees it.
 */
export function selectionToPageSelections(
  range: Range,
  pages: Record<number, HTMLDivElement | null>,
): PageSelection[] {
  if (range.collapsed) return [];
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
    let quote = "";
    let previous: Box | null = null;

    for (const node of textNodesIn(layer)) {
      const slice = coveredSlice(range, node);
      if (!slice) continue;
      const [from, to] = slice;
      const text = node.data.slice(from, to);
      const pieceBoxes = sliceBoxes(node, from, to, hostBox);

      if (pieceBoxes.length === 0) {
        // No geometry (a zero-size fragment): keep its text, nothing to paint.
        quote += text;
        continue;
      }

      // A line change is read off the geometry rather than from <br> elements,
      // so the quote has a break exactly where the text visibly wraps.
      const first = pieceBoxes[0]!;
      if (previous) {
        const prevCentre = (previous.top + previous.bottom) / 2;
        const centre = (first.top + first.bottom) / 2;
        const tall = Math.max(previous.bottom - previous.top, first.bottom - first.top);
        if (Math.abs(centre - prevCentre) > 0.6 * tall) quote += "\n";
      }
      quote += text;
      previous = pieceBoxes[pieceBoxes.length - 1]!;
      boxes.push(...pieceBoxes);
    }
    if (boxes.length === 0) continue;

    const rects: Rect[] = toLineRects(boxes).map((b) => {
      const x = clamp01(b.left / hostBox.width);
      const y = clamp01(b.top / hostBox.height);
      return {
        x: round(x),
        y: round(y),
        w: round(Math.min(1 - x, (b.right - b.left) / hostBox.width)),
        h: round(Math.min(1 - y, (b.bottom - b.top) / hostBox.height)),
      };
    });

    groups.push({ page: Number(key), quote: tidyQuote(quote), rects });
  }

  return groups.sort((a, b) => a.page - b.page);
}

/** Does a page-relative point (0..1) fall inside any of these rects? */
export function rectsContain(rects: Rect[], x: number, y: number): boolean {
  return rects.some((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);
}
