import type { Finding, InvestigationResult, ModelAssessment, Overall, Passage, SourceRecord, Verdict } from "@/lib/contracts";
import { isVolatileClaim, neutralize, salientTerms, terms } from "@/lib/text";
import { placeAliases } from "./topics";
import { findOpposites, splitSentences } from "./opposites";
import { passageMatchesSource } from "./passages";

/**
 * Server-side validation of the model's assessment. The model proposes labels and cites
 * passage ids; the server decides whether each label is ELIGIBLE given the cited evidence.
 * Eligibility is necessary, not sufficient: it cannot prove the model read a passage correctly,
 * which is why semantic quality is evaluated separately against human-reviewed fixtures.
 * Labels are only ever downgraded (to "unresolved"), never upgraded or coerced to "supported".
 */
export type ValidationContext = {
  claims: string[];
  passages: Passage[];
  sources: SourceRecord[];
  referenceDate: string;
  /** Origin group of the user's submitted article, if any: it cannot corroborate itself. */
  submittedSourceId: string | null;
  /** Planner/rule view: false for opinions and predictions. */
  checkable?: boolean[];
};

export type ValidationOutcome = { findings: Finding[]; problems: string[] };

const STATEMENT_CLAIM = /\b(said|says|told|stated|claimed|claims|announced|announces|tweeted|posted|wrote|quoted|according to|alleged|alleges|declared|promised|promises|pledged|vowed|assured)\b/i;

/**
 * High-stakes outcome words. If a claim asserts one of these, a passage can only SUPPORT it if
 * it states the same outcome itself — "granted relief / interim bail" is not "acquitted, all
 * cases dropped". A narrow lexical guard against a small model over-reading evidence.
 */
const OUTCOMES: { label: string; re: RegExp }[] = [
  { label: "acquitted", re: /\bacquit(?:s|ted|tal)?\b/i },
  { label: "convicted", re: /\bconvict(?:s|ed|ion)?\b/i },
  { label: "cases dropped/withdrawn", re: /\b(?:dropp(?:ed|ing)|withdr[ae]wn?|quash(?:ed)?)\b/i },
  { label: "dismissed", re: /\bdismiss(?:ed|al)?\b/i },
  { label: "arrested", re: /\barrest(?:s|ed)?\b/i },
  { label: "died/killed", re: /\b(?:died|dead|death|killed|passed away)\b/i },
  { label: "resigned", re: /\bresign(?:s|ed|ation)?\b/i },
  { label: "banned", re: /\bban(?:s|ned)?\b/i },
  { label: "sworn in", re: /\b(?:sworn in|took oath|takes oath|oath of office)\b/i },
  { label: "permanently", re: /\bpermanent(?:ly)?\b/i },
  { label: "guilty", re: /\bguilty\b/i },
  { label: "cancelled/scrapped", re: /\b(?:cancel(?:led|ed)?|scrapp?(?:ed)?)\b/i },
];

/**
 * Key-term coverage: the cited support must mention most of what the claim is about
 * (people, places, numbers, events — after synonym mapping). Catches a small model citing a
 * related but different event ("a student fell" for "a woman and child died").
 */
export function uncoveredClaimTerms(claim: string, passageTexts: string[]): { missing: string[]; ratio: number } {
  const key = [...new Set(terms(claim))].filter((t) => t.length > 2 || /\d/.test(t));
  if (key.length < 3) return { missing: [], ratio: 1 };
  const present = new Set(passageTexts.flatMap((t) => terms(t)));
  const missing = key.filter((t) => !present.has(t));
  return { missing, ratio: (key.length - missing.length) / key.length };
}

const NUMBER_WORDS: Record<string, string> = { one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10", eleven: "11", twelve: "12", first: "1", second: "2", third: "3", fourth: "4", fifth: "5", sixth: "6", seventh: "7", eighth: "8", ninth: "9", tenth: "10", eighteenth: "18", twentieth: "20", hundred: "100", thousand: "1000" };

function numbersIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/\d[\d,]*(?:\.\d+)?/g)) out.add(m[0].replace(/,/g, "").replace(/^0+(?=\d)/, ""));
  for (const w of text.toLowerCase().match(/[a-z]+/g) ?? []) if (NUMBER_WORDS[w]) out.add(NUMBER_WORDS[w]);
  return out;
}

