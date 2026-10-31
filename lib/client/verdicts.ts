import type { InvestigationResult, Overall, Verdict } from "@/lib/contracts";

export type Tone = "supported" | "contradicted" | "unresolved" | "neutral" | "pending";
export type IconName = "check" | "cross" | "context" | "question" | "minus" | "incomplete" | "stop";

export type VerdictView = { label: string; tone: Tone; icon: IconName; meaning: string };

export const VERDICT_VIEW: Record<Verdict | "mixed", VerdictView> = {
  supported: { label: "Supported by the evidence", tone: "supported", icon: "check", meaning: "Readable evidence directly supports the claim as stated — at the time checked, within the sources searched." },
  contradicted: { label: "Contradicted by the evidence", tone: "contradicted", icon: "cross", meaning: "Readable evidence directly contradicts the claim as stated." },
  misleading_context: { label: "Misleading / missing context", tone: "unresolved", icon: "context", meaning: "Something real is involved, but the claim misplaces its time, place or scope, or leaves out context that changes its meaning." },
  unresolved: { label: "Not enough evidence", tone: "unresolved", icon: "question", meaning: "The sources searched do not settle it. Not finding evidence is not evidence that a claim is false." },
  not_fact_checkable: { label: "Not fact-checkable", tone: "neutral", icon: "minus", meaning: "An opinion, value judgement or prediction that evidence cannot settle yet." },
  mixed: { label: "Mixed findings", tone: "unresolved", icon: "context", meaning: "The statements in this submission received different findings, or some were not checked. Read each one." },
};

export function overallView(result: InvestigationResult): VerdictView {
  if (result.status === "cancelled") return { label: "Investigation stopped", tone: "neutral", icon: "stop", meaning: "You stopped this investigation. Nothing was concluded." };
  if (result.status !== "complete" || result.overall == null) {
    return { label: "Investigation incomplete", tone: "neutral", icon: "incomplete", meaning: "The run did not finish its assessment, so no verdict is shown. This says nothing about whether the claim is true." };
  }
  return VERDICT_VIEW[result.overall as NonNullable<Overall>];
}
