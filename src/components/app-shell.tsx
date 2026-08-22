import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";
import { SiteFooter } from "@/components/site-footer";
import { BRAND } from "@/lib/brand";
import { cn } from "@/lib/utils";

export function AppShell({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="border-b border-border bg-card/60 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-6 px-5 py-3">
          <Link to="/" className="font-display text-lg font-semibold tracking-tight">
            {BRAND}
          </Link>
          <nav className="flex items-center gap-1 text-sm">
            <Link
              to="/library"
              className="rounded px-3 py-1.5 text-muted-foreground transition-colors hover:text-foreground"
              activeProps={{ className: "rounded px-3 py-1.5 text-foreground font-medium" }}
            >
              Library
            </Link>
            <Link
              to="/stats"
              className="rounded px-3 py-1.5 text-muted-foreground transition-colors hover:text-foreground"
              activeProps={{ className: "rounded px-3 py-1.5 text-foreground font-medium" }}
            >
              Insights
            </Link>
          </nav>
          <div className="ml-auto flex items-center gap-1">
            <ThemeToggle />
            <Button asChild variant="ghost" size="sm">
              <Link to="/account" className="gap-1.5">
                <Settings className="h-4 w-4" /> Settings
              </Link>
            </Button>
          </div>
        </div>
      </header>
      <main className={cn("mx-auto w-full flex-1 px-5 py-8", wide ? "max-w-7xl" : "max-w-6xl")}>
        {children}
      </main>
      <SiteFooter />
    </div>
  );
}