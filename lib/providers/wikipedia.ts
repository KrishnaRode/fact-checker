import { z } from "zod";
import { safeFetch } from "@/lib/network/safe-fetch";
import { normalizeText, toIso } from "@/lib/text";
import { remaining, type Lead, type Provider } from "./types";
import { asProviderError, safeJson } from "./util";

/**
 * English Wikipedia via the MediaWiki Action API — background and entity context.
 * Etiquette: descriptive User-Agent (set in safeFetch), maxlag, serial-friendly small requests,
 * gzip handled by the transport. Revision id + timestamp are preserved for each extract.
 * Wikipedia is never treated as the sole authority for breaking or contested claims (the
 * assessment prompt and validation limitations say so explicitly).
 */
const API = "https://en.wikipedia.org/w/api.php";

const SearchSchema = z.object({
  query: z.object({ search: z.array(z.object({ title: z.string(), pageid: z.number() })) }).optional(),
});

const PageSchema = z.object({
  query: z
    .object({
      pages: z.array(
        z.object({
          pageid: z.number().optional(),
          title: z.string(),
          missing: z.boolean().optional(),
          extract: z.string().optional(),
          fullurl: z.string().optional(),
          canonicalurl: z.string().optional(),
          revisions: z.array(z.object({ revid: z.number(), timestamp: z.string() })).optional(),
        }),
      ),
    })
    .optional(),
});

async function api(params: Record<string, string>, signal: AbortSignal, timeoutMs: number) {
  const qs = new URLSearchParams({ format: "json", formatversion: "2", maxlag: "5", ...params });
  const res = await safeFetch(`${API}?${qs}`, { signal, timeoutMs, accept: "application/json" });
  return safeJson(res.text);
}

export const wikipediaProvider: Provider = {
  id: "wikipedia",
  name: "Wikipedia",
  kind: "core",
  scope: "selected",
  description: "Background on people, places and organisations, with revision ids. Not an authority for breaking or contested claims.",
  modes: ["live"],
  timeoutMs: 4_500,
  cachePolicy: "Extracts cached with the document cache (revision id recorded).",
  enabled: () => true,
  disabledReason: () => null,
  async search(q): Promise<Lead[]> {
    const query = q.queries[0];
    if (!query) return [];
    try {
      const budget = () => Math.max(500, Math.min(this.timeoutMs, remaining(q.deadline)));
      const s = SearchSchema.parse(await api({ action: "query", list: "search", srsearch: query, srlimit: "3", srprop: "" }, q.signal, budget()));
      const titles = (s.query?.search ?? []).slice(0, 2).map((r) => r.title);
      const pages = await Promise.all(
        titles.map(async (title) => {
          const p = PageSchema.parse(
            await api(
              { action: "query", prop: "extracts|info|revisions", titles: title, explaintext: "1", exsectionformat: "plain", inprop: "url", rvprop: "ids|timestamp", redirects: "1" },
              q.signal,
              budget(),
            ),
          );
          return p.query?.pages?.[0];
        }),
      );
      return pages
        .filter((p): p is NonNullable<typeof p> => !!p && !p.missing && !!p.extract)
        .map((p, i) => {
          const rev = p.revisions?.[0];
          const url = p.canonicalurl ?? p.fullurl ?? `https://en.wikipedia.org/wiki/${encodeURIComponent(p.title.replace(/ /g, "_"))}`;
          return {
            url,
            title: `${p.title} — Wikipedia`,
            publisher: "Wikipedia",
            publishedAt: null,
            modifiedAt: rev ? toIso(rev.timestamp) : null,
            revisionId: rev ? String(rev.revid) : null,
            snippet: null,
            fullText: normalizeText(p.extract!).slice(0, 80_000),
            provider: "wikipedia",
            kind: "reference" as const,
            providerRank: i,
          };
        });
    } catch (err) {
      throw asProviderError("wikipedia", err);
    }
  },
};
