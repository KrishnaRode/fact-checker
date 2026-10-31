import { ModelPlanSchema } from "@/lib/contracts";
import { PLANNER_SYSTEM, dataBlock } from "@/lib/prompts";
import { buildQuery, neutralize, salientTerms, terms } from "@/lib/text";

export type PlannedClaim = { claim: string; checkable: boolean; queries: string[] };
export type Plan = {
  claims: PlannedClaim[];
  deferred: string[];
  usedModel: boolean;
  note: string | null;
};

export type InputKind = { kind: "url"; url: string } | { kind: "text"; text: string };

export function detectInput(input: string): InputKind {
  const t = input.trim();
  if (/^https?:\/\/\S+$/i.test(t)) return { kind: "url", url: t };
  return { kind: "text", text: t };
}

/**
 * Value judgements and long-range predictions. Deliberately narrow: "will reopen on 3 Nov"
 * or "entry will be free" are checkable statements about announced plans.
 */
const OPINION = /\b(best|worst|greatest|most beautiful|most liveable|ought to|i think|i believe|in my opinion|deserves?|by 20[3-9]\d|in the (?:distant )?future|will (?:surely|definitely|never) )\b/i;

/** Outcomes that cannot have happened yet: elections, matches, markets. */
const OUTCOME_PREDICTION = /\b(will|is going to|are going to|set to|bound to)\s+(?:\w+\s+){0,2}(win|lose|sweep|form (?:the )?government|come (?:back )?to power|be re-?elected|get (?:a )?majority|defeat|beat|crash|collapse)\b/i;

export function looksUncheckable(claim: string, referenceYear = new Date().getFullYear()): boolean {
  if (OPINION.test(claim) || OUTCOME_PREDICTION.test(claim)) return true;
  // "will …" about an explicit future year is a prediction (but "will reopen on 3 Nov" is not).
  return /\bwill\b/i.test(claim) && (claim.match(/\b20\d{2}\b/g) ?? []).some((y) => Number(y) > referenceYear);
}