/**
 * Specific details — numbers and named people/places/organisations — must match exactly.
 * "25th floor in Mumbai" is not supported by "18th floor in Pune", however similar the event.
 */
export function mismatchedSpecifics(claim: string, passageTexts: string[]): string[] {
  const joined = passageTexts.join(" ");
  const passageNums = numbersIn(joined);
  const missing: string[] = [];
  for (const m of claim.matchAll(/\d[\d,]*(?:\.\d+)?(?:st|nd|rd|th)?/g)) {
    const n = m[0].replace(/(st|nd|rd|th)$/, "").replace(/,/g, "").replace(/^0+(?=\d)/, "");
    if (!passageNums.has(n)) missing.push(m[0]);
  }
  const passageTerms = new Set(terms(joined));
  for (const entity of salientTerms(neutralize(claim))) {
    if (/^\d/.test(entity)) continue;
    const parts = terms(entity).filter((t) => t.length > 2);
    // Multi-word names need their distinctive words present; one-word names must appear.
    // A city also counts when the passage names one of its localities or old names.
    const aliases = placeAliases(entity).flatMap((a) => terms(a));
    if (parts.length && !parts.some((t) => passageTerms.has(t)) && !aliases.some((t) => passageTerms.has(t))) missing.push(entity);
  }
  return [...new Set(missing)];
}

export function unsupportedOutcomes(claim: string, passageTexts: string[]): string[] {
  return OUTCOMES.filter((o) => o.re.test(claim) && !passageTexts.some((t) => o.re.test(t))).map((o) => o.label);
}

/** Problems worth one bounded repair attempt (structural, not judgement). */
export function structuralProblems(model: ModelAssessment, ctx: ValidationContext): string[] {
  const problems: string[] = [];
  const ids = new Set(ctx.passages.map((p) => p.id));
  const seen = new Set<number>();
  for (const f of model.findings) {
    if (f.claim_index >= ctx.claims.length) problems.push(`claim_index ${f.claim_index} does not exist (valid: 0–${ctx.claims.length - 1}).`);
    seen.add(f.claim_index);
    for (const e of f.evidence) if (!ids.has(e.passage_id)) problems.push(`passage_id ${e.passage_id} does not exist; cite only: ${[...ids].join(", ") || "none"}.`);
  }
  for (let i = 0; i < ctx.claims.length; i++) if (!seen.has(i)) problems.push(`No finding for claim_index ${i}.`);
  return problems;
}

