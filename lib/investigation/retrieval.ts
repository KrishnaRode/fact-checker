import "server-only";
import { budgets, cachePolicy } from "@/app.config";
import { cacheGet, cacheSet } from "@/lib/cache";
import { FetchError, politeFetch } from "@/lib/network/safe-fetch";
import { robotsAllows } from "@/lib/network/robots";
import { ProviderError, type Lead, type Provider, type ProviderQuery } from "@/lib/providers/types";
import { bm25Scores, canonicalizeUrl, domainOf, normalizeText, sha256, terms } from "@/lib/text";
import { extractArticle } from "./extract";

/** A document as the pipeline sees it: extracted text + server-established metadata. */
export type FetchedDocument = {
  url: string;
  canonicalUrl: string;
  title: string;
  text: string;
  publisher: string | null;
  publishedAt: string | null;
  modifiedAt: string | null;
  fetchedAt: string;
  access: "full_text" | "snippet_only" | "blocked" | "failed";
  accessNote: string | null;
  provider: string;
  kind: "news_article" | "reference" | "fact_check" | "web_page" | "user_submitted";
  links: string[];
  attributions: string[];
  revisionId: string | null;
  factCheck: Lead["factCheck"] | null;
  /** Text the passages are drawn from is the body (full_text) or a snippet/feed excerpt. */
  textKind: "article_body" | "search_snippet" | "feed_excerpt";
  contentHash: string | null;
  fromCache: boolean;
};

export interface DocumentSource {
  fetch(lead: Lead, opts: { signal: AbortSignal; timeoutMs: number; revalidate: boolean }): Promise<FetchedDocument>;
}

type CachedDoc = Omit<FetchedDocument, "fromCache" | "provider" | "kind" | "factCheck"> & { etag: string | null; lastModified: string | null };

const MIN_BODY_CHARS = 280;

export function hashContent(text: string): string | null {
  const t = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return t.length >= 200 ? sha256(t).slice(0, 24) : null;
}

/** Fallback document from a lead's snippet when the page itself is not accessible. */
export function snippetDocument(lead: Lead, access: FetchedDocument["access"], note: string | null): FetchedDocument {
  const snippet = normalizeText(lead.snippet ?? "");
  return {
    url: lead.url,
    canonicalUrl: canonicalizeUrl(lead.url),
    title: lead.title,
    text: snippet,
    publisher: lead.publisher,
    publishedAt: lead.publishedAt,
    modifiedAt: lead.modifiedAt ?? null,
    fetchedAt: new Date().toISOString(),
    access: snippet ? (access === "full_text" ? "snippet_only" : access) : access,
    accessNote: note,
    provider: lead.provider,
    kind: lead.kind,
    links: [],
    attributions: [],
    revisionId: lead.revisionId ?? null,
    factCheck: lead.factCheck ?? null,
    textKind: lead.provider === "rss" ? "feed_excerpt" : "search_snippet",
    contentHash: null,
    fromCache: false,
  };
}

/** Live fetcher: robots-aware, SSRF-safe, cached with conditional revalidation. */
export const liveDocumentSource: DocumentSource = {
  async fetch(lead, { signal, timeoutMs, revalidate }) {
    const now = new Date().toISOString();
    if (lead.fullText) {
      return {
        url: lead.url,
        canonicalUrl: canonicalizeUrl(lead.url),
        title: lead.title,
        text: lead.fullText,
        publisher: lead.publisher,
        publishedAt: lead.publishedAt,
        modifiedAt: lead.modifiedAt ?? null,
        fetchedAt: now,
        access: "full_text",
        accessNote: lead.revisionId ? `Wikipedia revision ${lead.revisionId}.` : null,
        provider: lead.provider,
        kind: lead.kind,
        links: [],
        attributions: [],
        revisionId: lead.revisionId ?? null,
        factCheck: null,
        textKind: "article_body",
        contentHash: hashContent(lead.fullText),
        fromCache: false,
      };
    }
    const key = canonicalizeUrl(lead.url);
    const cached = await cacheGet<CachedDoc>("documents", key, { allowStale: true });
    if (cached && !cached.stale && !revalidate) {
      return { ...cached.value, provider: lead.provider, kind: lead.kind, factCheck: lead.factCheck ?? null, fromCache: true };
    }

    try {
      if (!(await robotsAllows(lead.url, signal))) {
        return snippetDocument(lead, "blocked", "The site's robots.txt does not permit automated reading of this page.");
      }
      const conditional: Record<string, string> = {};
      if (cached?.value.etag) conditional["if-none-match"] = cached.value.etag;
      if (cached?.value.lastModified) conditional["if-modified-since"] = cached.value.lastModified;
      const res = await politeFetch(lead.url, { signal, timeoutMs, headers: conditional, allowNotModified: !!cached, minGapMs: 1_000 });
      if (res.notModified && cached) {
        const value = { ...cached.value, fetchedAt: now, accessNote: "Unchanged since the last read (server confirmed)." };
        await cacheSet("documents", key, value, cachePolicy.documentTtlMs, cachePolicy.maxDocuments).catch(() => undefined);
        return { ...value, provider: lead.provider, kind: lead.kind, factCheck: lead.factCheck ?? null, fromCache: true };
      }
      if (res.contentType === "application/json" || res.contentType === "text/plain") {
        return snippetDocument(lead, "failed", "The link did not return an HTML article.");
      }
      const ex = extractArticle(res.text, res.url, budgets.documentTextMaxChars);
      if (ex.text.length < MIN_BODY_CHARS) {
        return snippetDocument(lead, "blocked", "The article text was not accessible (paywall, sign-in or script-rendered page).");
      }
      const doc: CachedDoc = {
        url: res.url,
        canonicalUrl: ex.canonicalUrl,
        title: ex.title || lead.title,
        text: ex.text,
        publisher: ex.publisher ?? lead.publisher,
        publishedAt: ex.publishedAt ?? lead.publishedAt,
        modifiedAt: ex.modifiedAt,
        fetchedAt: now,
        access: "full_text",
        accessNote: ex.extractionNote,
        links: ex.links,
        attributions: ex.attributions,
        revisionId: null,
        textKind: "article_body",
        contentHash: hashContent(ex.text),
        etag: res.headers["etag"] ?? null,
        lastModified: res.headers["last-modified"] ?? null,
      };
      await cacheSet("documents", key, doc, cachePolicy.documentTtlMs, cachePolicy.maxDocuments).catch(() => undefined);
      return { ...doc, provider: lead.provider, kind: lead.kind, factCheck: lead.factCheck ?? null, fromCache: false };
    } catch (err) {
      if (err instanceof FetchError && err.code === "aborted") throw err;
      if (cached) {
        return { ...cached.value, provider: lead.provider, kind: lead.kind, factCheck: lead.factCheck ?? null, fromCache: true, accessNote: "Live re-read failed; using the copy read earlier (it may have changed since)." };
      }
      const msg = err instanceof FetchError ? err.message : "The page could not be read.";
      return snippetDocument(lead, err instanceof FetchError && err.status && [401, 402, 403].includes(err.status) ? "blocked" : "failed", msg);
    }
  },
};

