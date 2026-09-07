/**
 * Geometry helpers for pdf.js text layers.
 *
 * pdf.js positions every text run as its own absolutely-positioned <span>
 * rather than laying text out in normal document flow. That means none of the
 * browser's built-in notions of "the line above", "the start of this line" or
 * "the caret position at this x" apply, so the reader derives them from the
 * spans' own geometry instead.
 */

export type LineSpan = { el: HTMLElement; left: number; right: number };

export type TextLine = {
  top: number;
  bottom: number;
  left: number;
  right: number;
  spans: LineSpan[];
};

export type PageLines = {
  lines: TextLine[];
  /** Which line each span belongs to, for exact (column-safe) lookups. */
  bySpan: Map<HTMLElement, number>;
  /** Rendered page width these measurements were taken at. */
  width: number;
  spanCount: number;
};

/** Text-bearing spans of a page's text layer, in reading order. */
export function textSpans(host: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const el of host.querySelectorAll<HTMLElement>(".textLayer span")) {
    const first = el.firstChild;
    if (first && first.nodeType === Node.TEXT_NODE && first.textContent) out.push(el);
  }
  return out;
}

/**
 * Groups a page's spans into visual lines, in DOM order. pdf.js emits text in
 * reading order, so for a two-column layout that is every line of column 1
 * followed by every line of column 2 — exactly the order a caret should
 * travel, including across the column break.
 *
 * Geometry is stored relative to the page rather than the viewport, so the
 * result stays valid while the reader scrolls and can be cached between
 * keystrokes. Measuring every span costs a forced layout pass, and a page
 * holds on the order of a thousand of them.
 */
export function buildPageLines(host: HTMLElement, width: number): PageLines {
  const hostBox = host.getBoundingClientRect();
  const spans = textSpans(host);
  const lines: TextLine[] = [];
  const bySpan = new Map<HTMLElement, number>();

  for (const el of spans) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) {
      // A zero-size fragment (e.g. a hyphenated word-wrap continuation) has no
      // line of its own; treat it as part of whatever line precedes it, so a
      // caret landing inside one is never stranded.
      if (lines.length > 0) bySpan.set(el, lines.length - 1);
      continue;
    }
    const top = r.top - hostBox.top;
    const bottom = r.bottom - hostBox.top;
    const left = r.left - hostBox.left;
    const right = r.right - hostBox.left;
    const centre = (top + bottom) / 2;
    const last = lines[lines.length - 1];
    if (last && Math.abs((last.top + last.bottom) / 2 - centre) < r.height * 0.6) {
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

  return { lines, bySpan, width, spanCount: spans.length };
}

/**
 * Character offset within a text node nearest a viewport x, by binary search
 * over per-character rects.
 *
 * Range geometry is layout-derived, so unlike document.caretRangeFromPoint
 * this works for text scrolled out of view — which is what lets the caret move
 * onto a page that isn't on screen yet — and it can't be intercepted by the
 * annotation layer that pdf.js paints on top of the text.
 */
export function offsetAtX(textNode: Text, x: number): number {
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
 * Caret position on a line closest to a page-relative x. A line can be several
 * spans wide — or, in a byline row, several unrelated ones with gaps between
 * them — so pick whichever actually spans that x, and otherwise the nearest.
 */
export function positionInLine(
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
