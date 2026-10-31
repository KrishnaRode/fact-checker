import type { Finding, Passage, SourceRecord } from "@/lib/contracts";

/**
 * Evidence strength — how much independent, readable evidence stands behind a label.
 *
 * Counted in INDEPENDENT ORIGINS, not websites: twenty sites carrying one wire story are one
 * origin. The type of evidence matters (an original/cited source or a published fact-check
 * counts more than a rewrite; Wikipedia is background), and conflicting evidence lowers it.
 * Social posts are reported as mentions but never add strength. The result is a labelled
 * level with its reasons — not a probability and not a verdict on its own.
 */
export type Strength = NonNullable<Finding["strength"]>;

export function computeStrength(f: Finding, passages: Passage[], sources: SourceRecord[], citedOriginals: Set<string>): Strength | null {
  const pById = new Map(passages.map((p) => [p.id, p]));
  const sById = new Map(sources.map((s) => [s.id, s]));
  const eligible = (ids: string[]) =>
    ids.filter((id) => {
      const p = pById.get(id);
      const s = p ? sById.get(p.sourceId) : undefined;
      return !!p && !!s && p.retrievalKind === "article_body" && s.access === "full_text" && !p.suspectedInjection && s.kind !== "user_submitted" && s.kind !== "social";
    });

  const decisive =
    f.verdict === "supported" ? eligible(f.supportingPassageIds) : f.verdict === "contradicted" ? eligible(f.contradictingPassageIds) : f.verdict === "misleading_context" ? eligible([...f.supportingPassageIds, ...f.contradictingPassageIds, ...f.contextPassageIds]) : [];
  if (!decisive.length) return null;

  const decisiveSources = [...new Set(decisive.map((id) => pById.get(id)!.sourceId))].map((id) => sById.get(id)!);
  const origins = new Set(decisiveSources.map((s) => s.originGroupId ?? `solo:${s.id}`));
  const hasPrimary = decisiveSources.some((s) => citedOriginals.has(s.id) || s.kind === "fact_check");
  const onlyBackground = decisiveSources.every((s) => s.kind === "reference");
  const opposing = f.verdict === "supported" ? eligible(f.contradictingPassageIds) : f.verdict === "contradicted" ? eligible(f.supportingPassageIds) : [];
  const quotationsOnly = decisive.every((id) => pById.get(id)!.isQuotation);
  const socialMentions = new Set(passages.filter((p) => p.retrievalKind === "social_post").map((p) => p.sourceId)).size;

  let score = Math.min(3, origins.size);
  if (hasPrimary) score += 1;
  if (onlyBackground) score -= 1;
  if (opposing.length) score -= 1;
  if (quotationsOnly) score -= 1;
  const level: Strength["level"] = score >= 3 ? "strong" : score === 2 ? "moderate" : "thin";

  const reasons: string[] = [];
  const copies = decisiveSources.length - origins.size;
  reasons.push(
    `${origins.size} independent origin${origins.size === 1 ? "" : "s"} (${decisiveSources.length} report${decisiveSources.length === 1 ? "" : "s"}${copies > 0 ? `; ${copies} cop${copies === 1 ? "y" : "ies"} of the same story counted once` : ""})`,
  );
  if (hasPrimary) {
    const names = decisiveSources.filter((s) => citedOriginals.has(s.id) || s.kind === "fact_check").map((s) => s.publisher ?? s.title);
    reasons.push(`includes an original or fact-checking source (${[...new Set(names)].join(", ")})`);
  }
  if (onlyBackground) reasons.push("only encyclopedia background, no news or official report");
  if (opposing.length) reasons.push("some readable evidence points the other way");
  if (quotationsOnly) reasons.push("rests on quoted statements");
  if (socialMentions) reasons.push(`${socialMentions} social post${socialMentions === 1 ? "" : "s"} mention it — not counted as evidence`);
  return { level, independentOrigins: origins.size, reports: decisiveSources.length, socialMentions, reasons };
}
