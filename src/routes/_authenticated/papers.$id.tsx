import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ChevronDown, ExternalLink, Highlighter, MessageSquare, ThumbsUp } from "lucide-react";
import { toast } from "sonner";
import { AppShell } from "@/components/app-shell";
import { PaperFormDialog } from "@/components/paper-form";
import { StarRating } from "@/components/star-rating";
import { ImportanceSelect, StatusSelect } from "@/components/paper-controls";
import { TagInput } from "@/components/tag-input";
import { useAllTags } from "@/hooks/use-all-tags";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { getLibraryItem, removeFromLibrary, updateUserPaper } from "@/lib/papers";
import { listAnnotations } from "@/lib/annotations";
import type { PaperStatus } from "@/lib/paper-types";
import { BRAND } from "@/lib/brand";

export const Route = createFileRoute("/_authenticated/papers/$id")({
  head: () => ({
    meta: [
      { title: `Paper — ${BRAND}` },
      { name: "description", content: "Notes, rating and importance for a paper in your library." },
      { property: "og:title", content: `Paper — ${BRAND}` },
      { property: "og:description", content: "Notes, rating and importance for a paper in your library." },
    ],
  }),
  component: PaperDetail,
  errorComponent: ({ error }) => <div role="alert" className="p-10 text-sm">{error.message}</div>,
  notFoundComponent: () => <div className="p-10">Paper not found.</div>,
});

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="rule-under pb-1 font-display text-sm uppercase tracking-wide text-muted-foreground">
        {title}
      </h2>
      <div className="mt-3 text-sm leading-relaxed">{children}</div>
    </section>
  );
}

function statusPatch(next: PaperStatus, startedAt: string | null): Record<string, unknown> {
  const values: Record<string, unknown> = { status: next };
  if (next === "reading" && !startedAt) values.started_at = new Date().toISOString();
  if (next === "read") values.finished_at = new Date().toISOString();
  return values;
}

function PaperDetail() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [editOpen, setEditOpen] = useState(false);
  const [abstractOpen, setAbstractOpen] = useState(true);
  const allTags = useAllTags();

  const { data: item, isLoading } = useQuery({
    queryKey: ["library", id],
    queryFn: () => getLibraryItem({ paperId: id }),
  });

  const { data: annotations = [] } = useQuery({
    queryKey: ["annotations", id],
    queryFn: () => listAnnotations({ paperId: id }),
  });

  const patch = useMutation({
    mutationFn: (values: Record<string, unknown>) =>
      updateUserPaper({ paperId: id, values: values as never }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["library"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const removeMutation = useMutation({
    mutationFn: () => removeFromLibrary({ paperId: id }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["library"] });
      navigate({ to: "/library" });
    },
  });

  if (isLoading) return <AppShell><p className="text-sm text-muted-foreground">Loading…</p></AppShell>;
  if (!item) return <AppShell><p>Paper not found.</p></AppShell>;

  const paper = item.paper;
  const comments = annotations.filter((a) => a.comment && a.comment.trim());
  const highlights = annotations.filter((a) => a.kind === "highlight");

  return (
    <AppShell>
      <Link to="/library" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Library
      </Link>

      <header className="mt-4 rule-under pb-5">
        <h1 className="font-display text-3xl leading-tight">{paper.title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {paper.authors.join(", ") || "Unknown authors"}
          {paper.year ? ` · ${paper.year}` : ""}
          {paper.venue ? ` · ${paper.venue}` : ""}
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <StatusSelect
            value={item.status}
            onChange={(v) => patch.mutate(statusPatch(v, item.started_at))}
            className="h-9"
          />
          <ImportanceSelect
            value={item.importance}
            onChange={(v) => patch.mutate({ importance: v })}
            className="h-9"
          />
          <StarRating value={item.rating} size={18} onChange={(v) => patch.mutate({ rating: v })} />
          <button
            type="button"
            onClick={() => patch.mutate({ recommend: !item.recommend })}
            aria-pressed={item.recommend}
            className={cn(
              "inline-flex items-center gap-1.5 rounded border px-2.5 py-1.5 text-xs transition-colors",
              item.recommend
                ? "border-status-read/40 bg-status-read/15 text-status-read"
                : "border-border text-muted-foreground hover:text-foreground",
            )}
          >
            <ThumbsUp className="h-3.5 w-3.5" />
            {item.recommend ? "Would recommend" : "Mark as recommended"}
          </button>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-4 text-sm">
          {paper.pdf_url && (
            <Link to="/read/$id" params={{ id }} className="text-primary underline">
              Open Reader
            </Link>
          )}
          {paper.url && (
            <a href={paper.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary underline">
              Source <ExternalLink className="h-3 w-3" />
            </a>
          )}
          {paper.pdf_url && (
            <a href={paper.pdf_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary underline">
              PDF <ExternalLink className="h-3 w-3" />
            </a>
          )}
          <button type="button" onClick={() => setEditOpen(true)} className="text-primary underline">
            Edit
          </button>
          <button
            type="button"
            onClick={() => removeMutation.mutate()}
            className="text-destructive underline"
          >
            Remove
          </button>
          {paper.doi && <span className="font-mono text-xs text-muted-foreground">{paper.doi}</span>}
        </div>
      </header>

      <div className="grid gap-8 md:grid-cols-[2fr_1fr]">
        <div>
          {paper.abstract && (
            <section className="mt-8">
              <button
                type="button"
                onClick={() => setAbstractOpen((v) => !v)}
                aria-expanded={abstractOpen}
                className="rule-under flex w-full items-center justify-between pb-1 font-display text-sm uppercase tracking-wide text-muted-foreground hover:text-foreground"
              >
                Abstract
                <ChevronDown
                  className={cn("h-4 w-4 transition-transform", abstractOpen && "rotate-180")}
                />
              </button>
              {abstractOpen && (
                <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
                  {paper.abstract}
                </p>
              )}
            </section>
          )}

          {item.notes && <Section title="Notes"><p className="whitespace-pre-wrap">{item.notes}</p></Section>}
        </div>

        <aside>
          <Section title="Tags">
            <TagInput value={item.tags} onChange={(v) => patch.mutate({ tags: v })} suggestions={allTags} />
          </Section>
          <Section title="Record">
            <div className="space-y-1.5 text-xs text-muted-foreground">
              <p>Added {new Date(item.created_at).toLocaleDateString()}</p>
              {item.started_at && <p>Started {new Date(item.started_at).toLocaleDateString()}</p>}
              {item.finished_at && <p>Finished {new Date(item.finished_at).toLocaleDateString()}</p>}
            </div>
          </Section>
          <Section title="Marginalia">
            <div className="flex flex-wrap gap-2">
              <span className="inline-flex items-center gap-1.5 rounded border border-border bg-muted/40 px-2.5 py-1.5 text-sm font-medium">
                <Highlighter className="h-4 w-4 text-primary" /> {highlights.length} highlight
                {highlights.length === 1 ? "" : "s"}
              </span>
              <span className="inline-flex items-center gap-1.5 rounded border border-border bg-muted/40 px-2.5 py-1.5 text-sm font-medium">
                <MessageSquare className="h-4 w-4 text-primary" /> {comments.length} comment
                {comments.length === 1 ? "" : "s"}
              </span>
            </div>
          </Section>
          {item.recommend && (
            <Section title="Verdict">
              <Badge variant="outline" className="border-status-read/30 bg-status-read/15 font-normal text-status-read">
                Would recommend
              </Badge>
            </Section>
          )}
        </aside>
      </div>

      <PaperFormDialog open={editOpen} onOpenChange={setEditOpen} item={item} />
    </AppShell>
  );
}