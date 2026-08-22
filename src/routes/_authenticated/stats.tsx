import { createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { AppShell } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { STATUS_LABEL, STATUSES, type LibraryItem } from "@/lib/paper-types";
import { listLibrary } from "@/lib/papers";

export const Route = createFileRoute("/_authenticated/stats")({
  head: () => ({
    meta: [
      { title: "Insights — Marginalia" },
      { name: "description", content: "Reading pace, ratings and topic trends across your paper library." },
      { property: "og:title", content: "Insights — Marginalia" },
      { property: "og:description", content: "Reading pace, ratings and topic trends across your paper library." },
    ],
  }),
  component: StatsPage,
});

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border border-border bg-card p-5">
      <h2 className="font-display text-sm uppercase tracking-wide text-muted-foreground">{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function monthKey(iso: string) {
  return iso.slice(0, 7);
}

function computeStreak(papers: LibraryItem[]) {
  const months = new Set(papers.filter((p) => p.finished_at).map((p) => monthKey(p.finished_at!)));
  let streak = 0;
  const d = new Date();
  for (;;) {
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    if (!months.has(key)) break;
    streak += 1;
    d.setMonth(d.getMonth() - 1);
  }
  return streak;
}

function StatsPage() {
  const { data: papers = [] } = useQuery({ queryKey: ["library"], queryFn: () => listLibrary() });

  const perMonth = useMemo(() => {
    const map = new Map<string, number>();
    papers.filter((p) => p.finished_at).forEach((p) => {
      const k = monthKey(p.finished_at!);
      map.set(k, (map.get(k) ?? 0) + 1);
    });
    return [...map.entries()].sort().slice(-12).map(([month, count]) => ({ month, count }));
  }, [papers]);

  const byStatus = useMemo(
    () =>
      STATUSES.map((s) => ({
        name: STATUS_LABEL[s],
        value: papers.filter((p) => p.status === s).length,
      })).filter((d) => d.value > 0),
    [papers],
  );

  const ratings = useMemo(
    () =>
      [1, 2, 3, 4, 5].map((r) => ({
        rating: `${r}★`,
        count: papers.filter((p) => p.rating === r).length,
      })),
    [papers],
  );

  const topTags = useMemo(() => {
    const map = new Map<string, number>();
    papers.flatMap((p) => p.tags).forEach((t) => map.set(t, (map.get(t) ?? 0) + 1));
    return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  }, [papers]);

  const read = papers.filter((p) => p.status === "read");
  const avgRating = read.filter((p) => p.rating).length
    ? (
        read.reduce((s, p) => s + (p.rating ?? 0), 0) / read.filter((p) => p.rating).length
      ).toFixed(1)
    : "—";
  const avgDays = (() => {
    const done = papers.filter((p) => p.finished_at);
    if (!done.length) return "—";
    const total = done.reduce(
      (s, p) => s + (new Date(p.finished_at!).getTime() - new Date(p.created_at).getTime()),
      0,
    );
    return `${Math.round(total / done.length / 86400000)} d`;
  })();

  const colors = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];

  return (
    <AppShell>
      <div className="rule-under pb-4">
        <h1 className="font-display text-3xl">Insights</h1>
        <p className="mt-1 text-sm text-muted-foreground">How your reading is actually going.</p>
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-4">
        {[
          ["Papers tracked", String(papers.length)],
          ["Finished", String(read.length)],
          ["Average rating", String(avgRating)],
          ["Added → finished", avgDays],
        ].map(([label, value]) => (
          <div key={label} className="border border-border bg-card p-4">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
            <p className="mt-1 font-display text-2xl">{value}</p>
          </div>
        ))}
      </div>

      <p className="mt-4 text-sm text-muted-foreground">
        Current streak: <span className="text-foreground">{computeStreak(papers)}</span> consecutive month(s)
        with a finished paper.
      </p>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Panel title="Papers finished per month">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={perMonth}>
              <CartesianGrid strokeDasharray="2 4" stroke="var(--border)" vertical={false} />
              <XAxis dataKey="month" fontSize={11} stroke="var(--muted-foreground)" />
              <YAxis allowDecimals={false} fontSize={11} stroke="var(--muted-foreground)" />
              <Tooltip contentStyle={{ background: "var(--popover)", border: "1px solid var(--border)" }} />
              <Bar dataKey="count" fill="var(--chart-1)" />
            </BarChart>
          </ResponsiveContainer>
        </Panel>

        <Panel title="Status breakdown">
          <ResponsiveContainer width="100%" height={220}>
            <PieChart>
              <Pie data={byStatus} dataKey="value" nameKey="name" outerRadius={80} label>
                {byStatus.map((_, i) => (
                  <Cell key={i} fill={colors[i % colors.length]} />
                ))}
              </Pie>
              <Tooltip contentStyle={{ background: "var(--popover)", border: "1px solid var(--border)" }} />
            </PieChart>
          </ResponsiveContainer>
        </Panel>

        <Panel title="Rating distribution">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={ratings}>
              <CartesianGrid strokeDasharray="2 4" stroke="var(--border)" vertical={false} />
              <XAxis dataKey="rating" fontSize={11} stroke="var(--muted-foreground)" />
              <YAxis allowDecimals={false} fontSize={11} stroke="var(--muted-foreground)" />
              <Tooltip contentStyle={{ background: "var(--popover)", border: "1px solid var(--border)" }} />
              <Bar dataKey="count" fill="var(--chart-3)" />
            </BarChart>
          </ResponsiveContainer>
        </Panel>

        <Panel title="Most read topics">
          {topTags.length === 0 ? (
            <p className="text-sm text-muted-foreground">Tag some papers to see topics here.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {topTags.map(([tag, count]) => (
                <Badge key={tag} variant="outline" className="font-normal">
                  {tag} · {count}
                </Badge>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </AppShell>
  );
}