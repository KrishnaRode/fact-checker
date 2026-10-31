/**
 * Fact Checker — single source of truth for branding, model selection, budgets and sources.
 * run.sh reads `defaultModel` and `port` from this file; components and server code import it.
 * Environment variables (see .env.example) may override the model, Ollama host and port.
 */
export const appConfig = {
  name: "Fact Checker",
  hero: "Before you believe it.",
  supportingLine: "Bring a claim. Follow the evidence.",
  primaryAction: "Investigate",
  description:
    "Paste a claim, a forward or a news article URL. Fact Checker retrieves live sources, extracts the relevant passages and assesses the claim with a local open-weight model through Ollama.",
  owner: "Krishna Rode",
  series: "The Sunday Builds",
  seriesLine: "Free AI. Real Problems. Every Sunday.",
  seriesLong: "The Sunday Builds — Solving Real Problems using Free AI, every Sunday.",
  /** Unset until explicitly confirmed by the owner. */
  buildNumber: null as number | null,
  /** Confirmed by the owner on 31 Oct 2026. */
  repoUrl: "https://github.com/KrishnaRode/fact-checker" as string | null,

  port: 3016,
  /** Fast default. A candidate, not a benchmark claim — see BENCHMARKS.md. */
  defaultModel: "qwen3:4b",
  /** Configurable quality option. */
  qualityModel: "qwen3:8b",
  ollamaHost: "http://127.0.0.1:11434",
  /** Keep the model loaded between investigations. */
  keepAlive: "15m",

  referenceTimezone: "Asia/Kolkata",
  maxInputChars: 12_000,
  maxFollowUpChars: 1_000,
  userAgent: "FactChecker/0.1 (local research tool; The Sunday Builds; +https://ollama.com)",
} as const;

/** Work budgets. Initial values, tuned against measurements in BENCHMARKS.md. */
export const budgets = {
  quick: {
    /**
     * Base budget for one claim; each additional claim adds `perExtraClaimMs`.
     * Tuned from BENCHMARKS.md: local inference alone measured 8–20 s per assessment on the
     * reference MacBook Air M4 (11–25 tok/s depending on memory pressure), so 25 s cut off
     * healthy live runs. 30 s keeps the deadline honest without hiding slow runs.
     */
    totalMs: 30_000,
    perExtraClaimMs: 9_000,
    discoveryMs: 6_500,
    fetchMs: 5_500,
    maxClaims: 3,
    maxQueriesPerClaim: 2,
    discoveryCandidates: 10,
    fetchCount: 5,
    perDomainFetches: 2,
    maxPassages: 7,
    passagesPerSource: 2,
    evidenceChars: 6_000,
  },
  deep: {
    totalMs: 50_000,
    perExtraClaimMs: 12_000,
    discoveryMs: 12_000,
    fetchMs: 9_000,
    maxClaims: 3,
    maxQueriesPerClaim: 3,
    discoveryCandidates: 18,
    fetchCount: 9,
    perDomainFetches: 3,
    maxPassages: 14,
    passagesPerSource: 3,
    evidenceChars: 14_000,
  },
  /** Minimum time that must remain to attempt (or repair) an assessment call. */
  minInferenceMs: 6_000,
  modelNumCtx: 8_192,
  modelMaxOutputTokens: 1_100,
  fetchMaxBytes: 2_500_000,
  fetchMaxRedirects: 4,
  documentTextMaxChars: 80_000,
} as const;

/** Cache retention. Volatile = relative time words or breaking-news language. */
export const cachePolicy = {
  assessmentTtlStableMs: 6 * 60 * 60 * 1000,
  assessmentTtlVolatileMs: 15 * 60 * 1000,
  documentTtlMs: 6 * 60 * 60 * 1000,
  feedIndexTtlMs: 20 * 60 * 1000,
  maxAssessments: 200,
  maxDocuments: 400,
  maxFeedEntries: 900,
  /** Bump when prompts, schemas or the evidence pipeline change meaningfully. */
  promptVersion: "assess-v4",
  schemaVersion: "result-v2",
  evidenceVersion: "evidence-v3",
} as const;

/**
 * Selected public RSS/Atom feeds. Each was fetched successfully on 31 Oct 2026 during
 * implementation (HTTP 200, parseable). Feeds that failed then (PIB 403, AP 403,
 * PolitiFact 404, BOOM 404) are intentionally absent. Inaccessible feeds are skipped at runtime.
 */
export const feeds = [
  { id: "bbc", publisher: "BBC News", url: "https://feeds.bbci.co.uk/news/rss.xml" },
  { id: "bbc-world", publisher: "BBC News", url: "https://feeds.bbci.co.uk/news/world/rss.xml" },
  { id: "hindu", publisher: "The Hindu", url: "https://www.thehindu.com/news/national/feeder/default.rss" },
  { id: "indianexpress", publisher: "The Indian Express", url: "https://indianexpress.com/feed/" },
  { id: "livemint", publisher: "Mint", url: "https://www.livemint.com/rss/news" },
  { id: "ndtv", publisher: "NDTV", url: "https://feeds.feedburner.com/ndtvnews-top-stories" },
  { id: "guardian-world", publisher: "The Guardian", url: "https://www.theguardian.com/world/rss" },
  { id: "npr", publisher: "NPR", url: "https://feeds.npr.org/1001/rss.xml" },
  { id: "aljazeera", publisher: "Al Jazeera", url: "https://www.aljazeera.com/xml/rss/all.xml" },
  { id: "altnews", publisher: "Alt News", url: "https://www.altnews.in/feed/" },
  { id: "factcheckorg", publisher: "FactCheck.org", url: "https://www.factcheck.org/feed/" },
] as const;

export type AppConfig = typeof appConfig;
