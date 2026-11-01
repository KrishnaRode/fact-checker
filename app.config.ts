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
  /** Confirmed by the owner on 31 Oct 2026. */
  buildNumber: 17 as number | null,
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
  /**
   * The companion Chrome extension (extension/) — its ID is fixed by the public key in
   * extension/static/manifest.json. Only these extension origins may call the local API.
   * Add more (e.g. a Web Store build) with FACTCHECK_EXTENSION_ORIGINS, comma-separated.
   */
  extensionOrigins: ["chrome-extension://jkccdjdinghdfoampelfceigjgkbkdfi"],
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
    /** Topic/place feeds scanned on demand per investigation. */
    topicFeeds: 6,
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
    topicFeeds: 10,
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
  promptVersion: "assess-v5",
  schemaVersion: "result-v2",
  evidenceVersion: "evidence-v15",
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
  { id: "ie-politics", publisher: "The Indian Express", url: "https://indianexpress.com/section/political-pulse/feed/" },
  { id: "ht-india", publisher: "Hindustan Times", url: "https://www.hindustantimes.com/feeds/rss/india-news/rssfeed.xml" },
  { id: "news18-india", publisher: "News18", url: "https://www.news18.com/rss/india.xml" },
  { id: "livemint", publisher: "Mint", url: "https://www.livemint.com/rss/news" },
  { id: "ndtv", publisher: "NDTV", url: "https://feeds.feedburner.com/ndtvnews-top-stories" },
  { id: "guardian-world", publisher: "The Guardian", url: "https://www.theguardian.com/world/rss" },
  { id: "npr", publisher: "NPR", url: "https://feeds.npr.org/1001/rss.xml" },
  { id: "aljazeera", publisher: "Al Jazeera", url: "https://www.aljazeera.com/xml/rss/all.xml" },
  { id: "altnews", publisher: "Alt News", url: "https://www.altnews.in/feed/" },
  { id: "factcheckorg", publisher: "FactCheck.org", url: "https://www.factcheck.org/feed/" },
] as const;

/**
 * Topic- and place-routed feeds, scanned ON DEMAND when a claim's keywords match their tags
 * (see lib/investigation/topics.ts). Tags: "city:x", "state:x", "topic:x", "region:x".
 * Every feed here was fetched and parsed successfully on 31 Oct 2026 (items dated that day or
 * the day before). TOI Tech (stale) and HT Bengaluru (1 item) were left out.
 */
