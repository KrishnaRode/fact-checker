import { feeds, topicFeeds } from "@/app.config";
import { parseFeed } from "@/lib/providers/feed-parse";
import { pruneKeys, toRecords } from "./index-core";
import { allRecords, deleteKeys, getMeta, putRecords, setMeta } from "./index-store";

/**
 * Refresh the local index from ALL configured feeds (14 general + 41 topic/city), 8 at a time,
 * 8 s each. Runs in the background every 30 minutes; never blocks a check.
 */
export const ALL_FEEDS = [...feeds, ...topicFeeds].map((f) => ({ id: f.id, publisher: f.publisher, url: f.url }));
const STALE_RUN_MS = 10 * 60 * 1000;

async function fetchFeed(f: { id: string; publisher: string; url: string }) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8_000);
  try {
    const res = await fetch(f.url, { signal: ctrl.signal, credentials: "omit", cache: "no-store" });
    if (!res.ok) return null;
    return parseFeed(await res.text(), f);
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export async function refreshIndex(): Promise<{ added: number; ok: number; total: number }> {
  const meta = await getMeta();
  if (meta.running && meta.lastRefresh && Date.now() - meta.lastRefresh < STALE_RUN_MS) return { added: 0, ok: meta.feedsOk, total: meta.feedsTotal };
  await setMeta({ ...meta, running: true });
  let ok = 0;
  let added = 0;
  try {
    const queue = [...ALL_FEEDS];
    const workers = Array.from({ length: 8 }, async () => {
      for (let f = queue.shift(); f; f = queue.shift()) {
        const entries = await fetchFeed(f);
        if (!entries) continue;
        ok++;
        const recs = toRecords(entries, Date.now());
        added += recs.length;
        await putRecords(recs);
      }
    });
    await Promise.all(workers);
    const all = await allRecords();
    const drop = pruneKeys(all, Date.now());
    await deleteKeys(drop);
    await setMeta({ lastRefresh: Date.now(), count: all.length - drop.length, feedsOk: ok, feedsTotal: ALL_FEEDS.length, running: false });
  } catch {
    await setMeta({ ...(await getMeta()), running: false });
  }
  return { added, ok, total: ALL_FEEDS.length };
}
