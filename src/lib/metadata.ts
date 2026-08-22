// This module runs entirely in the browser (no server, no createServerFn).
// It exists specifically because the app is deployed as a static site
// (GitHub Pages) with no backend process to call into — every provider here
// is chosen because it serves permissive CORS headers to browser fetches.

export type Lookup = {
  title: string;
  authors: string[];
  year: number | null;
  venue: string | null;
  doi: string | null;
  url: string | null;
  pdf_url: string | null;
  abstract: string | null;
};

function stripTags(input: string) {
  return input.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

function extract(xml: string, tag: string) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return m ? stripTags(m[1]) : null;
}

function reconstructOpenAlexAbstract(invertedIndex?: Record<string, number[]> | null): string | null {
  if (!invertedIndex || typeof invertedIndex !== "object") return null;
  const wordEntries: [number, string][] = [];
  for (const [word, positions] of Object.entries(invertedIndex)) {
    if (Array.isArray(positions)) {
      for (const pos of positions) {
        wordEntries.push([pos, word]);
      }
    }
  }
  if (wordEntries.length === 0) return null;
  wordEntries.sort((a, b) => a[0] - b[0]);
  return wordEntries.map((e) => e[1]).join(" ");
}

export function parseIdentifier(raw: string): { kind: "doi" | "arxiv" | "search"; value: string } {
  const input = raw.trim();

  const arxiv =
    input.match(/arxiv\.org\/(?:abs|pdf)\/([0-9]{4}\.[0-9]{4,5})(?:v\d+)?/i) ??
    input.match(/^arxiv:\s*([0-9]{4}\.[0-9]{4,5})/i) ??
    input.match(/^([0-9]{4}\.[0-9]{4,5})$/);
  if (arxiv) return { kind: "arxiv", value: arxiv[1] };

  const doiMatch = input.match(/10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+/i);
  if (doiMatch) {
    const cleanDoi = doiMatch[0].replace(/[).,;]+$/, "").trim();
    return { kind: "doi", value: cleanDoi };
  }

  return { kind: "search", value: input };
}

// ---------------------------------------------------------------------------
// Shared throttle: keeps a minimum gap between outgoing requests *per host*
// so we don't trip Semantic Scholar's (fairly low) unauthenticated rate
// limit. Without this, a couple of quick lookups in a row is enough to get
// 429s, which the browser then reports as opaque CORS/"Failed to fetch"
// errors since S2 doesn't send CORS headers on its error responses.
// ---------------------------------------------------------------------------
const lastCallByHost = new Map<string, number>();

async function throttle(host: string, minGapMs: number) {
  const last = lastCallByHost.get(host) ?? 0;
  const wait = last + minGapMs - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallByHost.set(host, Date.now());
}

/** fetch() with a hard timeout — prevents an unresponsive host (e.g. a
 * slow/overloaded CORS proxy) from hanging the lookup indefinitely. */
