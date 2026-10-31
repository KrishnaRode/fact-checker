import type { Finding, InvestigationResult, ModelAssessment, Overall, Passage, SourceRecord, Verdict } from "@/lib/contracts";
import { isVolatileClaim } from "@/lib/text";
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

const STATEMENT_CLAIM = /\b(said|says|told|stated|claimed|claims|announced|announces|tweeted|posted|wrote|quoted|according to|alleged|alleges|declared)\b/i;

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
      } else if (ok.every((pid) => passages.get(pid)!.isQuotation) && !STATEMENT_CLAIM.test(ctx.claims[index]!)) {
        downgrade("Support came only from quoted statements: they show what was said, not that it is true.");
      } else if (isVolatileClaim(ctx.claims[index]!) && ok.every((pid) => sources.get(passages.get(pid)!.sourceId)?.kind === "reference")) {
        downgrade("Only Wikipedia supported a time-sensitive claim; it is background, not an authority for current events.");
      } else if (isVolatileClaim(ctx.claims[index]!)) {
        const ages = ok.map((pid) => sources.get(passages.get(pid)!.sourceId)?.publishedAt).filter((d): d is string => !!d).map((d) => (refTime - new Date(d).getTime()) / 86_400_000);
        if (ages.length && ages.every((a) => a > 60)) downgrade("The supporting articles are more than two months older than the claim's reference date, so they may describe an earlier event.");
      }
    } else if (verdict === "contradicted") {
      if (!eligible(contra).length) {
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
