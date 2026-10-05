import { useEffect, useRef, useState } from "react";
import { Check, Copy, MessageSquarePlus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { ANNOTATION_COLORS, type AnnotationColor } from "@/lib/paper-types";

/** Adobe-ish pastels: saturated enough to tell apart, light enough to read through. */
export const HIGHLIGHT_HEX: Record<AnnotationColor, string> = {
  yellow: "#F5D742",
  orange: "#F0A860",
  green: "#7FBF7F",
  blue: "#6E97D6",
  pink: "#E894B0",
};

/**
 * How strongly each colour paints over the page. Yellow is the lightest hue
 * of the set but the most saturated, so at a shared strength it read heavier
 * than the rest; it gets a slightly lower value so the palette feels even.
 */
export const HIGHLIGHT_ALPHA: Record<AnnotationColor, number> = {
  yellow: 0.26,
  orange: 0.32,
  green: 0.32,
  blue: 0.32,
  pink: 0.32,
};

export const COLOR_LABEL: Record<AnnotationColor, string> = {
  yellow: "Yellow",
  orange: "Orange",
  green: "Green",
  blue: "Blue",
  pink: "Pink",
};

function Swatches({
  value,
  onPick,
  label,
}: {
  value?: AnnotationColor | null;
  onPick: (c: AnnotationColor) => void;
  label: string;
}) {
  return (
    <div role="group" aria-label={label} className="flex items-center gap-1">
      {ANNOTATION_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          title={COLOR_LABEL[c]}
          aria-label={COLOR_LABEL[c]}
          aria-pressed={value === c}
          onClick={() => onPick(c)}
          className={cn(
            "relative h-6 w-6 rounded-full border border-black/15 transition-transform hover:scale-110",
            value === c && "ring-2 ring-primary ring-offset-1 ring-offset-popover",
          )}
          style={{ background: HIGHLIGHT_HEX[c] }}
        >
          {value === c && (
            <Check className="absolute inset-0 m-auto h-3.5 w-3.5 text-black/70" strokeWidth={3} />
          )}
        </button>
      ))}
    </div>
  );
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = window.setTimeout(() => setDone(false), 1200);
    return () => window.clearTimeout(t);
  }, [done]);
  return (
    <Button
      size="sm"
      variant="ghost"
      className="h-8 gap-1.5 px-2 text-xs"
      onClick={async () => setDone(await copyText(text))}
    >
      {done ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {done ? "Copied" : "Copy"}
    </Button>
  );
}

/**
 * The menu shown for a fresh selection: picking a colour is the action, so a
 * highlight is one click rather than the old pick-colour-in-the-toolbar-first,
 * then-press-Highlight two-step.
 */
export function NewHighlightMenu({
  quote,
  defaultColor,
  busy,
  startNoting = false,
  onHighlight,
  onDismiss,
}: {
  quote: string;
  defaultColor: AnnotationColor;
  busy: boolean;
  /** Open straight into the note field (the toolbar's Note tool). */
  startNoting?: boolean;
  onHighlight: (color: AnnotationColor, comment: string | null) => void;
  onDismiss: () => void;
}) {
  const [noting, setNoting] = useState(startNoting);
  const [comment, setComment] = useState("");
  const [color, setColor] = useState<AnnotationColor>(defaultColor);

  if (!noting) {
    return (
      <div className="flex items-center gap-1 rounded-md border border-border bg-popover p-1 shadow-lg">
        <Swatches value={null} label="Highlight colour" onPick={(c) => onHighlight(c, null)} />
        <span className="mx-0.5 h-5 w-px bg-border" />
        <Button
          size="sm"
          variant="ghost"
          className="h-8 gap-1.5 px-2 text-xs"
          disabled={busy}
          onClick={() => setNoting(true)}
        >
          <MessageSquarePlus className="h-3.5 w-3.5" /> Note
        </Button>
        <CopyButton text={quote} />
        <Button
          size="icon"
          variant="ghost"
          aria-label="Dismiss"
          className="h-8 w-8"
          onClick={onDismiss}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    );
  }

  return (
    <div className="w-80 rounded-md border border-border bg-popover p-3 shadow-lg">
      <p className="line-clamp-3 border-l-2 border-primary pl-2 text-xs italic text-muted-foreground">
        {quote}
      </p>
      <Textarea
        autoFocus
        className="mt-2"
        rows={3}
        placeholder="Your note…"
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) onHighlight(color, comment.trim());
        }}
      />
      <div className="mt-2 flex items-center justify-between gap-2">
        <Swatches value={color} label="Highlight colour" onPick={setColor} />
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={onDismiss}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={busy || !comment.trim()}
            onClick={() => onHighlight(color, comment.trim())}
          >
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * The menu for an existing highlight. Recolouring and editing the note happen
 * in place here; previously the colour of a saved highlight could never be
 * changed at all, even though the store supported it.
 */
