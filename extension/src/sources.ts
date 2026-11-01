import { queriesFor } from "@/lib/investigation/claim-planner";
import { normalizeText } from "@/lib/text";
import type { Doc } from "./rules";

/**
 * Extra sources for evidence-only mode:
 *  - GDELT DOC API: worldwide news discovery over ~3 months (links + titles only; slow, and the
 *    service asks for at most one request every 5 seconds).
 *  - Wikipedia: background on people, places and organisations — never a "same details" match.
 */
export type GdeltLead = { url: string; title: string; domain: string; seenAt: string | null };

let lastGdelt = 0;

export async function searchGdelt(claim: string, signal: AbortSignal): Promise<GdeltLead[]> {
  const query = queriesFor(claim, [], 1)[0];
  if (!query) return [];
  const wait = lastGdelt + 5_500 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastGdelt = Date.now();
  const words = query.split(/\s+/).filter((w) => w.length > 2).slice(0, 6).join(" ");
  const params = new URLSearchParams({ query: `${words} sourcelang:english`, mode: "artlist", format: "json", maxrecords: "15", sort: "hybridrel", timespan: "3months" });
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12_000);
  const onAbort = () => ctrl.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await fetch(`https://api.gdeltproject.org/api/v2/doc/doc?${params}`, { signal: ctrl.signal, credentials: "omit" });
    const text = await res.text();
    if (!res.ok || !text.trim().startsWith("{")) return [];
    const data = JSON.parse(text) as { articles?: { url: string; title?: string; domain?: string; seendate?: string }[] };
    return (data.articles ?? []).map((a) => {
      const m = a.seendate?.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
      return { url: a.url, title: a.title?.trim() || a.url, domain: a.domain ?? "", seenAt: m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : null };
    });
  } catch {
    return [];
  } finally {
    clearTimeout(t);
    signal.removeEventListener("abort", onAbort);
  }
}

export async function wikipediaDoc(claim: string, signal: AbortSignal): Promise<Doc | null> {
  const query = queriesFor(claim, [], 1)[0];
  if (!query) return null;
  const api = (p: Record<string, string>) => fetch(`https://en.wikipedia.org/w/api.php?${new URLSearchParams({ format: "json", formatversion: "2", origin: "*", ...p })}`, { signal, credentials: "omit" }).then((r) => r.json());
  try {
    const s = (await api({ action: "query", list: "search", srsearch: query, srlimit: "1", srprop: "" })) as { query?: { search?: { title: string }[] } };
    const title = s.query?.search?.[0]?.title;
    if (!title) return null;
    const p = (await api({ action: "query", prop: "extracts|info", titles: title, explaintext: "1", inprop: "url" })) as { query?: { pages?: { title: string; extract?: string; fullurl?: string }[] } };
    const page = p.query?.pages?.[0];
    if (!page?.extract) return null;
    return { url: page.fullurl ?? `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`, title: `${page.title} — Wikipedia`, publisher: "Wikipedia", publishedAt: null, text: normalizeText(page.extract).slice(0, 40_000), links: [], readable: true, note: null, isFactCheck: false, isReference: true };
  } catch {
    return null;
  }
}

export const ANY_SITE = { origins: ["https://*/*"] };

/** Whether the user granted reading articles from any site (needed for GDELT results). */
export async function canReadAnySite(): Promise<boolean> {
  try {
    return await chrome.permissions.contains(ANY_SITE);
  } catch {
    return false;
  }
}
