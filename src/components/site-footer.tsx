import { BRAND } from "@/lib/brand";

export function SiteFooter() {
  return (
    <footer className="mt-16 border-t border-border bg-card/40">
      <div className="mx-auto max-w-6xl px-5 py-8 text-sm text-muted-foreground">
        <p>
          © {new Date().getFullYear()} {BRAND} — Private & Local Research Library
        </p>
      </div>
    </footer>
  );
}
