import { describe, expect, it } from "vitest";
import type { Finding } from "@/lib/contracts";
import { computeStrength } from "@/lib/investigation/strength";
import { validateAssessment } from "@/lib/investigation/validation";
import { hashtagsFrom } from "@/lib/providers/mastodon";
import { assessment, passage, source } from "./helpers";

const finding = (over: Partial<Finding>): Finding => ({
  id: "C1", claim: "c", verdict: "supported", headline: "h", explanation: "e", supportingPassageIds: [], contradictingPassageIds: [], contextPassageIds: [], limitations: [], missingEvidence: [], validationNotes: [], modelProposedVerdict: null, strength: null, ...over,
});

describe("evidence strength (code-derived, counted in independent origins)", () => {
  const text = "The museum will reopen on 3 November.";
  it("counts copies of one story as one origin", () => {
    const sources = [source("S1", { originGroupId: "G1" }), source("S2", { originGroupId: "G1" }), source("S3", { originGroupId: "G1" })];
    const passages = [passage("P1", "S1", text), passage("P2", "S2", text), passage("P3", "S3", text)];
    const s = computeStrength(finding({ supportingPassageIds: ["P1", "P2", "P3"] }), passages, sources, new Set())!;
    expect(s.independentOrigins).toBe(1);
    expect(s.reports).toBe(3);
    expect(s.level).toBe("thin");
    expect(s.reasons[0]).toMatch(/2 copies of the same story counted once/);
  });
  it("rates several independent outlets plus an original source as strong", () => {
    const sources = [source("S1"), source("S2"), source("S3")];
    const passages = [passage("P1", "S1", text), passage("P2", "S2", text), passage("P3", "S3", text)];
    expect(computeStrength(finding({ supportingPassageIds: ["P1", "P2"] }), passages, sources, new Set())!.level).toBe("moderate");
    expect(computeStrength(finding({ supportingPassageIds: ["P1", "P2"] }), passages, sources, new Set(["S1"]))!.level).toBe("strong");
  });
  it("lowers strength for conflicting evidence and background-only sources", () => {
    const sources = [source("S1"), source("S2"), source("S3", { kind: "reference" })];
    const passages = [passage("P1", "S1", text), passage("P2", "S2", text), passage("P3", "S3", text)];
    expect(computeStrength(finding({ supportingPassageIds: ["P1", "P2"], contradictingPassageIds: ["P3"] }), passages, sources, new Set())!.level).toBe("thin");
    expect(computeStrength(finding({ supportingPassageIds: ["P3"] }), passages, sources, new Set())!.reasons.join(" ")).toMatch(/encyclopedia background/);
  });
  it("is absent for unresolved findings and never counts social posts", () => {
    const sources = [source("S1"), source("S9", { kind: "social", access: "snippet_only" })];
    const passages = [passage("P1", "S1", text), passage("P2", "S9", "Heard the museum reopens soon!", { retrievalKind: "social_post" })];
    expect(computeStrength(finding({ verdict: "unresolved" }), passages, sources, new Set())).toBeNull();
    const s = computeStrength(finding({ supportingPassageIds: ["P1", "P2"] }), passages, sources, new Set())!;
    expect(s.independentOrigins).toBe(1);
    expect(s.socialMentions).toBe(1);
    expect(s.reasons.join(" ")).toMatch(/not counted as evidence/);
  });
});

describe("social media posts", () => {
  it("can never decide a verdict", () => {
    const ctx = {
      claims: ["The museum reopens on 3 November."],
      sources: [source("S9", { kind: "social", access: "snippet_only" })],
      passages: [passage("P1", "S9", "The museum reopens on 3 November, my friend says!", { retrievalKind: "social_post" })],
      referenceDate: "2026-10-28",
      submittedSourceId: null,
    };
    const { findings } = validateAssessment(assessment([{ verdict: "supported", evidence: [{ passage_id: "P1", stance: "supports" }] }]), ctx);
    expect(findings[0]!.verdict).toBe("unresolved");
  });
  it("builds a few clean hashtags from keywords", () => {
    expect(hashtagsFrom(["Pune", "uttar pradesh", "ED", "pune", "Azam Khan"])).toEqual(["pune", "uttarpradesh", "azamkhan"]);
  });
});