export const topicFeeds: readonly { id: string; publisher: string; url: string; tags: readonly string[] }[] = [
  // Cities and states
  { id: "toi-pune", publisher: "The Times of India", url: "https://timesofindia.indiatimes.com/rssfeeds/-2128821991.cms", tags: ["city:pune", "state:maharashtra"] },
  { id: "ht-pune", publisher: "Hindustan Times", url: "https://www.hindustantimes.com/feeds/rss/cities/pune-news/rssfeed.xml", tags: ["city:pune", "state:maharashtra"] },
  { id: "ie-pune", publisher: "The Indian Express", url: "https://indianexpress.com/section/cities/pune/feed/", tags: ["city:pune", "state:maharashtra"] },
  { id: "toi-mumbai", publisher: "The Times of India", url: "https://timesofindia.indiatimes.com/rssfeeds/-2128838597.cms", tags: ["city:mumbai", "state:maharashtra"] },
  { id: "ht-mumbai", publisher: "Hindustan Times", url: "https://www.hindustantimes.com/feeds/rss/cities/mumbai-news/rssfeed.xml", tags: ["city:mumbai", "state:maharashtra"] },
  { id: "ie-mumbai", publisher: "The Indian Express", url: "https://indianexpress.com/section/cities/mumbai/feed/", tags: ["city:mumbai", "state:maharashtra"] },
  { id: "toi-delhi", publisher: "The Times of India", url: "https://timesofindia.indiatimes.com/rssfeeds/-2128839596.cms", tags: ["city:delhi", "state:delhi"] },
  { id: "ht-delhi", publisher: "Hindustan Times", url: "https://www.hindustantimes.com/feeds/rss/cities/delhi-news/rssfeed.xml", tags: ["city:delhi", "state:delhi"] },
  { id: "ie-delhi", publisher: "The Indian Express", url: "https://indianexpress.com/section/cities/delhi/feed/", tags: ["city:delhi", "state:delhi"] },
  { id: "toi-bengaluru", publisher: "The Times of India", url: "https://timesofindia.indiatimes.com/rssfeeds/-2128833038.cms", tags: ["city:bengaluru", "state:karnataka"] },
  { id: "toi-hyderabad", publisher: "The Times of India", url: "https://timesofindia.indiatimes.com/rssfeeds/-2128816011.cms", tags: ["city:hyderabad", "state:telangana"] },
  { id: "toi-chennai", publisher: "The Times of India", url: "https://timesofindia.indiatimes.com/rssfeeds/2950623.cms", tags: ["city:chennai", "state:tamil nadu"] },
  { id: "toi-kolkata", publisher: "The Times of India", url: "https://timesofindia.indiatimes.com/rssfeeds/-2128830821.cms", tags: ["city:kolkata", "state:west bengal"] },
  // National / world
  { id: "toi-india", publisher: "The Times of India", url: "https://timesofindia.indiatimes.com/rssfeeds/-2128936835.cms", tags: ["region:india", "topic:politics", "topic:crime"] },
  { id: "ie-india", publisher: "The Indian Express", url: "https://indianexpress.com/section/india/feed/", tags: ["region:india", "topic:politics", "topic:crime"] },
  { id: "ndtv-india", publisher: "NDTV", url: "https://feeds.feedburner.com/ndtvnews-india-news", tags: ["region:india", "topic:politics", "topic:crime"] },
  { id: "bbc-india", publisher: "BBC News", url: "https://feeds.bbci.co.uk/news/world/asia/india/rss.xml", tags: ["region:india", "region:world"] },
  { id: "hindu-intl", publisher: "The Hindu", url: "https://www.thehindu.com/news/international/feeder/default.rss", tags: ["region:world"] },
  // Topics
  { id: "ie-tech", publisher: "The Indian Express", url: "https://indianexpress.com/section/technology/feed/", tags: ["topic:technology"] },
  { id: "ht-tech", publisher: "Hindustan Times", url: "https://www.hindustantimes.com/feeds/rss/technology/rssfeed.xml", tags: ["topic:technology"] },
  { id: "mint-tech", publisher: "Mint", url: "https://www.livemint.com/rss/technology", tags: ["topic:technology"] },
  { id: "bbc-tech", publisher: "BBC News", url: "https://feeds.bbci.co.uk/news/technology/rss.xml", tags: ["topic:technology", "region:world"] },
  { id: "guardian-tech", publisher: "The Guardian", url: "https://www.theguardian.com/technology/rss", tags: ["topic:technology", "region:world"] },
  { id: "hindu-scitech", publisher: "The Hindu", url: "https://www.thehindu.com/sci-tech/feeder/default.rss", tags: ["topic:technology", "topic:science"] },
  { id: "bbc-science", publisher: "BBC News", url: "https://feeds.bbci.co.uk/news/science_and_environment/rss.xml", tags: ["topic:science", "topic:environment"] },
  { id: "ie-business", publisher: "The Indian Express", url: "https://indianexpress.com/section/business/feed/", tags: ["topic:business"] },
  { id: "toi-business", publisher: "The Times of India", url: "https://timesofindia.indiatimes.com/rssfeeds/1898055.cms", tags: ["topic:business"] },
  { id: "hindu-business", publisher: "The Hindu", url: "https://www.thehindu.com/business/feeder/default.rss", tags: ["topic:business"] },
  { id: "ht-business", publisher: "Hindustan Times", url: "https://www.hindustantimes.com/feeds/rss/business/rssfeed.xml", tags: ["topic:business"] },
  { id: "mint-markets", publisher: "Mint", url: "https://www.livemint.com/rss/markets", tags: ["topic:business"] },
  { id: "bbc-business", publisher: "BBC News", url: "https://feeds.bbci.co.uk/news/business/rss.xml", tags: ["topic:business", "region:world"] },
  { id: "hindu-health", publisher: "The Hindu", url: "https://www.thehindu.com/sci-tech/health/feeder/default.rss", tags: ["topic:health"] },
  { id: "ht-health", publisher: "Hindustan Times", url: "https://www.hindustantimes.com/feeds/rss/lifestyle/health/rssfeed.xml", tags: ["topic:health"] },
  { id: "bbc-health", publisher: "BBC News", url: "https://feeds.bbci.co.uk/news/health/rss.xml", tags: ["topic:health", "region:world"] },
  { id: "ie-education", publisher: "The Indian Express", url: "https://indianexpress.com/section/education/feed/", tags: ["topic:education"] },
  { id: "ht-education", publisher: "Hindustan Times", url: "https://www.hindustantimes.com/feeds/rss/education/rssfeed.xml", tags: ["topic:education"] },
  { id: "ie-sports", publisher: "The Indian Express", url: "https://indianexpress.com/section/sports/feed/", tags: ["topic:sports"] },
  { id: "toi-sports", publisher: "The Times of India", url: "https://timesofindia.indiatimes.com/rssfeeds/4719148.cms", tags: ["topic:sports"] },
  { id: "hindu-sport", publisher: "The Hindu", url: "https://www.thehindu.com/sport/feeder/default.rss", tags: ["topic:sports"] },
  { id: "ht-cricket", publisher: "Hindustan Times", url: "https://www.hindustantimes.com/feeds/rss/cricket/rssfeed.xml", tags: ["topic:sports"] },
  { id: "hindu-religion", publisher: "The Hindu", url: "https://www.thehindu.com/society/faith/feeder/default.rss", tags: ["topic:religion"] },
];

/** "The Sunday Builds #17" — derived so the number is set in exactly one place. */
export const seriesLabel = `${appConfig.series}${appConfig.buildNumber != null ? ` #${appConfig.buildNumber}` : ""}`;

export type AppConfig = typeof appConfig;
