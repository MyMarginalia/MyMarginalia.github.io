import type {
  Annotation,
  AnnotationColor,
  CatalogPaper,
  LibraryItem,
  PaperImportance,
  PaperInput,
  PaperStatus,
  Rect,
} from "@/lib/paper-types";

const DB_NAME = "marginalia-db";
const DB_VERSION = 1;

export type ProfileData = {
  id: string;
  display_name: string | null;
  avatar_url: string | null;
  created_at: string;
};

type StoredPaper = LibraryItem;
type StoredAnnotation = Annotation;

interface MarginaliaDBSchema {
  papers: StoredPaper;
  annotations: StoredAnnotation;
  settings: { key: string; value: unknown };
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (typeof window === "undefined" || typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB is not available in this environment."));
  }

  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        // Papers store
        if (!db.objectStoreNames.contains("papers")) {
          const papersStore = db.createObjectStore("papers", { keyPath: "paper_id" });
          papersStore.createIndex("created_at", "created_at", { unique: false });
          papersStore.createIndex("status", "status", { unique: false });
          papersStore.createIndex("importance", "importance", { unique: false });
          papersStore.createIndex("rating", "rating", { unique: false });
        }

        // Annotations store
        if (!db.objectStoreNames.contains("annotations")) {
          const annotationsStore = db.createObjectStore("annotations", { keyPath: "id" });
          annotationsStore.createIndex("paper_id", "paper_id", { unique: false });
          annotationsStore.createIndex("page", "page", { unique: false });
          annotationsStore.createIndex("created_at", "created_at", { unique: false });
        }

        // Settings store
        if (!db.objectStoreNames.contains("settings")) {
          db.createObjectStore("settings", { keyPath: "key" });
        }
      };

      request.onsuccess = async (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        // Check and migrate legacy localStorage guest items if present
        try {
          await migrateLegacyLocalStorage(db);
        } catch (e) {
          console.warn("Legacy localStorage migration skipped:", e);
        }
        resolve(db);
      };

      request.onerror = (event) => {
        reject((event.target as IDBOpenDBRequest).error);
      };
    });
  }

  return dbPromise;
}

