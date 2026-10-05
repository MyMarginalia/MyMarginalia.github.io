import { useCallback, useEffect, useRef, type RefObject } from "react";
import { selectionToPageSelections, type PageSelection } from "@/lib/pdf/selection-geometry";

/** The popups carry this attribute (set in pdf-reader.tsx). */
const MENU_ATTR = "data-highlight-menu";

function insideMenu(target: EventTarget | Node | null): boolean {
  const el = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  return !!el?.closest(`[${MENU_ATTR}]`);
}

/**
 * Reports each *finished* text selection made inside the reader.
 *
 * The browser's own selection is the only mechanism: no fake caret, no key
 * handling of its own. Three things make that dependable:
 *
 * - Listeners sit on the document, not on a page. Dragging past the edge of a
 *   page and letting go over the grey gutter still ends the selection.
 * - A selection counts as finished when the pointer is released, or — with no
 *   pointer down, as with Shift+Arrow or a touch selection handle — once it
 *   has stopped changing for a moment. Nothing is reported mid-drag.
 * - Whatever is reported is a snapshot. Clicking a popup button may collapse
 *   the live selection in some browsers; the popup keeps working because it
 *   holds its own copy.
 *
 * Starting a new press anywhere outside a popup, or pressing Escape, calls
 * `onDismiss`.
 *
 * `instant` says a finished selection will be applied immediately (the
 * highlighter is armed), so the hook is more patient: a pointer-less selection
 * (Shift+Arrow, a touch handle) must sit still longer, so a finger still
 * adjusting a handle isn't cut off, and a double-click waits briefly in case a
 * third click is coming, so a triple-click highlights the paragraph rather
 * than the word and then the paragraph on top of it.
 *
 * Also returns `readSelection`, the current selection as page groups, for
 * actions that act on text already selected (picking a colour in the toolbar).
 */
export function useTextSelection({
  paneRef,
  pageRefs,
  onSelect,
  onDismiss,
  instant = false,
}: {
  paneRef: RefObject<HTMLElement | null>;
  pageRefs: RefObject<Record<number, HTMLDivElement | null>>;
  onSelect: (groups: PageSelection[]) => void;
  onDismiss: () => void;
  instant?: boolean;
}) {
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  const instantRef = useRef(instant);
  instantRef.current = instant;

  /** The live selection as per-page groups, or [] if there is none inside the pages. */
  const readSelection = useCallback((): PageSelection[] => {
    const pane = paneRef.current;
    const sel = window.getSelection();
    if (!pane || !sel || sel.isCollapsed || sel.rangeCount === 0) return [];
    const range = sel.getRangeAt(0);
    const root = range.commonAncestorContainer;
    // Ignore selections outside the pages, and text selected in a popup's
    // own note field.
    if (!pane.contains(root) || insideMenu(root)) return [];
    return selectionToPageSelections(range, pageRefs.current ?? {}).filter(
      (g) => g.rects.length > 0 && g.quote,
    );
  }, [paneRef, pageRefs]);

  useEffect(() => {
    let pointerDown = false;
    let timer: number | undefined;
    // Click counting, for the double-click wait described above.
    let clicks = 0;
    let lastDown = { time: 0, x: 0, y: 0 };

    const capture = () => {
      const groups = readSelection();
      if (groups.length > 0) onSelectRef.current(groups);
    };

    const settle = (delay: number) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(capture, delay);
    };

    const onPointerDown = (e: PointerEvent) => {
      if (insideMenu(e.target)) return;
      pointerDown = true;
      window.clearTimeout(timer);
      onDismissRef.current();
      const near =
        Math.abs(e.clientX - lastDown.x) < 6 && Math.abs(e.clientY - lastDown.y) < 6;
      clicks = e.timeStamp - lastDown.time < 500 && near ? clicks + 1 : 1;
      lastDown = { time: e.timeStamp, x: e.clientX, y: e.clientY };
    };
    const onPointerUp = (e: PointerEvent) => {
      pointerDown = false;
      if (insideMenu(e.target)) return;
      // The selection settles just after the release event.
      settle(instantRef.current && clicks === 2 ? 320 : 10);
    };
    const onPointerCancel = () => {
      // Touch browsers cancel the pointer when they take over for selection
      // handles; selectionchange takes it from there.
      pointerDown = false;
    };
    const onSelectionChange = () => {
      if (pointerDown) return;
      settle(instantRef.current ? 700 : 350);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      window.getSelection()?.removeAllRanges();
      onDismissRef.current();
    };

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("pointerup", onPointerUp, true);
    document.addEventListener("pointercancel", onPointerCancel, true);
    document.addEventListener("selectionchange", onSelectionChange);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("pointerup", onPointerUp, true);
      document.removeEventListener("pointercancel", onPointerCancel, true);
      document.removeEventListener("selectionchange", onSelectionChange);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [readSelection]);

  return { readSelection };
}
