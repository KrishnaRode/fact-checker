import { z } from "zod";
import { safeFetch, sleep } from "@/lib/network/safe-fetch";
import { toIso } from "@/lib/text";
import { ProviderError, remaining, type Lead, type Provider } from "./types";
import { asProviderError, safeJson } from "./util";
import { serverConfig } from "@/lib/config";

/**
 * GDELT DOC 2.0 API (artlist mode). Discovery metadata only: titles, URLs, domains and
 * "seendate" — never article bodies. The service asks for at most one request every 5 s and
 * its latency varied between 11–17 s when measured on 31 Oct 2026, so it runs best-effort under
 * a hard deadline and a process-wide spacing gate. Coverage is a rolling window (~3 months).
 */
const ENDPOINT = "https://api.gdeltproject.org/api/v2/doc/doc";
const MIN_GAP_MS = 5_500;
let nextAllowedAt = 0;

const ArticleSchema = z.object({
  url: z.string(),
  title: z.string().optional().default(""),
  seendate: z.string().optional(),
  domain: z.string().optional(),
  language: z.string().optional(),
});
const ResponseSchema = z.object({ articles: z.array(ArticleSchema).optional().default([]) });

function parseSeenDate(s?: string): string | null {
  // GDELT format: 20261030T153000Z
  const m = s?.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  return m ? toIso(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`) : null;
}

export const gdeltProvider: Provider = {
  id: "gdelt",
  name: "GDELT news index",
  kind: "core",
  scope: "selected",
  description: "Discovers recent worldwide news coverage (rolling ~3-month window). Returns links and titles, not article text; often slow.",
  modes: ["live"],
  timeoutMs: 14_000,
  latency: "slow",
  cachePolicy: "Not cached; results feed the document cache.",
  enabled: () => !serverConfig.disableGdelt,
  disabledReason: () => (serverConfig.disableGdelt ? "Disabled by FACTCHECK_DISABLE_GDELT=1." : null),
  async search(q): Promise<Lead[]> {
    const query = q.queries[0];
    if (!query) return [];
    const wait = nextAllowedAt - Date.now();
    if (wait > remaining(q.deadline) - 2_000) {
      throw new ProviderError("gdelt", "skipped", "Skipped to respect GDELT's one-request-per-5-seconds limit.");
    }
    nextAllowedAt = Math.max(Date.now(), nextAllowedAt) + MIN_GAP_MS;
    if (wait > 0) await sleep(wait, q.signal);

    // GDELT rejects very short words and needs quoted phrases for multiword entities; keep it simple.
    const words = query.split(/\s+/).filter((w) => w.length > 2).slice(0, 6);
    const params = new URLSearchParams({
      query: `${words.join(" ")} sourcelang:english`,
      mode: "artlist",
      format: "json",
      maxrecords: String(Math.min(q.maxResults, 15)),
      sort: "hybridrel",
      timespan: "3months",
    });
    try {
      const res = await safeFetch(`${ENDPOINT}?${params}`, {
        signal: q.signal,
        timeoutMs: Math.min(this.timeoutMs, remaining(q.deadline)),
        accept: "application/json",
      });
      if (/limit requests/i.test(res.text)) throw new ProviderError("gdelt", "rate_limited", "GDELT asked us to slow down.");
      if (!res.text.trim().startsWith("{")) {
        throw new ProviderError("gdelt", "bad_response", "GDELT returned a non-JSON response for this query.");
      }
      const data = ResponseSchema.parse(safeJson(res.text));
      return data.articles.map((a, i) => ({
        url: a.url,
        title: a.title.trim() || a.url,
        publisher: a.domain ?? null,
        publishedAt: parseSeenDate(a.seendate),
        snippet: null,
        provider: "gdelt",
        kind: "news_article" as const,
        providerRank: i,
      }));
    } catch (err) {
      throw asProviderError("gdelt", err);
    }
  },
};
