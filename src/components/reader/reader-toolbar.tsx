import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Maximize2, Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const MIN_SCALE = 0.5;
export const MAX_SCALE = 3;

export function clampScale(value: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(value * 100) / 100));
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
}: {
  page: number;
  numPages: number;
  scale: number;
  fitWidth: boolean;
  onGoToPage: (page: number) => void;
  onStepPage: (delta: number) => void;
  onSetScale: (scale: number) => void;
  onFitWidth: () => void;
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
    <div className="flex flex-wrap items-center gap-1 border-b border-border px-2 py-1.5 text-sm">
      <Button
        variant="ghost"
        size="icon"
        aria-label="Previous page"
        disabled={page <= 1}
        onClick={() => onStepPage(-1)}
      >
        <ChevronLeft className="h-4 w-4" />
      </Button>

      <div className="flex items-center gap-1 text-muted-foreground">
        <input
          aria-label="Page number"
          value={draft}
          inputMode="numeric"
          onFocus={() => setEditing(true)}
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
          className="h-7 w-11 rounded border border-border bg-background px-1 text-center text-xs tabular-nums outline-none focus:border-primary"
        />
        <span className="text-xs tabular-nums">/ {numPages || "…"}</span>
      </div>

      <Button
        variant="ghost"
        size="icon"
        aria-label="Next page"
        disabled={!numPages || page >= numPages}
        onClick={() => onStepPage(1)}
      >
        <ChevronRight className="h-4 w-4" />
      </Button>

      <div className="ml-auto flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Fit width"
          title="Fit width"
          className={cn(fitWidth && "text-primary")}
          onClick={onFitWidth}
        >
          <Maximize2 className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Zoom out"
          disabled={scale <= MIN_SCALE}
          onClick={() => onSetScale(clampScale(scale - 0.1))}
        >
          <Minus className="h-4 w-4" />
        </Button>
        <button
          type="button"
          title="Reset zoom to 100%"
          aria-label="Reset zoom to 100%"
          onClick={() => onSetScale(1)}
          className="w-12 rounded text-center text-xs tabular-nums text-muted-foreground hover:text-foreground"
        >
          {Math.round(scale * 100)}%
        </button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Zoom in"
          disabled={scale >= MAX_SCALE}
          onClick={() => onSetScale(clampScale(scale + 0.1))}
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