/** Migrates legacy localStorage guest papers to IndexedDB if any exist */
async function migrateLegacyLocalStorage(db: IDBDatabase) {
  if (typeof window === "undefined") return;
  const legacyKey = "marginalia-guest-library";
  const raw = window.localStorage.getItem(legacyKey);
  if (!raw) return;

  try {
    const items = JSON.parse(raw);
    if (!Array.isArray(items) || items.length === 0) return;

    const tx = db.transaction(["papers"], "readwrite");
    const store = tx.objectStore("papers");

    for (const item of items) {
      const now = new Date().toISOString();
      const paperId = item.id || crypto.randomUUID();
      const catalog: CatalogPaper = {
        id: paperId,
        title: item.title || "Untitled Paper",
        authors: typeof item.authors === "string" ? item.authors.split(",").map((s: string) => s.trim()).filter(Boolean) : (item.authors || []),
        year: item.year || null,
        venue: item.venue || null,
        doi: item.doi || null,
        url: item.url || null,
        pdf_url: item.pdf_url || null,
        abstract: item.abstract || null,
        created_at: item.created_at || now,
        updated_at: now,
      };

      const stored: StoredPaper = {
        paper_id: paperId,
        paper: catalog,
        status: item.status || "to_read",
        importance: item.importance || "medium",
        rating: item.rating ?? null,
        tags: item.tags || [],
        notes: item.notes ?? null,
        recommend: Boolean(item.recommend),
        started_at: item.started_at ?? null,
        finished_at: item.finished_at ?? null,
        created_at: item.created_at || now,
        updated_at: now,
        highlight_count: 0,
        comment_count: 0,
      };

      store.put(stored);
    }

    await txToPromise(tx);
    // Remove the legacy localStorage key once migrated
    window.localStorage.removeItem(legacyKey);
  } catch (err) {
    console.error("Failed to migrate legacy localStorage guest data:", err);
  }
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txToPromise(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// ---------------------------------------------------------------------------
// Paper operations
// ---------------------------------------------------------------------------

export async function listLibrary(): Promise<LibraryItem[]> {
  const db = await openDB();
  const tx = db.transaction(["papers", "annotations"], "readonly");
  const papersStore = tx.objectStore("papers");
  const annStore = tx.objectStore("annotations");

  const papers = await reqToPromise(papersStore.getAll() as IDBRequest<StoredPaper[]>);
  const annotations = await reqToPromise(annStore.getAll() as IDBRequest<StoredAnnotation[]>);

  // Group annotation counts by paper_id
  const highlightCounts: Record<string, number> = {};
  const commentCounts: Record<string, number> = {};

  for (const ann of annotations) {
    if (ann.kind === "highlight") {
      highlightCounts[ann.paper_id] = (highlightCounts[ann.paper_id] || 0) + 1;
    }
    if (ann.comment && ann.comment.trim()) {
      commentCounts[ann.paper_id] = (commentCounts[ann.paper_id] || 0) + 1;
    }
  }

  return papers.map((item) => ({
    ...item,
    highlight_count: highlightCounts[item.paper_id] || 0,
    comment_count: commentCounts[item.paper_id] || 0,
  }));
}

export async function getLibraryItem(paperId: string): Promise<LibraryItem | null> {
  const db = await openDB();
  const tx = db.transaction(["papers", "annotations"], "readonly");
  const item = await reqToPromise(tx.objectStore("papers").get(paperId) as IDBRequest<StoredPaper | undefined>);

  if (!item) return null;

  const annIndex = tx.objectStore("annotations").index("paper_id");
  const annotations = await reqToPromise(annIndex.getAll(paperId) as IDBRequest<StoredAnnotation[]>);

  const highlight_count = annotations.filter((a) => a.kind === "highlight").length;
  const comment_count = annotations.filter((a) => a.comment && a.comment.trim()).length;

  return {
    ...item,
    highlight_count,
    comment_count,
  };
}

export async function addPaper(input: PaperInput): Promise<{ paperId: string }> {
  const db = await openDB();
  const now = new Date().toISOString();
  const paperId = crypto.randomUUID();

  const catalog: CatalogPaper = {
    id: paperId,
    title: input.title.trim(),
    authors: input.authors || [],
    year: input.year ?? null,
    venue: input.venue?.trim() || null,
    doi: input.doi?.trim() || null,
    url: input.url?.trim() || null,
    pdf_url: input.pdf_url?.trim() || null,
    abstract: input.abstract?.trim() || null,
    created_at: now,
    updated_at: now,
  };

  const stored: StoredPaper = {
    paper_id: paperId,
    paper: catalog,
    status: input.status || "to_read",
    importance: input.importance || "medium",
    rating: input.rating ?? null,
    tags: input.tags || [],
    notes: input.notes?.trim() || null,
    recommend: Boolean(input.recommend),
    started_at: input.started_at ?? (input.status === "reading" ? now : null),
    finished_at: input.finished_at ?? (input.status === "read" ? now : null),
    created_at: now,
    updated_at: now,
    highlight_count: 0,
    comment_count: 0,
  };

  const tx = db.transaction(["papers"], "readwrite");
  tx.objectStore("papers").put(stored);
  await txToPromise(tx);

  return { paperId };
}

export async function updateUserPaper(
  paperId: string,
  values: Partial<Omit<LibraryItem, "paper_id" | "paper" | "created_at">>,
): Promise<{ ok: boolean }> {
  const db = await openDB();
  const tx = db.transaction(["papers"], "readwrite");
  const store = tx.objectStore("papers");
  const existing = await reqToPromise(store.get(paperId) as IDBRequest<StoredPaper | undefined>);

  if (!existing) {
    throw new Error("Paper not found in library.");
  }

  const now = new Date().toISOString();
  const updated: StoredPaper = {
    ...existing,
    ...values,
    updated_at: now,
  };

  store.put(updated);
  await txToPromise(tx);

  return { ok: true };
}

export async function updatePaperMetadata(
  paperId: string,
  values: Partial<CatalogPaper>,
): Promise<{ ok: boolean; paperId: string }> {
  const db = await openDB();
  const tx = db.transaction(["papers"], "readwrite");
  const store = tx.objectStore("papers");
  const existing = await reqToPromise(store.get(paperId) as IDBRequest<StoredPaper | undefined>);

  if (!existing) {
    throw new Error("Paper not found in library.");
  }

  const now = new Date().toISOString();
  const updatedCatalog: CatalogPaper = {
    ...existing.paper,
    ...values,
    updated_at: now,
  };

  const updated: StoredPaper = {
    ...existing,
    paper: updatedCatalog,
    updated_at: now,
  };

  store.put(updated);
  await txToPromise(tx);

  return { ok: true, paperId };
}

export async function removeFromLibrary(paperId: string): Promise<{ ok: boolean }> {
  const db = await openDB();
  const tx = db.transaction(["papers", "annotations"], "readwrite");
  tx.objectStore("papers").delete(paperId);

  // Delete associated annotations
  const annStore = tx.objectStore("annotations");
  const annIndex = annStore.index("paper_id");
  const annotations = await reqToPromise(annIndex.getAll(paperId) as IDBRequest<StoredAnnotation[]>);
  for (const ann of annotations) {
    annStore.delete(ann.id);
  }

  await txToPromise(tx);
  return { ok: true };
}

export async function bulkSetStatus(ids: string[], status: PaperStatus): Promise<{ ok: boolean }> {
  const db = await openDB();
  const tx = db.transaction(["papers"], "readwrite");
  const store = tx.objectStore("papers");
  const now = new Date().toISOString();

  for (const id of ids) {
    const existing = await reqToPromise(store.get(id) as IDBRequest<StoredPaper | undefined>);
    if (existing) {
      existing.status = status;
      if (status === "reading" && !existing.started_at) existing.started_at = now;
      if (status === "read") existing.finished_at = now;
      existing.updated_at = now;
      store.put(existing);
    }
  }

  await txToPromise(tx);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Annotation operations (PDF reader highlights & notes)
// ---------------------------------------------------------------------------

export async function listAnnotations(paperId: string): Promise<Annotation[]> {
  const db = await openDB();
  const tx = db.transaction(["annotations"], "readonly");
  const store = tx.objectStore("annotations");
  const index = store.index("paper_id");
  const annotations = await reqToPromise(index.getAll(paperId) as IDBRequest<StoredAnnotation[]>);

  return annotations.sort((a, b) => {
    if (a.page !== b.page) return a.page - b.page;
    return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
  });
}

export async function createAnnotation(input: {
  paperId: string;
  page: number;
  kind: "highlight" | "note";
  quote?: string | null;
  comment?: string | null;
  color?: AnnotationColor;
  rects: Rect[];
}): Promise<{ id: string }> {
  const db = await openDB();
  const now = new Date().toISOString();
  const id = crypto.randomUUID();

  const ann: StoredAnnotation = {
    id,
    paper_id: input.paperId,
    page: input.page,
    kind: input.kind,
    quote: input.quote ?? null,
    comment: input.comment ?? null,
    color: input.color || "yellow",
    rects: input.rects || [],
    created_at: now,
    updated_at: now,
  };

  const tx = db.transaction(["annotations"], "readwrite");
  tx.objectStore("annotations").put(ann);
  await txToPromise(tx);

  return { id };
}

export async function updateAnnotation(
  id: string,
  patch: { comment?: string | null; color?: AnnotationColor },
): Promise<{ ok: boolean }> {
  const db = await openDB();
  const tx = db.transaction(["annotations"], "readwrite");
  const store = tx.objectStore("annotations");
  const existing = await reqToPromise(store.get(id) as IDBRequest<StoredAnnotation | undefined>);

  if (!existing) {
    throw new Error("Annotation not found.");
  }

  if (patch.comment !== undefined) existing.comment = patch.comment || null;
  if (patch.color !== undefined) existing.color = patch.color;
  existing.updated_at = new Date().toISOString();

  store.put(existing);
  await txToPromise(tx);
  return { ok: true };
}

export async function deleteAnnotation(id: string): Promise<{ ok: boolean }> {
  const db = await openDB();
  const tx = db.transaction(["annotations"], "readwrite");
  tx.objectStore("annotations").delete(id);
  await txToPromise(tx);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Settings & Profile operations
// ---------------------------------------------------------------------------

const PROFILE_KEY = "user_profile";

export async function getProfile(): Promise<ProfileData> {
  const db = await openDB();
  const tx = db.transaction(["settings"], "readonly");
  const store = tx.objectStore("settings");
  const record = await reqToPromise(store.get(PROFILE_KEY) as IDBRequest<{ key: string; value: ProfileData } | undefined>);

  if (record && record.value) {
    return record.value;
  }

  return {
    id: "local-user",
    display_name: "Researcher",
    avatar_url: null,
    created_at: new Date().toISOString(),
  };
}

export async function updateProfile(patch: { display_name?: string | null }): Promise<{ ok: boolean }> {
  const db = await openDB();
  const current = await getProfile();
  const updated: ProfileData = {
    ...current,
    display_name: patch.display_name !== undefined ? patch.display_name : current.display_name,
  };

  const tx = db.transaction(["settings"], "readwrite");
  tx.objectStore("settings").put({ key: PROFILE_KEY, value: updated });
  await txToPromise(tx);
  return { ok: true };
}

export async function getAccountStats(): Promise<{ papers: number; annotations: number }> {
  const db = await openDB();
  const tx = db.transaction(["papers", "annotations"], "readonly");
  const papersCount = await reqToPromise(tx.objectStore("papers").count());
  const annotationsCount = await reqToPromise(tx.objectStore("annotations").count());
  return { papers: papersCount, annotations: annotationsCount };
}

// ---------------------------------------------------------------------------
// Full Backup Export / Import / Clear
// ---------------------------------------------------------------------------

export type FullBackup = {
  version: 1;
  exported_at: string;
  papers: StoredPaper[];
  annotations: StoredAnnotation[];
  profile: ProfileData;
};

export async function exportBackupJson(): Promise<string> {
  const db = await openDB();
  const tx = db.transaction(["papers", "annotations", "settings"], "readonly");
  const papers = await reqToPromise(tx.objectStore("papers").getAll() as IDBRequest<StoredPaper[]>);
  const annotations = await reqToPromise(tx.objectStore("annotations").getAll() as IDBRequest<StoredAnnotation[]>);
  const profile = await getProfile();

  const backup: FullBackup = {
    version: 1,
    exported_at: new Date().toISOString(),
    papers,
    annotations,
    profile,
  };

  return JSON.stringify(backup, null, 2);
}

export async function importBackupJson(jsonString: string): Promise<{ importedPapers: number; importedAnnotations: number }> {
  const parsed = JSON.parse(jsonString);
  const db = await openDB();

  let papersToInsert: StoredPaper[] = [];
  let annotationsToInsert: StoredAnnotation[] = [];

  if (Array.isArray(parsed)) {
    // Array of papers (legacy guest import or plain paper array)
    papersToInsert = parsed.map((p) => {
      const id = p.paper_id || p.id || crypto.randomUUID();
      const catalog: CatalogPaper = p.paper || {
        id,
        title: p.title || "Untitled Paper",
        authors: typeof p.authors === "string" ? p.authors.split(/[;,]/).map((s: string) => s.trim()).filter(Boolean) : (p.authors || []),
        year: p.year || null,
        venue: p.venue || null,
        doi: p.doi || null,
        url: p.url || null,
        pdf_url: p.pdf_url || null,
        abstract: p.abstract || null,
        created_at: p.created_at || new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      return {
        paper_id: id,
        paper: catalog,
        status: p.status || "to_read",
        importance: p.importance || "medium",
        rating: p.rating ?? null,
        tags: Array.isArray(p.tags) ? p.tags : (typeof p.tags === "string" ? p.tags.split(/[;,]/).map((s: string) => s.trim()).filter(Boolean) : []),
        notes: p.notes ?? null,
        recommend: Boolean(p.recommend),
        started_at: p.started_at ?? null,
        finished_at: p.finished_at ?? null,
        created_at: p.created_at || new Date().toISOString(),
        updated_at: new Date().toISOString(),
        highlight_count: 0,
        comment_count: 0,
      };
    });
  } else if (parsed && typeof parsed === "object") {
    if (Array.isArray(parsed.papers)) {
      papersToInsert = parsed.papers;
    }
    if (Array.isArray(parsed.annotations)) {
      annotationsToInsert = parsed.annotations;
    }
    if (parsed.profile) {
      await updateProfile(parsed.profile);
    }
  }

  const tx = db.transaction(["papers", "annotations"], "readwrite");
  const paperStore = tx.objectStore("papers");
  const annStore = tx.objectStore("annotations");

  // Save annotations
  for (const ann of annotationsToInsert) {
    annStore.put(ann);
  }

  // Calculate annotation counts and save papers
  for (const paper of papersToInsert) {
    const paperAnns = annotationsToInsert.filter((a) => a.paper_id === paper.paper_id);
    if (paperAnns.length > 0) {
      paper.highlight_count = paperAnns.filter((a) => a.kind === "highlight").length;
      paper.comment_count = paperAnns.filter((a) => a.comment && a.comment.trim()).length;
    }
    paperStore.put(paper);
  }

  await txToPromise(tx);

  return {
    importedPapers: papersToInsert.length,
    importedAnnotations: annotationsToInsert.length,
  };
}

export async function clearEntireLibrary(): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(["papers", "annotations", "settings"], "readwrite");
  tx.objectStore("papers").clear();
  tx.objectStore("annotations").clear();
  tx.objectStore("settings").clear();
  await txToPromise(tx);
}
