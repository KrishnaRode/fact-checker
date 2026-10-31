import type { FollowUpResponse, InvestigationResult, ModelFollowUp } from "@/lib/contracts";
import { FOLLOWUP_SYSTEM, dataBlock } from "@/lib/prompts";
import { buildEvidenceBundle } from "./assessment";
import { scrubModelText } from "./validation";

/**
 * Follow-up questions are answered only from the run's validated passages. Questions asking
 * for newer facts are routed to a new bounded investigation instead of reusing old evidence.
 */
const UPDATE_RE = /\b(latest|now|currently|today|update[ds]?|still|right now|any news|what happened next|has it|is it still|newest|recent)\b/i;

export type FollowUpCaller = (system: string, user: string) => Promise<{ value: ModelFollowUp; ms: number }>;

export async function answerFollowUp(run: InvestigationResult, question: string, call: FollowUpCaller | null): Promise<FollowUpResponse> {
  const base = { runId: run.id, mode: run.mode, citedPassageIds: [] as string[], suggestedClaim: null as string | null, notes: [] as string[], inferenceMs: 0 };
  if (UPDATE_RE.test(question)) {
    return {
      ...base,
      kind: "needs_new_investigation",
      answer: `This asks for current information. The evidence in this investigation was retrieved for an assessment made at ${new Date(run.assessedAt).toLocaleString("en-IN", { timeZone: run.referenceTimezone })}, so it should not be treated as an update. Start a new investigation to search again.`,
      suggestedClaim: question.trim(),
    };
  }
  if (!run.passages.length) {
    return { ...base, kind: "unavailable", answer: "This investigation has no evidence passages to answer from. Try a new investigation with more detail." };
  }
  if (!call) {
    return { ...base, kind: "unavailable", answer: "Ollama is not running, so follow-up questions cannot be answered right now. Start Ollama and retry." };
  }
  const passages = new Map(run.passages.map((p) => [p.id, p]));
  const findings = run.findings.map((f) => `- ${f.claim} → ${f.verdict}: ${f.headline}`).join("\n");
  const user = [
    dataBlock("submission", { note: "the text the user originally submitted for checking" }, run.originalInput.slice(0, 3_000)),
    `Investigation findings (validated):\n${findings || "(no findings)"}`,
    `Evidence passages:\n${buildEvidenceBundle(run.passages, run.sources, run.sources.find((s) => s.kind === "user_submitted")?.id ?? null)}`,
    dataBlock("question", {}, question),
  ].join("\n\n");
  const out = await call(FOLLOWUP_SYSTEM, user);
  const cited = [...new Set(out.value.cited_passage_ids)].filter((id) => passages.has(id));
  const rejected = out.value.cited_passage_ids.filter((id) => !passages.has(id));
  const notes = rejected.length ? [`Removed citations to passages that do not exist: ${rejected.join(", ")}.`] : [];
  const proposed = out.value.new_claim.trim();
  if (out.value.kind === "new_claim" && proposed.split(/\s+/).length >= 4 && !/\b(not defined|evidence|passage|question|forward)\b/i.test(proposed)) {
    return {
      ...base,
      kind: "needs_new_investigation",
      answer: scrubModelText(out.value.answer || "That question introduces a claim this evidence does not cover. Start a new investigation for it.", passages),
      suggestedClaim: proposed,
      notes,
      inferenceMs: out.ms,
    };
  }
  if (!cited.length) notes.push("The answer does not cite a specific passage; treat it as a reading aid, not a finding.");
  return { ...base, kind: "answer", answer: scrubModelText(out.value.answer, passages), citedPassageIds: cited, notes, inferenceMs: out.ms };
}
