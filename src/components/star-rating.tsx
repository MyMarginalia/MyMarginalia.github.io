import { Star } from "lucide-react";
import { cn } from "@/lib/utils";

export function StarRating({
  value,
  onChange,
  size = 16,
}: {
  value: number | null;
  onChange?: (v: number | null) => void;
  size?: number;
}) {
  return (
    <div className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          disabled={!onChange}
          aria-label={`${n} star${n > 1 ? "s" : ""}`}
          onClick={() => onChange?.(value === n ? null : n)}
          className={cn("transition-opacity", onChange ? "hover:opacity-70" : "cursor-default")}
        >
          <Star
            style={{ width: size, height: size }}
            className={cn(
              (value ?? 0) >= n ? "fill-primary text-primary" : "text-muted-foreground/50",
            )}
          />
        </button>
      ))}
    </div>
  );
}