import type { Mode } from "@/lib/contracts";

/** A discovery result. Snippets are leads, never sufficient grounds for a green/red finding. */
export type Lead = {
  url: string;
  title: string;
  publisher: string | null;
  publishedAt: string | null;
  snippet: string | null;
  provider: string;
  kind: "news_article" | "reference" | "fact_check" | "web_page" | "social";
  /** Providers that return the document text directly (Wikipedia API, demo corpus). */
  fullText?: string;
  revisionId?: string | null;
  modifiedAt?: string | null;
  factCheck?: { publisher: string; rating: string; reviewedClaim: string; reviewDate: string | null } | null;
  /** Ranking score inside one provider's results (not a truth probability). */
  providerRank?: number;
};

export type ProviderQuery = {
  /** Neutral search queries, already validated and capped by the orchestrator. */
  queries: string[];
  claims: string[];
  referenceDate: string;
  maxResults: number;
  signal: AbortSignal;
  /** Absolute epoch ms by which the provider must return. */
  deadline: number;
  /** Topic/place feeds chosen by the router (lib/investigation/topics.ts), scanned on demand. */
  feedIds?: string[];
  /** Hashtags derived from the claim's keywords (social providers). */
  hashtags?: string[];
};

export type ProviderCapability = {
  id: string;
  name: string;
  kind: "core" | "optional";
  /** "broad" providers search the open web; "selected" ones cover a defined set. */
  scope: "selected" | "broad";
  /** What the provider can and cannot do, shown in settings. */
  description: string;
  modes: Mode[];
  /** Provider-specific time budget in ms (further capped by the stage deadline). */
  timeoutMs: number;
  /** Slow providers never block the first fetch wave; late results join a second wave. */
  latency?: "fast" | "slow";
  cachePolicy: string;
};

export interface Provider extends ProviderCapability {
  enabled(): boolean;
  disabledReason(): string | null;
  search(q: ProviderQuery): Promise<Lead[]>;
}

export type ProviderErrorCode = "unavailable" | "rate_limited" | "timeout" | "bad_response" | "not_configured" | "aborted" | "skipped";

export class ProviderError extends Error {
  constructor(
    public provider: string,
    public code: ProviderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export function remaining(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}