export function validateAssessment(model: ModelAssessment, ctx: ValidationContext): ValidationOutcome {
  const passages = new Map(ctx.passages.map((p) => [p.id, p]));
  const sources = new Map(ctx.sources.map((s) => [s.id, s]));
  const problems = structuralProblems(model, ctx);
  const submittedGroup = ctx.submittedSourceId ? (sources.get(ctx.submittedSourceId)?.originGroupId ?? `self:${ctx.submittedSourceId}`) : null;
  const refTime = new Date(`${ctx.referenceDate}T12:00:00Z`).getTime();

  const findings: Finding[] = ctx.claims.map((claim, index) => {
    const proposed = model.findings.find((f) => f.claim_index === index);
    if (!proposed) {
      return {
        id: `C${index + 1}`,
        claim,
        verdict: "unresolved",
        headline: "The local model did not return an assessment for this claim.",
        explanation: "No validated assessment is available for this claim, so no conclusion is drawn.",
        supportingPassageIds: [],
        contradictingPassageIds: [],
        contextPassageIds: [],
        limitations: [],
        missingEvidence: [],
        validationNotes: ["Missing from the model's answer."],
        modelProposedVerdict: null,
        strength: null,
      };
    }
    const notes: string[] = [];
    const limitations = [...proposed.limitations];
    const support: string[] = [];
    const contra: string[] = [];
    const context: string[] = [];
    const assigned = new Set<string>();
    for (const e of proposed.evidence) {
      if (!passages.has(e.passage_id)) {
        notes.push(`Rejected a citation to a passage that does not exist (${e.passage_id}).`);
        continue;
      }
      if (assigned.has(e.passage_id)) continue;
      assigned.add(e.passage_id);
      (e.stance === "supports" ? support : e.stance === "contradicts" ? contra : context).push(e.passage_id);
    }

    const isFullText = (pid: string) => {
      const p = passages.get(pid);
      const s = p ? sources.get(p.sourceId) : undefined;
      return !!p && !!s && p.retrievalKind === "article_body" && s.access === "full_text" && !p.suspectedInjection;
    };
    const isSelf = (pid: string) => {
      const s = sources.get(passages.get(pid)?.sourceId ?? "");
      if (!s || !submittedGroup) return false;
      return s.id === ctx.submittedSourceId || (s.originGroupId != null && s.originGroupId === submittedGroup);
    };
    const eligible = (ids: string[]) => ids.filter((pid) => isFullText(pid) && !isSelf(pid));

    let verdict: Verdict = proposed.verdict;
    /** First readable, eligible passage (cited or not) whose sentences say the opposite of the claim. */
    const opposingPassage = (i: number): { pid: string; o: ReturnType<typeof findOpposites>[number] } | null => {
      const all = ctx.passages.map((p) => p.id).filter(isFullText).filter((pid) => !isSelf(pid));
      for (const pid of all) {
        const o = findOpposites(ctx.claims[i]!, splitSentences(passages.get(pid)!.text)).find((x) => x.kind !== "price");
        if (o) return { pid, o };
      }
      return null;
    };
    /** A readable source's headline saying the opposite (blocks green; a headline alone never makes red). */
    const opposingHeadline = (i: number) => {
      for (const s of ctx.sources) {
        if (s.access !== "full_text" || s.kind === "user_submitted" || s.kind === "social" || s.id === ctx.submittedSourceId) continue;
        // Headlines are short: only explicit negation or a who-beat-whom flip counts, never
        // antonym-by-absence (a "shut until 2 Nov" headline does not contradict "reopens 3 Nov").
        const o = findOpposites(ctx.claims[i]!, [s.title]).find((x) => x.kind === "negated" || x.claimWord.includes(" beat "));
        if (o) return { s, o };
      }
      return null;
    };
    const downgrade = (why: string) => {
      notes.push(why);
      verdict = "unresolved";
    };

    if (support.concat(contra).some((pid) => passages.get(pid)!.suspectedInjection)) {
      notes.push("A cited passage contains instructions addressed to AI systems; it was treated as untrusted text and cannot decide the label.");
    }

    if (ctx.checkable?.[index] === false && verdict !== "not_fact_checkable" && verdict !== "misleading_context") {
      // Opinions and long-range predictions cannot be supported or contradicted by evidence today.
      notes.push("Classified as an opinion or prediction: evidence cannot settle it yet. Related passages are kept as context.");
      context.push(...support.splice(0), ...contra.splice(0));
      verdict = "not_fact_checkable";
    } else if (verdict === "supported") {
      const ok = eligible(support);
      if (!ok.length) {
        downgrade(
          support.some(isSelf)
            ? "The only support came from the submitted article itself (or a copy of it), which cannot corroborate itself."
            : support.length
              ? "The supporting citations were search snippets or feed summaries, not readable article text."
              : "The model proposed “supported” without citing a supporting passage.",
        );
      } else if (opposingPassage(index)) {
        // Explicit opposite wording in readable evidence: the label follows the evidence.
        const { pid, o } = opposingPassage(index)!;
        notes.push(`Decided by the opposite-wording check, overriding the model's “supported”: the claim says “${o.claimWord}”, ${pid} says “${o.reportWords}”.`);
        verdict = "contradicted";
        context.push(...support.splice(0).filter((x) => x !== pid));
        if (!contra.includes(pid)) contra.unshift(pid);
      } else if (opposingHeadline(index)) {
        const { s, o } = opposingHeadline(index)!;
        downgrade(`The headline of ${s.publisher ?? s.id} says the opposite: “${s.title}” (the claim says “${o.claimWord}”, the headline says “${o.reportWords}”).`);
      } else if (mismatchedSpecifics(ctx.claims[index]!, ok.map((pid) => passages.get(pid)!.text)).length) {
        downgrade(`Specific details in the claim (${mismatchedSpecifics(ctx.claims[index]!, ok.map((pid) => passages.get(pid)!.text)).slice(0, 4).join(", ")}) do not appear in the supporting passages, so they may describe a different event or different facts.`);
      } else if (uncoveredClaimTerms(ctx.claims[index]!, ok.map((pid) => passages.get(pid)!.text)).ratio < 0.6) {
        const { missing } = uncoveredClaimTerms(ctx.claims[index]!, ok.map((pid) => passages.get(pid)!.text));
        downgrade(`The supporting passages do not mention key parts of the claim (${missing.slice(0, 5).join(", ")}), so they may describe a different event.`);
      } else if (unsupportedOutcomes(ctx.claims[index]!, ok.map((pid) => passages.get(pid)!.text)).length) {
        downgrade(`The claim says “${unsupportedOutcomes(ctx.claims[index]!, ok.map((pid) => passages.get(pid)!.text)).join("”, “")}”, but no supporting passage states that outcome.`);
      } else if (ok.every((pid) => passages.get(pid)!.isQuotation) && !STATEMENT_CLAIM.test(ctx.claims[index]!)) {
        downgrade("Support came only from quoted statements: they show what was said, not that it is true.");
      } else if ((isVolatileClaim(ctx.claims[index]!) || STATEMENT_CLAIM.test(ctx.claims[index]!)) && ok.every((pid) => sources.get(passages.get(pid)!.sourceId)?.kind === "reference")) {
        downgrade("Only Wikipedia supported a claim about recent events or what someone said or promised; it is background, not an authority for that.");
      } else if (isVolatileClaim(ctx.claims[index]!)) {
        const ages = ok.map((pid) => sources.get(passages.get(pid)!.sourceId)?.publishedAt).filter((d): d is string => !!d).map((d) => (refTime - new Date(d).getTime()) / 86_400_000);
        if (ages.length && ages.every((a) => a > 60)) downgrade("The supporting articles are more than two months older than the claim's reference date, so they may describe an earlier event.");
      }
    } else if (verdict === "contradicted") {
      const okContra = eligible(contra);
      if (okContra.length && (isVolatileClaim(ctx.claims[index]!) || STATEMENT_CLAIM.test(ctx.claims[index]!)) && okContra.every((pid) => sources.get(passages.get(pid)!.sourceId)?.kind === "reference")) {
        downgrade("Only Wikipedia contradicted a claim about recent events or what someone said or promised; it is background, not an authority for that.");
      } else if (!okContra.length) {
        downgrade(
          contra.length
            ? "The contradicting citations were snippets, summaries or the submitted article itself, not independent readable article text."
            : "The model proposed “contradicted” without citing a contradicting passage. Missing evidence is not contradiction.",
        );
      }
    } else if (verdict === "misleading_context") {
      if (!eligible([...support, ...contra, ...context]).length) downgrade("“Missing context” needs a cited readable passage showing the context; none was cited.");
    }

    // Shared-origin caution for definitive labels.
    if (verdict === "supported" || verdict === "contradicted") {
      const used = eligible(verdict === "supported" ? support : contra);
      const groups = new Set(used.map((pid) => sources.get(passages.get(pid)!.sourceId)?.originGroupId ?? `solo:${passages.get(pid)!.sourceId}`));
      if (used.length > 1 && groups.size === 1) limitations.push("The cited sources appear to share one origin, so they count as one line of evidence, not several.");
      if (verdict === "supported" && eligible(contra).length) limitations.push("Some retrieved evidence points the other way; see the conflicting passages.");
    }

    return {
      id: `C${index + 1}`,
      claim: ctx.claims[index]!,
      verdict,
      headline: scrubModelText(proposed.finding, passages),
      explanation: scrubModelText(proposed.explanation, passages),
      supportingPassageIds: support,
      contradictingPassageIds: contra,
      contextPassageIds: context,
      limitations: limitations.map((l) => scrubModelText(l, passages)).filter(Boolean),
      missingEvidence: proposed.missing_evidence.map((m) => scrubModelText(m, passages)).filter(Boolean),
      validationNotes: notes,
      modelProposedVerdict: verdict !== proposed.verdict ? proposed.verdict : null,
      strength: null,
    };
  });

  return { findings, problems };
}

