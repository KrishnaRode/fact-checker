import { parseFeed } from "@/lib/providers/feed-parse";

/**
 * Evidence-only retrieval inside the extension: fetch public RSS/Atom feeds and article pages
 * with the browser's own fetch (host permissions are limited to the listed news publishers),
 * parse with DOMParser, never execute page scripts. Feed results are cached in session storage
 * for 20 minutes so repeated checks stay fast.
 */
export type { FeedEntry as FeedItem } from "@/lib/providers/feed-parse";
import type { FeedEntry as FeedItem } from "@/lib/providers/feed-parse";
export type Article = { url: string; title: string; publisher: string; publishedAt: string | null; text: string; links: string[]; readable: boolean; note: string | null };

const FEED_TTL_MS = 20 * 60 * 1000;

function iso(s: string | null | undefined): string | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Shared, DOM-free parser (the same one the app server uses). */
export const parseFeedXml = parseFeed;

async function timedFetch(url: string, ms: number, signal: AbortSignal): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  const onAbort = () => ctrl.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await fetch(url, { signal: ctrl.signal, credentials: "omit", cache: "no-store", redirect: "follow" });
  } finally {
    clearTimeout(t);
    signal.removeEventListener("abort", onAbort);
  }
}

export async function loadFeed(feed: { id: string; publisher: string; url: string }, signal: AbortSignal): Promise<FeedItem[]> {
  const key = `feed:${feed.id}`;
  try {
    const hit = (await chrome.storage.session.get(key))[key] as { at: number; items: FeedItem[] } | undefined;
    if (hit && Date.now() - hit.at < FEED_TTL_MS) return hit.items;
  } catch {
    /* storage unavailable: fetch fresh */
  }
  try {
    const res = await timedFetch(feed.url, 5_000, signal);
    if (!res.ok) return [];
    const items = parseFeedXml(await res.text(), feed);
    try {
      await chrome.storage.session.set({ [key]: { at: Date.now(), items } });
    } catch {
      /* quota: skip caching */
    }
    return items;
  } catch {
    return [];
  }
}

const MAX_BYTES = 2_500_000;

export function extractArticle(html: string, url: string, fallback: { title: string; publisher: string; publishedAt: string | null }): Article {
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const el of doc.querySelectorAll("script, style, nav, header, footer, aside, form, noscript, iframe, figure")) el.remove();
  const root = doc.querySelector("article") ?? doc.querySelector("main") ?? doc.body;
  // Paragraphs only; skip link lists ("related stories") where most of the text is links.
  const paras = [...root.querySelectorAll("p, h2")]
    .filter((p) => {
      const all = (p.textContent ?? "").length || 1;
      const linked = [...p.querySelectorAll("a")].reduce((n, a) => n + (a.textContent ?? "").length, 0);
      return linked / all < 0.5 && !p.closest("ul, ol, [class*='related'], [class*='recommend'], [class*='trending']");
    })
    .map((p) => (p.textContent ?? "").replace(/\s+/g, " ").trim())
    .filter((t) => t.length > 40);
  let text = paras.join("\n\n");
  if (text.length < 280) {
    // Some sites (e.g. TOI) put article text directly in <div>s with <br>s: take blocks whose
    // OWN text (not their children's) is substantial.
    const blocks = [...root.querySelectorAll("div, section")]
      .filter((d) => !d.closest("ul, ol, [class*='related'], [class*='recommend'], [class*='trending']"))
      .map((d) => [...d.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent ?? "").join(" ").replace(/\s+/g, " ").trim())
      .filter((t) => t.length > 150);
    text = blocks.join("\n\n");
  }
  text = text.slice(0, 60_000);
  const meta = (name: string) => doc.querySelector(`meta[property="${name}"], meta[name="${name}"]`)?.getAttribute("content") ?? null;
  const links = [...root.querySelectorAll("a[href]")]
    .map((a) => {
      try {
        return new URL(a.getAttribute("href") ?? "", url).href;
      } catch {
        return null;
      }
    })
    .filter((u): u is string => !!u && /^https?:/.test(u));
  return {
    url,
    title: meta("og:title") ?? fallback.title,
    publisher: meta("og:site_name") ?? fallback.publisher,
    publishedAt: iso(meta("article:published_time")) ?? fallback.publishedAt,
    text,
    links,
    readable: text.length >= 280,
    note: text.length >= 280 ? null : "The article text was not accessible (paywall, sign-in or script-rendered page).",
  };
}

export async function loadArticle(item: FeedItem, signal: AbortSignal): Promise<Article> {
  const fallback = { title: item.title, publisher: item.publisher, publishedAt: item.publishedAt };
  try {
    const res = await timedFetch(item.url, 6_000, signal);
    if (!res.ok) return { url: item.url, ...fallback, text: "", links: [], readable: false, note: `The site answered with HTTP ${res.status}.` };
    const type = res.headers.get("content-type") ?? "";
    if (!type.includes("html")) return { url: item.url, ...fallback, text: "", links: [], readable: false, note: "Not an HTML article." };
    const body = await res.text();
    if (body.length > MAX_BYTES) return { url: item.url, ...fallback, text: "", links: [], readable: false, note: "Page too large to read." };
    return extractArticle(body, res.url || item.url, fallback);
  } catch {
    return { url: item.url, ...fallback, text: "", links: [], readable: false, note: "The site could not be reached." };
  }
}