export function EditHighlightMenu({
  quote,
  comment,
  color,
  busy,
  onRecolor,
  onSaveComment,
  onDeleteComment,
  onDelete,
  onDismiss,
}: {
  quote: string | null;
  comment: string | null;
  color: AnnotationColor;
  busy: boolean;
  onRecolor: (c: AnnotationColor) => void;
  onSaveComment: (text: string) => void;
  onDeleteComment: () => void;
  onDelete: () => void;
  onDismiss: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment ?? "");
  const lastComment = useRef(comment);
  useEffect(() => {
    if (lastComment.current !== comment) {
      lastComment.current = comment;
      setDraft(comment ?? "");
    }
  }, [comment]);

  return (
    <div className="w-80 rounded-md border border-border bg-popover p-3 shadow-lg">
      {quote && (
        <p className="line-clamp-3 border-l-2 border-primary pl-2 text-xs italic text-muted-foreground">
          {quote}
        </p>
      )}

      <div className="mt-2 flex items-center justify-between gap-2">
        <Swatches value={color} label="Highlight colour" onPick={onRecolor} />
        <div className="flex items-center">
          {quote && <CopyButton text={quote} />}
          <Button
            size="icon"
            variant="ghost"
            aria-label="Delete highlight"
            title="Delete highlight"
            className="h-8 w-8 text-destructive"
            disabled={busy}
            onClick={onDelete}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            aria-label="Dismiss"
            className="h-8 w-8"
            onClick={onDismiss}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {editing ? (
        <>
          <Textarea
            autoFocus
            className="mt-2"
            rows={3}
            placeholder="Your note…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                onSaveComment(draft.trim());
                setEditing(false);
              }
            }}
          />
          <div className="mt-2 flex justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setDraft(comment ?? "");
                setEditing(false);
              }}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={busy || !draft.trim()}
              onClick={() => {
                onSaveComment(draft.trim());
                setEditing(false);
              }}
            >
              Save note
            </Button>
          </div>
        </>
      ) : comment ? (
        <div className="mt-2 rounded-md bg-muted/50 p-2">
          <p className="whitespace-pre-wrap text-xs">{comment}</p>
          <div className="mt-1.5 flex gap-2">
            <button
              type="button"
              className="text-xs text-muted-foreground underline-offset-2 hover:underline"
              onClick={() => setEditing(true)}
            >
              Edit note
            </button>
            <button
              type="button"
              className="text-xs text-muted-foreground underline-offset-2 hover:underline"
              onClick={onDeleteComment}
            >
              Remove note
            </button>
          </div>
        </div>
      ) : (
        <Button
          size="sm"
          variant="ghost"
          className="mt-2 h-8 gap-1.5 px-2 text-xs"
          onClick={() => setEditing(true)}
        >
          <MessageSquarePlus className="h-3.5 w-3.5" /> Add note
        </Button>
      )}
    </div>
  );
}
