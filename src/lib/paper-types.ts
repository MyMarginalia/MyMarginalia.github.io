import { z } from "zod";

export const STATUSES = ["to_read", "reading", "read", "abandoned"] as const;
export const IMPORTANCES = ["low", "medium", "high", "critical"] as const;

export const ANNOTATION_COLORS = ["yellow", "orange", "green", "blue", "pink"] as const;
export type AnnotationColor = (typeof ANNOTATION_COLORS)[number];

export type Rect = { x: number; y: number; w: number; h: number };

export type Annotation = {
  id: string;
  paper_id: string;
  page: number;
  kind: "highlight" | "note";
  quote: string | null;
  comment: string | null;
  color: AnnotationColor;
  rects: Rect[];
  created_at: string;
  updated_at: string;
};

export type PaperStatus = (typeof STATUSES)[number];
export type PaperImportance = (typeof IMPORTANCES)[number];

export const STATUS_LABEL: Record<PaperStatus, string> = {
  to_read: "To read",
  reading: "Reading",
  read: "Read",
  abandoned: "Abandoned",
};

export const IMPORTANCE_LABEL: Record<PaperImportance, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  critical: "Critical",
};

/** Tailwind classes built on semantic tokens declared in src/styles.css */
export const STATUS_CLASS: Record<PaperStatus, string> = {
  to_read: "bg-status-toread/15 text-status-toread border-status-toread/30",
  reading: "bg-status-reading/15 text-status-reading border-status-reading/30",
  read: "bg-status-read/15 text-status-read border-status-read/30",
  abandoned: "bg-status-abandoned/15 text-status-abandoned border-status-abandoned/30",
};

export const IMPORTANCE_CLASS: Record<PaperImportance, string> = {
  low: "bg-imp-low/15 text-imp-low border-imp-low/30",
  medium: "bg-imp-medium/15 text-imp-medium border-imp-medium/30",
  high: "bg-imp-high/15 text-imp-high border-imp-high/30",
  critical: "bg-imp-critical/15 text-imp-critical border-imp-critical/30",
};

export const IMPORTANCE_DOT: Record<PaperImportance, string> = {
  low: "bg-imp-low",
  medium: "bg-imp-medium",
  high: "bg-imp-high",
  critical: "bg-imp-critical",
};

export const STATUS_DOT: Record<PaperStatus, string> = {
  to_read: "bg-status-toread",
  reading: "bg-status-reading",
  read: "bg-status-read",
  abandoned: "bg-status-abandoned",
};

/** A row in the shared paper catalog. */
export type CatalogPaper = {
  id: string;
  title: string;
  authors: string[];
  year: number | null;
  venue: string | null;
  doi: string | null;
  url: string | null;
  pdf_url: string | null;
  abstract: string | null;
  created_at: string;
  updated_at: string;
};

/** One paper as it appears in a user's library: catalog metadata + personal data. */
export type LibraryItem = {
  paper_id: string;
  paper: CatalogPaper;
  status: PaperStatus;
  importance: PaperImportance;
  rating: number | null;
  tags: string[];
  notes: string | null;
  recommend: boolean;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
  highlight_count: number;
  comment_count: number;
};

const nullableText = z.string().trim().max(20000).nullish().transform((v) => (v ? v : null));
const strList = z.array(z.string().trim().min(1)).max(200).default([]);

/** Hostnames that must never be reachable via a stored link (SSRF hardening). */
function isPublicWebUrl(value: string) {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  if (u.port && u.port !== "80" && u.port !== "443") return false;
  const h = u.hostname.toLowerCase();
  if (!h.includes(".") || h.endsWith(".internal") || h.endsWith(".local")) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(":")) return false; // no raw IP literals
  return true;
}

const nullableUrl = z
  .string()
  .trim()
  .max(2000)
  .nullish()
  .transform((v) => (v ? v : null))
  .refine((v) => v === null || isPublicWebUrl(v), {
    message: "Must be a public http(s) link",
  });

/** Shared metadata — lives in the global catalog. */
export const metadataSchema = z.object({
  title: z.string().trim().min(1).max(500),
  authors: strList,
  year: z.number().int().min(1500).max(2200).nullish().transform((v) => v ?? null),
  venue: nullableText,
  doi: nullableText,
  url: nullableUrl,
  pdf_url: nullableUrl,
  abstract: nullableText,
});

/** Personal data — lives in user_papers. */
export const userDataSchema = z.object({
  status: z.enum(STATUSES).default("to_read"),
  importance: z.enum(IMPORTANCES).default("medium"),
  rating: z.number().int().min(1).max(5).nullish().transform((v) => v ?? null),
  tags: strList,
  notes: nullableText,
  recommend: z.boolean().default(false),
  started_at: z.string().nullish().transform((v) => v ?? null),
  finished_at: z.string().nullish().transform((v) => v ?? null),
});

export const paperInputSchema = metadataSchema.merge(userDataSchema);

export type PaperInput = z.input<typeof paperInputSchema>;

export const emptyPaper: PaperInput = {
  title: "",
  authors: [],
  year: null,
  venue: null,
  doi: null,
  url: null,
  pdf_url: null,
  abstract: null,
  status: "to_read",
  importance: "medium",
  rating: null,
  tags: [],
  notes: null,
  recommend: false,
  started_at: null,
  finished_at: null,
};

export function itemToInput(item: LibraryItem): PaperInput {
  return {
    title: item.paper.title,
    authors: item.paper.authors,
    year: item.paper.year,
    venue: item.paper.venue,
    doi: item.paper.doi,
    url: item.paper.url,
    pdf_url: item.paper.pdf_url,
    abstract: item.paper.abstract,
    status: item.status,
    importance: item.importance,
    rating: item.rating,
    tags: item.tags,
    notes: item.notes,
    recommend: item.recommend,
    started_at: item.started_at,
    finished_at: item.finished_at,
  };
}