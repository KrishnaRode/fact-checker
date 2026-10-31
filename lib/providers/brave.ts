import { z } from "zod";
import { serverConfig } from "@/lib/config";
import { safeFetch } from "@/lib/network/safe-fetch";
import { stripHtml, toIso } from "@/lib/text";
import { remaining, type Lead, type Provider } from "./types";
import { asProviderError, safeJson } from "./util";

/**
 * Brave Search API (web search). Enabled only when BRAVE_SEARCH_API_KEY is set; the key stays
 * server-side and is redacted from errors. Results are leads: the article is fetched before it
 * can support a finding. No plan or quota is assumed.
 */
const ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

const ResultSchema = z.object({
  web: z
    .object({
      results: z.array(
        z.object({
          url: z.string(),
          title: z.string().optional().default(""),
          description: z.string().optional(),
          page_age: z.string().optional(),
          age: z.string().optional(),
          profile: z.object({ name: z.string().optional() }).optional(),
          meta_url: z.object({ hostname: z.string().optional() }).optional(),
        }),
      ),
    })
    .optional(),
});

export const braveProvider: Provider = {
  id: "brave",
  name: "Brave Search",
  kind: "optional",
  scope: "broad",
  description: "Broader web and primary-source discovery using your own Brave Search API key.",
  modes: ["live"],
  timeoutMs: 5_000,
  cachePolicy: "Not cached; fetched pages use the document cache.",
  enabled: () => !!serverConfig.braveApiKey,
  disabledReason: () => (serverConfig.braveApiKey ? null : "Add BRAVE_SEARCH_API_KEY to .env.local to enable broader web search."),
  async search(q): Promise<Lead[]> {
    const key = serverConfig.braveApiKey;
    if (!key) return [];
    const out: Lead[] = [];
    try {
      for (const query of q.queries.slice(0, 2)) {
        const params = new URLSearchParams({ q: query, count: String(Math.min(q.maxResults, 10)), safesearch: "moderate", text_decorations: "false" });
        const res = await safeFetch(`${ENDPOINT}?${params}`, {
          signal: q.signal,
          timeoutMs: Math.max(500, Math.min(this.timeoutMs, remaining(q.deadline))),
          accept: "application/json",
          headers: { "x-subscription-token": key },
        });
        const data = ResultSchema.parse(safeJson(res.text));
        for (const [i, r] of (data.web?.results ?? []).entries()) {
          out.push({
            url: r.url,
            title: stripHtml(r.title) || r.url,
            publisher: r.profile?.name ?? r.meta_url?.hostname ?? null,
            publishedAt: toIso(r.page_age),
            snippet: r.description ? stripHtml(r.description) : null,
            provider: "brave",
            kind: "web_page",
            providerRank: i,
          });
        }
      }
      return out;
    } catch (err) {
      if (out.length) return out;
      throw asProviderError("brave", err);
    }
  },
};