/** Remove URLs and references to non-existent passages from model-written prose. */
export function scrubModelText(text: string, passages: Map<string, Passage>): string {
  return text
    .replace(/\bhttps?:\/\/\S+/gi, "[link removed]")
    .replace(/\[(P\d{1,3})\]/g, (m, id: string) => (passages.has(id) ? m : ""))
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Overall label is derived in code — the model never writes the headline verdict. */
export function deriveOverall(findings: Finding[], status: InvestigationResult["status"], unchecked: string[]): Overall {
  if (status !== "complete" || !findings.length) return null;
  const verdicts = new Set(findings.map((f) => f.verdict));
  if (unchecked.length > 0) return "mixed";
  if (verdicts.size === 1) return findings[0]!.verdict;
  return "mixed";
}

const VERDICT_WORDS: Record<Verdict, string> = {
  supported: "supported",
  contradicted: "contradicted",
  misleading_context: "missing context",
  unresolved: "not enough evidence",
  not_fact_checkable: "not fact-checkable",
};

export function deriveSummary(findings: Finding[], overall: Overall, unchecked: string[], status: InvestigationResult["status"]): string {
  if (status === "cancelled") return "Investigation stopped before an assessment was made.";
  if (status !== "complete") return "Investigation incomplete — no conclusion is drawn from a partial run.";
  if (findings.length === 1 && overall !== "mixed") return findings[0]!.headline;
  const counts = new Map<Verdict, number>();
  for (const f of findings) counts.set(f.verdict, (counts.get(f.verdict) ?? 0) + 1);
  const parts = [...counts.entries()].map(([v, n]) => `${n} ${VERDICT_WORDS[v]}`);
  const checked = `Checked ${findings.length} claim${findings.length === 1 ? "" : "s"}: ${parts.join(", ")}.`;
  return unchecked.length ? `${checked} ${unchecked.length} more claim${unchecked.length === 1 ? " was" : "s were"} not checked.` : checked;
}

/** Referential integrity of a whole result before it is emitted. */
export function integrityProblems(result: Pick<InvestigationResult, "sources" | "passages" | "findings" | "graph">, sourceTexts: Map<string, string>): string[] {
  const out: string[] = [];
  const sourceIds = new Set(result.sources.map((s) => s.id));
  const passageIds = new Set(result.passages.map((p) => p.id));
  for (const p of result.passages) {
    if (!sourceIds.has(p.sourceId)) out.push(`Passage ${p.id} belongs to an unknown source.`);
    else if (!passageMatchesSource(p, sourceTexts.get(p.sourceId))) out.push(`Passage ${p.id} does not match its source text at the stored offsets.`);
  }
  for (const f of result.findings) {
    for (const pid of [...f.supportingPassageIds, ...f.contradictingPassageIds, ...f.contextPassageIds]) {
      if (!passageIds.has(pid)) out.push(`Finding ${f.id} cites unknown passage ${pid}.`);
    }
  }
  const nodeIds = new Set(result.graph.nodes.map((n) => n.id));
  for (const e of result.graph.edges) if (!nodeIds.has(e.from) || !nodeIds.has(e.to)) out.push(`Graph edge ${e.id} references a missing node.`);
  return out;
}
