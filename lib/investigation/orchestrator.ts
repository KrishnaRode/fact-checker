import { budgets as allBudgets, cachePolicy } from "@/app.config";
import type { Finding, InvestigateRequest, InvestigationResult, ModelPlan, Passage, SourceRecord } from "@/lib/contracts";
import { STAGE_LABELS, type Stage } from "@/lib/contracts";
import type { Lead, Provider } from "@/lib/providers/types";
import { canonicalizeUrl, clip, domainOf, explicitDates, explicitYears, formatDay, isVolatileClaim, neutralize, resolveRelativeDates, salientTerms, terms } from "@/lib/text";
import { assess, buildAssessmentPrompt, type ModelCaller } from "./assessment";
import { assessmentCacheKey } from "./cache-key";
import { detectInput, isFewSentences, isShortClaim, planClaims, queriesFor, sanitizeQuery, type PlannedClaim } from "./claim-planner";
import type { EventChannel } from "./events";
import { selectPassages } from "./passages";
import { analyzeProvenance, buildGraph, type ProvLink } from "./provenance";
import { discover, rankLeads, type DocumentSource, type FetchedDocument } from "./retrieval";
import { getRun, saveRun } from "./run-store";
import { classifyClaim, describeClassification, routeFeeds } from "./topics";
import { computeStrength } from "./strength";
import { hashtagsFrom } from "@/lib/providers/mastodon";
import { topicFeeds } from "@/app.config";
import { deriveOverall, deriveSummary, integrityProblems, validateAssessment } from "./validation";

/**
 * The orchestrator owns the permitted tools (providers, the document fetcher, the local
 * model) and decides what runs. Model output is data: it can cite passage ids and propose
 * labels, but it can never trigger a fetch, a provider call or an event.
 */

export type ModelCheck = { ok: true; warm: boolean | null } | { ok: false; code: string; message: string };

export type OrchestratorDeps = {
  providers: Provider[];
  documents: DocumentSource;
  callAssessment: ModelCaller;
  callPlanner: ((system: string, user: string, timeoutMs: number, signal: AbortSignal) => Promise<ModelPlan>) | null;
  checkModel: () => Promise<ModelCheck>;
  modelName: string;
  scope: "selected_sources" | "broader_web";
  referenceDate: string;
  cache: {
    get(key: string): Promise<{ value: InvestigationResult; expiresAt: number } | null>;
    set(key: string, value: InvestigationResult, ttlMs: number): Promise<void>;
  } | null;
};

/** Settle no later than the signal: a step that ignores cancellation cannot hold the run. */
export function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

class Incomplete extends Error {
  constructor(
    public reason: string,
    public kind: "partial" | "failed",
  ) {
    super(reason);
  }
}

