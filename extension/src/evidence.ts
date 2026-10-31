import { feeds, topicFeeds } from "@/app.config";
import { classifyClaim, describeClassification, routeFeeds } from "@/lib/investigation/topics";
import { decide, rankItems, type Doc, type RuleResult } from "./rules";
import { loadArticle, loadFeed, type FeedItem } from "./web";

const FACT_CHECK_FEEDS = new Set(["altnews", "factcheckorg"]);

export type Progress = (message: string) => void;

/**
 * Evidence-only investigation, entirely inside the extension: keyword routing → feeds →
 * article pages → deterministic rules. Bounded: ≤ 21 feeds, ≤ 6 article pages.
 */
export async function runEvidenceOnly(claim: string, signal: AbortSignal, progress: Progress): Promise<RuleResult & { detected: string; elapsedMs: number }> {
  const t0 = Date.now();
  const cls = classifyClaim(claim);
  const detected = describeClassification(cls);
  const route = routeFeeds(cls, 6);
  const chosen = [...feeds.map((f) => ({ ...f })), ...topicFeeds.filter((f) => route.ids.includes(f.id))];
  progress(`Detected ${detected}. Searching ${chosen.length} news feeds…`);

  const all: FeedItem[] = (await Promise.all(chosen.map((f) => loadFeed(f, signal)))).flat();
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  progress(`Scanned ${all.length} recent headlines.`);

  const factCheckItems = all.filter((i) => FACT_CHECK_FEEDS.has(i.feedId));
  const newsItems = all.filter((i) => !FACT_CHECK_FEEDS.has(i.feedId));
  let top = rankItems(claim, newsItems, 8).map((i) => newsItems[i]!);
  // At most two pages per publisher.
  const perPub = new Map<string, number>();
  top = top.filter((it) => {
    const n = perPub.get(it.publisher) ?? 0;
    perPub.set(it.publisher, n + 1);
    return n < 2;
  }).slice(0, 5);
  const fcTop = rankItems(claim, factCheckItems, 2).map((i) => factCheckItems[i]!);

  progress(top.length ? `Reading ${top.length} matching report${top.length === 1 ? "" : "s"}…` : "No matching headlines in the selected feeds.");
  const docs: Doc[] = (await Promise.all(top.map((it) => loadArticle(it, signal)))).map((a) => ({ ...a, isFactCheck: false }));

  // Follow the story: if a matching report is blocked, look for the same headline elsewhere.
  const blocked = docs.filter((d) => !d.readable);
  if (blocked.length && docs.filter((d) => d.readable).length < 2) {
    progress(`${blocked.map((d) => d.publisher).join(", ")} could not be read — looking for the same story elsewhere…`);
    const tried = new Set(docs.map((d) => d.url));
    const blockedPubs = new Set(blocked.map((d) => d.publisher));
    const again = rankItems(`${claim} ${blocked.map((d) => d.title).join(" ")}`, newsItems, 10)
      .map((i) => newsItems[i]!)
      .filter((it) => !tried.has(it.url) && !blockedPubs.has(it.publisher))
      .slice(0, 3);
    docs.push(...(await Promise.all(again.map((it) => loadArticle(it, signal)))).map((a) => ({ ...a, isFactCheck: false })));
  }
  for (const it of fcTop) docs.push({ url: it.url, title: it.title, publisher: it.publisher, publishedAt: it.publishedAt, text: it.summary, links: [], readable: false, note: null, isFactCheck: true });

  progress("Comparing names, numbers, places and outcomes…");
  return { ...decide(claim, docs), detected, elapsedMs: Date.now() - t0 };
}
