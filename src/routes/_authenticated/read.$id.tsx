import { createFileRoute, Link } from "@tanstack/react-router";
import { lazy, Suspense, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ClientOnly } from "@tanstack/react-router";
import { ArrowLeft, MessageSquare, Trash2 } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { getLibraryItem } from "@/lib/papers";
import {
  createAnnotation,
  deleteAnnotation,
  listAnnotations,
  updateAnnotation,
} from "@/lib/annotations";
import { HIGHLIGHT_HEX } from "@/components/reader/highlight-menu";
import { BRAND } from "@/lib/brand";
import { cn } from "@/lib/utils";

const PdfReader = lazy(() =>
  import("@/components/pdf-reader").then((m) => ({ default: m.PdfReader })),
);

export const Route = createFileRoute("/_authenticated/read/$id")({
  head: () => ({
    meta: [
      { title: `Reader — ${BRAND}` },
      {
        name: "description",
        content: "Read the PDF with your highlights and comments beside it.",
      },
      { property: "og:title", content: `Reader — ${BRAND}` },
      {
        property: "og:description",
        content: "Read the PDF with your highlights and comments beside it.",
      },
    ],
  }),
  component: ReaderPage,
  errorComponent: ({ error }) => (
    <div role="alert" className="p-10 text-sm">
      {error.message}
    </div>
  ),
  notFoundComponent: () => <div className="p-10">Paper not found.</div>,
});

type Filter = "all" | "notes";

