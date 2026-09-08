import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, Highlighter, LibraryBig, ShieldCheck, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { BRAND } from "@/lib/brand";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: `${BRAND} — Private Research Paper Tracker` },
      {
        name: "description",
        content:
          "Save research papers with a DOI or link, track what you've read, rate what mattered, and highlight PDFs with private in-browser notes.",
      },
      { property: "og:title", content: `${BRAND} — A private library for the papers you read` },
      {
        property: "og:description",
        content:
          "Track, rate and annotate every paper you read — 100% private, local-first library with a built-in PDF reader.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

const FEATURES = [
  {
    icon: LibraryBig,
    title: "One shelf for everything",
    body: "Paste a DOI, arXiv ID or link — the title, authors and abstract fill themselves in automatically.",
  },
  {
    icon: Star,
    title: "Know what mattered",
    body: "Status, importance, star ratings and custom tags, editable straight from your cards or table view.",
  },
  {
    icon: Highlighter,
    title: "Read and annotate here",
    body: "A built-in PDF reader with color-coded highlights and margin comments saved directly on your device.",
  },
  {
    icon: ShieldCheck,
    title: "100% Private & Local",
    body: "All papers and annotations persist directly in your browser's IndexedDB. No accounts, no cloud sync, no tracking.",
  },
];

function Index() {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <SiteHeader />

      <main className="mx-auto w-full max-w-6xl flex-1 px-5 pb-20 pt-16">
        <h1 className="max-w-3xl font-display text-4xl leading-[1.1] sm:text-6xl">
          A private library for the research papers you read.
        </h1>
        <p className="mt-5 max-w-xl text-lg leading-relaxed text-muted-foreground">
          Track what you want to read, are reading, and have read — with ratings, tags, and PDF
          highlights that never leave your computer.
        </p>

        <div className="mt-8 flex flex-wrap items-center gap-3">
          <Button asChild size="lg" className="gap-2">
            <Link to="/library">
              My Library <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link to="/account">Settings & Backups</Link>
          </Button>
        </div>

        <p className="mt-4 text-xs text-muted-foreground">
          Your data lives exclusively in this browser. You can export or restore a full JSON backup anytime from Settings.
        </p>

        <div className="mt-16 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map((f) => (
            <div key={f.title} className="rounded-md border border-border bg-card p-5">
              <f.icon className="h-5 w-5 text-primary" />
              <h2 className="mt-3 font-display text-lg">{f.title}</h2>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{f.body}</p>
            </div>
          ))}
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
