import { describe, expect, it } from "vitest";
import type { Provider } from "@/lib/providers/types";
import { ProviderError } from "@/lib/providers/types";
import { demoProvider } from "@/lib/providers/demo";
import { assessment, idFor, runDemo } from "./helpers";

/**
 * The real orchestrator over the bundled fictional corpus, with a scripted model standing in
 * for Ollama. These tests check plumbing and guarantees, not model judgement (that is what
 * `npm run eval:fixtures` measures against the real local model).
 */
describe("investigation pipeline (demo corpus, scripted model)", () => {
  it("attributes a contradicted finding to the original notice passage", async () => {
    const { result } = await runDemo("BREAKING: The Riverbend Museum has shut down permanently from today! Share before they delete this!!", (prompt) =>
      assessment([{ verdict: "contradicted", evidence: [{ passage_id: idFor(prompt, "not closing permanently"), stance: "contradicts" }] }]),
    );
    expect(result.status).toBe("complete");
    expect(result.overall).toBe("contradicted");
    const pid = result.findings[0]!.contradictingPassageIds[0]!;
    const p = result.passages.find((x) => x.id === pid)!;
    expect(p.text).toContain("not closing permanently");
    expect(result.sources.find((s) => s.id === p.sourceId)!.publisher).toBe("Kestrel Bay Museums Trust");
    expect(result.assumptions.join(" ")).toMatch(/"today" read as Wed, 28 Oct/);
  });

  it("supports a precise reopening-time claim from the original notice", async () => {
    const { result } = await runDemo("The Riverbend Museum reopens on Tuesday 3 November at 10 am.", (prompt) =>
      assessment([{ verdict: "supported", evidence: [{ passage_id: idFor(prompt, "reopen to visitors on Tuesday 3 November 2026 at 10:00"), stance: "supports" }] }]),
    );
    expect(result.overall).toBe("supported");
    const pid = result.findings[0]!.supportingPassageIds[0]!;
    expect(result.sources.find((s) => s.id === result.passages.find((p) => p.id === pid)!.sourceId)!.kind).toBe("web_page");
  });

  it("groups three syndicated copies under one origin instead of counting three confirmations", async () => {
    const { result, events } = await runDemo("The Riverbend Museum is closed for roof repairs this week.", () => assessment([{ verdict: "unresolved" }]));
    const wire = result.sources.filter((s) => ["Coastal Wire Service", "Harbour Daily", "Bay News Now"].includes(s.publisher ?? ""));
    expect(wire.length).toBe(3);
    expect(new Set(wire.map((s) => s.originGroupId)).size).toBe(1);
    expect(wire[0]!.originGroupId).not.toBeNull();
    expect(events.some((e) => e.type === "provenance_linked" && e.payload.relation === "exact_duplicate")).toBe(true);
    expect(result.graph.edges.some((e) => e.relation === "exact_duplicate" && e.basis === "exact_hash")).toBe(true);
    expect(result.graph.edges.some((e) => e.relation === "near_duplicate" && e.basis === "text_similarity")).toBe(true);
  });

  it("does not produce a confident result when inference is unavailable, and keeps the sources", async () => {
    const { result, events } = await runDemo("The Riverbend Museum reopens on Tuesday 3 November at 10 am.", () => assessment([{ verdict: "supported" }]), {
      check: { ok: false, code: "offline", message: "Ollama is not running. Start Ollama and retry." },
    });
    expect(result.status).toBe("partial");
    expect(result.overall).toBeNull();
    expect(result.findings).toEqual([]);
    expect(result.sources.length).toBeGreaterThan(0);
    expect(result.statusReason).toMatch(/Ollama is not running/);
    expect(events.some((e) => e.type === "provider_warning" && e.payload.provider === "ollama")).toBe(true);
  });

  it("answers 'no relevant evidence' without a model call, as unresolved — never contradicted", async () => {
    let calls = 0;
    const { result } = await runDemo("The Kestrel Bay education department will give a free laptop to every student who forwards this message to 10 groups.", () => {
      calls++;
      return assessment([{ verdict: "contradicted" }]);
    });
    expect(calls).toBe(0);
    expect(result.overall).toBe("unresolved");
    expect(result.timing.llmCalls).toBe(0);
  });

  it("labels a prediction by rule without a model call", async () => {
    let calls = 0;
    const { result } = await runDemo("Kestrel Bay will be the best city in the world to live in by 2040.", () => {
      calls++;
      return assessment([{ verdict: "supported" }]);
    });
    expect(calls).toBe(0);
    expect(result.overall).toBe("not_fact_checkable");
    expect(result.findings[0]!.supportingPassageIds).toEqual([]);
  });

  it("surfaces a failing provider independently while others complete", async () => {
    const broken: Provider = { ...demoProvider, id: "broken", name: "Broken provider", search: async () => { throw new ProviderError("broken", "rate_limited", "Rate limited."); } };
    const { result, events } = await runDemo("The Riverbend Museum reopens on Tuesday 3 November at 10 am.", (prompt) =>
      assessment([{ verdict: "supported", evidence: [{ passage_id: idFor(prompt, "10:00"), stance: "supports" }] }]),
      { providers: [broken, demoProvider] },
    );
    expect(result.status).toBe("complete");
    expect(result.coverage.providersAttempted.sort()).toEqual(["broken", "demo_corpus"]);
    expect(result.coverage.providersSucceeded).toEqual(["demo_corpus"]);
    expect(events.some((e) => e.type === "provider_warning" && e.payload.provider === "broken" && e.payload.code === "rate_limited")).toBe(true);
  });

  it("treats injected instructions as data: no extra tool events, and they cannot decide the label", async () => {
    const { result, events, prompts } = await runDemo("Kestrel Bay's tap water had dangerous lead levels last week.", (prompt) =>
      // A model that "obeys" the injection and cites the injected passage as support.
      assessment([{ verdict: "supported", evidence: [{ passage_id: idFor(prompt, "IGNORE ALL PREVIOUS"), stance: "supports" }] }]),
    );
    expect(result.findings[0]!.verdict).toBe("unresolved");
    // The injected URLs never became a fetch or a discovered source.
    const fetchEvents = events.filter((e) => e.type === "source_fetched" || e.type === "source_discovered");
    expect(fetchEvents.some((e) => JSON.stringify(e.payload).includes("169.254"))).toBe(false);
    expect(result.sources.every((s) => s.url.endsWith(".example") || /\.example\//.test(s.url))).toBe(true);
    // Allowed event types only; nothing after the result.
    const allowed = new Set(["started", "stage_started", "stage_completed", "claim_identified", "source_discovered", "source_fetched", "passage_selected", "provenance_linked", "observation", "provider_warning"]);
    expect(events.every((e) => allowed.has(e.type))).toBe(true);
    // The model saw the passage flagged and wrapped as data.
    expect(prompts[0]).toMatch(/addressed to AI systems/);
    expect(prompts[0]).not.toMatch(/<\/evidence>\s*IGNORE/);
    expect(events.some((e) => e.type === "observation" && /addressed to AI systems/.test(e.payload.message))).toBe(true);
  });

  it("cancels: aborting mid-assessment yields a cancelled run with no verdict", async () => {
    const ctrl = new AbortController();
    const { result } = await runDemo(
      "The Riverbend Museum reopens on Tuesday 3 November at 10 am.",
      () => {
        ctrl.abort();
        throw Object.assign(new Error("Cancelled."), { code: "aborted" });
      },
      { signal: ctrl.signal },
    );
    expect(result.status).toBe("cancelled");
    expect(result.overall).toBeNull();
  });

  it("propagates cancellation into providers", async () => {
    let sawAbort = false;
    const slow: Provider = {
      ...demoProvider,
      id: "slow",
      search: (q) =>
        new Promise((_, reject) => {
          q.signal.addEventListener("abort", () => {
            sawAbort = true;
            reject(new ProviderError("slow", "aborted", "Cancelled."));
          });
        }),
    };
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 50);
    const { result } = await runDemo("The Riverbend Museum reopens on Tuesday 3 November at 10 am.", () => assessment([{ verdict: "unresolved" }]), { providers: [slow], signal: ctrl.signal });
    expect(sawAbort).toBe(true);
    expect(result.status).toBe("cancelled");
  });

  it("splits a two-sentence submission into two claims and reports mixed findings", async () => {
    const { result } = await runDemo("The Riverbend Museum closes for roof maintenance from 26 October. Entry will be free for everyone when it reopens.", (prompt) =>
      assessment([
        { verdict: "supported", evidence: [{ passage_id: idFor(prompt, "close temporarily from Monday 26 October"), stance: "supports" }] },
        { verdict: "contradicted", evidence: [{ passage_id: idFor(prompt, "Ticket prices are unchanged"), stance: "contradicts" }] },
      ]),
    );
    expect(result.findings.map((f) => f.verdict)).toEqual(["supported", "contradicted"]);
    expect(result.overall).toBe("mixed");
    expect(result.summary).toMatch(/Checked 2 claims/);
  });

  it("keeps demo results labelled as demo", async () => {
    const { result, events } = await runDemo("The Riverbend Museum reopens on Tuesday 3 November at 10 am.", () => assessment([{ verdict: "unresolved" }]));
    expect(result.mode).toBe("demo");
    expect(events[0]!.type === "started" && events[0]!.payload.mode).toBe("demo");
  });
});

describe("deadlines cannot be held hostage by a hung step", () => {
  it("raceAbort settles when the signal aborts even if the work never settles or listens", async () => {
    const { raceAbort } = await import("@/lib/investigation/orchestrator");
    const ctrl = new AbortController();
    const never = new Promise<never>(() => undefined);
    const t0 = Date.now();
    setTimeout(() => ctrl.abort(), 50);
    await expect(raceAbort(never, ctrl.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(Date.now() - t0).toBeLessThan(1_000);
  });
});