async function fetchWithTimeout(
  url: string,
  init: RequestInit | undefined,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch with per-host throttling, retry-with-backoff on 429, and a single
 * retry on network-level failures (flaky connection, DNS blip, timeout). */
async function fetchWithRetry(
  url: string,
  init: RequestInit | undefined,
  host: string,
  minGapMs: number,
  retries = 2,
  timeoutMs = 8000,
): Promise<Response> {
  let attempt = 0;
  for (; ;) {
    await throttle(host, minGapMs);
    try {
      const res = await fetchWithTimeout(url, init, timeoutMs);
      if (res.status !== 429 || attempt >= retries) return res;
      const retryAfter = Number(res.headers.get("retry-after"));
      const backoff = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : minGapMs * 2 ** (attempt + 1);
      await new Promise((r) => setTimeout(r, backoff));
      attempt++;
    } catch (err) {
      // Network error, CORS block, or timeout abort. Retry once; after
      // that, let the caller fall through to the next provider.
      if (attempt >= 1) throw err;
      attempt++;
      await new Promise((r) => setTimeout(r, minGapMs));
    }
  }
}

/** 1. Semantic Scholar API — open CORS */
async function lookupSemanticScholar(id: string): Promise<Lookup | null> {
  try {
    // Do NOT encodeURIComponent(id): "DOI:10.xxx/yyy" needs its ":" and "/"
    // literal in the path, or Semantic Scholar's router 404s.
    const url = `https://api.semanticscholar.org/graph/v1/paper/${id}?fields=title,authors,year,venue,abstract,openAccessPdf,url,externalIds`;
    const res = await fetchWithRetry(url, undefined, "semanticscholar", 1100);
    if (!res.ok) {
      console.warn(`[metadata] Semantic Scholar ${res.status} for id "${id}"`);
      return null;
    }
    const data = await res.json();
    if (!data || !data.title) return null;

    const authors = Array.isArray(data.authors)
      ? data.authors.map((a: { name?: string }) => a.name).filter(Boolean)
      : [];

    const doi = data.externalIds?.DOI || (id.startsWith("DOI:") ? id.slice(4) : null);
    const arxivId = data.externalIds?.ArXiv;
    const pdfUrl = data.openAccessPdf?.url || (arxivId ? `https://arxiv.org/pdf/${arxivId}` : null);
    const paperUrl =
      data.url || (doi ? `https://doi.org/${doi}` : arxivId ? `https://arxiv.org/abs/${arxivId}` : null);

    return {
      title: data.title.trim(),
      authors,
      year: data.year || null,
      venue: data.venue || (arxivId ? "arXiv" : null),
      doi: doi || null,
      url: paperUrl,
      pdf_url: pdfUrl,
      abstract: data.abstract ? stripTags(data.abstract) : null,
    };
  } catch (err) {
    console.warn(`[metadata] Semantic Scholar fetch threw for id "${id}"`, err);
    return null;
  }
}

/** 2. OpenAlex API — open CORS */
async function lookupOpenAlex(identifier: string): Promise<Lookup | null> {
  try {
    let clean = identifier.replace(/^https?:\/\/doi\.org\//i, "").trim();
    if (!clean.startsWith("https://") && !clean.startsWith("doi:")) {
      clean = clean.startsWith("10.") ? `https://doi.org/${clean}` : clean;
    }
    const url = `https://api.openalex.org/works/${encodeURI(clean)}`;
    const res = await fetchWithRetry(url, undefined, "openalex", 150);
    if (!res.ok) {
      console.warn(`[metadata] OpenAlex ${res.status} for identifier "${identifier}"`);
      return null;
    }
    const data = await res.json();
    if (!data || !data.title) return null;

    const authors = Array.isArray(data.authorships)
      ? data.authorships
        .map((a: { author?: { display_name?: string } }) => a.author?.display_name)
        .filter(Boolean)
      : [];

    const abstract = reconstructOpenAlexAbstract(data.abstract_inverted_index);
    const rawPdfUrl = data.best_oa_location?.pdf_url || data.open_access?.oa_url || null;
    // open_access.oa_url in particular is sometimes a landing page rather
    // than a direct PDF link (e.g. a DOI resolver URL) — don't pass that
    // through as pdf_url, since it will silently break the PDF viewer.
    const pdfUrl = looksLikePdfUrl(rawPdfUrl) ? rawPdfUrl : null;
    const doi = data.doi ? String(data.doi).replace(/^https?:\/\/doi\.org\//i, "") : null;

    return {
      title: data.display_name || data.title,
      authors,
      year: data.publication_year || null,
      venue: data.primary_location?.source?.display_name || null,
      doi: doi || (identifier.startsWith("10.") ? identifier : null),
      url: data.primary_location?.landing_page_url || data.doi || `https://doi.org/${identifier}`,
      pdf_url: pdfUrl,
      abstract,
    };
  } catch (err) {
    console.warn(`[metadata] OpenAlex fetch threw for identifier "${identifier}"`, err);
    return null;
  }
}

/**
 * arXiv-specific OpenAlex lookup. IMPORTANT: OpenAlex's single-work
 * lookup-by-external-ID only resolves a handful of ID namespaces when you
 * pass a bare identifier/URL as the path (doi, pmid, mag, openalex, ...).
 * "https://arxiv.org/abs/<id>" is NOT one of them and will always 404.
 * arXiv preprints do have a DOI though — 10.48550/arXiv.<id> — which
 * OpenAlex (and Semantic Scholar / Crossref) *do* resolve.
 */
async function lookupOpenAlexByArxiv(arxivId: string): Promise<Lookup | null> {
  return lookupOpenAlex(`https://doi.org/10.48550/arXiv.${arxivId}`);
}

/** True when a URL genuinely looks like a direct PDF file, not a landing/
 * abstract page. OpenAlex's open_access.oa_url in particular is often a
 * landing page (e.g. a DOI resolver link) rather than an actual PDF. */
function looksLikePdfUrl(pdfUrl: string | null): boolean {
  if (!pdfUrl) return false;
  const lower = pdfUrl.toLowerCase();
  if (lower.includes("doi.org/")) return false; // DOI links resolve to landing pages, never a raw PDF
  return lower.includes(".pdf") || lower.includes("arxiv.org/pdf/");
}

/** True when a pdf_url points straight at arxiv.org, which does not send
 * CORS headers and will fail to load in an in-browser PDF viewer. */
function isRawArxivPdf(pdfUrl: string | null): boolean {
  return !!pdfUrl && /arxiv\.org\/pdf\//i.test(pdfUrl);
}

/** 3. Crossref API — CORS-enabled */
async function lookupCrossref(doi: string): Promise<Lookup | null> {
  try {
    const clean = doi.replace(/^https?:\/\/doi\.org\//i, "").trim();
    const res = await fetchWithRetry(
      `https://api.crossref.org/works/${clean}`,
      { headers: { Accept: "application/json" } },
      "crossref",
      100,
    );
    if (!res.ok) {
      console.warn(`[metadata] Crossref ${res.status} for DOI "${clean}"`);
      return null;
    }
    const json = (await res.json()) as { message?: Record<string, unknown> };
    const m = json.message;
    if (!m) return null;

    const authors = Array.isArray(m.author)
      ? (m.author as Array<{ given?: string; family?: string; name?: string }>)
        .map((a) => [a.given, a.family].filter(Boolean).join(" ") || (a.name ?? ""))
        .filter(Boolean)
      : [];
    const issued = m.issued as { "date-parts"?: number[][] } | undefined;
    const title = Array.isArray(m.title) && m.title.length > 0 ? stripTags(String(m.title[0])) : clean;
    const venue =
      Array.isArray(m["container-title"]) && m["container-title"].length > 0
        ? String((m["container-title"] as string[])[0])
        : null;

    let pdfUrl: string | null = null;
    if (Array.isArray(m.link)) {
      const pdfLink = (m.link as Array<{ "content-type"?: string; URL?: string }>).find((l) =>
        l["content-type"] === "application/pdf" || (l.URL && l.URL.endsWith(".pdf")),
      );
      if (pdfLink?.URL) pdfUrl = pdfLink.URL;
    }

    return {
      title,
      authors,
      year: issued?.["date-parts"]?.[0]?.[0] ?? null,
      venue,
      doi: String(m.DOI ?? clean),
      url: typeof m.URL === "string" ? m.URL : `https://doi.org/${clean}`,
      pdf_url: pdfUrl,
      abstract: typeof m.abstract === "string" ? stripTags(m.abstract) : null,
    };
  } catch (err) {
    console.warn(`[metadata] Crossref fetch threw for DOI "${doi}"`, err);
    return null;
  }
}

/** 4. arXiv — tries OpenAlex (via DOI) first since it has proven the most
 *     reliable in practice, then Semantic Scholar, then falls back to the
 *     arXiv API directly, then via a CORS proxy, since export.arxiv.org
 *     does not reliably send CORS headers to browsers and the proxy is a
 *     shared free service that can be slow/overloaded. */
async function lookupArxiv(arxivId: string): Promise<Lookup | null> {
  const oa = await lookupOpenAlexByArxiv(arxivId);

  // If OpenAlex didn't give us a usable PDF link (either no pdf_url at all,
  // or one that points at arxiv.org directly — which won't load in the
  // in-browser viewer due to missing CORS headers), check whether Semantic
  // Scholar has a mirrored copy on a CORS-friendly host instead. Metadata
  // fields still come from OpenAlex since it was the one that succeeded.
  if (oa && (!oa.pdf_url || isRawArxivPdf(oa.pdf_url))) {
    const ss = await lookupSemanticScholar(`ARXIV:${arxivId}`);
    if (ss?.pdf_url && !isRawArxivPdf(ss.pdf_url)) {
      return { ...oa, pdf_url: ss.pdf_url };
    }
    // No better option found — fall back to the constructed arxiv.org
    // link. It won't load in-browser without a proxy, but it's a real
    // PDF file rather than a landing page, and still opens fine in a new tab.
    return { ...oa, pdf_url: oa.pdf_url ?? `https://arxiv.org/pdf/${arxivId}` };
  }
  if (oa) return oa;

  const ss = await lookupSemanticScholar(`ARXIV:${arxivId}`);
  if (ss) return ss;

  const directUrl = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxivId)}`;
  const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(directUrl)}`;

  for (const url of [directUrl, proxyUrl]) {
    try {
      const res = await fetchWithRetry(url, undefined, "arxiv", 300, 1, 10000);
      if (!res.ok) {
        console.warn(`[metadata] arXiv ${res.status} for id "${arxivId}" via ${url}`);
        continue;
      }
      const xml = await res.text();
      const entry = xml.split("<entry>")[1];
      if (!entry) continue;

      const authors = [...entry.matchAll(/<name>([\s\S]*?)<\/name>/g)].map((m) => stripTags(m[1]));
      const published = extract(entry, "published");

      return {
        title: extract(entry, "title") ?? arxivId,
        authors,
        year: published ? Number(published.slice(0, 4)) : null,
        venue: "arXiv",
        doi: extract(entry, "arxiv:doi"),
        url: `https://arxiv.org/abs/${arxivId}`,
        pdf_url: `https://arxiv.org/pdf/${arxivId}`,
        abstract: extract(entry, "summary"),
      };
    } catch (err) {
      console.warn(`[metadata] arXiv fetch threw for id "${arxivId}" via ${url}`, err);
    }
  }

  return null;
}

/** 5. Free-text search fallback, only for genuinely non-identifier input */
async function searchOpenAlex(query: string): Promise<Lookup | null> {
  try {
    if (query.trim().length < 3) return null;
    const url = `https://api.openalex.org/works?search=${encodeURIComponent(query.trim())}&per-page=1`;
    const res = await fetchWithRetry(url, undefined, "openalex", 150);
    if (!res.ok) return null;
    const json = await res.json();
    const data = json.results?.[0];
    if (!data || !data.title) return null;

    const authors = Array.isArray(data.authorships)
      ? data.authorships
        .map((a: { author?: { display_name?: string } }) => a.author?.display_name)
        .filter(Boolean)
      : [];

    const abstract = reconstructOpenAlexAbstract(data.abstract_inverted_index);
    const rawPdfUrl = data.best_oa_location?.pdf_url || data.open_access?.oa_url || null;
    // open_access.oa_url in particular is sometimes a landing page rather
    // than a direct PDF link (e.g. a DOI resolver URL) — don't pass that
    // through as pdf_url, since it will silently break the PDF viewer.
    const pdfUrl = looksLikePdfUrl(rawPdfUrl) ? rawPdfUrl : null;
    const doi = data.doi ? String(data.doi).replace(/^https?:\/\/doi\.org\//i, "") : null;

    return {
      title: data.display_name || data.title,
      authors,
      year: data.publication_year || null,
      venue: data.primary_location?.source?.display_name || null,
      doi,
      url: data.primary_location?.landing_page_url || data.doi || null,
      pdf_url: pdfUrl,
      abstract,
    };
  } catch (err) {
    console.warn(`[metadata] OpenAlex search threw for query "${query}"`, err);
    return null;
  }
}

async function lookupMetadataUncached(kind: "doi" | "arxiv" | "search", value: string): Promise<Lookup | null> {
  if (kind === "arxiv") {
    return await lookupArxiv(value);
  }

  if (kind === "doi") {
    const ss = await lookupSemanticScholar(`DOI:${value}`);
    if (ss && ss.title) return ss;

    const oa = await lookupOpenAlex(`https://doi.org/${value}`);
    if (oa && oa.title) return oa;

    const cr = await lookupCrossref(value);
    if (cr && cr.title) return cr;

    console.warn(`[metadata] No metadata found for DOI "${value}" via any provider`);
    return null;
  }

  return await searchOpenAlex(value);
}

// Cache in-flight and completed lookups, keyed by the *normalized*
// identifier (kind:value) rather than the raw input string, so
// "arxiv.org/abs/X", "arxiv.org/pdf/X", and bare "X" all share one entry.
// Misses (null results) are evicted immediately rather than cached, so a
// transient outage doesn't permanently blackhole a real paper for the rest
// of the session — only genuine successes stay cached.
const cache = new Map<string, Promise<Lookup | null>>();

export async function lookupMetadata(raw: string): Promise<Lookup | null> {
  if (!raw || !raw.trim()) return null;

  const { kind, value } = parseIdentifier(raw);
  const key = `${kind}:${value.toLowerCase()}`;

  if (cache.has(key)) return cache.get(key)!;

  const promise = lookupMetadataUncached(kind, value)
    .then((result) => {
      if (result === null) cache.delete(key);
      return result;
    })
    .catch((err) => {
      cache.delete(key);
      throw err;
    });

  cache.set(key, promise);
  return promise;
}