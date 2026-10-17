import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  ChevronDown,
  Download,
  ExternalLink,
  FileText,
  Highlighter,
  MessageSquare,
  NotebookPen,
  Plus,
  Search,
  ThumbsUp,
  Upload,
} from "lucide-react";
import { toast } from "sonner";
import { AppShell } from "@/components/app-shell";
import { PaperFormDialog } from "@/components/paper-form";
import { StarRating } from "@/components/star-rating";
import { ImportanceSelect, StatusSelect } from "@/components/paper-controls";
import { TagBadge } from "@/components/tag-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { BRAND } from "@/lib/brand";
import {
  IMPORTANCES,
  IMPORTANCE_LABEL,
  STATUSES,
  STATUS_CLASS,
  STATUS_LABEL,
  type LibraryItem,
  type PaperImportance,
  type PaperStatus,
} from "@/lib/paper-types";
import { bulkSetStatus, listLibrary, removeFromLibrary, updateUserPaper } from "@/lib/papers";
import { exportBackupJson, importBackupJson, getMyProfile } from "@/lib/account";

export const Route = createFileRoute("/_authenticated/library")({
  head: () => ({
    meta: [
      { title: `Library — ${BRAND}` },
      { name: "description", content: "Every paper you want to read, are reading, or have read." },
      { property: "og:title", content: `Library — ${BRAND}` },
      {
        property: "og:description",
        content: "Every paper you want to read, are reading, or have read.",
      },
    ],
  }),
  component: LibraryPage,
  errorComponent: ({ error }) => (
    <div role="alert" className="p-10 text-sm">
      {error.message}
    </div>
  ),
  notFoundComponent: () => <div className="p-10">Not found.</div>,
});

const SORTS = [
  { key: "added", label: "Recently added" },
  { key: "importance", label: "Importance" },
  { key: "rating", label: "Rating" },
  { key: "year", label: "Year" },
  { key: "recommend", label: "Recommended" },
] as const;

const IMPORTANCE_RANK: Record<PaperImportance, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

