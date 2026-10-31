import { z } from "zod";
import { safeFetch } from "@/lib/network/safe-fetch";
import { bm25Scores, coverage, domainOf, stripHtml, terms, toIso } from "@/lib/text";
import { remaining, type Lead, type Provider } from "./types";
import { asProviderError, safeJson } from "./util";

/**
 * Public social media — LOW RELIABILITY, leads only.
 *
 * Mastodon's public hashtag timelines (official API, no login; mastodon.social robots.txt
 * allows general agents, and this app does not train on content). Checked 31 Oct 2026.
 * Not used, with reasons: Reddit (robots.txt disallows all bots, API 403), Bluesky public
 * search (403), YouTube channel feeds (robots.txt disallows /feeds/videos.xml), X/Facebook/
 * Instagram/WhatsApp (login or paid API required).
 *
 * Posts are shown as "social leads" and never count toward a verdict. A news link inside a
 * post becomes an ordinary lead: that ARTICLE is fetched and judged like any other source.
 */
const INSTANCE = "https://mastodon.social";

const StatusSchema = z.object({
  id: z.string(),
  url: z.string().nullable().optional(),
  uri: z.string(),
  created_at: z.string(),
  content: z.string(),
  sensitive: z.boolean().optional(),
  language: z.string().nullable().optional(),
  account: z.object({ acct: z.string(), bot: z.boolean().optional() }),
  card: z.object({ url: z.string(), title: z.string().optional().default(""), provider_name: z.string().optional() }).nullable().optional(),
});

export function hashtagsFrom(keywords: string[]): string[] {
  return [...new Set(keywords.map((k) => k.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "")).filter((k) => k.length >= 3))].slice(0, 3);
}

export const mastodonProvider: Provider = {
  id: "social_mastodon",
  name: "Mastodon public hashtags (social, low reliability)",
  kind: "core",
  scope: "selected",
  description: "Public posts under hashtags from the claim's keywords. Shown as low-reliability leads, never counted as evidence; linked news articles are checked separately.",
  modes: ["live"],
  timeoutMs: 4_000,
  cachePolicy: "Not cached.",
  enabled: () => process.env.FACTCHECK_DISABLE_SOCIAL !== "1",
  disabledReason: () => (process.env.FACTCHECK_DISABLE_SOCIAL === "1" ? "Disabled by FACTCHECK_DISABLE_SOCIAL=1." : null),
  async search(q): Promise<Lead[]> {
    const tags = q.hashtags ?? [];
    if (!tags.length) return [];
    try {
      const pages = await Promise.all(
        tags.map(async (tag) => {
          const res = await safeFetch(`${INSTANCE}/api/v1/timelines/tag/${encodeURIComponent(tag)}?limit=40`, {
            signal: q.signal,
            timeoutMs: Math.max(800, Math.min(this.timeoutMs, remaining(q.deadline))),
            accept: "application/json",
          });
          return z.array(StatusSchema).parse(safeJson(res.text));
        }),
      );
      const posts = [...new Map(pages.flat().map((p) => [p.id, p])).values()].filter((p) => !p.sensitive && !p.account.bot && (!p.language || p.language === "en"));
      const qTerms = terms(q.claims.join(" "));
      const texts = posts.map((p) => stripHtml(p.content));
      const docs = texts.map((t, i) => terms(`${t} ${posts[i]!.card?.title ?? ""}`));
      const scores = bm25Scores(qTerms, docs);
      const ranked = posts
        .map((p, i) => ({ p, text: texts[i]!, s: scores[i]!, c: coverage(qTerms, docs[i]!) }))
        .filter((x) => x.s > 0 && x.c >= 0.3)
        .sort((a, b) => b.s - a.s)
        .slice(0, 6);
      const leads: Lead[] = [];
      for (const [i, { p, text }] of ranked.entries()) {
        leads.push({
          url: p.url ?? p.uri,
          title: text.length > 140 ? `${text.slice(0, 137)}…` : text,
          publisher: `@${p.account.acct} on Mastodon`,
          publishedAt: toIso(p.created_at),
          snippet: text.slice(0, 600),
          provider: "social_mastodon",
          kind: "social",
          providerRank: i,
        });
        // A news link shared in the post is followed as an ordinary lead.
        if (p.card?.url && /^https?:/.test(p.card.url) && !domainOf(p.card.url).includes("mastodon")) {
          leads.push({ url: p.card.url, title: p.card.title || p.card.url, publisher: p.card.provider_name ?? domainOf(p.card.url), publishedAt: null, snippet: null, provider: "social_link", kind: "news_article", providerRank: i });
        }
      }
      return leads;
    } catch (err) {
      throw asProviderError("social_mastodon", err);
    }
  },
};
