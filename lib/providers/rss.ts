import "server-only";
import { XMLParser } from "fast-xml-parser";
import { cachePolicy, feeds } from "@/app.config";
import { cacheGet, cacheSet } from "@/lib/cache";
import { safeFetch } from "@/lib/network/safe-fetch";
import { bm25Scores, canonicalizeUrl, coverage, stripHtml, terms, toIso } from "@/lib/text";
import { remaining, type Lead, type Provider } from "./types";

/**
 * Selected RSS/Atom feeds → a small bounded local index of recent headlines + summaries.
 * A feed item is discovery metadata: the orchestrator fetches the article itself before it can
 * contribute to a green/red finding. Refresh is bounded (one pass over ≈10 feeds, 4 s each),
 * deduplicated, coalesced and backed off per feed after failures.
 */
export type FeedEntry = {
  url: string;
  title: string;
  summary: string;
  publishedAt: string | null;
  publisher: string;
  feedId: string;
};

type FeedIndex = { refreshedAt: string; entries: FeedEntry[]; failures: Record<string, { at: number; count: number; message: string }> };

const INDEX_KEY = "feed-index-v1";
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", textNodeName: "#text", processEntities: true, htmlEntities: true });

let memory: FeedIndex | null = null;
let refreshing: Promise<FeedIndex> | null = null;

function text(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string" || typeof v === "number") return String(v);
  if (Array.isArray(v)) return text(v[0]);
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("#text" in o) return text(o["#text"]);
    if ("@_href" in o) return text(o["@_href"]);
  }
  return "";
}

export function parseFeed(xml: string, feed: { id: string; publisher: string }): FeedEntry[] {
  const doc = parser.parse(xml) as Record<string, unknown>;
  const rss = doc.rss as { channel?: { item?: unknown } } | undefined;
  const atom = doc.feed as { entry?: unknown } | undefined;
  const rawItems = rss?.channel?.item ?? atom?.entry ?? (doc["rdf:RDF"] as { item?: unknown } | undefined)?.item ?? [];
  const items = (Array.isArray(rawItems) ? rawItems : [rawItems]) as Record<string, unknown>[];
  const out: FeedEntry[] = [];
  for (const it of items.slice(0, 120)) {
    let link = text(it.link);
    if (Array.isArray(it.link)) {
      const alt = (it.link as Record<string, unknown>[]).find((l) => !l["@_rel"] || l["@_rel"] === "alternate");
      link = text(alt?.["@_href"] ?? alt);
    }
    if (!link) link = text(it.guid);
    if (!/^https?:\/\//.test(link)) continue;
    const title = stripHtml(text(it.title));
    if (!title) continue;
    out.push({
      url: link.trim(),
      title,
      summary: stripHtml(text(it.description ?? it.summary ?? it.content)).slice(0, 600),
      publishedAt: toIso(text(it.pubDate ?? it.published ?? it.updated ?? it["dc:date"])),
      publisher: feed.publisher,
      feedId: feed.id,
    });
  }
  return out;
}

async function loadIndex(): Promise<FeedIndex | null> {
  if (memory) return memory;
  const hit = await cacheGet<FeedIndex>("feeds", INDEX_KEY, { allowStale: true });
  memory = hit?.value ?? null;
  return memory;
}

export async function refreshFeedIndex(signal?: AbortSignal, perFeedTimeoutMs = 4_000): Promise<FeedIndex> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const prev = (await loadIndex()) ?? { refreshedAt: new Date(0).toISOString(), entries: [], failures: {} };
    const failures = { ...prev.failures };
    const fresh: FeedEntry[] = [];
    await Promise.all(
      feeds.map(async (feed) => {
        const f = failures[feed.id];
        // Exponential backoff for feeds that keep failing (max 2 h).
        if (f && Date.now() - f.at < Math.min(2 * 60 * 60 * 1000, 60_000 * 2 ** Math.min(f.count, 7))) return;
        try {
          const res = await safeFetch(feed.url, { signal, timeoutMs: perFeedTimeoutMs, maxBytes: 1_500_000, accept: "application/rss+xml,application/atom+xml,application/xml,text/xml" });
          fresh.push(...parseFeed(res.text, feed));
          delete failures[feed.id];
        } catch (err) {
          failures[feed.id] = { at: Date.now(), count: (f?.count ?? 0) + 1, message: err instanceof Error ? err.message : "failed" };
        }
      }),
    );
    // Merge with previous entries (dedupe by canonical URL), keep newest N.
    const byUrl = new Map<string, FeedEntry>();
    for (const e of [...fresh, ...prev.entries]) {
      const k = canonicalizeUrl(e.url);
      if (!byUrl.has(k)) byUrl.set(k, e);
    }
    const entries = [...byUrl.values()]
      .sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""))
      .slice(0, cachePolicy.maxFeedEntries);
    const index: FeedIndex = { refreshedAt: fresh.length ? new Date().toISOString() : prev.refreshedAt, entries, failures };
    memory = index;
    await cacheSet("feeds", INDEX_KEY, index, 30 * 24 * 60 * 60 * 1000, 4).catch(() => undefined);
    return index;
  })();
  try {
    return await refreshing;
  } finally {
    refreshing = null;
  }
}

