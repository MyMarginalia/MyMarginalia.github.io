import type { TextLine } from "@/lib/pdf/text-geometry";

/**
 * The set of places a text cursor may sit on one line, and where each of them
 * belongs on screen.
 *
 * Two things have to be true at once, and getting either alone is not enough:
 *
 *  - A cursor belongs *between characters*. Positions taken from the painted
 *    pixels can't provide that: the blank columns on a line fall between the
 *    stems of letters like m, n, u and i as readily as between letters, so a
 *    cursor derived from them lands inside a letter, and where two letters
 *    touch there is no blank column and the position between them is missing
 *    entirely. So the positions come from the text.
 *
 *  - They have to line up with the glyphs a reader can see. pdf.js lays its
 *    invisible text layer out in a *generic substitute font* — there are no
 *    @font-face rules for the document's own fonts, spans are literally
 *    `font-family: sans-serif` — and corrects only each run's total width. The
 *    ends of a run therefore match the page while the characters inside it
 *    land wherever the substitute's letter widths put them.
 *
 * So: take the boundaries from the text, then correct them against the page by
 * matching words. Word gaps are the one feature that survives the substitution
 * — they are wide, unambiguous, and equally visible in the text and in the
 * ink — so each word's boundaries are rescaled from where the substitute font
 * put the word onto where the word is actually painted. Error inside a word is
 * then bounded by that word's width instead of accumulating along the line.
 */

const INK_LUMINANCE = 170;
const INK_ALPHA = 16;
/** A gap at least this tall a fraction of the line is a space between words. */
const WORD_GAP_RATIO = 0.2;

export type LineCursors = {
  /** Page-relative x of each cursor position, ascending. */
  xs: number[];
  /** The DOM position each one corresponds to. */
  nodes: Text[];
  offsets: number[];
};

type Char = { left: number; right: number; node: Text; offset: number; space: boolean };

/** Every character of the line, with its box in page-relative coordinates. */
function readChars(host: HTMLElement, line: TextLine): Char[] {
  const hostBox = host.getBoundingClientRect();
  const range = document.createRange();
  const chars: Char[] = [];
  for (const span of line.spans) {
    const node = span.el.firstChild;
    if (!node || node.nodeType !== Node.TEXT_NODE) continue;
    const text = node as Text;
    for (let i = 0; i < text.length; i += 1) {
      range.setStart(text, i);
      range.setEnd(text, i + 1);
      const r = range.getBoundingClientRect();
      const ch = text.data[i] ?? "";
      chars.push({
        left: r.left - hostBox.left,
        right: r.right - hostBox.left,
        node: text,
        offset: i,
        space: !ch.trim(),
      });
    }
  }
  return chars;
}

/** Horizontal extent of each painted word on the line, from the canvas. */
function readPaintedWords(host: HTMLElement, line: TextLine): { left: number; right: number }[] {
  const canvas = host.querySelector("canvas");
  if (!canvas) return [];
  const hostBox = host.getBoundingClientRect();
  const canvasBox = canvas.getBoundingClientRect();
  if (canvasBox.width === 0 || canvasBox.height === 0) return [];
  const perCssX = canvas.width / canvasBox.width;
  const perCssY = canvas.height / canvasBox.height;
  const offsetX = hostBox.left - canvasBox.left;
  const offsetY = hostBox.top - canvasBox.top;

  const lineHeight = line.bottom - line.top;
  if (lineHeight <= 0) return [];
  const left = Math.floor((line.left + offsetX) * perCssX);
  const right = Math.ceil((line.right + offsetX) * perCssX);
  // The full line height, not a middle band: a word's extent must include its
  // ascenders and descenders, or a leading "l" or trailing "y" is clipped off.
  const top = Math.floor((line.top + offsetY) * perCssY);
  const height = Math.max(1, Math.round(lineHeight * perCssY));
  const width = right - left;
  if (width <= 1 || left < 0 || top < 0) return [];
  if (left + width > canvas.width || top + height > canvas.height) return [];

  let pixels: ImageData;
  try {
    const context = canvas.getContext("2d");
    if (!context) return [];
    pixels = context.getImageData(left, top, width, height);
  } catch {
    return []; // tainted canvas
  }

  const { data } = pixels;
  const minGap = Math.max(2, lineHeight * WORD_GAP_RATIO * perCssX);
  const words: { left: number; right: number }[] = [];
  const toPageX = (column: number) => (left + column) / perCssX - offsetX;
  let wordStart = -1;
  let blankRun = 0;
  for (let column = 0; column <= width; column += 1) {
    let inked = false;
    if (column < width) {
      for (let row = 0; row < height; row += 1) {
        const i = (row * width + column) * 4;
        const alpha = data[i + 3] ?? 0;
        const luminance = ((data[i] ?? 255) + (data[i + 1] ?? 255) + (data[i + 2] ?? 255)) / 3;
        if (alpha > INK_ALPHA && luminance < INK_LUMINANCE) {
          inked = true;
          break;
        }
      }
    }
    if (inked) {
      if (wordStart < 0) wordStart = column;
      blankRun = 0;
      continue;
    }
    blankRun += 1;
    // Only a gap wide enough to be a space ends a word; the narrow gaps
    // between letters, and the ones inside an m or a u, must not.
    if (wordStart >= 0 && (blankRun >= minGap || column === width)) {
      words.push({ left: toPageX(wordStart), right: toPageX(column - blankRun + 1) });
      wordStart = -1;
    }
  }
  return words;
}

