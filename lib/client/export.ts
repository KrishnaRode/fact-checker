import type { InvestigationResult } from "@/lib/contracts";
import { overallView, VERDICT_VIEW } from "./verdicts";

/**
 * Exports carry timestamps, live/demo label, sources, findings and limitations. Only the
 * short evidence passages are included — never full article bodies — and no secrets exist
 * client-side to leak.
 */
export function toExportJson(r: InvestigationResult): string {
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      product: "Fact Checker (The Sunday Builds)",
      label: r.mode === "demo" ? "DEMO — fictional bundled evidence" : "LIVE — retrieved from the internet",
      note: "An evidence assessment as of the time checked, not a certification of truth.",
      ...r,
    },
    null,
    2,
  );
}

export function toMarkdown(r: InvestigationResult): string {
  const v = overallView(r);
  const src = new Map(r.sources.map((s) => [s.id, s]));
  const pass = new Map(r.passages.map((p) => [p.id, p]));
  const lines: string[] = [];
  lines.push(`# Fact Checker assessment`, "");
  lines.push(`> ${r.mode === "demo" ? "**DEMO** — fictional bundled evidence, not real events." : "**LIVE** — sources retrieved from the internet."} An assessment as of the time checked, not a certification of truth.`, "");
  lines.push(`- **Result:** ${v.label}`);
  lines.push(`- **Checked at:** ${r.assessedAt} (${r.origin === "cached_run" ? "cached result" : "fresh run"})`);
  lines.push(`- **Reference date:** ${r.referenceDate} (${r.referenceTimezone})`);
  lines.push(`- **Status:** ${r.status}${r.statusReason ? ` — ${r.statusReason}` : ""}`);
  lines.push(`- **Coverage:** ${r.coverage.scope === "broader_web" ? "Broader web search enabled" : "Selected-source coverage"}; providers answered: ${r.coverage.providersSucceeded.join(", ") || "none"}`);
  if (r.model) lines.push(`- **Local model:** ${r.model}`);
  lines.push("", `## Submission`, "", ...r.originalInput.split("\n").map((l) => `> ${l}`), "", `## Summary`, "", r.summary, "");
  for (const f of r.findings) {
    lines.push(`## ${f.id}: ${VERDICT_VIEW[f.verdict].label}`, "", `**Claim:** ${f.claim}`, "", f.headline, "", f.explanation, "");
    if (f.strength) lines.push(`**Evidence strength:** ${f.strength.level} — ${f.strength.reasons.join("; ")}`, "");
    const cite = (ids: string[], title: string) => {
      if (!ids.length) return;
      lines.push(`**${title}**`, "");
      for (const id of ids) {
        const p = pass.get(id);
        const s = p ? src.get(p.sourceId) : undefined;
        if (!p || !s) continue;
        lines.push(`- [${id}] “${p.text.length > 400 ? p.text.slice(0, 400) + "…" : p.text}” — ${s.publisher ?? s.title}, ${s.publishedAt?.slice(0, 10) ?? "date unknown"} (${s.url})`);
      }
      lines.push("");
    };
    cite(f.supportingPassageIds, "Supporting evidence");
    cite(f.contradictingPassageIds, "Conflicting evidence");
    cite(f.contextPassageIds, "Context");
    if (f.missingEvidence.length) lines.push(`**Missing evidence:** ${f.missingEvidence.join("; ")}`, "");
    if (f.limitations.length) lines.push(`**Limitations:** ${f.limitations.join("; ")}`, "");
    if (f.validationNotes.length) lines.push(`**Validation notes:** ${f.validationNotes.join("; ")}`, "");
  }
  if (r.uncheckedClaims.length) lines.push(`## Not checked`, "", ...r.uncheckedClaims.map((c) => `- ${c}`), "");
  lines.push(`## Sources`, "");
  for (const s of r.sources) {
    lines.push(`- ${s.id}: ${s.title} — ${s.publisher ?? "unknown publisher"}; published ${s.publishedAt?.slice(0, 10) ?? "unknown"}; read ${s.fetchedAt}; access: ${s.access}${s.originGroupId ? `; origin group ${s.originGroupId} (${s.provenanceStatus})` : ""}. ${s.url}`);
  }
  if (r.coverage.warnings.length) lines.push("", `## Coverage warnings`, "", ...r.coverage.warnings.map((w) => `- ${w}`));
  return lines.join("\n") + "\n";
}

export function download(filename: string, content: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
