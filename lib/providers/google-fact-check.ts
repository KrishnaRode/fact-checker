import { z } from "zod";
import { serverConfig } from "@/lib/config";
import { safeFetch } from "@/lib/network/safe-fetch";
import { toIso } from "@/lib/text";
import { remaining, type Lead, type Provider } from "./types";
import { asProviderError, safeJson } from "./util";

/**
 * Google Fact Check Tools — claims:search. Enabled only with GOOGLE_FACT_CHECK_API_KEY.
 * Returns existing fact-checks by named publishers. It is not a truth oracle nor a complete
 * index; each review is attributed to its publisher, and whether it matches the exact current
 * claim is part of the assessment (the reviewed claim text is preserved for comparison).
 */
const ENDPOINT = "https://factchecktools.googleapis.com/v1alpha1/claims:search";

const Schema = z.object({
  claims: z
    .array(
      z.object({
        text: z.string().optional().default(""),
        claimant: z.string().optional(),
        claimDate: z.string().optional(),
        claimReview: z
          .array(
            z.object({
              publisher: z.object({ name: z.string().optional(), site: z.string().optional() }).optional(),
              url: z.string(),
              title: z.string().optional(),
              reviewDate: z.string().optional(),
              textualRating: z.string().optional(),
            }),
          )
          .optional()
          .default([]),
      }),
    )
    .optional()
    .default([]),
});

export const googleFactCheckProvider: Provider = {
  id: "google_fact_check",
  name: "Google Fact Check Tools",
  kind: "optional",
  scope: "broad",
  description: "Finds existing fact-checks (ClaimReview) from named publishers using your own API key. Ratings are attributed, not adopted.",
  modes: ["live"],
  timeoutMs: 4_500,
  cachePolicy: "Not cached; review pages use the document cache.",
  enabled: () => !!serverConfig.googleFactCheckKey,
  disabledReason: () => (serverConfig.googleFactCheckKey ? null : "Add GOOGLE_FACT_CHECK_API_KEY to .env.local to search published fact-checks."),
  async search(q): Promise<Lead[]> {
    const key = serverConfig.googleFactCheckKey;
    if (!key) return [];
    const query = q.queries[0];
    if (!query) return [];
    try {
      const params = new URLSearchParams({ query, languageCode: "en", pageSize: String(Math.min(q.maxResults, 8)), key });
      const res = await safeFetch(`${ENDPOINT}?${params}`, {
        signal: q.signal,
        timeoutMs: Math.max(500, Math.min(this.timeoutMs, remaining(q.deadline))),
        accept: "application/json",
      });
      const data = Schema.parse(safeJson(res.text));
      const out: Lead[] = [];
      for (const c of data.claims) {
        for (const r of c.claimReview) {
          const publisher = r.publisher?.name ?? r.publisher?.site ?? "Unnamed publisher";
          const rating = r.textualRating ?? "No rating given";
          out.push({
            url: r.url,
            title: r.title ?? `Fact-check by ${publisher}`,
            publisher,
            publishedAt: toIso(r.reviewDate),
            snippet: `${publisher} reviewed the claim “${c.text}”${c.claimant ? ` (claimant: ${c.claimant})` : ""} and rated it: ${rating}.`,
            provider: "google_fact_check",
            kind: "fact_check",
            factCheck: { publisher, rating, reviewedClaim: c.text, reviewDate: toIso(r.reviewDate) },
            providerRank: out.length,
          });
        }
      }
      return out.slice(0, q.maxResults);
    } catch (err) {
      throw asProviderError("google_fact_check", err);
    }
  },
};
