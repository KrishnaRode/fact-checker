import { feeds, topicFeeds } from "@/app.config";
import { classifyClaim, describeClassification, routeFeeds } from "@/lib/investigation/topics";
import { canonicalizeUrl, domainOf, terms } from "@/lib/text";
import { searchRecords, type IndexRecord } from "./index-core";
import { allRecords, getMeta } from "./index-store";
import { decide, type Doc, type RuleResult } from "./rules";
import { canReadAnySite, searchGdelt, wikipediaDoc } from "./sources";
import { loadArticle, loadFeed } from "./web";

const FACT_CHECK_FEEDS = new Set(["altnews", "factcheckorg"]);

export type Progress = (message: string) => void;
export type EvidenceRun = RuleResult & { detected: string; elapsedMs: number; coverageNote: string };

/**
 * Evidence-only investigation, entirely inside the extension:
 *   local 14-day index of 55 feeds + a fresh pull of the routed feeds → best headlines →
 *   up to 5 article pages (+3 when following a blocked story) → GDELT (≈3 months, worldwide)
 *   when local coverage is thin → Wikipedia background → deterministic rules.
 */
export async function runEvidenceOnly(claim: string, signal: AbortSignal, progress: Progress): Promise<EvidenceRun> {
  const t0 = Date.now();
  const cls = classifyClaim(claim);
  const detected = describeClassification(cls);
  const route = routeFeeds(cls, 6);
  const fresh = [...feeds, ...topicFeeds.filter((f) => route.ids.includes(f.id))];

  // GDELT is slow: start it now, use it only if local coverage turns out thin.
  const gdeltP = searchGdelt(claim, signal);
  const wikiP = wikipediaDoc(claim, signal);

  const [index, meta, live] = await Promise.all([allRecords().catch(() => [] as IndexRecord[]), getMeta().catch(() => null), Promise.all(fresh.map((f) => loadFeed(f, signal))).then((x) => x.flat())]);
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  const oldest = index.reduce((m, r) => Math.min(m, r.publishedAt ? new Date(r.publishedAt).getTime() : r.seenAt), Date.now());
  const days = meta?.lastRefresh ? Math.round((Date.now() - oldest) / 86_400_000) : 0;
  progress(`Detected ${detected}. Searching ${index.length.toLocaleString("en-IN")} indexed headlines${days ? ` (last ${days} days)` : ""} + ${live.length} fresh ones…`);

  // Merge the local index (terms pre-computed) with fresh items; fresh wins on duplicates.
  const pool = new Map<string, IndexRecord>();
  for (const r of index) pool.set(r.k, r);
  for (const it of live) {
    const k = canonicalizeUrl(it.url);
    pool.set(k, { ...it, k, seenAt: Date.now(), t: terms(`${it.title} ${it.title} ${it.summary}`).join(" ") });
  }
  const records = [...pool.values()];
  const news = records.filter((r) => !FACT_CHECK_FEEDS.has(r.feedId));
  const checks = records.filter((r) => FACT_CHECK_FEEDS.has(r.feedId));

  const perPub = new Map<string, number>();
  const top = searchRecords(news, claim, 12)
    .filter((it) => {
      const n = perPub.get(it.publisher) ?? 0;
      perPub.set(it.publisher, n + 1);
      return n < 2;
    })
    .slice(0, 5);
  const fcTop = searchRecords(checks, claim, 2, 0.4);

  progress(top.length ? `Reading ${top.length} matching report${top.length === 1 ? "" : "s"}…` : "No matching headlines in the local index.");
  const docs: Doc[] = (await Promise.all(top.map((it) => loadArticle(it, signal)))).map((a) => ({ ...a, isFactCheck: false }));

  // Follow the story: a blocked report's headline is searched again across the index.
  const blocked = docs.filter((d) => !d.readable);
  if (blocked.length && docs.filter((d) => d.readable).length < 2) {
    progress(`${blocked.map((d) => d.publisher).join(", ")} could not be read — looking for the same story elsewhere…`);
    const tried = new Set(docs.map((d) => canonicalizeUrl(d.url)));
    const blockedPubs = new Set(blocked.map((d) => d.publisher));
    const again = searchRecords(news, `${claim} ${blocked.map((d) => d.title).join(" ")}`, 10)
      .filter((it) => !tried.has(it.k) && !blockedPubs.has(it.publisher))
      .slice(0, 3);
    docs.push(...(await Promise.all(again.map((it) => loadArticle(it, signal)))).map((a) => ({ ...a, isFactCheck: false })));
  }

  // GDELT when local coverage is thin (fewer than two readable reports).
  let coverageNote = `Local index: ${index.length.toLocaleString("en-IN")} headlines from 55 feeds${days ? `, last ${days} days` : ""}.`;
  if (docs.filter((d) => d.readable).length < 2) {
    progress("Local coverage is thin — searching GDELT's worldwide news index (≈3 months)…");
    const leads = (await gdeltP).filter((l) => !docs.some((d) => canonicalizeUrl(d.url) === canonicalizeUrl(l.url)));
    if (leads.length) {
      const anySite = await canReadAnySite();
      const readableLeads = leads.filter((l) => anySite || pool.size === 0 || [...pool.values()].some((p) => domainOf(p.url) === domainOf(l.url))).slice(0, 3);
      const extra = await Promise.all(readableLeads.map((l) => loadArticle({ url: l.url, title: l.title, summary: "", publishedAt: l.seenAt, publisher: l.domain, feedId: "gdelt" }, signal)));
      docs.push(...extra.map((a) => ({ ...a, isFactCheck: false })));
      const unreadableLeads = leads.filter((l) => !readableLeads.includes(l)).slice(0, 3);
      docs.push(...unreadableLeads.map((l) => ({ url: l.url, title: l.title, publisher: l.domain, publishedAt: l.seenAt, text: "", links: [], readable: false, note: anySite ? "Not read (limit reached)." : "Found by GDELT on a site outside the default list — allow “Read articles from any site” in settings to read it.", isFactCheck: false })));
      coverageNote += ` GDELT found ${leads.length} more report${leads.length === 1 ? "" : "s"}${anySite ? "" : " (some sites need your permission to read)"}.`;
    } else coverageNote += " GDELT found nothing more (or did not answer in time).";
  }

  const wiki = await wikiP;
  if (wiki) docs.push(wiki);
  for (const it of fcTop) docs.push({ url: it.url, title: it.title, publisher: it.publisher, publishedAt: it.publishedAt, text: it.summary, links: [], readable: false, note: null, isFactCheck: true });

  progress("Comparing names, numbers, places, outcomes and opposite wording…");
  return { ...decide(claim, docs), detected, elapsedMs: Date.now() - t0, coverageNote };
}
