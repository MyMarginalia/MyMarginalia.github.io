import { createFileRoute, Link } from "@tanstack/react-router";
import { lazy, Suspense, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ClientOnly } from "@tanstack/react-router";
import { ArrowLeft, MessageSquare, PanelRight, Trash2 } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";
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

const readerLoading = (
  <div className="grid h-full place-items-center text-sm text-muted-foreground">
    Loading reader…
  </div>
);

function ReaderPage() {
  const { id } = Route.useParams();
  const queryClient = useQueryClient();

  const [activeId, setActiveId] = useState<string | null>(null);
  const [jumpTo, setJumpTo] = useState<{ id: string; nonce: number } | null>(
    null,
  );
  const [filter, setFilter] = useState<Filter>("all");
  // Open beside the page on wide screens; a drawer you summon on narrow ones.
  const [panelOpen, setPanelOpen] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(min-width: 1024px)").matches,
  );

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

  const backLink = (
    <Link
      to="/papers/$id"
      params={{ id }}
      title="Back to paper"
      className="flex min-w-0 items-center gap-2 rounded-md py-1 pr-2 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="h-4 w-4 shrink-0" />
      <span className="hidden truncate md:inline">{item.paper.title}</span>
    </Link>
  );

  const toolbarActions = (
    <>
      <Button
        variant="ghost"
        size="sm"
        aria-pressed={panelOpen}
        onClick={() => setPanelOpen((v) => !v)}
        className={cn("gap-1.5", panelOpen && "bg-muted")}
      >
        <PanelRight className="h-4 w-4" />
        <span className="hidden sm:inline">Highlights ({annotations.length})</span>
        <span className="sm:hidden">{annotations.length}</span>
      </Button>
      <ThemeToggle />
    </>
  );

  return (
    // The reader owns the whole window, like a dedicated PDF viewer: no site
    // header or footer, one toolbar, and the page scrolls inside the pane
    // rather than the window.
    <div className="relative flex h-dvh min-h-0 overflow-hidden bg-background">
      <div className="min-w-0 flex-1">
        <ClientOnly fallback={readerLoading}>
          <Suspense fallback={readerLoading}>
            <PdfReader
              key={item.paper.pdf_url}
              url={item.paper.pdf_url}
              storageKey={`marginalia:reading-position:${id}`}
              header={backLink}
              actions={toolbarActions}
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

      {panelOpen && (
        <aside
          className={cn(
            "flex w-72 max-w-[85vw] flex-col border-l border-border bg-background",
            // Below lg it floats over the page under the toolbar; from lg up
            // it takes its own column and the page narrows to make room.
            "absolute bottom-0 right-0 top-12 z-30 shadow-xl",
            "lg:static lg:z-auto lg:shrink-0 lg:shadow-none",
          )}
        >
          <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-3">
            <h2 className="font-display text-sm font-medium">Highlights</h2>
            <div className="flex gap-1 text-xs">
              {(
                [
                  ["all", `All (${annotations.length})`],
                  ["notes", `Notes (${noteCount})`],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setFilter(value)}
                  className={cn(
                    "rounded px-1.5 py-0.5",
                    filter === value
                      ? "bg-muted text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="min-h-0 flex-1 space-y-1.5 overflow-auto p-3">
            {shown.length === 0 && (
              <p className="text-xs text-muted-foreground">
                Select text in the PDF, then pick a colour to highlight it — or
                choose Note to add a comment at the same time.
              </p>
            )}

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
      )}
    </div>
  );
}