/* ── Discovery ────────────────────────────────────────────────────────────── */

export type DiscoveryOutcome = {
  leads: Lead[];
  attempted: string[];
  succeeded: string[];
  warnings: { provider: string; code: string; message: string }[];
};

/** Run independent providers concurrently; each failure is reported and isolated. */
export async function discover(
  providers: Provider[],
  q: Omit<ProviderQuery, "signal"> & { signal: AbortSignal },
  hooks: { onLead?: (l: Lead) => void; onWarning?: (w: { provider: string; code: string; message: string }) => void },
): Promise<DiscoveryOutcome> {
  const outcome: DiscoveryOutcome = { leads: [], attempted: [], succeeded: [], warnings: [] };
  await Promise.all(
    providers.map(async (p) => {
      outcome.attempted.push(p.id);
      const ctrl = new AbortController();
      const onAbort = () => ctrl.abort();
      q.signal.addEventListener("abort", onAbort, { once: true });
      const budget = Math.min(p.timeoutMs, Math.max(0, q.deadline - Date.now()));
      const timer = setTimeout(() => ctrl.abort(), budget);
      try {
        const leads = await Promise.race([
          p.search({ ...q, signal: ctrl.signal, deadline: Math.min(q.deadline, Date.now() + budget) }),
          new Promise<never>((_, reject) =>
            ctrl.signal.addEventListener("abort", () => reject(new ProviderError(p.id, q.signal.aborted ? "aborted" : "timeout", "Did not respond within its time budget.")), { once: true }),
          ),
        ]);
        outcome.succeeded.push(p.id);
        for (const l of leads) {
          outcome.leads.push(l);
          hooks.onLead?.(l);
        }
      } catch (err) {
        const e = err instanceof ProviderError ? err : new ProviderError(p.id, "unavailable", "Could not be reached.");
        if (e.code === "aborted" && q.signal.aborted) return;
        const w = { provider: p.id, code: e.code, message: `${p.name}: ${e.message}` };
        outcome.warnings.push(w);
        hooks.onWarning?.(w);
      } finally {
        clearTimeout(timer);
        q.signal.removeEventListener("abort", onAbort);
      }
    }),
  );
  return outcome;
}

/**
 * Rank and deduplicate leads for fetching. Relevance and directness first; recency matters
 * only for time-sensitive claims. Scores are internal ordering, never shown as probabilities.
 */
export function rankLeads(leads: Lead[], claimText: string, opts: { volatile: boolean; referenceDate: string; limit: number; perDomain: number }): Lead[] {
  const seen = new Set<string>();
  const unique: Lead[] = [];
  for (const l of leads) {
    const k = canonicalizeUrl(l.url);
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(l);
  }
  const qTerms = terms(claimText);
  const docs = unique.map((l) => terms(`${l.title} ${l.title} ${l.snippet ?? ""} ${(l.fullText ?? "").slice(0, 1500)}`));
  const scores = bm25Scores(qTerms, docs);
  // Reciprocal rank fusion: our title/snippet relevance + each provider's own ranking (which
  // may have seen more of the document than its snippet).
  const ourRank = new Map([...scores.keys()].sort((a, b) => scores[b]! - scores[a]!).map((idx, r) => [idx, r]));
  const ref = new Date(`${opts.referenceDate}T12:00:00Z`).getTime();
  const scored = unique.map((l, i) => {
    let s = scores[i]! > 0 ? 1 / (8 + ourRank.get(i)!) + 1 / (8 + (l.providerRank ?? 20)) : 0;
    if (l.kind === "fact_check") s *= 1.25;
    if (l.kind === "reference") s *= 0.8;
    if (opts.volatile && l.publishedAt) {
      const ageDays = (ref - new Date(l.publishedAt).getTime()) / 86_400_000;
      if (ageDays > 30) s *= 0.75;
    }
    return { l, s };
  });
  scored.sort((a, b) => b.s - a.s);
  const perDomain = new Map<string, number>();
  const out: Lead[] = [];
  for (const { l, s } of scored) {
    if (s <= 0 && !l.fullText && (l.providerRank ?? 99) > 2) continue;
    const d = domainOf(l.url);
    const n = perDomain.get(d) ?? 0;
    if (n >= opts.perDomain) continue;
    perDomain.set(d, n + 1);
    out.push(l);
    if (out.length >= opts.limit) break;
  }
  return out;
}
