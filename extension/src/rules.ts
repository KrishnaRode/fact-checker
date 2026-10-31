import { looksUncheckable } from "@/lib/investigation/claim-planner";
import { selectPassages } from "@/lib/investigation/passages";
import { analyzeProvenance } from "@/lib/investigation/provenance";
import { mismatchedSpecifics, uncoveredClaimTerms, unsupportedOutcomes } from "@/lib/investigation/validation";
import { canonicalizeUrl, coverage, domainOf, normalizeText, sha256, terms } from "@/lib/text";

/**
 * Evidence-only mode: a deterministic decision from retrieved reports — no language model.
 *
 * It reuses the app's own checks (key-term coverage, exact numbers and places, outcome words,
 * provenance grouping). Rules cannot understand meaning (paraphrase, sarcasm, "X denied Y"),
 * so the labels are deliberately different from the AI mode's "Supported/Contradicted":
 * they say what the reports show, not whether the claim is true.
 */
export type RuleLabel = "matches" | "differs" | "denial" | "conflict" | "disputed" | "no_coverage" | "opinion";

export type Doc = { url: string; title: string; publisher: string; publishedAt: string | null; text: string; links: string[]; readable: boolean; note: string | null; isFactCheck: boolean };

export type RuleEvidence = { publisher: string; title: string; url: string; publishedAt: string | null; passage: string; detail: string | null; originGroup: string | null };

export type RuleResult = {
  label: RuleLabel;
  title: string;
  tone: "supported" | "contradicted" | "unresolved" | "neutral";
  summary: string;
  independentOrigins: number;
  matches: RuleEvidence[];
  differs: RuleEvidence[];
  denials: RuleEvidence[];
  factChecks: RuleEvidence[];
  unreadable: { publisher: string; title: string; url: string; note: string | null }[];
  notes: string[];
};

const DEBUNK = /\b(fake|false|falsely|misleading|misreport|hoax|debunk(?:ed)?|no,|not true|morphed|edited|old (?:video|image|photo)|viral claim|fact[- ]check|baseless|incorrect|wrongly)\b/i;
const DENIAL = /\b(denied|denies|deny|refuted|refutes|rumou?rs?|fake news|not true|baseless|clarified that .{0,40}\bnot\b|dismissed (?:the )?(?:claim|reports?))\b/i;

const LABELS: Record<RuleLabel, { title: string; tone: RuleResult["tone"] }> = {
  matches: { title: "Matches independent reports", tone: "supported" },
  differs: { title: "Reports differ on details", tone: "unresolved" },
  denial: { title: "Reports mention a denial", tone: "unresolved" },
  conflict: { title: "Reports conflict", tone: "unresolved" },
  disputed: { title: "A fact-checker disputes a similar claim", tone: "contradicted" },
  no_coverage: { title: "No matching coverage found", tone: "neutral" },
  opinion: { title: "Opinion or prediction", tone: "neutral" },
};

