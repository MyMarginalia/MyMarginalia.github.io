import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, HardDrive, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  exportBackupJson,
  getAccountStats,
  getMyProfile,
  importBackupJson,
  updateMyProfile,
  deleteMyAccount,
} from "@/lib/account";
import { BRAND } from "@/lib/brand";

export const Route = createFileRoute("/_authenticated/account")({
  head: () => ({
    meta: [
      { title: `Settings & Data — ${BRAND}` },
      { name: "description", content: `Manage your local data, backups, and preferences on ${BRAND}.` },
      { property: "og:title", content: `Settings & Data — ${BRAND}` },
      { property: "og:description", content: `Manage your local data, backups, and preferences on ${BRAND}.` },
    ],
  }),
  component: AccountPage,
  errorComponent: ({ error }) => <div role="alert" className="p-10 text-sm">{error.message}</div>,
  notFoundComponent: () => <div className="p-10">Not found.</div>,
});

function AccountPage() {
  const queryClient = useQueryClient();
  const jsonFileRef = useRef<HTMLInputElement>(null);

  const [name, setName] = useState("");
  const [confirm, setConfirm] = useState("");

  const { data: profile } = useQuery({ queryKey: ["profile"], queryFn: () => getMyProfile() });
  const { data: stats } = useQuery({ queryKey: ["account-stats"], queryFn: () => getAccountStats() });

  useEffect(() => {
    if (profile) {
      setName(profile.display_name ?? "");
    }
  }, [profile]);

  const update = useMutation({
    mutationFn: () => updateMyProfile({ display_name: name }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["profile"] });
      toast.success("Profile saved.");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const clearLibrary = useMutation({
    mutationFn: () => deleteMyAccount(),
    onSuccess: () => {
      queryClient.invalidateQueries();
      setConfirm("");
      toast.success("Local library cleared.");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  async function downloadJsonBackup() {
    try {
      const json = await exportBackupJson();
      const blob = new Blob([json], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `marginalia-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast.success("JSON backup downloaded.");
    } catch {
      toast.error("Failed to generate backup.");
    }
  }

  async function onImportJsonFile(file: File) {
    try {
      const text = await file.text();
      const result = await importBackupJson(text);
      queryClient.invalidateQueries();
      toast.success(`Restored ${result.importedPapers} paper(s) and ${result.importedAnnotations} annotation(s).`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Invalid JSON backup file.");
    }
  }

  return (
    <AppShell>
      <div className="rule-under pb-4">
        <h1 className="font-display text-3xl">Settings & Data</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {stats ? `${stats.papers} paper(s) · ${stats.annotations} annotation(s) stored locally in IndexedDB` : " "}
        </p>
      </div>

      {/* Profile Section */}
      <section className="mt-8 max-w-lg space-y-4">
        <h2 className="font-display text-lg">Profile</h2>
        <div className="grid gap-1.5">
          <Label htmlFor="name">Display name</Label>
          <Input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Researcher" />
        </div>
        <Button onClick={() => update.mutate()} disabled={update.isPending}>
          Save changes
        </Button>
      </section>

      {/* Local Storage & Data Management Section */}
      <section className="mt-12 max-w-3xl rounded-md border border-border bg-card p-5">
        <div className="flex items-center gap-2">
          <HardDrive className="h-5 w-5 text-primary" />
          <h2 className="font-display text-lg">Import & Export</h2>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          Marginalia stores 100% of your library, PDF highlights, comments, and settings locally in this browser.
        </p>

        <div className="mt-6 max-w-sm">
          <div className="flex flex-col justify-between rounded border border-border/80 bg-background/50 p-4">
            <div>
              <div className="flex items-center gap-1.5 font-medium text-sm">
                <HardDrive className="h-4 w-4 text-primary" /> Full Backup (JSON)
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Saves complete database snapshot including paper metadata, reading status, and PDF reader highlights/comments.
              </p>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button variant="outline" size="sm" className="gap-1.5" onClick={downloadJsonBackup}>
                <Download className="h-3.5 w-3.5" /> Export JSON
              </Button>
              <input
                ref={jsonFileRef}
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={(e) => e.target.files?.[0] && onImportJsonFile(e.target.files[0])}
              />
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => jsonFileRef.current?.click()}
              >
                <Upload className="h-3.5 w-3.5" /> Import JSON
              </Button>
            </div>
          </div>
        </div>
      </section>

      {/* Clear Database Section */}
      <section className="mt-12 max-w-lg rounded-md border border-destructive/40 bg-destructive/5 p-4">
        <h2 className="font-display text-lg text-destructive">Clear Local Library</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          This permanently erases all locally saved papers, notes, and annotations in this browser. Type <strong>DELETE</strong> to confirm.
        </p>
        <Input
          className="mt-3"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder="DELETE"
          aria-label="Type DELETE to confirm"
        />
        <Button
          variant="destructive"
          className="mt-3 gap-1.5"
          disabled={confirm !== "DELETE" || clearLibrary.isPending}
          onClick={() => clearLibrary.mutate()}
        >
          <Trash2 className="h-4 w-4" /> Clear local database
        </Button>
      </section>
    </AppShell>
  );
}