export function clearFeedMemory(): void {
  memory = null;
}

export async function feedIndexInfo(): Promise<{ entries: number; refreshedAt: string | null; failing: string[] }> {
  const idx = await loadIndex();
  return {
    entries: idx?.entries.length ?? 0,
    refreshedAt: idx && idx.entries.length ? idx.refreshedAt : null,
    failing: Object.keys(idx?.failures ?? {}),
  };
}

/** Non-blocking warm-up: refresh when stale, never awaited by the UI. */
export function warmFeedIndex(): void {
  void loadIndex().then((idx) => {
    const age = idx ? Date.now() - new Date(idx.refreshedAt).getTime() : Infinity;
    if (age > cachePolicy.feedIndexTtlMs) void refreshFeedIndex().catch(() => undefined);
  });
}

export const rssProvider: Provider = {
  id: "rss",
  name: "Selected news feeds",
  kind: "core",
  scope: "selected",
  description: `A bounded index of recent headlines from ${feeds.length} public feeds (BBC, The Hindu, Indian Express, Mint, NDTV, Guardian, NPR, Al Jazeera, Alt News, FactCheck.org). Recent items only.`,
  modes: ["live"],
  timeoutMs: 4_500,
  cachePolicy: "Index refreshed when older than 20 minutes; up to 900 recent items kept.",
  enabled: () => true,
  disabledReason: () => null,
  async search(q): Promise<Lead[]> {
    let idx = await loadIndex();
    const age = idx ? Date.now() - new Date(idx.refreshedAt).getTime() : Infinity;
    if (!idx || !idx.entries.length || age > cachePolicy.feedIndexTtlMs) {
      const budget = Math.min(this.timeoutMs, remaining(q.deadline) - 300);
      if (budget > 800) idx = await refreshFeedIndex(q.signal, budget).catch(() => idx);
    }
    if (!idx?.entries.length) return [];
    const qTerms = terms(q.queries.join(" ") + " " + q.claims.join(" "));
    const docs = idx.entries.map((e) => terms(`${e.title} ${e.title} ${e.summary}`));
    const scores = bm25Scores(qTerms, docs);
    return idx.entries
      .map((e, i) => ({ e, s: scores[i]!, c: coverage(qTerms, docs[i]!) }))
      .filter((x) => x.s > 0 && x.c >= 0.15)
      .sort((a, b) => b.s - a.s)
      .slice(0, q.maxResults)
      .map(({ e }, i) => ({
        url: e.url,
        title: e.title,
        publisher: e.publisher,
        publishedAt: e.publishedAt,
        snippet: e.summary || null,
        provider: "rss",
        kind: "news_article" as const,
        providerRank: i,
      }));
  },
};
