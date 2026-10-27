// This module runs entirely in the browser (no server, no createServerFn).
// It exists specifically because the app is deployed as a static site
// (GitHub Pages) with no backend process to call into — every provider here
// is chosen because it serves permissive CORS headers to browser fetches.
//
// Providers, and what each is relied on for:
//
//   Crossref   journal/conference DOIs. No key, no tight limits.
//   DataCite   everything Crossref doesn't hold, and in particular arXiv: every
//              arXiv paper has a DataCite DOI (10.48550/arXiv.<id>). No key.
//   Semantic Scholar, OpenAlex
//              extras — abstracts and open-access PDF links. Neither can be
//              depended on: Semantic Scholar's keyless tier is one rate limit
//              shared by every keyless user in the world, and since 13 Feb 2026
//              OpenAlex answers keyless requests only a hundred times a day
//              before refusing with 409.
//
// A lookup therefore asks the dependable providers and the extras at the same
// time, uses whatever the dependable ones return, and lets the extras fill in
// what is missing only if they answer promptly.

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

function stripTags(input: string) {
  return input.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

function extract(xml: string, tag: string) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  const body = m?.[1];
  return body === undefined ? null : stripTags(body);
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
  if (arxiv?.[1]) return { kind: "arxiv", value: arxiv[1] };

  const doiMatch = input.match(/10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+/i);
  if (doiMatch) {
    const cleanDoi = doiMatch[0].replace(/[).,;]+$/, "").trim();
    return { kind: "doi", value: cleanDoi };
  }

  return { kind: "search", value: input };
}

// ---------------------------------------------------------------------------
// Request plumbing
// ---------------------------------------------------------------------------

/** What happened to the requests of one lookup, so that "no provider could
 * be reached" can be told apart from "every provider said it has no such
 * paper" — the first is a problem to report, the second a plain not-found. */
type Diagnostics = {
  /** Providers that gave a definite answer: a record, or a 404. */
  answered: number;
  failures: string[];
};

// Keeps a minimum gap between outgoing requests *per host*, so a couple of
// quick lookups in a row don't trip a provider's rate limit. (A rate-limited
// response from a host that sends no CORS headers on errors reaches the page
// only as an opaque network failure.)
const lastCallByHost = new Map<string, number>();

async function throttle(host: string, minGapMs: number) {
  const last = lastCallByHost.get(host) ?? 0;
  const wait = last + minGapMs - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallByHost.set(host, Date.now());
}

/** fetch() with a hard timeout — prevents an unresponsive host (e.g. a
 * slow/overloaded CORS proxy) from hanging the lookup indefinitely. */
