import type { InvestigationEvent, ModelAssessment, Passage, SourceRecord } from "@/lib/contracts";
import { InvestigateRequestSchema } from "@/lib/contracts";
import { EventChannel } from "@/lib/investigation/events";
import type { ModelCheck, OrchestratorDeps } from "@/lib/investigation/orchestrator";
import { runInvestigation } from "@/lib/investigation/orchestrator";
import { demoDocumentSource, demoProvider } from "@/lib/providers/demo";
import type { Provider } from "@/lib/providers/types";

export function source(id: string, over: Partial<SourceRecord> = {}): SourceRecord {
  return {
    id,
    url: `https://example.org/${id}`,
    canonicalUrl: `https://example.org/${id}`,
    title: `Title ${id}`,
    publisher: `Publisher ${id}`,
    publishedAt: "2026-10-20T00:00:00.000Z",
    modifiedAt: null,
    fetchedAt: "2026-10-31T00:00:00.000Z",
    access: "full_text",
    accessNote: null,
    contentHash: null,
    originGroupId: null,
    provenanceStatus: "unknown",
    provider: "test",
    kind: "news_article",
    revisionId: null,
    factCheckRating: null,
    dateNotes: [],
    ...over,
  };
}

export function passage(id: string, sourceId: string, text: string, over: Partial<Passage> = {}): Passage {
  return { id, sourceId, text, normalizedStart: 0, normalizedEnd: text.length, retrievalKind: "article_body", isQuotation: false, suspectedInjection: false, ...over };
}

export function assessment(findings: Partial<ModelAssessment["findings"][number]>[]): ModelAssessment {
  return {
    findings: findings.map((f, i) => ({
      claim_index: i,
      evidence: [],
      finding: "A finding.",
      verdict: "unresolved",
      explanation: "An explanation.",
      limitations: [],
      missing_evidence: [],
      ...f,
    })),
  };
}

/** Run the real orchestrator over the bundled demo corpus with a scripted model. */
export async function runDemo(
  input: string,
  model: (prompt: string) => ModelAssessment,
  opts: { providers?: Provider[]; signal?: AbortSignal; check?: ModelCheck; onEvent?: (e: InvestigationEvent) => void } = {},
) {
  const events: InvestigationEvent[] = [];
  const prompts: string[] = [];
  const deps: OrchestratorDeps = {
    providers: opts.providers ?? [demoProvider],
    documents: demoDocumentSource,
    callAssessment: async ({ user, signal }) => {
      if (signal.aborted) throw Object.assign(new Error("Cancelled."), { code: "aborted" });
      prompts.push(user);
      return { value: model(user), ms: 5, loadMs: 0 };
    },
    callPlanner: null,
    checkModel: async () => opts.check ?? { ok: true, warm: true },
    modelName: "test-model",
    scope: "selected_sources",
    referenceDate: "2026-10-28",
    cache: null,
  };
  const ch = new EventChannel("test-run", (e) => {
    events.push(e);
    opts.onEvent?.(e);
  });
  const req = InvestigateRequestSchema.parse({ input, mode: "demo" });
  const result = await runInvestigation(req, deps, ch, opts.signal ?? new AbortController().signal);
  return { result, events, prompts };
}

/** Find the passage id whose text contains a phrase, from the prompt the model received. */
export function idFor(prompt: string, phrase: string): string {
  const blocks = prompt.split("<evidence ");
  for (const b of blocks) if (b.includes(phrase)) return b.match(/id="(P\d+)"/)![1]!;
  throw new Error(`No passage containing “${phrase}” was sent to the model.`);
}
