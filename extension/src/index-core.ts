import type { FeedEntry } from "@/lib/providers/feed-parse";
import { canonicalizeUrl, coverage, terms } from "@/lib/text";

/**
 * Rolling local news index — pure logic (storage lives in index-store.ts).
 * Each headline is stored once (keyed by canonical URL) with its pre-computed search terms,
 * kept for 14 days, capped at 40,000 items (≈ 10–15 MB).
 */
export type IndexRecord = {
  k: string;
  url: string;
  title: string;
  summary: string;
  publisher: string;
  feedId: string;
  publishedAt: string | null;
  seenAt: number;
  /** Space-joined search terms of title (twice) + summary. */
  t: string;
};

export const INDEX_MAX_AGE_DAYS = 14;
export const INDEX_MAX_ITEMS = 40_000;

export function toRecords(entries: FeedEntry[], now: number): IndexRecord[] {
  return entries.map((e) => ({
    k: canonicalizeUrl(e.url),
    url: e.url,
    title: e.title,
    summary: e.summary.slice(0, 400),
    publisher: e.publisher,
    feedId: e.feedId,
    publishedAt: e.publishedAt,
    seenAt: now,
    t: terms(`${e.title} ${e.title} ${e.summary}`).join(" "),
  }));
}

/** Keys to delete: older than the window (by publish date, else first seen), then oldest beyond the cap. */
export function pruneKeys(records: IndexRecord[], now: number, maxAgeDays = INDEX_MAX_AGE_DAYS, maxItems = INDEX_MAX_ITEMS): string[] {
  const cutoff = now - maxAgeDays * 86_400_000;
  const when = (r: IndexRecord) => (r.publishedAt ? new Date(r.publishedAt).getTime() : r.seenAt);
  const drop = new Set(records.filter((r) => when(r) < cutoff).map((r) => r.k));
  const rest = records.filter((r) => !drop.has(r.k)).sort((a, b) => when(b) - when(a));
  for (const r of rest.slice(maxItems)) drop.add(r.k);
  return [...drop];
}

/** Best-matching headlines for a claim: term coverage first, newer first on ties. */
export function searchRecords(records: IndexRecord[], claim: string, limit: number, minCoverage = 0.25): IndexRecord[] {
  const q = terms(claim);
  if (!q.length) return [];
  return records
    .map((r) => ({ r, c: coverage(q, r.t.split(" ")) }))
    .filter((x) => x.c >= minCoverage)
    .sort((a, b) => b.c - a.c || (b.r.publishedAt ?? "").localeCompare(a.r.publishedAt ?? ""))
    .slice(0, limit)
    .map((x) => x.r);
}
