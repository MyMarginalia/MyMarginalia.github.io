import { memo, type CSSProperties } from "react";
import { Page } from "react-pdf";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Annotation } from "@/lib/paper-types";
import { HIGHLIGHT_ALPHA, HIGHLIGHT_HEX } from "@/components/reader/highlight-menu";
import type { Caret } from "@/components/reader/use-caret-navigation";

// react-pdf's own Page isn't memoized, so it — and its text and annotation
// layers, which together own on the order of a thousand DOM nodes per page —
// re-renders whenever anything in the reader changes. Memoizing it here means
// it is skipped unless its own props actually change.
const MemoizedPage = memo(Page);

/** Stable identity so a page with no highlights doesn't re-render every time. */
export const NO_ANNOTATIONS: Annotation[] = [];

export type PageLoadInfo = { width: number; height: number; originalHeight: number };

/**
 * One page: canvas, text layer, highlights and caret.
 *
 * Everything expensive per page lives here rather than inline in the reader,
 * so that a caret move or a hover — which only ever affect one page — don't
 * re-run the JSX for every page in the document.
 */
export const PdfPageView = memo(function PdfPageView({
  pageNumber,
  isVisible,
  pageWidth,
  placeholderHeight,
  renderDpr,
  onLoadSuccess,
  annotations,
  activeId,
  caret,
}: {
  pageNumber: number;
  isVisible: boolean;
  pageWidth: number;
  placeholderHeight: number;
  renderDpr: number;
  onLoadSuccess: (page: PageLoadInfo) => void;
  annotations: Annotation[];
  activeId?: string | null;
  caret: Caret | null;
}) {
  // Identical footprint whether the page is unmounted, mounting or rendered.
  // react-pdf's default loading state is a line of text a few pixels tall, so
  // without this a page collapses by its whole height the instant it mounts
  // and grows back when it finishes — shifting everything below it by ~1000px,
  // which threw scroll positions off and made scrolling visibly jumpy.
  const placeholder = (
    <div
      className="flex items-center justify-center bg-card"
      style={{ width: pageWidth, height: placeholderHeight }}
    >
      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
    </div>
  );

  return (
    <>
      {isVisible ? (
        <MemoizedPage
          pageNumber={pageNumber}
          width={pageWidth}
          devicePixelRatio={renderDpr}
          renderAnnotationLayer
          onLoadSuccess={onLoadSuccess}
          loading={placeholder}
          error={placeholder}
          noData={placeholder}
        />
      ) : (
        placeholder
      )}

      {caret && (
        <span
          className="pdf-caret"
          style={{ top: caret.top, left: caret.left, height: caret.height }}
        />
      )}

      <div className="pdf-highlight-layer">
        {annotations.map((a) => (
          <div
            key={a.id}
            data-annotation={a.id}
            className={cn("pdf-highlight-group", activeId === a.id && "is-active")}
            // Drives the group's opacity, so the active-state bump stays in
            // CSS rather than being overridden by an inline opacity here.
            style={
              {
                "--highlight-alpha": HIGHLIGHT_ALPHA[a.color] ?? 0.32,
              } as CSSProperties
            }
          >
            {a.rects.map((r, i) => (
              <span
                key={i}
                className="pdf-highlight"
                title={a.comment ?? a.quote ?? "Highlight"}
                style={{
                  left: `${r.x * 100}%`,
                  top: `${r.y * 100}%`,
                  width: `${r.w * 100}%`,
                  height: `${r.h * 100}%`,
                  background: HIGHLIGHT_HEX[a.color] ?? HIGHLIGHT_HEX.yellow,
                }}
              />
            ))}
          </div>
        ))}
        {/* Outside the groups: a marker inside one would inherit the group's
            faded, multiplied compositing and all but disappear. */}
        {annotations.map((a) =>
          a.comment ? <span key={a.id} className="pdf-note-dot" style={notePin(a)} /> : null,
        )}
      </div>
    </>
  );
});

/** A small marker on annotated highlights, so notes are findable at a glance. */
function notePin(a: Annotation): CSSProperties {
  const first = a.rects[0];
  if (!first) return { display: "none" };
  return { left: `${first.x * 100}%`, top: `${first.y * 100}%` };
}
