import {
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { Page } from "react-pdf";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Annotation } from "@/lib/paper-types";
import { HIGHLIGHT_ALPHA, HIGHLIGHT_HEX } from "@/components/reader/highlight-menu";

// react-pdf's own Page isn't memoized, so it — and its text and annotation
// layers, which together own on the order of a thousand DOM nodes per page —
// re-renders whenever anything in the reader changes. Memoizing it here means
// it is skipped unless its own props actually change.
const MemoizedPage = memo(Page);

/** Stable identity so a page with no highlights doesn't re-render every time. */
export const NO_ANNOTATIONS: Annotation[] = [];

export type PageLoadInfo = {
  pageNumber: number;
  width: number;
  height: number;
  originalHeight: number;
};

/** One drawing of the page, at the width it was (or is being) drawn at. */
type Layer = { id: number; width: number; dpr: number; done: boolean; shown: boolean };

/**
 * Keeps the drawings of a page in step with the size the reader wants.
 *
 * Redrawing a page wipes its canvas, and a heavy page takes a while to draw
 * again, so redrawing in place makes the page blank out. Instead a new drawing
 * is made alongside the old one, kept hidden, and swapped in when it reports
 * done; the old one stays on screen until then. At most two exist at once:
 * the one on show and the one being drawn.
 */
function useRenderLayers(isVisible: boolean, width: number, dpr: number) {
  const [layers, setLayers] = useState<Layer[]>([]);
  const nextId = useRef(1);

  useLayoutEffect(() => {
    if (!isVisible) {
      setLayers((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    setLayers((prev) => {
      const latest = prev[prev.length - 1];
      if (latest && latest.width === width && latest.dpr === dpr) return prev;
      const drawn = [...prev].reverse().find((l) => l.done);
      // With nothing finished yet there is nothing worth keeping on screen:
      // start over at the new size. Otherwise keep the finished one visible
      // and draw the new one behind it, replacing any earlier unfinished try.
      const layer: Layer = { id: nextId.current++, width, dpr, done: false, shown: !drawn };
      return drawn ? [drawn, layer] : [layer];
    });
  }, [isVisible, width, dpr]);

  const onRendered = useCallback((id: number) => {
    setLayers((prev) =>
      prev.some((l) => l.id === id)
        ? prev.filter((l) => l.id >= id).map((l) => (l.id === id ? { ...l, done: true, shown: true } : l))
        : prev,
    );
  }, []);

  const onFailed = useCallback((id: number) => {
    // Keep what is on screen; only give up the attempt that failed.
    setLayers((prev) => (prev.length > 1 ? prev.filter((l) => l.id !== id) : prev));
  }, []);

  return { layers, onRendered, onFailed };
}

function Placeholder({ width, height }: { width: number; height: number }) {
  return (
    <div className="flex items-center justify-center bg-white" style={{ width, height }}>
      <Loader2 className="h-5 w-5 animate-spin text-neutral-400" />
    </div>
  );
}

/**
 * One drawing of a page, scaled from the width it was drawn at to the width
 * the page is laid out at now. Everything on it — bitmap, text layer, link
 * boxes — shares that one scale, so while a redraw is pending the page just
 * looks a little soft instead of coming apart (link boxes, in particular,
 * are sized for the scale they were drawn at and look wrong if only the
 * bitmap is stretched).
 */
const PageLayer = memo(function PageLayer({
  layer,
  pageNumber,
  pageWidth,
  heightPerWidth,
  onLoadSuccess,
  onRendered,
  onFailed,
}: {
  layer: Layer;
  pageNumber: number;
  pageWidth: number;
  heightPerWidth: number;
  onLoadSuccess: (page: PageLoadInfo) => void;
  onRendered: (id: number) => void;
  onFailed: (id: number) => void;
}) {
  const scale = pageWidth / layer.width;
  const onRenderSuccess = useCallback(() => onRendered(layer.id), [onRendered, layer.id]);
  const onRenderError = useCallback(() => onFailed(layer.id), [onFailed, layer.id]);
  // Sized in this layer's own units, and not depending on the zoom in progress,
  // so react-pdf's page isn't handed new props on every step of a zoom.
  const placeholder = useMemo(
    () => <Placeholder width={layer.width} height={layer.width * heightPerWidth} />,
    [layer.width, heightPerWidth],
  );
  return (
    <div
      className="pdf-layer"
      style={{
        width: layer.width,
        visibility: layer.shown ? undefined : "hidden",
        // No transform at rest: one would put the page in its own stacking
        // context for no reason.
        transform: scale === 1 ? undefined : `scale(${scale})`,
      }}
    >
      <MemoizedPage
        pageNumber={pageNumber}
        width={layer.width}
        devicePixelRatio={layer.dpr}
        renderAnnotationLayer
        onLoadSuccess={onLoadSuccess}
        onRenderSuccess={onRenderSuccess}
        onRenderError={onRenderError}
        loading={placeholder}
        error={placeholder}
        noData={placeholder}
      />
    </div>
  );
});

/**
 * One page: canvas, text layer and highlights.
 *
 * Everything expensive per page lives here rather than inline in the reader,
 * so that a hover or a new highlight — which only ever affect one page — don't
 * re-run the JSX for every page in the document.
 */
export const PdfPageView = memo(function PdfPageView({
  pageNumber,
  isVisible,
  pageWidth,
  renderWidth,
  placeholderHeight,
  renderDpr,
  onLoadSuccess,
  annotations,
  activeId,
}: {
  pageNumber: number;
  isVisible: boolean;
  /** The width this page is laid out at: follows a zoom instantly. */
  pageWidth: number;
  /** The width the page is drawn at: lags `pageWidth` while zooming. */
  renderWidth: number;
  placeholderHeight: number;
  renderDpr: number;
  onLoadSuccess: (page: PageLoadInfo) => void;
  annotations: Annotation[];
  activeId?: string | null;
}) {
  const { layers, onRendered, onFailed } = useRenderLayers(isVisible, renderWidth, renderDpr);
  // Rounded so float noise in the division doesn't read as a change.
  const heightPerWidth = Math.round((placeholderHeight / pageWidth) * 1e4) / 1e4;

  return (
    <>
      {isVisible && layers.length > 0 ? (
        layers.map((layer) => (
          <PageLayer
            key={layer.id}
            layer={layer}
            pageNumber={pageNumber}
            pageWidth={pageWidth}
            heightPerWidth={heightPerWidth}
            onLoadSuccess={onLoadSuccess}
            onRendered={onRendered}
            onFailed={onFailed}
          />
        ))
      ) : (
        // Identical footprint whether the page is unmounted, mounting or
        // rendered. react-pdf's default loading state is a line of text a few
        // pixels tall, so without this a page collapses by its whole height the
        // instant it mounts and grows back when it finishes — shifting
        // everything below it by ~1000px.
        <Placeholder width={pageWidth} height={placeholderHeight} />
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