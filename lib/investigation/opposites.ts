/**
 * Deterministic "says the opposite" detection — the part of reading that fixed rules CAN do.
 *
 * For each claim word in a known contrast pair, look at the report sentences that are about the
 * claim (they share most of its key terms):
 *   1. negated:   the claim word appears with a negator just before it ("not closing permanently")
 *   2. antonym:   the claim word is absent and its opposite is present ("temporary" vs "permanent",
 *                 "below the safety limit" vs "dangerous", "fell" vs "rose")
 *   3. price:     "free" in the claim, a stated price in the report (a caution, not a contradiction —
 *                 "children under 12 enter free" can coexist with adult prices)
 * Every hit names the exact words and sentence, so a person can check it in seconds.
 * It is a narrow lexicon, not language understanding: what it does not list, it cannot see.
 */
export type Opposite = { claimWord: string; reportWords: string; sentence: string; kind: "negated" | "antonym" | "price" };

type Pair = { claim: RegExp; opposite: RegExp; label: string };

const PAIRS: Pair[] = [
  { claim: /\bpermanent(?:ly)?\b/i, opposite: /\btemporar(?:y|ily)\b|\bfor (?:a|one|two|\d+) (?:day|week|month)s?\b|\bwill reopen\b|\breopens? on\b/i, label: "permanently" },
  { claim: /\btemporar(?:y|ily)\b/i, opposite: /\bpermanent(?:ly)?\b/i, label: "temporarily" },
  { claim: /\b(?:shut(?:\s+down)?|closed|closes|closing|close)\b/i, opposite: /\b(?:remains? open|open as usual|operating normally|services? (?:are|were) normal)\b/i, label: "closed" },
  { claim: /\b(?:open|opened|reopens?|reopened)\b/i, opposite: /\b(?:remains? closed|shut|closed until)\b/i, label: "open" },
  { claim: /\b(?:dangerous|unsafe|toxic|contaminated|high (?:levels?|concentrations?)|excessive|alarming)\b/i, opposite: /\b(?:below (?:the )?(?:\w+ )?(?:detection |safety |permissible |safe )?limits?|within (?:the )?(?:\w+ )?(?:safe|safety|permissible) limits?|not detected|undetectable|safe to (?:drink|use|eat)|no (?:trace|traces) of)\b/i, label: "dangerous / high" },
  { claim: /\b(?:rose|rise|rises|risen|increased?|surged?|hiked?|up by)\b/i, opposite: /\b(?:fell|fall|falls|fallen|decreased?|declined?|dropped|drop|down by|cut)\b/i, label: "rose" },
  { claim: /\b(?:fell|fall|falls|fallen|decreased?|declined?|dropped|down by)\b/i, opposite: /\b(?:rose|rise|rises|risen|increased?|surged?|gained|up by)\b/i, label: "fell" },
  { claim: /\b(?:won|wins|win|victory)\b/i, opposite: /\b(?:lost|loses|lose|defeated|defeat)\b/i, label: "won" },
  { claim: /\b(?:lost|loses|defeated)\b/i, opposite: /\b(?:won|wins|victory)\b/i, label: "lost" },
  { claim: /\b(?:convicted|guilty)\b/i, opposite: /\b(?:acquitted|not guilty|cleared of)\b/i, label: "convicted" },
  { claim: /\b(?:acquitted|cleared)\b/i, opposite: /\b(?:convicted|found guilty|sentenced|interim bail|bail)\b/i, label: "acquitted" },
  { claim: /\b(?:approved|passed|cleared)\b/i, opposite: /\b(?:rejected|struck down|withdrawn|deferred)\b/i, label: "approved" },
  { claim: /\b(?:banned|ban)\b/i, opposite: /\b(?:ban (?:was )?lifted|allowed|permitted|not banned)\b/i, label: "banned" },
  { claim: /\b(?:dead|died|killed)\b/i, opposite: /\b(?:alive|survived|is safe|was rescued|injured but)\b/i, label: "died" },
  { claim: /\b(?:cancel(?:led|ed)?|called off|postponed)\b/i, opposite: /\b(?:will go ahead|went ahead|as scheduled|not (?:been )?cancel(?:led|ed))\b/i, label: "cancelled" },
];

const NEGATOR = /\b(?:not|no|never|neither|nor|without|isn't|wasn't|aren't|weren't|won't|doesn't|didn't|hasn't|haven't|cannot|can't)\b/i;
const PRICE = /(?:₹|rs\.?\s?|inr\s?|\$|usd\s?)\s?\d|\b\d[\d,]*\s?(?:rupees|rs)\b|\bticket prices?\b|\bentry fee\b|\bcharge(?:s|d)?\b/i;

export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 10);
}

/** Negator within the four words before the match. */
function negatedAt(sentence: string, re: RegExp): boolean {
  const m = sentence.match(re);
  if (!m || m.index === undefined) return false;
  const before = sentence.slice(0, m.index).split(/\s+/).slice(-4).join(" ");
  return NEGATOR.test(before);
}

/**
 * @param focus sentences from the reports that are about the claim (caller decides relevance)
 */
export function findOpposites(claim: string, focus: string[]): Opposite[] {
  const out: Opposite[] = [];
  for (const p of PAIRS) {
    if (!p.claim.test(claim) || negatedAt(claim, p.claim)) continue;
    const negated = focus.find((s) => p.claim.test(s) && negatedAt(s, p.claim));
    if (negated) {
      out.push({ claimWord: p.label, reportWords: `not … ${negated.match(p.claim)![0]}`, sentence: negated, kind: "negated" });
      continue;
    }
    const claimWordUsed = focus.some((s) => p.claim.test(s) && !negatedAt(s, p.claim));
    const opposite = focus.find((s) => p.opposite.test(s));
    if (!claimWordUsed && opposite) out.push({ claimWord: p.label, reportWords: opposite.match(p.opposite)![0], sentence: opposite, kind: "antonym" });
  }
  if (/\bfree\b/i.test(claim) && !NEGATOR.test(claim)) {
    const priced = focus.find((s) => PRICE.test(s));
    if (priced) out.push({ claimWord: "free", reportWords: priced.match(PRICE)![0].trim(), sentence: priced, kind: "price" });
  }
  return out;
}
