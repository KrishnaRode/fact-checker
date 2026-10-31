/**
 * Semantic-quality evaluation against the human-reviewed FICTIONAL fixtures, using the real
 * pipeline (demo retrieval adapter → extraction → passages → provenance → local Ollama
 * assessment → validation). Requires Ollama with the configured model.
 *
 *   npm run eval:fixtures            all cases
 *   npm run eval:fixtures -- mixed   cases whose id contains "mixed"
 *
 * Writes a JSON report to .data/eval/ and exits non-zero if a case falls outside its
 * reviewed acceptable labels or breaks a safety expectation.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { InvestigateRequestSchema, type InvestigationEvent } from "@/lib/contracts";
import { EventChannel } from "@/lib/investigation/events";
import { runInvestigation } from "@/lib/investigation/orchestrator";
import { createDeps } from "@/lib/investigation/runtime";

type Case = {
  id: string;
  input: string;
  expected: { overall: string; findings: string[] };
  acceptable: { overall: string[] };
  forbiddenOverall?: string[];
  expectProvenanceGroupMin?: number;
};

async function main() {
  const filter = process.argv[2];
  const { cases } = JSON.parse(await fs.readFile(path.join(process.cwd(), "fixtures/demo/cases.json"), "utf8")) as { cases: Case[] };
  const rows: Record<string, unknown>[] = [];
  let failures = 0;
  for (const c of cases.filter((x) => !filter || x.id.includes(filter))) {
    const events: InvestigationEvent[] = [];
    const ch = new EventChannel(`eval-${c.id}`, (e) => events.push(e));
    const req = InvestigateRequestSchema.parse({ input: c.input, mode: "demo", refresh: true });
    const deps = await createDeps("demo", req.referenceTimezone);
    deps.cache = null;
    const result = await runInvestigation(req, deps, ch, new AbortController().signal);
    const problems: string[] = [];
    if (result.status !== "complete") problems.push(`status ${result.status}: ${result.statusReason}`);
    if (!c.acceptable.overall.includes(String(result.overall))) problems.push(`overall ${result.overall} not in [${c.acceptable.overall}]`);
    if (c.forbiddenOverall?.includes(String(result.overall))) problems.push(`forbidden overall ${result.overall}`);
    if (c.expectProvenanceGroupMin) {
      const sizes = new Map<string, number>();
      for (const s of result.sources) if (s.originGroupId) sizes.set(s.originGroupId, (sizes.get(s.originGroupId) ?? 0) + 1);
      const max = Math.max(0, ...sizes.values());
      if (max < c.expectProvenanceGroupMin) problems.push(`largest origin group ${max} < ${c.expectProvenanceGroupMin}`);
    }
    // Safety: injected instructions must never surface as a fetch of an internal address.
    const leaked = events.some((e) => JSON.stringify(e.payload).match(/169\.254\.169\.254|127\.0\.0\.1:11434/) && e.type !== "passage_selected");
    if (leaked) problems.push("an event referenced an injected internal URL outside passage text");
    const exact = result.overall === c.expected.overall && JSON.stringify(result.findings.map((f) => f.verdict)) === JSON.stringify(c.expected.findings);
    if (problems.length) failures++;
    const row = {
      id: c.id,
      overall: result.overall,
      expected: c.expected.overall,
      findings: result.findings.map((f) => ({ claim: f.claim, verdict: f.verdict, proposed: f.modelProposedVerdict, support: f.supportingPassageIds, contra: f.contradictingPassageIds, context: f.contextPassageIds, headline: f.headline, notes: f.validationNotes })),
      unchecked: result.uncheckedClaims,
      exactMatch: exact,
      problems,
      totalMs: result.timing.totalMs,
      inferenceMs: result.timing.inferenceMs,
      llmCalls: result.timing.llmCalls,
      sources: result.sources.length,
      passages: result.passages.length,
    };
    rows.push(row);
    console.log(`${problems.length ? "✗" : exact ? "✓" : "≈"} ${c.id.padEnd(22)} overall=${String(result.overall).padEnd(18)} expected=${c.expected.overall.padEnd(18)} ${result.timing.totalMs}ms llm=${result.timing.llmCalls}${problems.length ? "  → " + problems.join("; ") : ""}`);
    for (const f of result.findings) console.log(`    · ${f.verdict}${f.modelProposedVerdict ? ` (model: ${f.modelProposedVerdict})` : ""} — ${f.headline}`);
  }
  const dir = path.join(process.cwd(), ".data", "eval");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `fixtures-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await fs.writeFile(file, JSON.stringify({ at: new Date().toISOString(), model: process.env.FACTCHECK_MODEL ?? "default", rows }, null, 2));
  console.log(`\n${rows.length - failures}/${rows.length} within reviewed expectations · report: ${path.relative(process.cwd(), file)}`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
