import type { Passage } from "@/lib/contracts";
import { bm25Scores, coverage, terms } from "@/lib/text";

/**
 * Passage selection. Every passage is an exact slice of the stored normalized document text:
 * text === docText.slice(normalizedStart, normalizedEnd). Nothing is paraphrased here.
 */
export type Segment = { start: number; end: number; text: string };

const MAX_SEGMENT = 700;

/** Paragraph spans of normalized text; long paragraphs are split at sentence ends. */
function paragraphs(text: string): Segment[] {
  const out: Segment[] = [];
  const re = /[^\n]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const para = m[0];
    const base = m.index;
    if (para.trim().length < 25) continue;
    if (para.length <= MAX_SEGMENT) {
      out.push({ start: base, end: base + para.length, text: para });
      continue;
    }
    const sentences = [...para.matchAll(/[^.!?]+(?:[.!?]+["”’)]*\s*|$)/g)].filter((s) => s[0].length);
    let winStart = -1;
    let winEnd = -1;
    for (const s of sentences) {
      const sStart = base + s.index!;
      const sEnd = sStart + s[0].trimEnd().length;
      if (winStart < 0) {
        winStart = sStart;
        winEnd = sEnd;
      } else if (sEnd - winStart <= MAX_SEGMENT) {
        winEnd = sEnd;
      } else {
        out.push({ start: winStart, end: winEnd, text: text.slice(winStart, winEnd) });
        winStart = sStart;
        winEnd = sEnd;
      }
    }
    if (winStart >= 0) {
      const end = Math.min(winEnd, winStart + MAX_SEGMENT * 2);
      out.push({ start: winStart, end, text: text.slice(winStart, end) });
    }
  }
  return out;
}

/**
 * Candidate windows: each paragraph alone, plus each paragraph joined with following short
 * paragraphs up to MAX_SEGMENT chars, so a notice's key sentence keeps its neighbours.
 * Every window is still an exact slice of the source text.
 */
export function segment(text: string): Segment[] {
  const paras = paragraphs(text);
  const out: Segment[] = [...paras];
  for (let i = 0; i < paras.length; i++) {
    let end = i;
    while (end + 1 < paras.length && paras[end + 1]!.end - paras[i]!.start <= MAX_SEGMENT) end++;
    if (end > i) out.push({ start: paras[i]!.start, end: paras[end]!.end, text: text.slice(paras[i]!.start, paras[end]!.end) });
  }
  return out;
}

export function looksLikeQuotation(text: string): boolean {
  const quoted = (text.match(/[“"][^”"]{12,}[”"]/g) ?? []).join("").length;
  const speech = /\b(said|says|told|stated|claimed|alleged|according to|tweeted|posted|wrote)\b/i.test(text);
  return speech && quoted / Math.max(1, text.length) > 0.35;
}

const INJECTION_PATTERNS = [
  /\bignore (?:all |any )?(?:the )?(?:previous|prior|above|earlier) (?:instructions|directions|prompts?)\b/i,
  /\bdisregard (?:all |any )?(?:the )?(?:previous|prior|above|system) /i,
  /\byou are now (?:in |an? )?(?:admin|administrator|developer|dan|jailbreak)/i,
  /\b(?:system|assistant)\s*:\s*(?:tool|call|you|ignore|mark|override)/i,
  /\btool_?call\b|\bfunction_?call\b/i,
  /\bmark (?:the|this) claim (?:about [^.]{0,60})?as (?:supported|true|verified|contradicted|false)\b/i,
  /\b(?:as an ai|language model),? (?:you must|ignore|respond)/i,
  /\bfetch\(\s*['"]https?:\/\//i,
];

/** Text addressed to AI systems inside a retrieved document — data, never instructions. */
export function looksLikeInjection(text: string): boolean {
  return INJECTION_PATTERNS.some((r) => r.test(text));
}

export type DocForPassages = {
  sourceId: string;
  text: string;
  textKind: Passage["retrievalKind"];
  /** Excluded from evidence (e.g. the user's own submitted article). */
  excluded?: boolean;
};

export type Candidate = Passage & { score: number; claimIndex: number };

/**
 * Score windows against each claim. Coverage is weighted by how rare each claim term is
 * across the retrieved documents, so words every document shares (a city name) cannot by
 * themselves qualify a passage. Keep the best few non-overlapping windows per source, then
 * apply a global cap with source diversity and a total character budget.
 */
export function selectPassages(
  docs: DocForPassages[],
  claims: string[],
  opts: { perSource: number; maxPassages: number; maxChars: number; startIndex?: number },
): Candidate[] {
  const usable = docs.filter((d) => !d.excluded && d.text);
  const claimTerms = claims.map((c) => [...new Set(terms(c))]);
  const docTermSets = usable.map((d) => new Set(terms(d.text)));
  const N = Math.max(1, usable.length);
  const idf = (t: string) => Math.log(1 + (N + 1) / (1 + docTermSets.filter((s) => s.has(t)).length));

  const perSource: Candidate[][] = [];
  for (const doc of usable) {
    const segs = segment(doc.text);
    if (!segs.length) continue;
    const segTerms = segs.map((s) => terms(s.text));
    const best: { seg: Segment; score: number; claimIndex: number }[] = [];
    claimTerms.forEach((ct, ci) => {
      const weights = ct.map(idf);
      const total = weights.reduce((a, b) => a + b, 0) || 1;
      const scores = bm25Scores(ct, segTerms);
      segs.forEach((seg, si) => {
        const present = new Set(segTerms[si]);
        const wcov = ct.reduce((acc, t, k) => acc + (present.has(t) ? weights[k]! : 0), 0) / total;
        if (wcov < 0.3 || coverage(ct, segTerms[si]!) < 0.15) return;
        // Covering more of the claim's distinctive terms dominates; BM25 breaks ties; a window
        // must earn its extra length.
        const lengthPenalty = 1 / (1 + Math.max(0, seg.text.length - 350) / 1200);
        best.push({ seg, score: wcov * wcov * (1 + Math.log1p(scores[si]!)) * lengthPenalty, claimIndex: ci });
      });
    });
    best.sort((a, b) => b.score - a.score);
    const picked: Candidate[] = [];
    for (const b of best) {
      if (picked.some((p) => b.seg.start < p.normalizedEnd && p.normalizedStart < b.seg.end)) continue;
      picked.push({
        id: "",
        sourceId: doc.sourceId,
        text: b.seg.text,
        normalizedStart: b.seg.start,
        normalizedEnd: b.seg.end,
        retrievalKind: doc.textKind,
        isQuotation: looksLikeQuotation(b.seg.text),
        suspectedInjection: looksLikeInjection(b.seg.text),
        score: b.score,
        claimIndex: b.claimIndex,
      });
      if (picked.length >= opts.perSource) break;
    }
    if (picked.length) perSource.push(picked);
  }

  // Round-robin by source rank (best first), so one long article cannot crowd out the rest.
  perSource.sort((a, b) => b[0]!.score - a[0]!.score);
  const out: Candidate[] = [];
  let chars = 0;
  for (let round = 0; out.length < opts.maxPassages; round++) {
    let added = false;
    for (const list of perSource) {
      const c = list[round];
      if (!c) continue;
      if (chars + c.text.length > opts.maxChars) continue;
      out.push(c);
      chars += c.text.length;
      added = true;
      if (out.length >= opts.maxPassages) break;
    }
    if (!added) break;
  }
  let n = opts.startIndex ?? 1;
  for (const c of out) c.id = `P${n++}`;
  return out;
}

/** Integrity check: the stored passage text must equal the source text at its offsets. */
export function passageMatchesSource(p: Pick<Passage, "text" | "normalizedStart" | "normalizedEnd">, sourceText: string | undefined): boolean {
  if (sourceText == null) return false;
  if (p.normalizedEnd <= p.normalizedStart || p.normalizedEnd > sourceText.length) return false;
  return sourceText.slice(p.normalizedStart, p.normalizedEnd) === p.text;
}