async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Resolves to `null` if `promise` hasn't produced something within `ms`. */
function orNullAfter<T>(promise: Promise<T | null>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

type RequestOptions = {
  /** Minimum gap between requests to this host. */
  gapMs: number;
  timeoutMs: number;
  /** Wait out one 429 and try again. */
  retryOnce?: boolean;
};

/** One request. Resolves to the response when it succeeded, otherwise to
 * null after noting in `diag` what went wrong. Never throws. */
async function request(
  url: string,
  host: string,
  diag: Diagnostics,
  { gapMs, timeoutMs, retryOnce = false }: RequestOptions,
): Promise<Response | null> {
  let retried = false;
  for (;;) {
    await throttle(host, gapMs);
    let res: Response;
    try {
      res = await fetchWithTimeout(url, timeoutMs);
    } catch (err) {
      console.warn(`[metadata] ${host}: request failed`, err);
      diag.failures.push(`${host}: no response`);
      return null;
    }
    if (res.status === 429 && retryOnce && !retried) {
      retried = true;
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1500;
      await new Promise((r) => setTimeout(r, Math.min(waitMs, 3000)));
      continue;
    }
    if (res.status === 404) {
      diag.answered += 1;
      return null;
    }
    if (!res.ok) {
      console.warn(`[metadata] ${host}: HTTP ${res.status} for ${url}`);
      diag.failures.push(`${host}: HTTP ${res.status}`);
      return null;
    }
    return res;
  }
}

async function requestJson(
  url: string,
  host: string,
  diag: Diagnostics,
  options: RequestOptions,
): Promise<Json | null> {
  const res = await request(url, host, diag, options);
  if (!res) return null;
  try {
    const json = (await res.json()) as Json;
    diag.answered += 1;
    return json;
  } catch (err) {
    console.warn(`[metadata] ${host}: unreadable response`, err);
    diag.failures.push(`${host}: unreadable response`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers shared by providers
// ---------------------------------------------------------------------------

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

function cleanDoi(doi: string): string {
  return doi.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").trim();
}

/** DataCite writes names as "Family, Given"; show them as "Given Family". */
function personName(c: { name?: string; givenName?: string; familyName?: string }): string {
  if (c.givenName && c.familyName) return `${c.givenName} ${c.familyName}`;
  const name = (c.name ?? "").trim();
  const comma = name.indexOf(",");
  return comma > 0 ? `${name.slice(comma + 1).trim()} ${name.slice(0, comma).trim()}`.trim() : name;
}

// ---------------------------------------------------------------------------
// Providers. Each resolves to a Lookup, or null for "no record / no answer".
// ---------------------------------------------------------------------------

/** Crossref — no key, CORS-enabled. */
function crossrefToLookup(m: Json, fallbackDoi: string | null): Lookup | null {
  const title = Array.isArray(m.title) && m.title.length > 0 ? stripTags(String(m.title[0])) : "";
  if (!title) return null;

  const authors = Array.isArray(m.author)
    ? (m.author as Array<{ given?: string; family?: string; name?: string }>)
        .map((a) => [a.given, a.family].filter(Boolean).join(" ") || (a.name ?? ""))
        .filter(Boolean)
    : [];
  const issued = (m.issued ?? m["published-print"] ?? m["published-online"]) as
    | { "date-parts"?: number[][] }
    | undefined;
  const venue =
    Array.isArray(m["container-title"]) && m["container-title"].length > 0
      ? String((m["container-title"] as string[])[0])
      : null;

  let pdfUrl: string | null = null;
  if (Array.isArray(m.link)) {
    const pdfLink = (m.link as Array<{ "content-type"?: string; URL?: string }>).find(
      (l) => l["content-type"] === "application/pdf" || (l.URL && l.URL.endsWith(".pdf")),
    );
    if (pdfLink?.URL) pdfUrl = pdfLink.URL;
  }
  const doi = typeof m.DOI === "string" ? m.DOI : fallbackDoi;

  return {
    title,
    authors,
    year: issued?.["date-parts"]?.[0]?.[0] ?? null,
    venue,
    doi,
    url: typeof m.URL === "string" ? m.URL : doi ? `https://doi.org/${doi}` : null,
    pdf_url: pdfUrl,
    abstract: typeof m.abstract === "string" ? stripTags(m.abstract) || null : null,
  };
}

async function lookupCrossref(doi: string, diag: Diagnostics): Promise<Lookup | null> {
  const clean = cleanDoi(doi);
  const json = await requestJson(`https://api.crossref.org/works/${encodeURI(clean)}`, "crossref", diag, {
    gapMs: 100,
    timeoutMs: 6000,
    retryOnce: true,
  });
  return json?.message ? crossrefToLookup(json.message as Json, clean) : null;
}

async function searchCrossref(query: string, diag: Diagnostics): Promise<Lookup | null> {
  if (query.trim().length < 3) return null;
  const json = await requestJson(
    `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(query.trim())}&rows=1`,
    "crossref",
    diag,
    { gapMs: 100, timeoutMs: 6000, retryOnce: true },
  );
  const item = (json?.message as Json | undefined)?.items?.[0] as Json | undefined;
  return item ? crossrefToLookup(item, null) : null;
}

/** DataCite — no key, CORS-enabled. Holds arXiv's DOIs, among many others. */
async function lookupDataCite(
  doi: string,
  diag: Diagnostics,
  extra?: { arxivId?: string },
): Promise<Lookup | null> {
  const clean = cleanDoi(doi);
  const json = await requestJson(`https://api.datacite.org/dois/${encodeURI(clean)}`, "datacite", diag, {
    gapMs: 0,
    timeoutMs: 6000,
    retryOnce: true,
  });
  const a = (json?.data as Json | undefined)?.attributes as Json | undefined;
  if (!a) return null;

  const title = Array.isArray(a.titles) && a.titles[0]?.title ? stripTags(String(a.titles[0].title)) : "";
  if (!title) return null;

  const authors = Array.isArray(a.creators)
    ? (a.creators as Array<{ name?: string; givenName?: string; familyName?: string }>)
        .map(personName)
        .filter(Boolean)
    : [];
  const abstractEntry = Array.isArray(a.descriptions)
    ? (a.descriptions as Array<{ description?: string; descriptionType?: string }>).find(
        (d) => d.descriptionType === "Abstract" && d.description,
      )
    : undefined;
  const year = Number(a.publicationYear);
  const arxivId = extra?.arxivId;

  return {
    title,
    authors,
    year: Number.isFinite(year) && year > 0 ? year : null,
    venue: arxivId ? "arXiv" : (a.container?.title ?? a.publisher ?? null),
    doi: arxivId ? clean : typeof a.doi === "string" ? a.doi : clean,
    url: typeof a.url === "string" && a.url ? a.url : `https://doi.org/${clean}`,
    pdf_url: arxivId ? `https://arxiv.org/pdf/${arxivId}` : null,
    abstract: abstractEntry?.description ? stripTags(abstractEntry.description) || null : null,
  };
}

/** Semantic Scholar — an extra, see the note at the top. One quick attempt:
 * if the shared pool is busy there is no point queueing behind it. */
const S2_FIELDS = "title,authors,year,venue,abstract,openAccessPdf,url,externalIds";

function semanticScholarToLookup(data: Json, fallbackDoi: string | null): Lookup | null {
  if (!data || typeof data.title !== "string" || !data.title.trim()) return null;
  const authors = Array.isArray(data.authors)
    ? (data.authors as Array<{ name?: string }>).map((a) => a.name).filter((n): n is string => !!n)
    : [];
  const doi: string | null = data.externalIds?.DOI || fallbackDoi;
  const arxivId: string | undefined = data.externalIds?.ArXiv;
  return {
    title: data.title.trim(),
    authors,
    year: data.year || null,
    venue: data.venue || (arxivId ? "arXiv" : null),
    doi: doi || null,
    url: data.url || (doi ? `https://doi.org/${doi}` : arxivId ? `https://arxiv.org/abs/${arxivId}` : null),
    pdf_url: data.openAccessPdf?.url || (arxivId ? `https://arxiv.org/pdf/${arxivId}` : null),
    abstract: data.abstract ? stripTags(data.abstract) : null,
  };
}

async function lookupSemanticScholar(id: string, diag: Diagnostics): Promise<Lookup | null> {
  // Do NOT encodeURIComponent(id): "DOI:10.xxx/yyy" needs its ":" and "/"
  // literal in the path, or Semantic Scholar's router 404s.
  const json = await requestJson(
    `https://api.semanticscholar.org/graph/v1/paper/${id}?fields=${S2_FIELDS}`,
    "semanticscholar",
    diag,
    { gapMs: 700, timeoutMs: 5000 },
  );
  return json ? semanticScholarToLookup(json, id.startsWith("DOI:") ? id.slice(4) : null) : null;
}

async function searchSemanticScholar(query: string, diag: Diagnostics): Promise<Lookup | null> {
  if (query.trim().length < 3) return null;
  const json = await requestJson(
    `https://api.semanticscholar.org/graph/v1/paper/search/match?query=${encodeURIComponent(query.trim())}&fields=${S2_FIELDS}`,
    "semanticscholar",
    diag,
    { gapMs: 700, timeoutMs: 5000 },
  );
  const hit = json?.data?.[0] as Json | undefined;
  return hit ? semanticScholarToLookup(hit, null) : null;
}

/** OpenAlex — an extra, see the note at the top. It needs a (free) API key:
 * https://openalex.org/settings/api. Without one it is still tried as a last
 * resort, which costs a request or two of its small daily allowance. A key
 * can be supplied at build time (VITE_OPENALEX_API_KEY) or, without a rebuild,
 * in the browser console:
 *   localStorage.setItem("marginalia:openalex-key", "<key>")                 */
let openAlexRefused = false;

function openAlexKey(): string | null {
  try {
    const stored = typeof localStorage !== "undefined" ? localStorage.getItem("marginalia:openalex-key") : null;
    const built = (import.meta.env?.VITE_OPENALEX_API_KEY as string | undefined) ?? null;
    return (stored || built || "").trim() || null;
  } catch {
    return null;
  }
}

/** Whether OpenAlex is worth asking up front, alongside the other providers. */
function openAlexUsable(): boolean {
  return !openAlexRefused && openAlexKey() !== null;
}

async function openAlexGet(path: string, diag: Diagnostics): Promise<Json | null> {
  // Once it has refused us (no key, or the day's allowance is gone) it will
  // keep refusing: don't spend more time on it this session.
  if (openAlexRefused) return null;
  const key = openAlexKey();
  const url = `https://api.openalex.org${path}${key ? `${path.includes("?") ? "&" : "?"}api_key=${encodeURIComponent(key)}` : ""}`;
  const before = diag.failures.length;
  const json = await requestJson(url, "openalex", diag, { gapMs: 150, timeoutMs: 6000 });
  if (!json && diag.failures.slice(before).some((f) => /^openalex: HTTP (401|403|409|429)/.test(f))) {
    openAlexRefused = true;
  }
  return json;
}

function openAlexToLookup(data: Json, fallbackDoi: string | null): Lookup | null {
  if (!data || !(data.display_name || data.title)) return null;
  const authors = Array.isArray(data.authorships)
    ? (data.authorships as Array<{ author?: { display_name?: string } }>)
        .map((a) => a.author?.display_name)
        .filter((n): n is string => !!n)
    : [];
  const rawPdfUrl: string | null = data.best_oa_location?.pdf_url || data.open_access?.oa_url || null;
  // open_access.oa_url in particular is sometimes a landing page rather
  // than a direct PDF link (e.g. a DOI resolver URL) — don't pass that
  // through as pdf_url, since it will silently break the PDF viewer.
  const doi = data.doi ? cleanDoi(String(data.doi)) : fallbackDoi;
  return {
    title: String(data.display_name || data.title),
    authors,
    year: data.publication_year || null,
    venue: data.primary_location?.source?.display_name || null,
    doi,
    url: data.primary_location?.landing_page_url || data.doi || (doi ? `https://doi.org/${doi}` : null),
    pdf_url: looksLikePdfUrl(rawPdfUrl) ? rawPdfUrl : null,
    abstract: reconstructOpenAlexAbstract(data.abstract_inverted_index),
  };
}

async function lookupOpenAlex(doi: string, diag: Diagnostics): Promise<Lookup | null> {
  const clean = cleanDoi(doi);
  const json = await openAlexGet(`/works/${encodeURI(`https://doi.org/${clean}`)}`, diag);
  return json ? openAlexToLookup(json, clean) : null;
}

async function searchOpenAlex(query: string, diag: Diagnostics): Promise<Lookup | null> {
  if (query.trim().length < 3) return null;
  const json = await openAlexGet(`/works?search=${encodeURIComponent(query.trim())}&per-page=1`, diag);
  const hit = json?.results?.[0] as Json | undefined;
  return hit ? openAlexToLookup(hit, null) : null;
}

/** The arXiv API itself. It does not reliably send CORS headers to browsers,
 * and the proxy is a shared free service that can be slow or gone, so this is
 * the last thing tried. */
async function lookupArxivDirect(arxivId: string, diag: Diagnostics): Promise<Lookup | null> {
  const directUrl = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxivId)}`;
  const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(directUrl)}`;

  for (const url of [directUrl, proxyUrl]) {
    const res = await request(url, "arxiv", diag, { gapMs: 300, timeoutMs: 8000 });
    if (!res) continue;
    try {
      const xml = await res.text();
      const entry = xml.split("<entry>")[1];
      if (!entry) continue;
      diag.answered += 1;

      const authors = [...entry.matchAll(/<name>([\s\S]*?)<\/name>/g)].map((m) => stripTags(m[1] ?? ""));
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
      console.warn(`[metadata] arXiv: unreadable response via ${url}`, err);
      diag.failures.push("arxiv: unreadable response");
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Combining providers
// ---------------------------------------------------------------------------

/** Joins several records of the *same* paper field by field: for each field,
 * the first provider in the list that has a value wins. */
function mergeLookups(parts: Array<Lookup | null>): Lookup | null {
  const have = parts.filter((p): p is Lookup => p !== null);
  const first = have[0];
  if (!first) return null;
  const text = (key: "title" | "venue" | "doi" | "url" | "abstract") =>
    have.map((l) => l[key]).find((v): v is string => typeof v === "string" && v.trim() !== "") ?? null;
  return {
    title: text("title") ?? first.title,
    authors: have.map((l) => l.authors).find((a) => a.length > 0) ?? [],
    year: have.map((l) => l.year).find((y): y is number => typeof y === "number") ?? null,
    venue: text("venue"),
    doi: text("doi"),
    url: text("url"),
    abstract: text("abstract"),
    pdf_url: first.pdf_url,
  };
}

/** The best PDF link among providers, listed in order of preference: one the
 * in-browser viewer can actually load beats a raw arxiv.org link (no CORS),
 * which beats nothing. */
function pickPdf(parts: Array<Lookup | null>): string | null {
  const urls = parts.map((p) => p?.pdf_url ?? null).filter((u): u is string => !!u);
  return urls.find((u) => !isRawArxivPdf(u)) ?? urls[0] ?? null;
}

// How long extras may keep a lookup waiting once the dependable providers have
// already answered.
const EXTRAS_GRACE_MS = 1500;

async function lookupArxiv(arxivId: string, diag: Diagnostics): Promise<Lookup | null> {
  const doi = `10.48550/arXiv.${arxivId}`;
  const askOpenAlex = openAlexUsable();

  const dataCite = lookupDataCite(doi, diag, { arxivId });
  const semanticScholar = lookupSemanticScholar(`ARXIV:${arxivId}`, diag);
  const openAlex = askOpenAlex ? lookupOpenAlex(doi, diag) : Promise.resolve(null);

  const core = await dataCite;
  const [ss, oa] = core
    ? await Promise.all([orNullAfter(semanticScholar, EXTRAS_GRACE_MS), orNullAfter(openAlex, EXTRAS_GRACE_MS)])
    : await Promise.all([semanticScholar, openAlex]);

  let merged = mergeLookups([core, ss, oa]);
  if (!merged && !askOpenAlex) {
    // Nothing else answered; spend a keyless OpenAlex request.
    merged = mergeLookups([await lookupOpenAlex(doi, diag)]);
  }
  if (!merged) return lookupArxivDirect(arxivId, diag);

  return {
    ...merged,
    venue: merged.venue ?? "arXiv",
    doi: merged.doi ?? doi,
    url: merged.url ?? `https://arxiv.org/abs/${arxivId}`,
    pdf_url: pickPdf([ss, oa, core]) ?? `https://arxiv.org/pdf/${arxivId}`,
  };
}

async function lookupDoi(doi: string, diag: Diagnostics): Promise<Lookup | null> {
  const askOpenAlex = openAlexUsable();

  const crossref = lookupCrossref(doi, diag);
  const dataCite = lookupDataCite(doi, diag);
  const semanticScholar = lookupSemanticScholar(`DOI:${doi}`, diag);
  const openAlex = askOpenAlex ? lookupOpenAlex(doi, diag) : Promise.resolve(null);

  const [cr, dc] = await Promise.all([crossref, dataCite]);
  const [ss, oa] =
    cr || dc
      ? await Promise.all([orNullAfter(semanticScholar, EXTRAS_GRACE_MS), orNullAfter(openAlex, EXTRAS_GRACE_MS)])
      : await Promise.all([semanticScholar, openAlex]);

  let merged = mergeLookups([cr, dc, ss, oa]);
  if (!merged && !askOpenAlex) merged = mergeLookups([await lookupOpenAlex(doi, diag)]);
  if (!merged) return null;

  // Open-access links first: Crossref's own PDF links are usually the
  // publisher's, behind a paywall and without CORS.
  return { ...merged, pdf_url: pickPdf([ss, oa, cr, dc]) };
}

async function lookupFreeText(query: string, diag: Diagnostics): Promise<Lookup | null> {
  const askOpenAlex = openAlexUsable();
  const semanticScholar = searchSemanticScholar(query, diag);
  const crossref = searchCrossref(query, diag);
  const openAlex = askOpenAlex ? searchOpenAlex(query, diag) : Promise.resolve(null);

  const cr = await crossref;
  const ss = await (cr ? orNullAfter(semanticScholar, EXTRAS_GRACE_MS) : semanticScholar);
  const oa = await (cr || ss ? orNullAfter(openAlex, EXTRAS_GRACE_MS) : openAlex);

  // These are three different guesses at *which* paper was meant, so they are
  // not merged. Take the best single hit, then enrich it from its DOI — which
  // does join records of one known paper.
  const hit = ss ?? cr ?? oa;
  if (!hit) return null;
  if (hit.doi) {
    const richer = await lookupDoi(hit.doi, diag).catch(() => null);
    const merged = mergeLookups([richer, hit]);
    if (merged) return { ...merged, pdf_url: richer?.pdf_url ?? hit.pdf_url };
  }
  return hit;
}

async function lookupMetadataUncached(kind: "doi" | "arxiv" | "search", value: string): Promise<Lookup | null> {
  const diag: Diagnostics = { answered: 0, failures: [] };
  const found =
    kind === "arxiv"
      ? await lookupArxiv(value, diag)
      : kind === "doi"
        ? await lookupDoi(value, diag)
        : await lookupFreeText(value, diag);

  if (found) return found;

  if (diag.answered === 0 && diag.failures.length > 0) {
    // Not "there is no such paper" but "nobody we asked was able to say".
    console.warn(`[metadata] No provider could be reached for ${kind} "${value}":`, diag.failures);
    throw new Error(
      "Couldn't reach any of the lookup services right now. Check your connection and try again in a moment.",
    );
  }
  console.warn(`[metadata] No metadata found for ${kind} "${value}"`, diag.failures);
  return null;
}

// Cache in-flight and completed lookups, keyed by the *normalized*
// identifier (kind:value) rather than the raw input string, so
// "arxiv.org/abs/X", "arxiv.org/pdf/X", and bare "X" all share one entry.
// Misses (null results) and failures are evicted immediately rather than
// cached, so a transient outage doesn't permanently blackhole a real paper for
// the rest of the session — only genuine successes stay cached.
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