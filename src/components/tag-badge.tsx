import { X } from "lucide-react";
import { cn } from "@/lib/utils";

/** FNV-1a — spreads short, similar tag names across the hue wheel. */
function hashTag(tag: string) {
  let hash = 0x811c9dc5;
  const key = tag.trim().toLowerCase();
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * 24 hue slots walked in golden-angle order, so tags that land on neighbouring
 * slots still come out visibly far apart on the colour wheel.
 */
const SLOTS = 24;

export function tagStyle(tag: string): React.CSSProperties {
  const slot = hashTag(tag) % SLOTS;
  const hue = (slot * 137.508) % 360;
  const c = `oklch(var(--tag-l) var(--tag-c) ${hue.toFixed(1)})`;
  return {
    color: c,
    borderColor: `color-mix(in oklab, ${c} 45%, transparent)`,
    backgroundColor: `color-mix(in oklab, ${c} 14%, transparent)`,
  };
}

/** @deprecated use tagStyle */
export function tagTone(_tag: string) {
  return "";
}

export function TagBadge({
  tag,
  onRemove,
  onClick,
  active,
  className,
}: {
  tag: string;
  onRemove?: () => void;
  onClick?: () => void;
  active?: boolean;
  className?: string;
}) {
  const base = cn(
    "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-normal transition-colors",
    active && "ring-1 ring-current",
    className,
  );

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-pressed={active}
        style={tagStyle(tag)}
        className={cn(base, "hover:brightness-95")}
      >
        {tag}
      </button>
    );
  }

  return (
    <span className={base} style={tagStyle(tag)}>
      {tag}
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove ${tag}`}
          onClick={onRemove}
          className="opacity-60 hover:opacity-100"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}