function LibraryPage() {
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);

  const [view, setView] = useState<"cards" | "table" | "board">("cards");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<"all" | PaperStatus>("all");
  const [importance, setImportance] = useState<"all" | PaperImportance>("all");
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  const [sort, setSort] = useState<(typeof SORTS)[number]["key"]>("added");
  const [asc, setAsc] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<LibraryItem | undefined>();

  const { data: profile } = useQuery({
    queryKey: ["profile"],
    queryFn: () => getMyProfile(),
  });

  const { data: items = [], isLoading } = useQuery({
    queryKey: ["library"],
    queryFn: () => listLibrary(),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["library"] });

  const update = useMutation({
    mutationFn: (vars: { paperId: string; values: Record<string, unknown> }) =>
      updateUserPaper({ paperId: vars.paperId, values: vars.values as never }),
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(e.message),
  });

  const allTags = useMemo(() => Array.from(new Set(items.flatMap((i) => i.tags))).sort(), [items]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = items.filter((i) => {
      if (status !== "all" && i.status !== status) return false;
      if (importance !== "all" && i.importance !== importance) return false;
      if (tagFilter.length && !tagFilter.every((t) => i.tags.includes(t))) return false;
      if (!q) return true;
      return (
        i.paper.title.toLowerCase().includes(q) ||
        i.paper.authors.join(" ").toLowerCase().includes(q) ||
        (i.paper.venue ?? "").toLowerCase().includes(q) ||
        i.tags.join(" ").toLowerCase().includes(q)
      );
    });
    const dir = asc ? 1 : -1;
    return [...filtered].sort((a, b) => {
      switch (sort) {
        case "recommend":
          return ((a.recommend ? 1 : 0) - (b.recommend ? 1 : 0)) * dir;
        case "importance":
          return (IMPORTANCE_RANK[a.importance] - IMPORTANCE_RANK[b.importance]) * dir;
        case "rating":
          return ((a.rating ?? 0) - (b.rating ?? 0)) * dir;
        case "year":
          return ((a.paper.year ?? 0) - (b.paper.year ?? 0)) * dir;
        default:
          return (Date.parse(a.created_at) - Date.parse(b.created_at)) * dir;
      }
    });
  }, [items, search, status, importance, tagFilter, sort, asc]);

  function toggleTagFilter(t: string) {
    setTagFilter((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]));
  }

  function toggle(id: string) {
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  }

  async function exportJson() {
    try {
      const json = await exportBackupJson();
      const blob = new Blob([json], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `marginalia-library-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast.success("JSON backup downloaded.");
    } catch {
      toast.error("Failed to export backup.");
    }
  }

  async function onImportFile(file: File) {
    try {
      const text = await file.text();
      const res = await importBackupJson(text);
      toast.success(`Imported ${res.importedPapers} paper(s) and ${res.importedAnnotations} annotation(s).`);
      invalidate();
    } catch (e) {
      toast.error(
        e instanceof Error && e.message
          ? `Import failed: ${e.message}`
          : "Could not read that file. Expected a JSON backup of papers.",
      );
    }
  }

  return (
    <AppShell>
      <div className="rule-under flex flex-wrap items-end gap-3 pb-4">
        <div>
          <h1 className="font-display text-3xl">
            {profile?.display_name ? `${profile.display_name}'s Library` : "Library"}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {items.length} paper{items.length === 1 ? "" : "s"} · {visible.length} shown
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && onImportFile(e.target.files[0])}
          />
          <Button variant="ghost" size="sm" onClick={() => fileRef.current?.click()}>
            <Upload className="h-4 w-4" /> Import
          </Button>
          <Button variant="ghost" size="sm" onClick={() => exportJson()}>
            <Download className="h-4 w-4" /> Export
          </Button>
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <Plus className="h-4 w-4" /> Add paper
          </Button>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search title, author, venue, tag"
            className="pl-8"
          />
        </div>

        <Select value={status} onValueChange={(v) => setStatus(v as typeof status)}>
          <SelectTrigger className="w-36">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {STATUS_LABEL[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={importance} onValueChange={(v) => setImportance(v as typeof importance)}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder="Importance" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All importance</SelectItem>
            {IMPORTANCES.map((s) => (
              <SelectItem key={s} value={s}>
                {IMPORTANCE_LABEL[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="flex items-center">
          <Select value={sort} onValueChange={(v) => setSort(v as typeof sort)}>
            <SelectTrigger className="w-44 rounded-r-none">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SORTS.map((s) => (
                <SelectItem key={s.key} value={s.key}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="icon"
            className="rounded-l-none border-l-0"
            aria-label={asc ? "Sort ascending" : "Sort descending"}
            title={asc ? "Lowest / oldest first" : "Highest / newest first"}
            onClick={() => setAsc((v) => !v)}
          >
            {asc ? (
              <ArrowUpNarrowWide className="h-4 w-4" />
            ) : (
              <ArrowDownWideNarrow className="h-4 w-4" />
            )}
          </Button>
        </div>

        <Tabs value={view} onValueChange={(v) => setView(v as typeof view)}>
          <TabsList>
            <TabsTrigger value="cards">Cards</TabsTrigger>
            <TabsTrigger value="table">Table</TabsTrigger>
            <TabsTrigger value="board">Board</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {allTags.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5 rounded-md border border-border bg-card/40 p-2">
          <span className="px-1 text-xs uppercase tracking-wide text-muted-foreground">Tags</span>
          {allTags.map((t) => (
            <TagBadge
              key={t}
              tag={t}
              active={tagFilter.includes(t)}
              onClick={() => toggleTagFilter(t)}
              className={tagFilter.includes(t) ? "" : "opacity-70"}
            />
          ))}
          {tagFilter.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto h-7"
              onClick={() => setTagFilter([])}
            >
              Clear tags
            </Button>
          )}
        </div>
      )}

      {selected.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-2 rounded-md border border-border bg-card p-2 text-sm">
          <span className="px-1">{selected.length} selected</span>
          {STATUSES.map((s) => (
            <Button
              key={s}
              size="sm"
              variant="outline"
              onClick={async () => {
                await bulkSetStatus({ ids: selected, status: s });
                setSelected([]);
                invalidate();
              }}
            >
              Mark {STATUS_LABEL[s].toLowerCase()}
            </Button>
          ))}
          <Button size="sm" variant="ghost" onClick={() => setSelected([])}>
            Clear
          </Button>
        </div>
      )}

      {isLoading ? (
        <p className="mt-10 text-sm text-muted-foreground">Loading your library…</p>
      ) : visible.length === 0 ? (
        <div className="mt-16 text-center">
          <FileText className="mx-auto h-8 w-8 text-muted-foreground" />
          <p className="mt-3 font-display text-lg">Nothing here yet</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Add your first paper to start the pile.
          </p>
          <Button className="mt-5" onClick={() => setAddOpen(true)}>
            <Plus className="h-4 w-4" /> Add paper
          </Button>
        </div>
      ) : view === "cards" ? (
        <div className="mt-6 grid gap-4 md:grid-cols-2">
          {visible.map((item) => (
            <PaperCard
              key={item.paper_id}
              item={item}
              selected={selected.includes(item.paper_id)}
              onToggle={() => toggle(item.paper_id)}
              onPatch={(values) => update.mutate({ paperId: item.paper_id, values })}
              onEdit={() => setEditing(item)}
              onRemove={async () => {
                await removeFromLibrary({ paperId: item.paper_id });
                invalidate();
              }}
            />
          ))}
        </div>
      ) : view === "table" ? (
        <div className="mt-6 overflow-x-auto">
          <table className="w-full min-w-[900px] border-separate border-spacing-0 text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="w-10 border-b border-border py-3 pr-2" />
                <th className="min-w-[280px] border-b border-border py-3 pr-6">Title</th>
                <th className="w-16 border-b border-border py-3 pr-6">Year</th>
                <th className="w-36 border-b border-border py-3 pr-6">Status</th>
                <th className="w-36 border-b border-border py-3 pr-6">Importance</th>
                <th className="w-28 border-b border-border py-3 pr-6">Rating</th>
                <th className="min-w-[160px] border-b border-border py-3">Tags</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((i) => (
                <tr key={i.paper_id} className="align-top hover:bg-muted/30">
                  <td className="border-b border-border/60 py-3 pr-2">
                    <Checkbox
                      checked={selected.includes(i.paper_id)}
                      onCheckedChange={() => toggle(i.paper_id)}
                      aria-label="Select paper"
                    />
                  </td>
                  <td className="border-b border-border/60 py-3 pr-6">
                    <Link
                      to="/papers/$id"
                      params={{ id: i.paper_id }}
                      className="font-medium hover:underline"
                    >
                      {i.paper.title}
                    </Link>
                    <div className="text-xs text-muted-foreground">
                      {i.paper.authors.slice(0, 3).join(", ")}
                      {i.paper.authors.length > 3 ? " et al." : ""}
                    </div>
                  </td>
                  <td className="border-b border-border/60 py-3 pr-6 text-muted-foreground">
                    {i.paper.year ?? "—"}
                  </td>
                  <td className="border-b border-border/60 py-3 pr-6">
                    <StatusSelect
                      value={i.status}
                      onChange={(v) =>
                        update.mutate({ paperId: i.paper_id, values: statusPatch(v) })
                      }
                    />
                  </td>
                  <td className="border-b border-border/60 py-3 pr-6">
                    <ImportanceSelect
                      value={i.importance}
                      onChange={(v) =>
                        update.mutate({ paperId: i.paper_id, values: { importance: v } })
                      }
                    />
                  </td>
                  <td className="border-b border-border/60 py-3 pr-6">
                    <StarRating
                      value={i.rating}
                      size={14}
                      onChange={(v) =>
                        update.mutate({ paperId: i.paper_id, values: { rating: v } })
                      }
                    />
                  </td>
                  <td className="border-b border-border/60 py-3">
                    <div className="flex flex-wrap gap-1">
                      {i.tags.map((t) => (
                        <TagBadge key={t} tag={t} />
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="mt-6 grid gap-4 lg:grid-cols-4">
          {STATUSES.map((s) => (
            <div key={s} className="rounded-md border border-border bg-card/40 p-3">
              <h2
                className={cn(
                  "mb-3 inline-flex rounded px-2 py-0.5 text-xs font-medium",
                  STATUS_CLASS[s],
                )}
              >
                {STATUS_LABEL[s]} · {visible.filter((i) => i.status === s).length}
              </h2>
              <div className="space-y-2">
                {visible
                  .filter((i) => i.status === s)
                  .map((i) => (
                    <div
                      key={i.paper_id}
                      className="rounded border border-border bg-background p-2"
                    >
                      <Link
                        to="/papers/$id"
                        params={{ id: i.paper_id }}
                        className="line-clamp-3 text-sm font-medium hover:underline"
                      >
                        {i.paper.title}
                      </Link>
                      <div className="mt-2 flex items-center gap-2">
                        <ImportanceSelect
                          value={i.importance}
                          onChange={(v) =>
                            update.mutate({ paperId: i.paper_id, values: { importance: v } })
                          }
                        />
                        <StarRating
                          value={i.rating}
                          size={12}
                          onChange={(v) =>
                            update.mutate({ paperId: i.paper_id, values: { rating: v } })
                          }
                        />
                      </div>
                      <div className="mt-2">
                        <StatusSelect
                          value={i.status}
                          onChange={(v) =>
                            update.mutate({ paperId: i.paper_id, values: statusPatch(v) })
                          }
                        />
                      </div>
                    </div>
                  ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <PaperFormDialog open={addOpen} onOpenChange={setAddOpen} />
      <PaperFormDialog
        open={!!editing}
        onOpenChange={(v) => !v && setEditing(undefined)}
        item={editing}
      />
    </AppShell>
  );
}

function statusPatch(next: PaperStatus): Record<string, unknown> {
  const values: Record<string, unknown> = { status: next };
  if (next === "reading") values.started_at = new Date().toISOString();
  if (next === "read") values.finished_at = new Date().toISOString();
  return values;
}

function PaperCard({
  item,
  selected,
  onToggle,
  onPatch,
  onEdit,
  onRemove,
}: {
  item: LibraryItem;
  selected: boolean;
  onToggle: () => void;
  onPatch: (values: Record<string, unknown>) => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const [showAbstract, setShowAbstract] = useState(false);
  const [showNotes, setShowNotes] = useState(false);
  const [notes, setNotes] = useState(item.notes ?? "");
  // Whitespace alone isn't a note.
  const hasNotes = Boolean(item.notes?.trim());

  return (
    <article className="flex flex-col rounded-md border border-border bg-card p-4">
      <div className="flex items-start gap-3">
        <Checkbox
          checked={selected}
          onCheckedChange={onToggle}
          aria-label="Select paper"
          className="mt-1"
        />
        <div className="min-w-0 flex-1">
          <Link
            to="/papers/$id"
            params={{ id: item.paper_id }}
            className="font-display text-lg leading-snug hover:underline"
          >
            {item.paper.title}
          </Link>
          <p className="mt-1 text-xs text-muted-foreground">
            {item.paper.authors.slice(0, 4).join(", ") || "Unknown authors"}
            {item.paper.authors.length > 4 ? " et al." : ""}
            {item.paper.year ? ` · ${item.paper.year}` : ""}
            {item.paper.venue ? ` · ${item.paper.venue}` : ""}
          </p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <StatusSelect value={item.status} onChange={(v) => onPatch(statusPatch(v))} />
        <ImportanceSelect value={item.importance} onChange={(v) => onPatch({ importance: v })} />
        <StarRating value={item.rating} size={15} onChange={(v) => onPatch({ rating: v })} />
        <button
          type="button"
          onClick={() => onPatch({ recommend: !item.recommend })}
          aria-pressed={item.recommend}
          title="Would recommend"
          className={cn(
            "inline-flex items-center gap-1 rounded border px-2 py-1 text-xs transition-colors",
            item.recommend
              ? "border-status-read/40 bg-status-read/15 text-status-read"
              : "border-border text-muted-foreground hover:text-foreground",
          )}
        >
          <ThumbsUp className="h-3.5 w-3.5" /> Recommend
        </button>
      </div>

      {item.tags.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {item.tags.map((t) => (
            <TagBadge key={t} tag={t} />
          ))}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
        {item.paper.abstract && (
          <button
            type="button"
            onClick={() => setShowAbstract((v) => !v)}
            aria-expanded={showAbstract}
            className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-muted-foreground hover:text-foreground"
          >
            <ChevronDown
              className={cn("h-3.5 w-3.5 transition-transform", showAbstract && "rotate-180")}
            />
            Abstract
          </button>
        )}
        <button
          type="button"
          onClick={() => setShowNotes((v) => !v)}
          aria-expanded={showNotes}
          className={cn(
            "inline-flex items-center gap-1 rounded border px-2 py-1 transition-colors",
            // Green once there are notes, the same "done" green as Recommend,
            // so a card with notes stands out at a glance.
            hasNotes
              ? "border-status-read/40 bg-status-read/15 text-status-read"
              : "border-border text-muted-foreground hover:text-foreground",
          )}
        >
          <NotebookPen className="h-3.5 w-3.5" />
          {hasNotes ? "Notes taken" : "Add notes"}
        </button>
      </div>

      {showAbstract && item.paper.abstract && (
        <p className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded border border-border bg-background p-3 text-xs leading-relaxed text-muted-foreground">
          {item.paper.abstract}
        </p>
      )}

      {showNotes && (
        <div className="mt-2">
          <Textarea
            rows={4}
            value={notes}
            placeholder="Your notes on this paper…"
            onChange={(e) => setNotes(e.target.value)}
            className="text-sm"
          />
          <div className="mt-2 flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setNotes(item.notes ?? "");
                setShowNotes(false);
              }}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={notes === (item.notes ?? "")}
              onClick={() => {
                onPatch({ notes: notes.trim() || null });
                setShowNotes(false);
              }}
            >
              Save notes
            </Button>
          </div>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-border pt-3 text-xs text-muted-foreground">
        {item.highlight_count > 0 && (
          <span className="inline-flex items-center gap-1 text-imp-high">
            <Highlighter className="h-3.5 w-3.5" /> Highlights applied
          </span>
        )}
        {item.comment_count > 0 && (
          <span className="inline-flex items-center gap-1 text-status-reading">
            <MessageSquare className="h-3.5 w-3.5" /> Comments taken
          </span>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-1">
          {item.paper.pdf_url && (
            <Button asChild variant="outline" size="sm">
              <Link to="/read/$id" params={{ id: item.paper_id }}>
                Open Reader
              </Link>
            </Button>
          )}
          {item.paper.url && (
            <Button asChild variant="ghost" size="sm">
              <a href={item.paper.url} target="_blank" rel="noreferrer" className="gap-1">
                Source <ExternalLink className="h-3 w-3" />
              </a>
            </Button>
          )}
          {item.paper.pdf_url && (
            <Button asChild variant="ghost" size="sm">
              <a href={item.paper.pdf_url} target="_blank" rel="noreferrer" className="gap-1">
                PDF <ExternalLink className="h-3 w-3" />
              </a>
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={onEdit}>
            Edit
          </Button>
          <Button variant="ghost" size="sm" onClick={onRemove}>
            Remove
          </Button>
        </div>
      </div>
    </article>
  );
}