export async function runInvestigation(req: InvestigateRequest, deps: OrchestratorDeps, ch: EventChannel, userSignal: AbortSignal): Promise<InvestigationResult> {
  const budget = allBudgets[req.depth];
  const startedAt = Date.now();
  let deadline = startedAt + budget.totalMs;
  let budgetMs = budget.totalMs;
  const budgetCtrl = new AbortController();
  let budgetTimer = setTimeout(() => budgetCtrl.abort(), budget.totalMs);
  // Plain controller (strong references) rather than AbortSignal.any chains.
  const workCtrl = new AbortController();
  const work = workCtrl.signal;
  const abortWork = () => workCtrl.abort();
  userSignal.addEventListener("abort", abortWork, { once: true });
  budgetCtrl.signal.addEventListener("abort", abortWork, { once: true });
  /** Extend the visible budget once the number of claims is known (measured: ~9 s per extra claim). */
  const extendBudget = (extraMs: number) => {
    if (extraMs <= 0) return;
    clearTimeout(budgetTimer);
    budgetMs += extraMs;
    deadline = startedAt + budgetMs;
    budgetTimer = setTimeout(() => budgetCtrl.abort(), Math.max(0, deadline - Date.now()));
  };
  const tz = req.referenceTimezone;
  const refDate = deps.referenceDate;
  const refWeekday = new Date(`${refDate}T12:00:00Z`).getUTCDay();
  const input = detectInput(req.input);

  const warnings: string[] = [];
  const attempted = new Set<string>();
  const succeeded = new Set<string>();
  let retrievalMs = 0;
  let inferenceMs = 0;
  let llmCalls = 0;
  let modelWarm: boolean | null = null;
  let stage: Stage | null = null;

  const sources: SourceRecord[] = [];
  const docsById = new Map<string, FetchedDocument>();
  const sourceTexts = new Map<string, string>();
  let passages: Passage[] = [];
  let provLinks: ProvLink[] = [];
  let claims: PlannedClaim[] = [];
  let deferred: string[] = [];
  const assumptions: string[] = [];
  let submittedSourceId: string | null = null;
  let routing = { detected: "", feeds: [] as string[] };

  const budgetReason = () => `The ${req.depth} investigation reached its ${Math.round(budgetMs / 1000)}-second budget${stage ? ` while ${STAGE_LABELS[stage].toLowerCase()}` : ""}. Sources found so far are shown; no verdict is drawn from an incomplete run.`;
  const startStage = (s: Stage) => {
    stage = s;
    ch.emit("stage_started", { stage: s, label: STAGE_LABELS[s] });
  };
  const endStage = (s: Stage, detail: string | null = null) => ch.emit("stage_completed", { stage: s, label: STAGE_LABELS[s], detail });
  const checkAbort = () => {
    if (userSignal.aborted) throw new DOMException("Cancelled", "AbortError");
    if (work.aborted) throw new Incomplete(budgetReason(), "partial");
  };

  const providerIds = deps.providers.map((p) => p.id);
  const cacheKey = assessmentCacheKey({ input: req.input, mode: req.mode, depth: req.depth, referenceDate: refDate, referenceTimezone: tz, providerIds, model: deps.modelName });

  // ── Cache: exact, compatible, unexpired results return immediately (no animation wait).
  if (deps.cache && !req.refresh && !req.baseRunId) {
    const hit = await deps.cache.get(cacheKey);
    if (hit && hit.value.mode === req.mode) {
      ch.emit("started", { mode: req.mode, depth: req.depth, referenceDate: refDate, referenceTimezone: tz, providers: deps.providers.map((p) => ({ id: p.id, name: p.name })), scope: deps.scope, cached: true });
      const result: InvestigationResult = {
        ...hit.value,
        id: ch.runId,
        origin: "cached_run",
        cacheExpiresAt: new Date(hit.expiresAt).toISOString(),
        timing: { ...hit.value.timing, totalMs: ch.elapsed(), retrievalMs: 0, inferenceMs: 0, firstEvidenceMs: null, modelWarm: null, llmCalls: 0 },
      };
      saveRun({ result, sourceTexts: new Map(), documents: new Map() });
      return result;
    }
  }

  ch.emit("started", { mode: req.mode, depth: req.depth, referenceDate: refDate, referenceTimezone: tz, providers: deps.providers.map((p) => ({ id: p.id, name: p.name })), scope: deps.scope, cached: false });

  const addSource = (doc: FetchedDocument): string => {
    const existing = sources.find((s) => s.canonicalUrl === doc.canonicalUrl || canonicalizeUrl(s.url) === canonicalizeUrl(doc.url));
    if (existing) return existing.id;
    const id = `S${sources.length + 1}`;
    sources.push({
      id,
      url: doc.url,
      canonicalUrl: doc.canonicalUrl,
      title: doc.title,
      publisher: doc.publisher,
      publishedAt: doc.publishedAt,
      modifiedAt: doc.modifiedAt,
      fetchedAt: doc.fetchedAt,
      access: doc.access,
      accessNote: doc.accessNote,
      contentHash: doc.contentHash,
      originGroupId: null,
      provenanceStatus: "unknown",
      provider: doc.provider,
      kind: doc.kind,
      revisionId: doc.revisionId,
      factCheckRating: doc.factCheck ?? null,
      dateNotes: [],
    });
    docsById.set(id, doc);
    sourceTexts.set(id, doc.text);
    ch.emit("source_fetched", { sourceId: id, url: doc.url, title: doc.title, publisher: doc.publisher, access: doc.access, note: doc.accessNote });
    return id;
  };

  const result = (status: InvestigationResult["status"], statusReason: string | null, findings: Finding[]): InvestigationResult => {
    const unchecked = deferred;
    const overall = deriveOverall(findings, status, unchecked);
    const graph = buildGraph(findings, claims.map((c) => c.claim), sources, passages, provLinks);
    return {
      id: ch.runId,
      mode: req.mode,
      origin: "fresh_run",
      status,
      statusReason,
      depth: req.depth,
      assessedAt: new Date().toISOString(),
      referenceDate: refDate,
      referenceTimezone: tz,
      originalInput: req.input,
      inputKind: input.kind,
      overall,
      summary: deriveSummary(findings, overall, unchecked, status),
      findings,
      uncheckedClaims: unchecked,
      assumptions,
      sources,
      passages,
      coverage: { scope: deps.scope, providersAttempted: [...attempted], providersSucceeded: [...succeeded], warnings, routing },
      graph,
      model: llmCalls > 0 ? deps.modelName : null,
      timing: { totalMs: Date.now() - startedAt, retrievalMs, inferenceMs, firstEvidenceMs: ch.firstEvidenceMs, modelWarm, llmCalls },
      cacheExpiresAt: null,
      baseRunId: req.baseRunId ?? null,
    };
  };

  try {
    // ── 1. Understand ────────────────────────────────────────────────────────
    startStage("understand");
    const modelCheck = deps.checkModel().catch((): ModelCheck => ({ ok: false, code: "offline", message: "Ollama is not running. Start Ollama and retry." }));
    let planText = input.kind === "text" ? input.text : "";
    let headline: string | null = null;
    if (input.kind === "url") {
      const lead: Lead = { url: input.url, title: input.url, publisher: domainOf(input.url), publishedAt: null, snippet: null, provider: "user_url", kind: "news_article" };
      const doc = await deps.documents.fetch(lead, { signal: work, timeoutMs: Math.min(8_000, budget.fetchMs + 2_000), revalidate: req.refresh });
      if (doc.access !== "full_text") throw new Incomplete(doc.accessNote ?? "The submitted link could not be read. Paste the article text instead.", "failed");
      submittedSourceId = addSource({ ...doc, kind: "user_submitted" });
      sources.find((s) => s.id === submittedSourceId)!.kind = "user_submitted";
      planText = doc.text.slice(0, 6_000);
      headline = doc.title;
      ch.emit("observation", { message: `Read the submitted article from ${doc.publisher ?? domainOf(doc.url)}. It is examined as the source of the claims, not as corroboration.`, sourceIds: [submittedSourceId] });
    }

    const base = req.baseRunId ? getRun(req.baseRunId) : undefined;
    if (base && base.result.mode === req.mode) {
      // "Investigate further": reuse the checked claims and evidence of the base run.
      claims = base.result.findings.map((f) => {
        const gaps = f.missingEvidence.map((m) => sanitizeQuery(m)).filter((q): q is string => !!q);
        return { claim: f.claim, checkable: f.verdict !== "not_fact_checkable", queries: queriesFor(f.claim, gaps, budget.maxQueriesPerClaim) };
      });
      deferred = base.result.uncheckedClaims;
      ch.emit("observation", { message: `Reusing ${base.result.sources.length} sources from the previous run and searching ${claims.length} claim${claims.length === 1 ? "" : "s"} for missing evidence.`, sourceIds: [] });
    } else {
      const needsPlanner = input.kind === "url" || (!isShortClaim(planText) && !isFewSentences(planText));
      const plannerCall = needsPlanner && deps.callPlanner && (await modelCheck).ok
        ? async (system: string, user: string) => {
            const t0 = Date.now();
            try {
              return await deps.callPlanner!(system, user, Math.min(16_000, deadline - Date.now() - allBudgets.minInferenceMs), work);
            } finally {
              llmCalls++;
              inferenceMs += Date.now() - t0;
            }
          }
        : null;
      const plan = await raceAbort(planClaims(planText, budget.maxClaims, budget.maxQueriesPerClaim, plannerCall, headline), work);
      claims = plan.claims;
      deferred = plan.deferred;
      if (plan.note) assumptions.push(plan.note);
    }
    checkAbort();

    const usable = claims.filter((c) => terms(c.claim).length >= 2);
    if (!usable.length) throw new Incomplete("Add a little more detail — who, what, where or when — so the claim can be searched.", "failed");
    claims = usable;
    extendBudget((claims.length - 1) * budget.perExtraClaimMs);
    claims.forEach((c, index) => {
      const a = resolveRelativeDates(c.claim, refDate, refWeekday, tz);
      assumptions.push(...a.filter((x) => !assumptions.includes(x)));
      ch.emit("claim_identified", { index, claim: c.claim, checkable: c.checkable, assumptions: a });
    });
    if (deferred.length) {
      ch.emit("observation", { message: `Found ${claims.length + deferred.length} claims; checking the first ${claims.length}. ${deferred.length} deferred and listed in the answer.`, sourceIds: [] });
    }
    endStage("understand", `${claims.length} claim${claims.length === 1 ? "" : "s"} to check`);

    // ── 2. Retrieve ──────────────────────────────────────────────────────────
    // Fast providers (feeds, Wikipedia, optional search APIs) gate the first fetch wave.
    // Slow providers (GDELT: 11–17 s measured) run alongside and feed a second wave only if
    // they answer within the fetch window, so they never delay first evidence.
    startStage("retrieve");
    const tRetrieve = Date.now();
    const allQueries = [...new Set(claims.flatMap((c) => c.queries))].slice(0, budget.maxQueriesPerClaim * claims.length);
    const volatile = claims.some((c) => isVolatileClaim(c.claim));
    const claimText = claims.map((c) => c.claim).join(" ");
    let announced = 0;
    const hooks = {
      onWarning: (w: { provider: string; code: string; message: string }) => ch.emit("provider_warning", w),
      onLead: (l: Lead) => {
        if (announced++ < 14) ch.emit("source_discovered", { url: l.url, title: clip(l.title, 160), publisher: l.publisher, provider: l.provider, publishedAt: l.publishedAt });
      },
    };
    // Keyword routing: places and topics in the claim decide which city/topic feeds to scan.
    let feedIds: string[] = [];
    const cls = classifyClaim(`${claimText} ${headline ?? ""}`);
    const hashtags = hashtagsFrom([...cls.places.filter((p) => p.kind !== "country" || p.name === "india").map((p) => p.name), ...cls.topics.flatMap((t) => t.matched), ...salientTerms(neutralize(claimText))]);
    if (deps.providers.some((p) => p.id === "rss")) {
      const route = routeFeeds(cls, budget.topicFeeds);
      feedIds = route.ids;
      routing = { detected: describeClassification(cls), feeds: route.ids.map((id) => { const f = topicFeeds.find((x) => x.id === id)!; return `${f.publisher} (${f.tags.filter((t) => !t.startsWith("region")).map((t) => t.split(":")[1]).join(", ") || "national"})`; }) };
      ch.emit("observation", {
        message: feedIds.length
          ? `Detected ${routing.detected}. Also scanning ${feedIds.length} matching feed${feedIds.length === 1 ? "" : "s"}: ${routing.feeds.join("; ")}.`
          : `Detected ${routing.detected}; no specialised feed matches, so the general feeds are searched.`,
        sourceIds: [],
      });
    }
    const providerQuery = { queries: allQueries, claims: claims.map((c) => c.claim), referenceDate: refDate, maxResults: budget.discoveryCandidates, signal: work, feedIds, hashtags };
    const fast = deps.providers.filter((p) => p.latency !== "slow");
    const slow = deps.providers.filter((p) => p.latency === "slow");
    const firstWaveDeadline = Math.min(deadline - allBudgets.minInferenceMs, Date.now() + budget.discoveryMs + budget.fetchMs);
    const slowOutcome = slow.length ? discover(slow, { ...providerQuery, deadline: firstWaveDeadline - 1_500 }, hooks) : Promise.resolve(null);
    const outcome = await discover(fast, { ...providerQuery, deadline: Math.min(deadline, Date.now() + budget.discoveryMs) }, hooks);
    const record = (o: Awaited<ReturnType<typeof discover>>) => {
      o.attempted.forEach((p) => attempted.add(p));
      o.succeeded.forEach((p) => succeeded.add(p));
      warnings.push(...o.warnings.map((w) => w.message));
    };
    record(outcome);
    checkAbort();
    const pickLeads = (leads: Lead[], limit: number) => {
      const ranked = rankLeads(leads, claimText, { volatile, referenceDate: refDate, limit: limit + 2, perDomain: budget.perDomainFetches });
      const fresh = ranked.filter((l) => !sources.some((s) => canonicalizeUrl(s.url) === canonicalizeUrl(l.url)));
      // Social posts never use a fetch slot: at most two are kept as low-reliability leads.
      const social = leads.filter((l) => l.kind === "social" && !sources.some((s) => canonicalizeUrl(s.url) === canonicalizeUrl(l.url))).slice(0, 2);
      const news = fresh.filter((l) => l.kind !== "social");
      return [...news.filter((l) => !l.fullText).slice(0, limit), ...news.filter((l) => l.fullText).slice(0, 2), ...social];
    };
    const toFetch = pickLeads(outcome.leads, budget.fetchCount);
    endStage("retrieve", `${outcome.leads.length} candidate${outcome.leads.length === 1 ? "" : "s"} from ${outcome.succeeded.length} of ${outcome.attempted.length} fast providers${slow.length ? `; ${slow.map((p) => p.name).join(", ")} still searching` : ""}`);

    // ── 3. Extract and link ──────────────────────────────────────────────────
    startStage("extract");
    if (base) for (const [, doc] of base.documents) addSource(doc);
    const fetchOne = async (lead: Lead, until: number) => {
      const left = until - Date.now();
      if (left < 400) return;
      try {
        const doc = await raceAbort(deps.documents.fetch(lead, { signal: work, timeoutMs: left, revalidate: req.refresh }), work);
        addSource(doc);
      } catch (err) {
        if (userSignal.aborted) throw err;
      }
    };
    await Promise.all(toFetch.map((l) => fetchOne(l, firstWaveDeadline)));
    checkAbort();

    // Second wave: late results from slow providers, if they arrived in time.
    const late = await slowOutcome;
    if (late) {
      record(late);
      const extra = pickLeads(late.leads, req.depth === "deep" ? 3 : 2);
      const until = Math.min(deadline - allBudgets.minInferenceMs, Date.now() + 3_500);
      if (extra.length && until - Date.now() > 1_500) await Promise.all(extra.map((l) => fetchOne(l, until)));
      checkAbort();
    }

    // Follow the story: a relevant report we could not read (paywall, bot block) is a lead, not a
    // dead end. Search again with its headline to find the same story from other outlets.
    const unreadable = toFetch.filter((l) => {
      const s = sources.find((x) => canonicalizeUrl(x.url) === canonicalizeUrl(l.url));
      return s && l.kind !== "social" && s.access !== "full_text" && terms(l.title).length >= 3;
    });
    const readableCount = sources.filter((s) => s.access === "full_text" && s.kind !== "user_submitted").length;
    if (unreadable.length && readableCount < 3 && deadline - Date.now() > allBudgets.minInferenceMs + 4_000) {
      const names = [...new Set(unreadable.map((l) => l.publisher ?? domainOf(l.url)))].join(", ");
      ch.emit("observation", { message: `${names} could not be read. Looking for the same story from other outlets.`, sourceIds: [] });
      const headlineQueries = [...new Set(unreadable.map((l) => sanitizeQuery(l.title)).filter((q): q is string => !!q))].slice(0, 2);
      if (headlineQueries.length) {
        const again = await discover(fast, { ...providerQuery, queries: headlineQueries, claims: [...providerQuery.claims, ...unreadable.map((l) => l.title)], deadline: Math.min(deadline - allBudgets.minInferenceMs, Date.now() + 3_000) }, hooks);
        record(again);
        const tried = new Set(sources.map((s) => canonicalizeUrl(s.url)));
        const blockedDomains = new Set(unreadable.map((l) => domainOf(l.url)));
        const headlineText = unreadable.map((l) => l.title).join(" ");
        const extra = rankLeads(again.leads, `${claimText} ${headlineText}`, { volatile, referenceDate: refDate, limit: 6, perDomain: 1 })
          .filter((l) => !tried.has(canonicalizeUrl(l.url)) && !blockedDomains.has(domainOf(l.url)) && !l.fullText)
          .slice(0, req.depth === "deep" ? 4 : 3);
        const until = Math.min(deadline - allBudgets.minInferenceMs, Date.now() + 4_500);
        if (extra.length) await Promise.all(extra.map((l) => fetchOne(l, until)));
        const found = sources.filter((s) => extra.some((l) => canonicalizeUrl(l.url) === canonicalizeUrl(s.url)) && s.access === "full_text");
        ch.emit("observation", {
          message: found.length ? `Found the story at ${found.map((s) => s.publisher ?? domainOf(s.url)).join(", ")}.` : "No other readable outlet with the same story was found.",
          sourceIds: found.map((s) => s.id),
        });
      }
      checkAbort();
    }

    // Follow a reference that retrieved articles cite but we have not read yet: either cited
    // by two or more sources, or one whose address names two of the claim's distinctive terms.
    const readable = [...docsById.values()].filter((d) => d.access === "full_text");
    const prePass = analyzeProvenance(readable.map((d, i) => ({ id: `x${i}`, canonicalUrl: d.canonicalUrl, text: d.text, contentHash: d.contentHash, links: d.links, attributions: d.attributions, title: d.title, publisher: d.publisher })));
    const distinctive = new Set(terms(claimText).filter((t) => t.length >= 5));
    const follow = prePass.sharedCitations
      .filter((c) => !sources.some((s) => canonicalizeUrl(s.url) === c.url || s.canonicalUrl === c.url))
      .filter((c) => c.citedBy.length >= 2 || new Set(terms(c.url.replace(/[/_.?=&-]+/g, " ")).filter((t) => distinctive.has(t))).size >= 2)
      .slice(0, req.depth === "deep" ? 2 : 1);
    for (const c of follow) {
      const until = Math.min(deadline - allBudgets.minInferenceMs, Date.now() + 4_000);
      if (until - Date.now() < 1_500) break;
      ch.emit("observation", { message: `Following a reference cited by ${c.citedBy.length} article${c.citedBy.length === 1 ? "" : "s"}: ${domainOf(c.url)}.`, sourceIds: [] });
      await fetchOne({ url: c.url, title: c.url, publisher: domainOf(c.url), publishedAt: null, snippet: null, provider: "citation", kind: "web_page" }, until);
    }
    checkAbort();
    retrievalMs = Date.now() - tRetrieve;

    // Provenance across everything we read.
    const provDocs = sources.filter((s) => s.access === "full_text").map((s) => {
      const d = docsById.get(s.id)!;
      return { id: s.id, canonicalUrl: s.canonicalUrl, text: d.text, contentHash: d.contentHash, links: d.links, attributions: d.attributions, title: s.title, publisher: s.publisher };
    });
    const prov = analyzeProvenance(provDocs);
    provLinks = prov.links;
    for (const s of sources) {
      s.originGroupId = prov.groups.get(s.id) ?? null;
      s.provenanceStatus = prov.status.get(s.id) ?? "unknown";
    }
    const sourceName = (id: string) => sources.find((s) => s.id === id)?.publisher ?? domainOf(sources.find((s) => s.id === id)?.url ?? "");
    for (const l of prov.links) {
      const msg =
        l.relation === "exact_duplicate"
          ? `${sourceName(l.a)} and ${sourceName(l.b)} carry identical text — counted as one source.`
          : l.relation === "near_duplicate"
            ? `${sourceName(l.a)} and ${sourceName(l.b)}: possible shared origin (largely the same wording).`
            : l.relation === "cites_source"
              ? `${sourceName(l.a)} cites ${sourceName(l.b)}.`
              : `${sourceName(l.a)} and ${sourceName(l.b)}: possible shared origin. ${l.note}`;
      ch.emit("provenance_linked", { relation: l.relation, sourceIds: [l.a, l.b], message: msg });
    }
    for (const id of prov.citedOriginals) {
      const citers = prov.links.filter((l) => l.relation === "cites_source" && l.b === id).length;
      ch.emit("observation", { message: `Found an original source: ${sourceName(id)}, cited by ${citers} other article${citers === 1 ? "" : "s"}.`, sourceIds: [id] });
    }
    const multiCite = prov.sharedCitations.find((c) => c.citedBy.length >= 2);
    if (multiCite) ch.emit("observation", { message: `${multiCite.citedBy.length === 2 ? "Two" : multiCite.citedBy.length} articles cite the same report (${domainOf(multiCite.url)}).`, sourceIds: multiCite.citedBy });

    // Passages.
    passages = selectPassages(
      sources.map((s) => ({ sourceId: s.id, text: sourceTexts.get(s.id) ?? "", textKind: docsById.get(s.id)!.textKind, excluded: s.id === submittedSourceId })),
      claims.map((c) => c.claim),
      { perSource: budget.passagesPerSource, maxPassages: budget.maxPassages, maxChars: budget.evidenceChars },
    )
      // At most two social posts reach the model, labelled as low-reliability leads.
      .filter((c, _i, all) => c.retrievalKind !== "social_post" || all.filter((x) => x.retrievalKind === "social_post").indexOf(c) < 2)
      .map((c, i) => ({ id: `P${i + 1}`, sourceId: c.sourceId, text: c.text, normalizedStart: c.normalizedStart, normalizedEnd: c.normalizedEnd, retrievalKind: c.retrievalKind, isQuotation: c.isQuotation, suspectedInjection: c.suspectedInjection }));
    const socialSources = [...new Set(passages.filter((p) => p.retrievalKind === "social_post").map((p) => p.sourceId))];
    if (socialSources.length) {
      ch.emit("observation", { message: `${socialSources.length} public social post${socialSources.length === 1 ? "" : "s"} mention this — shown as low-reliability leads, not evidence.`, sourceIds: socialSources });
    }
    for (const p of passages) ch.emit("passage_selected", { passageId: p.id, sourceId: p.sourceId, preview: clip(p.text, 180) });
    const injected = [...new Set(passages.filter((p) => p.suspectedInjection).map((p) => p.sourceId))];
    if (injected.length) {
      ch.emit("observation", { message: `${injected.map(sourceName).join(", ")} contains text addressed to AI systems. It is treated as page content, not as instructions, and cannot decide the label.`, sourceIds: injected });
    }

    // Date context: explicit dates in the evidence and article age relative to the claim.
    const refYear = Number(refDate.slice(0, 4));
    const claimYears = claims.flatMap((c) => explicitYears(c.claim));
    for (const s of sources) {
      const used = passages.filter((p) => p.sourceId === s.id);
      if (!used.length) continue;
      s.dateNotes = explicitDates(used.map((p) => p.text).join(" "));
      const ageDays = s.publishedAt ? (new Date(`${refDate}T12:00:00Z`).getTime() - new Date(s.publishedAt).getTime()) / 86_400_000 : null;
      const years = explicitYears(used.map((p) => p.text).join(" "));
      const earlier = ageDays != null && ageDays > 365 && volatile && !claimYears.includes(new Date(s.publishedAt!).getUTCFullYear());
      if (earlier || (volatile && years.length && years.every((y) => y < refYear - 1) && !claimYears.some((y) => years.includes(y)))) {
        const when = s.publishedAt ? `published ${formatDay(s.publishedAt.slice(0, 10))}` : `mentions ${years.join(", ")}`;
        s.dateNotes.push(`Possibly an earlier event: ${when}, before the claim's reference date.`);
        ch.emit("observation", { message: `${s.publisher ?? domainOf(s.url)} refers to an earlier event (${when}).`, sourceIds: [s.id] });
      }
    }
    const blocked = sources.filter((s) => s.access === "blocked" || s.access === "failed").length;
    if (blocked) warnings.push(`${blocked} source${blocked === 1 ? "" : "s"} could not be read in full (blocked, paywalled or unreachable).`);
    endStage("extract", `${sources.filter((s) => s.access === "full_text").length} readable sources, ${passages.length} passages`);
    checkAbort();

    // ── 4. Compare ───────────────────────────────────────────────────────────
    startStage("compare");
    if (!succeeded.size && !base && input.kind === "text") {
      throw new Incomplete("No source provider could be reached, so nothing was checked. Check your internet connection and retry.", "partial");
    }
    if (passages.length && claims.every((c) => !c.checkable)) {
      // Opinions/predictions are labelled by rule, so a model call would not change the outcome.
      endStage("compare", "Opinion or prediction — no model call needed");
      startStage("validate");
      const findings: Finding[] = claims.map((c, i) => ({
        id: `C${i + 1}`,
        claim: c.claim,
        verdict: "not_fact_checkable",
        headline: "This is a prediction or opinion. Evidence available today cannot settle it.",
        explanation: "Related coverage is listed below as context only; it describes the present, not the outcome being predicted.",
        supportingPassageIds: [],
        contradictingPassageIds: [],
        contextPassageIds: passages.slice(0, 3).map((p) => p.id),
        limitations: [],
        missingEvidence: [],
        validationNotes: ["Classified as an opinion or prediction by rule; no model call was made."],
        modelProposedVerdict: null,
        strength: null,
      }));
      const draft = result("complete", null, findings);
      endStage("validate", "Context passages verified");
      saveRun({ result: draft, sourceTexts, documents: docsById });
      return draft;
    }
    if (!passages.length) {
      // Nothing relevant to compare: the honest answer needs no model call.
      endStage("compare", "No relevant passages — no model call needed");
      startStage("validate");
      const unreadableLeads = sources.filter((s) => s.access !== "full_text" && s.kind !== "user_submitted" && s.kind !== "social");
      const leadList = unreadableLeads.slice(0, 3).map((s) => `${s.publisher ?? domainOf(s.url)}: “${clip(s.title, 110)}”`).join("; ");
      const findings: Finding[] = claims.map((c, i) => ({
        id: `C${i + 1}`,
        claim: c.claim,
        verdict: c.checkable ? "unresolved" : "not_fact_checkable",
        headline: !c.checkable
          ? "This reads as an opinion or prediction, which evidence cannot settle yet."
          : unreadableLeads.length
            ? "Possibly matching reports were found, but none could be read, so the claim could not be verified."
            : "No relevant evidence was found in the sources searched. That is not evidence that the claim is false.",
        explanation: !c.checkable
          ? "No retrieved passage addressed it, and its nature means a factual check is not possible yet."
          : unreadableLeads.length
            ? `Headlines that may match: ${leadList}. Their article text was blocked or unavailable, and no other readable outlet carrying the story was found. A headline alone is not enough for a verdict — open the source to read it yourself.`
            : `The ${deps.scope === "broader_web" ? "searched web sources" : "selected sources"} returned nothing that addresses this claim. Coverage is limited, so the claim remains unverified either way.`,
        supportingPassageIds: [],
        contradictingPassageIds: [],
        contextPassageIds: [],
        limitations: deps.scope === "selected_sources" ? ["Only the selected sources were searched; broader web search is not enabled."] : [],
        missingEvidence: c.checkable ? ["A primary source (official notice, record or direct report) about this claim."] : [],
        validationNotes: ["Decided without a model call because no relevant passages were found."],
        modelProposedVerdict: null,
        strength: null,
      }));
      const draft = result("complete", null, findings);
      endStage("validate", "No citations to verify");
      saveRun({ result: draft, sourceTexts, documents: docsById });
      return draft;
    }
    const check = await raceAbort(modelCheck, work);
    if (!check.ok) {
      ch.emit("provider_warning", { provider: "ollama", code: check.code, message: check.message });
      throw new Incomplete(`${check.message} Retrieved sources are shown below for inspection.`, "partial");
    }
    modelWarm = check.warm;
    if (deadline - Date.now() < allBudgets.minInferenceMs) throw new Incomplete("The time budget ran out before the local model could assess the evidence.", "partial");

    const vctx = { claims: claims.map((c) => c.claim), passages, sources, referenceDate: refDate, submittedSourceId, checkable: claims.map((c) => c.checkable) };
    const prompt = buildAssessmentPrompt({ ...vctx, timeZone: tz, checkable: claims.map((c) => c.checkable), assumptions }, sources);
    const t0 = Date.now();
    let assessed;
    try {
      assessed = await raceAbort(assess(deps.callAssessment, prompt, vctx, { deadline, minInferenceMs: allBudgets.minInferenceMs, signal: work }), work);
    } catch (err) {
      llmCalls++;
      inferenceMs += Date.now() - t0;
      if (userSignal.aborted) throw new DOMException("Cancelled", "AbortError");
      if (work.aborted) throw new Incomplete(budgetReason(), "partial");
      const e = err as { code?: string; message?: string };
      ch.emit("provider_warning", { provider: "ollama", code: e.code ?? "error", message: e.message ?? "The local model failed." });
      throw new Incomplete(e.code === "timeout" ? "The local model did not finish within the time budget. Retry, or use Investigate further for a longer budget." : (e.message ?? "The local model failed."), "partial");
    }
    llmCalls += assessed.calls;
    inferenceMs += Date.now() - t0;
    endStage("compare", assessed.repaired ? "Assessment repaired once after a structural error" : null);

    // ── 5. Validate ──────────────────────────────────────────────────────────
    startStage("validate");
    const citedOriginals = new Set(prov.citedOriginals);
    const findings = validateAssessment(assessed.value, vctx).findings.map((f) => ({ ...f, strength: computeStrength(f, passages, sources, citedOriginals) }));
    const draft = result("complete", null, findings);
    const problems = integrityProblems(draft, sourceTexts);
    if (problems.length) throw new Incomplete(`Validation failed: ${problems[0]}`, "partial");
    const downgraded = findings.filter((f) => f.modelProposedVerdict).length;
    endStage("validate", downgraded ? `${downgraded} label${downgraded === 1 ? "" : "s"} adjusted by evidence checks` : "Citations and offsets verified");

    const ttl = volatile ? cachePolicy.assessmentTtlVolatileMs : cachePolicy.assessmentTtlStableMs;
    if (deps.cache && !req.baseRunId) await deps.cache.set(cacheKey, draft, ttl).catch(() => undefined);
    saveRun({ result: draft, sourceTexts, documents: docsById });
    return draft;
  } catch (err) {
    if (userSignal.aborted) {
      const r = result("cancelled", "Stopped by you.", []);
      saveRun({ result: r, sourceTexts, documents: docsById });
      return r;
    }
    let reason: string;
    let kind: "partial" | "failed" = "partial";
    if (err instanceof Incomplete) {
      reason = err.reason;
      kind = err.kind;
    } else if (work.aborted) {
      reason = budgetReason();
    } else {
      reason = "Something went wrong while investigating. Retry, and if it persists check the server log.";
      kind = "failed";
      console.error("[fact-checker] investigation error:", err instanceof Error ? err.message : err);
    }
    const r = result(kind, reason, []);
    saveRun({ result: r, sourceTexts, documents: docsById });
    return r;
  } finally {
    clearTimeout(budgetTimer);
    userSignal.removeEventListener("abort", abortWork);
  }
}
