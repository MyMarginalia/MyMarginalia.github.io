import { useEffect, useState, type ReactNode } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Highlighter,
  Maximize2,
  MessageSquarePlus,
  Minus,
  Plus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { COLOR_LABEL, HIGHLIGHT_HEX } from "@/components/reader/highlight-menu";
import { ANNOTATION_COLORS, type AnnotationColor } from "@/lib/paper-types";
import { cn } from "@/lib/utils";

/**
 * What the next text selection does. `highlight` applies the chosen colour the
 * moment the selection ends; `note` opens the note field for it; null leaves
 * the selection to the popup.
 */
export type ReaderTool = "highlight" | "note" | null;

/**
 * Colour buttons and a Note button: pick once, then every selection is a
 * highlight with no popup in between. Clicking the active colour again turns
 * the highlighter off. With text already selected, a colour applies to it
 * straight away.
 *
 * Mouse-down is cancelled on each button so that pressing one never collapses
 * the selection it is about to act on.
 */
export function HighlightTools({
  tool,
  color,
  onPickColor,
  onToggleNote,
}: {
  tool: ReaderTool;
  color: AnnotationColor;
  onPickColor: (color: AnnotationColor) => void;
  onToggleNote: () => void;
}) {
  return (
    <div role="group" aria-label="Highlighter" className="flex items-center gap-1.5">
      <Highlighter
        aria-hidden
        className={cn("h-4 w-4", tool ? "text-foreground" : "text-muted-foreground")}
      />
      {ANNOTATION_COLORS.map((c, i) => {
        const active = tool === "highlight" && color === c;
        return (
          <button
            key={c}
            type="button"
            title={`Highlight in ${COLOR_LABEL[c].toLowerCase()} (${i + 1})`}
            aria-label={`Highlight in ${COLOR_LABEL[c].toLowerCase()}`}
            aria-pressed={active}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPickColor(c)}
            className={cn(
              "h-5 w-5 rounded-full border border-black/15 transition-transform hover:scale-110",
              active && "ring-2 ring-primary ring-offset-2 ring-offset-card",
            )}
            style={{ background: HIGHLIGHT_HEX[c] }}
          />
        );
      })}
      <Button
        variant="ghost"
        size="sm"
        title="Highlight and add a note (N)"
        aria-pressed={tool === "note"}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onToggleNote}
        className={cn("ml-0.5 h-8 gap-1.5 px-2 text-xs", tool === "note" && "bg-muted text-primary")}
      >
        <MessageSquarePlus className="h-3.5 w-3.5" /> Note
      </Button>
    </div>
  );
}

export const MIN_SCALE = 0.5;
export const MAX_SCALE = 3;

const ZOOM_STOPS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

export function clampScale(value: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(value * 100) / 100));
}

/** The next preset zoom level above or below `current`, as PDF viewers step. */
export function nextZoomStop(current: number, dir: 1 | -1): number {
  if (dir > 0) return ZOOM_STOPS.find((s) => s > current + 0.01) ?? MAX_SCALE;
  return [...ZOOM_STOPS].reverse().find((s) => s < current - 0.01) ?? MIN_SCALE;
}

export function ReaderToolbar({
  page,
  numPages,
  scale,
  fitWidth,
  onGoToPage,
  onStepPage,
  onSetScale,
  onFitWidth,
  header,
  tools,
  actions,
}: {
  page: number;
  numPages: number;
  scale: number;
  fitWidth: boolean;
  onGoToPage: (page: number) => void;
  onStepPage: (delta: number) => void;
  onSetScale: (scale: number) => void;
  onFitWidth: () => void;
  /** Left slot: back link and title. */
  header?: ReactNode;
  /** The highlighter buttons: in the bar from lg up, on a row of their own below that. */
  tools?: ReactNode;
  /** Right slot: panel toggles and the like. */
  actions?: ReactNode;
}) {
  // Local draft so typing a page number doesn't fight the scroll position
  // continuously updating the committed value underneath.
  const [draft, setDraft] = useState(String(page));
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setDraft(String(page));
  }, [page, editing]);

  const commit = () => {
    setEditing(false);
    const n = Number.parseInt(draft, 10);
    if (Number.isFinite(n) && n >= 1 && numPages && n <= numPages) onGoToPage(n);
    else setDraft(String(page));
  };

  return (
    <>
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-card px-3 text-sm">
        <div className="flex min-w-0 flex-1 items-center">{header}</div>

        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Previous page"
            title="Previous page"
            disabled={page <= 1}
            onClick={() => onStepPage(-1)}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>

          <div className="flex items-center gap-1.5 text-muted-foreground">
            <input
              aria-label="Page number"
              value={draft}
              inputMode="numeric"
              onFocus={(e) => {
                setEditing(true);
                e.target.select();
              }}
              onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, ""))}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  (e.target as HTMLInputElement).blur();
                } else if (e.key === "Escape") {
                  setDraft(String(page));
                  setEditing(false);
                  (e.target as HTMLInputElement).blur();
                }
              }}
              className="h-7 w-11 rounded-md border border-border bg-background px-1 text-center text-sm tabular-nums text-foreground outline-none focus:border-primary"
            />
            <span className="text-sm tabular-nums">/ {numPages || "…"}</span>
          </div>

          <Button
            variant="ghost"
            size="icon"
            aria-label="Next page"
            title="Next page"
            disabled={!numPages || page >= numPages}
            onClick={() => onStepPage(1)}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>

          <div className="mx-1 hidden h-5 w-px bg-border sm:block" />

          <div className="hidden items-center gap-1 sm:flex">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Zoom out"
              title="Zoom out (-)"
              disabled={scale <= MIN_SCALE + 0.01}
              onClick={() => onSetScale(nextZoomStop(scale, -1))}
            >
              <Minus className="h-4 w-4" />
            </Button>
            <button
              type="button"
              title="Reset zoom to 100% (0)"
              aria-label="Reset zoom to 100%"
              onClick={() => onSetScale(1)}
              className="w-12 rounded-md py-1 text-center text-sm tabular-nums text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              {Math.round(scale * 100)}%
            </button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Zoom in"
              title="Zoom in (+)"
              disabled={scale >= MAX_SCALE - 0.01}
              onClick={() => onSetScale(nextZoomStop(scale, 1))}
            >
              <Plus className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Fit to width"
              aria-pressed={fitWidth}
              title="Fit to width"
              className={cn(fitWidth && "bg-muted text-primary")}
              onClick={onFitWidth}
            >
              <Maximize2 className="h-4 w-4" />
            </Button>
          </div>

          {tools && (
            <>
              <div className="mx-1 hidden h-5 w-px bg-border lg:block" />
              <div className="hidden lg:flex">{tools}</div>
            </>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-end gap-1 md:min-w-0 md:flex-1">{actions}</div>
      </div>
      {tools && (
        <div className="flex h-10 shrink-0 items-center justify-center border-b border-border bg-card lg:hidden">
          {tools}
        </div>
      )}
    </>
  );
}
