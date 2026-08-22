import { createFileRoute, Link } from "@tanstack/react-router";
import { lazy, Suspense, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ClientOnly } from "@tanstack/react-router";
import { ArrowLeft, Trash2 } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { getLibraryItem } from "@/lib/papers";
import {
  createAnnotation,
  deleteAnnotation,
  listAnnotations,
  updateAnnotation,
} from "@/lib/annotations";
import { BRAND } from "@/lib/brand";

const PdfReader = lazy(() =>
  import("@/components/pdf-reader").then((m) => ({ default: m.PdfReader })),
);

export const Route = createFileRoute("/_authenticated/read/$id")({
  head: () => ({
    meta: [
      { title: `Reader — ${BRAND}` },
      { name: "description", content: "Read the PDF with your highlights and comments beside it." },
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

function ReaderPage() {
  const { id } = Route.useParams();
  const queryClient = useQueryClient();

  const [activeId, setActiveId] = useState<string | null>(null);

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

  const comments = annotations.filter((a) => a.comment && a.comment.trim());

  if (!item)
    return (
      <AppShell>
        <p className="text-sm text-muted-foreground">Loading…</p>
      </AppShell>
    );
  if (!item.paper.pdf_url)
    return (
      <AppShell>
        <p className="text-sm">No PDF link on this paper yet. Add one from the paper page.</p>
      </AppShell>
    );

  return (
    <AppShell>
      <Link
        to="/papers/$id"
        params={{ id }}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> {item.paper.title}
      </Link>

      <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,1fr)_14rem]">
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
                onSelectAnnotation={setActiveId}
                onCreate={async (input) => {
                  await createAnnotation({
                    paperId: id,
                    page: input.page,
                    kind: input.comment ? "note" : "highlight",
                    quote: input.quote,
                    comment: input.comment,
                    color: input.color,
                    rects: input.rects,
                  });
                  invalidate();
                }}
                onComment={async (annotationId, text) => {
                  await updateAnnotation({ id: annotationId, comment: text });
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

        <aside className="space-y-2">
          <h2 className="font-display text-xs uppercase tracking-wide text-muted-foreground">
            Comments ({comments.length})
          </h2>
          {comments.length === 0 && (
            <p className="text-xs text-muted-foreground">
              Select text and choose Comment, or click a highlight to add one.
            </p>
          )}
          <div className="max-h-[72vh] space-y-1.5 overflow-auto pr-1">
            {comments.map((a) => (
              <div
                key={a.id}
                onMouseEnter={() => setActiveId(a.id)}
                onMouseLeave={() => setActiveId(null)}
                className="rounded-md border border-border p-2 text-xs"
              >
                {a.quote && (
                  <p className="line-clamp-2 border-l-2 border-primary pl-2 italic text-muted-foreground">
                    {a.quote}
                  </p>
                )}
                {a.comment && <p className="mt-1">{a.comment}</p>}
                <div className="mt-1.5 flex items-center justify-between text-muted-foreground">
                  <span>p.{a.page}</span>
                  <button
                    type="button"
                    aria-label="Delete comment"
                    title="Delete comment (keeps the highlight)"
                    onClick={async () => {
                      await updateAnnotation({ id: a.id, comment: null });
                      invalidate();
                    }}
                    className="hover:text-foreground"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </aside>
      </div>
    </AppShell>
  );
}