function ReaderPage() {
  const { id } = Route.useParams();
  const queryClient = useQueryClient();

  const [activeId, setActiveId] = useState<string | null>(null);
  const [jumpTo, setJumpTo] = useState<{ id: string; nonce: number } | null>(
    null,
  );
  const [filter, setFilter] = useState<Filter>("all");

  const { data: item } = useQuery({
    queryKey: ["library", id],
    queryFn: () => getLibraryItem({ paperId: id }),
  });
  const { data: annotations = [] } = useQuery({
    queryKey: ["annotations", id],
    queryFn: () => listAnnotations({ paperId: id }),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["annotations", id] });
    queryClient.invalidateQueries({ queryKey: ["library"] });
  };

  const noteCount = annotations.filter(
    (a) => a.comment && a.comment.trim(),
  ).length;
  const shown = (
    filter === "notes"
      ? annotations.filter((a) => a.comment?.trim())
      : annotations
  )
    .slice()
    .sort(
      (a, b) => a.page - b.page || a.created_at.localeCompare(b.created_at),
    );

  if (!item)
    return (
      <AppShell>
        <p className="text-sm text-muted-foreground">Loading…</p>
      </AppShell>
    );
  if (!item.paper.pdf_url)
    return (
      <AppShell>
        <p className="text-sm">
          No PDF link on this paper yet. Add one from the paper page.
        </p>
      </AppShell>
    );

  return (
    <AppShell wide>
      {/* Shrink-to-content and centred: the reader's frame is capped at a
          comfortable reading width, so a full-width column would leave it
          floating in the middle with the title and sidebar aligned to the
          column's edges rather than the frame's. */}
      <div className="mx-auto w-full lg:w-fit">
        <Link
          to="/papers/$id"
          params={{ id }}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" /> {item.paper.title}
        </Link>

        <div className="mt-4 flex flex-col gap-3 lg:flex-row lg:items-stretch">
          <div className="min-w-0">
            <ClientOnly
              fallback={
                <div className="rounded-md border border-border bg-card p-8 text-sm text-muted-foreground">
                  Loading reader…
                </div>
              }
            >
              <Suspense
                fallback={
                  <div className="rounded-md border border-border bg-card p-8 text-sm text-muted-foreground">
                    Loading reader…
                  </div>
                }
              >
                <PdfReader
                  url={item.paper.pdf_url}
                  annotations={annotations}
                  activeId={activeId}
                  jumpTo={jumpTo}
                  onSelectAnnotation={setActiveId}
                  onCreate={async ({ groups, color, comment }) => {
                    // A selection spanning a page break arrives as one group per
                    // page; each becomes its own highlight, since an annotation
                    // is anchored to a single page.
                    for (const group of groups) {
                      await createAnnotation({
                        paperId: id,
                        page: group.page,
                        kind: comment ? "note" : "highlight",
                        quote: group.quote,
                        comment,
                        color,
                        rects: group.rects,
                      });
                    }
                    invalidate();
                  }}
                  onUpdate={async (annotationId, patch) => {
                    await updateAnnotation({ id: annotationId, ...patch });
                    invalidate();
                  }}
                  onDelete={async (annotationId) => {
                    await deleteAnnotation({ id: annotationId });
                    invalidate();
                  }}
                />
              </Suspense>
            </ClientOnly>
          </div>

          {/* The panel is taken out of flow at lg and up so its own content
              can't stretch the row: otherwise a long list makes the sidebar
              taller than the reader and grows down past it instead of
              capping at the reader's height and scrolling. The wrapper still
              stretches to the row, and the panel fills it. */}
          <div className="relative w-full shrink-0 lg:w-64">
            <aside className="flex min-h-0 w-full flex-col gap-2 lg:absolute lg:inset-0">
              <div className="flex items-center justify-between">
                <h2 className="font-display text-xs uppercase tracking-wide text-muted-foreground">
                  Highlights ({annotations.length})
                </h2>
                <div className="flex gap-1 text-xs">
                  <button
                    type="button"
                    onClick={() => setFilter("all")}
                    className={cn(
                      "rounded px-1.5 py-0.5",
                      filter === "all"
                        ? "bg-muted text-foreground"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    All
                  </button>
                  <button
                    type="button"
                    onClick={() => setFilter("notes")}
                    className={cn(
                      "rounded px-1.5 py-0.5",
                      filter === "notes"
                        ? "bg-muted text-foreground"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    Notes ({noteCount})
                  </button>
                </div>
              </div>

              {shown.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  Select text in the PDF, then pick a colour to highlight it —
                  or choose Note to add a comment at the same time.
                </p>
              )}

              <div className="min-h-0 flex-1 space-y-1.5 overflow-auto pr-1">
                {shown.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    onMouseEnter={() => setActiveId(a.id)}
                    onMouseLeave={() => setActiveId(null)}
                    onClick={() => {
                      setActiveId(a.id);
                      // Carries a nonce so clicking the same entry twice scrolls
                      // to it again instead of being a no-op re-render.
                      setJumpTo({ id: a.id, nonce: Date.now() });
                    }}
                    className={cn(
                      "block w-full rounded-md border border-border p-2 text-left text-xs transition-colors hover:bg-muted/50",
                      activeId === a.id && "border-primary",
                    )}
                  >
                    <div className="flex items-start gap-1.5">
                      <span
                        aria-hidden
                        className="mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full border border-black/15"
                        style={{ background: HIGHLIGHT_HEX[a.color] }}
                      />
                      <div className="min-w-0 flex-1">
                        {a.quote && (
                          <p className="line-clamp-2 italic text-muted-foreground">
                            {a.quote}
                          </p>
                        )}
                        {a.comment && (
                          <p className="mt-1 line-clamp-3">{a.comment}</p>
                        )}
                      </div>
                    </div>
                    <div className="mt-1.5 flex items-center justify-between text-muted-foreground">
                      <span className="flex items-center gap-1">
                        p.{a.page}
                        {a.comment && <MessageSquare className="h-3 w-3" />}
                      </span>
                      <span
                        role="button"
                        tabIndex={0}
                        aria-label="Delete highlight"
                        title="Delete highlight"
                        onClick={async (e) => {
                          e.stopPropagation();
                          await deleteAnnotation({ id: a.id });
                          invalidate();
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ")
                            e.currentTarget.click();
                        }}
                        className="rounded p-0.5 hover:text-destructive"
                      >
                        <Trash2 className="h-3 w-3" />
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            </aside>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