/** Sanitise a model- or user-derived search query: plain words only, bounded length. */
export function sanitizeQuery(q: string): string | null {
  const cleaned = neutralize(q)
    .replace(/[^\p{L}\p{N}\s'’&.-]/gu, " ")
    .replace(/\b(fake|hoax|debunk(?:ed)?|true|false|fact ?check)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return terms(cleaned).length >= 2 ? cleaned : null;
}

export function queriesFor(claim: string, extra: string[] = [], max = 2): string[] {
  const out: string[] = [];
  const primary = sanitizeQuery(buildQuery(claim, 8));
  if (primary) out.push(primary);
  for (const e of extra) {
    const s = sanitizeQuery(e);
    if (s && !out.includes(s)) out.push(s);
  }
  // A broader entity-only query helps find context and conflicting coverage.
  const entities = salientTerms(neutralize(claim)).slice(0, 3).join(" ");
  const broad = sanitizeQuery(entities);
  if (broad && !out.includes(broad)) out.push(broad);
  return out.slice(0, max);
}

/** Split long text into sentence-like candidate claims (fallback when no model is available). */
/** Medium-length text with a few clear sentences: split without a model call. */
export function isFewSentences(text: string): boolean {
  const sentences = text.split(/(?<=[.!?।])\s+/).filter((s) => terms(neutralize(s)).length >= 2);
  return text.length <= 700 && sentences.length >= 2 && sentences.length <= 4;
}

export function sentenceClaims(text: string): string[] {
  return text
    .split(/(?<=[.!?।])\s+/)
    .map((s) => s.trim())
    .filter((s) => terms(neutralize(s)).length >= 2);
}

export function heuristicClaims(text: string, max: number): string[] {
  const sentences = text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?।])\s+(?=[\p{Lu}\d"“])/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 25 && terms(s).length >= 3);
  const scored = sentences.map((s, i) => ({ s, i, score: salientTerms(s).length + (/\d/.test(s) ? 1 : 0) - (looksUncheckable(s) ? 2 : 0) }));
  return scored
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, max)
    .sort((a, b) => a.i - b.i)
    .map((x) => x.s);
}

/** One meaningful sentence (calls to action like "Share before it's deleted!" don't count). */
export function isShortClaim(text: string): boolean {
  const sentences = text.split(/(?<=[.!?।])\s+/).filter((s) => terms(neutralize(s)).length >= 2);
  return text.length <= 300 && sentences.length <= 1;
}

/**
 * Plan the claims to check. Short input → the whole text is one claim (no model call).
 * Long input → one bounded planning call; the first `maxClaims` are checked and the rest are
 * listed as deferred. If the model is unavailable, a sentence heuristic is used and labelled.
 */
export async function planClaims(
  text: string,
  maxClaims: number,
  maxQueries: number,
  callModel: ((system: string, user: string) => Promise<import("@/lib/contracts").ModelPlan>) | null,
  headline: string | null = null,
): Promise<Plan> {
  const clean = text.replace(/\s+/g, " ").trim();
  if (isShortClaim(clean)) {
    return { claims: [{ claim: clean, checkable: !looksUncheckable(clean), queries: queriesFor(clean, [], maxQueries) }], deferred: [], usedModel: false, note: null };
  }
  if (isFewSentences(clean)) {
    // Sentences that lean on the first one ("Entry will be free when it reopens") borrow its
    // named entities for searching; the claim text itself is left exactly as written.
    const sentences = sentenceClaims(clean);
    const context = salientTerms(neutralize(sentences[0] ?? "")).slice(0, 3);
    const claims = sentences.map((c) => {
      const own = salientTerms(neutralize(c));
      const extra = own.length ? [] : [`${context.join(" ")} ${buildQuery(c, 5)}`];
      return { claim: c, checkable: !looksUncheckable(c), queries: queriesFor(c, extra, maxQueries) };
    });
    return { claims: claims.slice(0, maxClaims), deferred: claims.slice(maxClaims).map((c) => c.claim), usedModel: false, note: null };
  }
  if (callModel) {
    try {
      const body = headline ? `${dataBlock("headline", {}, headline)}\n${dataBlock("article", {}, clean.slice(0, 6_000))}` : dataBlock("submission", {}, clean.slice(0, 6_000));
      const plan = ModelPlanSchema.parse(await callModel(PLANNER_SYSTEM, `Split this submission into atomic claims.\n\n${body}`));
      const seen = new Set<string>();
      const claims = plan.claims.filter((c) => {
        const k = c.claim.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      const checked = claims.slice(0, maxClaims).map((c) => ({ claim: c.claim.trim(), checkable: c.checkable && !looksUncheckable(c.claim), queries: queriesFor(c.claim, [], maxQueries) }));
      if (checked.length) {
        return {
          claims: checked,
          deferred: claims.slice(maxClaims).map((c) => c.claim.trim()),
          usedModel: true,
          note: clean.length > 6_000 ? "Only the first 6,000 characters were scanned for claims." : null,
        };
      }
    } catch {
      /* fall through to the heuristic, labelled below */
    }
  }
  const all = heuristicClaims(clean, 8);
  // For an article, the headline is the best single statement of its central claim.
  const head = headline && terms(headline).length >= 3 ? [headline] : [];
  const picked = [...head, ...all.filter((c) => !head.includes(c))].length ? [...head, ...all.filter((c) => !head.includes(c))] : [clean.slice(0, 360)];
  return {
    claims: picked.slice(0, maxClaims).map((c) => ({ claim: c, checkable: !looksUncheckable(c), queries: queriesFor(c, [], maxQueries) })),
    deferred: picked.slice(maxClaims),
    usedModel: false,
    note: "Claims were selected by sentence because the local model could not plan them.",
  };
}
