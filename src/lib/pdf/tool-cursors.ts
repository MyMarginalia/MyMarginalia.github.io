/**
 * Mouse cursors for the highlighter and note tools, drawn as small inline SVGs
 * so no asset has to be shipped and the active colour can be baked in.
 *
 * Both are drawn on a 32x32 grid and shown at CURSOR_SIZE px, about the size of
 * the system arrow, so they don't dwarf the text being selected. The hotspot is
 * the point a selection starts from: the marker's tip for the highlighter, and
 * the I-beam's centre for the note tool (the I-beam is there so it still reads
 * as "select text here").
 */

/** On-screen size in CSS pixels. */
export const CURSOR_SIZE = 20;

/** Hotspots on the 32x32 drawing grid. */
const HOTSPOT = { highlight: [3, 29], note: [7, 14] } as const;

/** White halo under a dark line, so the cursor reads on the page and on dark backgrounds alike. */
const INK = "#1f2328";
const HALO = 'stroke="#fff" stroke-width="3.2" stroke-linejoin="round" stroke-linecap="round"';

function highlighterSvg(color: string): string {
  // Drawn along +x from the tip at the origin, then rotated so the tip points
  // down-left and the marker leans up-right.
  return `<svg xmlns='http://www.w3.org/2000/svg' width='${CURSOR_SIZE}' height='${CURSOR_SIZE}' viewBox='0 0 32 32'>
<g transform='translate(3 29) rotate(-45)' stroke-linejoin='round'>
  <path d='M0 -2 L9 -5.5 L9 5.5 L0 2 Z' fill='none' ${HALO}/>
  <rect x='9' y='-5.5' width='21' height='11' rx='2' fill='none' ${HALO}/>
  <rect x='9' y='-5.5' width='21' height='11' rx='2' fill='#3a3f47' stroke='${INK}' stroke-width='1'/>
  <rect x='22' y='-5.5' width='4' height='11' fill='#59606a'/>
  <path d='M0 -2 L9 -5.5 L9 5.5 L0 2 Z' fill='${color}' stroke='${INK}' stroke-width='1'/>
</g>
</svg>`;
}

function noteSvg(color: string): string {
  const badge = "M13 15 a2 2 0 0 1 2 -2 H25 L30 18 V28 a2 2 0 0 1 -2 2 H15 a2 2 0 0 1 -2 -2 Z";
  return `<svg xmlns='http://www.w3.org/2000/svg' width='${CURSOR_SIZE}' height='${CURSOR_SIZE}' viewBox='0 0 32 32'>
<path d='M4 5 H10 M7 5 V23 M4 23 H10' fill='none' ${HALO}/>
<path d='${badge}' fill='none' ${HALO}/>
<path d='M4 5 H10 M7 5 V23 M4 23 H10' fill='none' stroke='${INK}' stroke-width='1.3' stroke-linecap='round'/>
<path d='${badge}' fill='${color}' stroke='${INK}' stroke-width='1' stroke-linejoin='round'/>
<path d='M25 13 V18 H30' fill='#fff' fill-opacity='.55' stroke='${INK}' stroke-width='1' stroke-linejoin='round'/>
<path d='M16 22 H27 M16 26 H23' fill='none' stroke='${INK}' stroke-width='1.4' stroke-linecap='round'/>
</svg>`;
}

/** The raw SVG for a tool, exposed for testing and previews. */
export function toolCursorSvg(tool: "highlight" | "note", color: string): string {
  return tool === "highlight" ? highlighterSvg(color) : noteSvg(color);
}

/** A complete CSS `cursor` value: image, hotspot, and a plain fallback. */
export function toolCursor(tool: "highlight" | "note", color: string): string {
  const svg = toolCursorSvg(tool, color).replace(/\s*\n\s*/g, "");
  const [hx, hy] = HOTSPOT[tool];
  const k = CURSOR_SIZE / 32;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${Math.round(hx * k)} ${Math.round(hy * k)}, text`;
}