export function decide(claim: string, docs: Doc[]): RuleResult {
  const base = (label: RuleLabel, summary: string, extra: Partial<RuleResult> = {}): RuleResult => ({
    label,
    ...LABELS[label],
    summary,
    independentOrigins: 0,
    matches: [],
    differs: [],
    denials: [],
    factChecks: [],
    // Only unreadable reports whose headline relates to the claim are worth listing.
    unreadable: docs.filter((d) => !d.readable && !d.isFactCheck && uncoveredClaimTerms(claim, [d.title]).ratio >= 0.5).map((d) => ({ publisher: d.publisher, title: d.title, url: d.url, note: d.note })),
    notes: [],
    ...extra,
  });
  if (looksUncheckable(claim)) return base("opinion", "This reads as an opinion or a prediction. Reports can give context but cannot settle it.");

  const claimTerms = terms(claim);
  // Published fact-checks whose headline matches the claim and uses debunk wording.
  const factChecks: RuleEvidence[] = docs
    .filter((d) => d.isFactCheck && coverage(claimTerms, terms(`${d.title} ${d.text.slice(0, 600)}`)) >= 0.4 && DEBUNK.test(d.title))
    .map((d) => ({ publisher: d.publisher, title: d.title, url: d.url, publishedAt: d.publishedAt, passage: d.text.slice(0, 280) || d.title, detail: null, originGroup: null }));

  const readable = docs.filter((d) => d.readable && !d.isFactCheck);
  const texts = readable.map((d) => normalizeText(d.text));
  const prov = analyzeProvenance(
    readable.map((d, i) => ({ id: `D${i}`, canonicalUrl: canonicalizeUrl(d.url), text: texts[i]!, contentHash: texts[i]!.length > 200 ? sha256(texts[i]!.toLowerCase()) : null, links: d.links.map(canonicalizeUrl), attributions: [], title: d.title, publisher: d.publisher })),
  );
  const picked = selectPassages(
    readable.map((d, i) => ({ sourceId: `D${i}`, text: texts[i]!, textKind: "article_body" as const })),
    [claim],
    { perSource: 2, maxPassages: 12, maxChars: 12_000 },
  );

  const matches: RuleEvidence[] = [];
  const differs: RuleEvidence[] = [];
  const denials: RuleEvidence[] = [];
  readable.forEach((d, i) => {
    const mine = picked.filter((p) => p.sourceId === `D${i}`).map((p) => p.text);
    if (!mine.length) return;
    const joined = `${d.title}. ${mine.join(" ")}`;
    const { ratio } = uncoveredClaimTerms(claim, [joined]);
    const specifics = mismatchedSpecifics(claim, [joined]);
    const outcomes = unsupportedOutcomes(claim, [joined]);
    // Show the passage that covers the most of the claim; fall back to the headline.
    const best = [...mine].sort((a, b) => coverage(claimTerms, terms(b)) - coverage(claimTerms, terms(a)))[0]!;
    const shown = coverage(claimTerms, terms(best)) >= 0.4 ? best : `Headline: ${d.title}`;
    const ev = (detail: string | null): RuleEvidence => ({ publisher: d.publisher, title: d.title, url: d.url, publishedAt: d.publishedAt, passage: shown, detail, originGroup: prov.groups.get(`D${i}`) ?? null });
    if (ratio < 0.5) return;
    if (DENIAL.test(mine.join(" "))) denials.push(ev("mentions a denial or calls something a rumour"));
    else if (ratio >= 0.7 && !specifics.length && !outcomes.length) matches.push(ev(null));
    else if (specifics.length || outcomes.length) differs.push(ev(`does not state: ${[...specifics, ...outcomes].slice(0, 4).join(", ")}`));
  });

  const origins = new Set(matches.map((m) => m.originGroup ?? `solo:${domainOf(m.url)}:${m.url}`)).size;
  const notes: string[] = ["Evidence-only mode: rules compare words, numbers and places — they do not read for meaning."];
  if (matches.length > origins) notes.push(`${matches.length - origins} cop${matches.length - origins === 1 ? "y" : "ies"} of the same story counted once.`);
  const common = { matches, differs, denials, factChecks, independentOrigins: origins, notes };

  if (factChecks.length) return base("disputed", `${factChecks[0]!.publisher} published a fact-check on a similar claim. Read it to see whether it is the same claim.`, common);
  if (matches.length && denials.length) return base("conflict", "Some reports match the claim while others mention a denial. Read both sides.", common);
  if (matches.length) {
    const extra = differs.length ? ` ${differs.length} other report${differs.length === 1 ? "" : "s"} differ on details.` : "";
    return base("matches", `${origins} independent report${origins === 1 ? "" : "s"} describe${origins === 1 ? "s" : ""} the same facts — names, numbers and places included.${extra}`, common);
  }
  if (denials.length) return base("denial", "Matching coverage mentions a denial or calls the claim a rumour.", common);
  if (differs.length) return base("differs", "Reports about a similar event were found, but key details differ from the claim.", common);
  const unread = docs.filter((d) => !d.readable && !d.isFactCheck && uncoveredClaimTerms(claim, [d.title]).ratio >= 0.5);
  return base(
    "no_coverage",
    unread.length
      ? `Possibly matching reports (${unread.slice(0, 2).map((d) => d.publisher).join(", ")}) could not be read, and no readable report matched. That is not evidence the claim is false.`
      : "None of the searched sources covered this claim. That is not evidence that it is false.",
    common,
  );
}

/** Rank feed items for a claim (title weighted twice); returns indexes, best first. */
export function rankItems(claim: string, items: { title: string; summary: string; url: string }[], limit: number): number[] {
  const q = terms(claim);
  const seen = new Set<string>();
  return items
    .map((it, i) => ({ i, c: coverage(q, terms(`${it.title} ${it.title} ${it.summary}`)), url: canonicalizeUrl(it.url) }))
    .filter((x) => x.c >= 0.25 && !seen.has(x.url) && (seen.add(x.url), true))
    .sort((a, b) => b.c - a.c)
    .slice(0, limit)
    .map((x) => x.i);
}