export function buildLineCursors(host: HTMLElement, line: TextLine): LineCursors | null {
  const chars = readChars(host, line);
  if (chars.length === 0) return null;

  // Cursor positions: before every character, plus after the last one.
  const xs: number[] = [];
  const nodes: Text[] = [];
  const offsets: number[] = [];
  const charIndexOfCursor: number[] = [];
  for (const [i, c] of chars.entries()) {
    xs.push(c.left);
    nodes.push(c.node);
    offsets.push(c.offset);
    charIndexOfCursor.push(i);
  }
  const last = chars[chars.length - 1]!;
  xs.push(last.right);
  nodes.push(last.node);
  offsets.push(last.offset + 1);
  charIndexOfCursor.push(chars.length);

  // Group the text into words, then line them up with the painted ones.
  const textWords: { from: number; to: number }[] = [];
  let start = -1;
  for (const [i, c] of chars.entries()) {
    if (c.space) {
      if (start >= 0) textWords.push({ from: start, to: i - 1 });
      start = -1;
    } else if (start < 0) {
      start = i;
    }
  }
  if (start >= 0) textWords.push({ from: start, to: chars.length - 1 });

  const painted = readPaintedWords(host, line);
  if (painted.length !== textWords.length || textWords.length === 0) {
    // Can't match them up with confidence — the character positions on their
    // own are still the right *set* of places, just less precisely placed.
    return { xs, nodes, offsets };
  }

  for (const [w, word] of textWords.entries()) {
    const ink = painted[w]!;
    const textLeft = chars[word.from]!.left;
    const textRight = chars[word.to]!.right;
    const textWidth = textRight - textLeft;
    if (textWidth <= 0) continue;
    const scale = (ink.right - ink.left) / textWidth;
    for (let cursor = 0; cursor < xs.length; cursor += 1) {
      const ci = charIndexOfCursor[cursor]!;
      // A cursor belongs to this word if it sits before one of its characters,
      // or just after its last one.
      if (ci < word.from || ci > word.to + 1) continue;
      const original = ci <= word.to ? chars[ci]!.left : textRight;
      xs[cursor] = ink.left + (original - textLeft) * scale;
    }
  }

  return { xs, nodes, offsets };
}

/** Index of the cursor position nearest a page-relative x. */
export function nearestCursor(cursors: LineCursors, x: number): number {
  let best = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < cursors.xs.length; i += 1) {
    const d = Math.abs(cursors.xs[i]! - x);
    if (d < bestDistance) {
      bestDistance = d;
      best = i;
    }
  }
  return best;
}

/** Index of the cursor matching a DOM position, or -1. */
export function cursorForSelection(cursors: LineCursors, node: Node, offset: number): number {
  for (let i = 0; i < cursors.nodes.length; i += 1) {
    if (cursors.nodes[i] === node && cursors.offsets[i] === offset) return i;
  }
  return -1;
}
