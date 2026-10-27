import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { StarRating } from "@/components/star-rating";
import { ImportanceSelect, StatusSelect } from "@/components/paper-controls";
import { TagInput } from "@/components/tag-input";
import { useAllTags } from "@/hooks/use-all-tags";
import {
  emptyPaper,
  itemToInput,
  type LibraryItem,
  type PaperInput,
} from "@/lib/paper-types";
import { addPaper, lookupPaperMetadata, updatePaperMetadata, updateUserPaper } from "@/lib/papers";

export function PaperFormDialog({
  open,
  onOpenChange,
  item,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  item?: LibraryItem;
}) {
  const queryClient = useQueryClient();

  const [form, setForm] = useState<PaperInput>(emptyPaper);
  const [query, setQuery] = useState("");
  const allTags = useAllTags();

  useEffect(() => {
    if (open) {
      setForm(item ? itemToInput(item) : emptyPaper);
      setQuery("");
    }
  }, [open, item]);

  function set<K extends keyof PaperInput>(key: K, value: PaperInput[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  const fetchMeta = useMutation({
    mutationFn: () => lookupPaperMetadata({ query }),
    onSuccess: (meta) => {
      if (!meta) return toast.error("Nothing found for that DOI or link.");
      setForm((f) => ({
        ...f,
        title: meta.title || f.title,
        authors: meta.authors?.length ? meta.authors : f.authors,
        year: meta.year ?? f.year,
        venue: meta.venue ?? f.venue,
        doi: meta.doi ?? f.doi,
        url: meta.url ?? f.url,
        pdf_url: meta.pdf_url ?? f.pdf_url,
        abstract: meta.abstract ?? f.abstract,
      }));
      toast.success("Metadata filled in.");
    },
    onError: (err) => toast.error(err instanceof Error && err.message ? err.message : "Lookup failed."),
  });

  const save = useMutation({
    mutationFn: async () => {
      if (!form.title?.trim()) throw new Error("A title is required.");
      if (item) {
        const { title, authors, year, venue, doi, url, pdf_url, abstract, ...personal } = form;
        await updatePaperMetadata({
          paperId: item.paper_id,
          values: { title, authors, year, venue, doi, url, pdf_url, abstract },
        });
        await updateUserPaper({ paperId: item.paper_id, values: personal });
        return;
      }
      await addPaper(form);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["library"] });
      toast.success(item ? "Paper updated." : "Paper added to your library.");
      onOpenChange(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display">{item ? "Edit paper" : "Add a paper"}</DialogTitle>
          <DialogDescription>
            Paste a DOI or arXiv link to fill the details automatically, or type them in.
          </DialogDescription>
        </DialogHeader>

        {!item && (
          <div className="flex gap-2">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (query.trim().length >= 3 && !fetchMeta.isPending) {
                    fetchMeta.mutate();
                  }
                }
              }}
              placeholder="10.1145/3442188, arxiv.org/abs/1706.03762, or DOI URL"
            />
            <Button
              type="button"
              variant="secondary"
              disabled={query.trim().length < 3 || fetchMeta.isPending}
              onClick={() => fetchMeta.mutate()}
            >
              {fetchMeta.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="h-4 w-4" />
              )}
              Fetch
            </Button>
          </div>
        )}

        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="title">Title</Label>
            <Input id="title" value={form.title} onChange={(e) => set("title", e.target.value)} />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="authors">Authors</Label>
            <Input
              id="authors"
              value={(form.authors ?? []).join(", ")}
              onChange={(e) =>
                set(
                  "authors",
                  e.target.value.split(",").map((s) => s.trim()).filter(Boolean),
                )
              }
              placeholder="Comma separated"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="year">Year</Label>
              <Input
                id="year"
                inputMode="numeric"
                value={form.year ?? ""}
                onChange={(e) => set("year", e.target.value ? Number(e.target.value) : null)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="venue">Venue</Label>
              <Input id="venue" value={form.venue ?? ""} onChange={(e) => set("venue", e.target.value)} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="doi">DOI</Label>
              <Input id="doi" value={form.doi ?? ""} onChange={(e) => set("doi", e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="url">Link</Label>
              <Input id="url" value={form.url ?? ""} onChange={(e) => set("url", e.target.value)} />
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="pdf">PDF URL</Label>
            <Input
              id="pdf"
              value={form.pdf_url ?? ""}
              onChange={(e) => set("pdf_url", e.target.value)}
              placeholder="Opens in the reader with highlights and comments"
            />
          </div>

          <div className="flex flex-wrap items-center gap-3 rounded-md border border-border p-3">
            <StatusSelect value={form.status ?? "to_read"} onChange={(v) => set("status", v)} />
            <ImportanceSelect value={form.importance ?? "medium"} onChange={(v) => set("importance", v)} />
            <StarRating value={form.rating ?? null} onChange={(v) => set("rating", v)} />
            <div className="ml-auto flex items-center gap-2">
              <Label htmlFor="rec" className="text-sm font-normal">
                Would recommend
              </Label>
              <Switch
                id="rec"
                checked={!!form.recommend}
                onCheckedChange={(v) => set("recommend", v)}
              />
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label>Tags</Label>
            <TagInput value={form.tags ?? []} onChange={(v) => set("tags", v)} suggestions={allTags} />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="notes">Notes</Label>
            <Textarea
              id="notes"
              rows={4}
              value={form.notes ?? ""}
              onChange={(e) => set("notes", e.target.value)}
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="abstract">Abstract</Label>
            <Textarea
              id="abstract"
              rows={4}
              value={form.abstract ?? ""}
              onChange={(e) => set("abstract", e.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            {item ? "Save changes" : "Add to library"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}