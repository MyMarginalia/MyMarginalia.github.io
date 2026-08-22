import { useState } from "react";
import { Input } from "@/components/ui/input";
import { TagBadge } from "@/components/tag-badge";

export function TagInput({
  value,
  onChange,
  suggestions = [],
  placeholder = "Add a tag and press Enter",
}: {
  value: string[];
  onChange: (v: string[]) => void;
  suggestions?: string[];
  placeholder?: string;
}) {
  const [draft, setDraft] = useState("");

  function commit(raw: string) {
    const tag = raw.trim().replace(/,$/, "");
    if (!tag) return;
    if (!value.includes(tag)) onChange([...value, tag]);
    setDraft("");
  }

  const available = suggestions
    .filter((t) => !value.includes(t))
    .filter((t) => (draft.trim() ? t.toLowerCase().includes(draft.trim().toLowerCase()) : true));

  return (
    <div className="space-y-2">
    <div className="rounded-md border border-input p-2">
      {value.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {value.map((t) => (
            <TagBadge key={t} tag={t} onRemove={() => onChange(value.filter((x) => x !== t))} />
          ))}
        </div>
      )}
      <Input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            commit(draft);
          } else if (e.key === "Backspace" && !draft && value.length) {
            onChange(value.slice(0, -1));
          }
        }}
        placeholder={placeholder}
        className="border-0 p-0 shadow-none focus-visible:ring-0"
      />
    </div>
      {available.length > 0 && (
        <div>
          <p className="mb-1.5 text-xs text-muted-foreground">Existing tags — click to add</p>
          <div className="flex flex-wrap gap-1.5">
            {available.slice(0, 40).map((t) => (
              <TagBadge key={t} tag={t} onClick={() => commit(t)} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}