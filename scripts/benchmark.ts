/**
 * Latency benchmark through the real HTTP + SSE path of a running Fact Checker server.
 *
 *   npm run benchmark -- --base http://127.0.0.1:3016 --runs 3
 *   npm run benchmark -- --base http://127.0.0.1:3016 --runs 3 --cold   (adds cold-model runs)
 *   npm run benchmark -- --skip-live                                      (fixtures only)
 *
 * Records, per scenario: sample count, median and p95 of acknowledgement (first event),
 * first evidence and total time, failure rate, and machine/model conditions.
 * Fixture (demo) latency is NOT live-provider latency; both are reported separately.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SSEParser } from "@/lib/sse";

type Sample = { ackMs: number; firstEvidenceMs: number | null; totalMs: number; status: string; overall: string | null; llmCalls: number; inferenceMs: number; origin: string };

const args = process.argv.slice(2);
const arg = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : def;
};
const BASE = arg("base", "http://127.0.0.1:3016");
const RUNS = Number(arg("runs", "3"));
const COLD = args.includes("--cold");
const SKIP_LIVE = args.includes("--skip-live");
const OLLAMA = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";

const DEMO_CLAIMS = [
  "BREAKING: The Riverbend Museum has shut down permanently from today! Share before they delete this!!",
  "The Riverbend Museum reopens on Tuesday 3 November at 10 am.",
  "Kestrel Bay's tap water had dangerous lead levels last week.",
];
// Checked against accessible sources on 31 Oct 2026; used only for timing, not as ground truth.
const LIVE_CLAIMS = [
  "Prime Minister Andy Burnham has agreed to pay financial reparations for the UK's role in the slave trade.",
  "North Korean hackers are the main suspects in a major hack of the Binance crypto exchange.",
];

async function investigate(input: string, mode: "live" | "demo", refresh: boolean): Promise<Sample> {
  const t0 = performance.now();
  let ack: number | null = null;
  let first: number | null = null;
  type R = { statusReason: string | null; status: string; overall: string | null; origin: string; timing: { llmCalls: number; inferenceMs: number } };
  const holder: { result: R | null } = { result: null };
  const res = await fetch(`${BASE}/api/investigate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input, mode, refresh }) });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const parser = new SSEParser((data) => {
    const e = JSON.parse(data) as { type: string; payload: { result?: R } };
    const now = performance.now() - t0;
    ack ??= now;
    if (first == null && (e.type === "source_fetched" || e.type === "passage_selected")) first = now;
    if (e.type === "result") holder.result = e.payload.result!;
  });
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parser.push(value);
  }
  parser.end();
  const r = holder.result;
  return {
    ackMs: ack ?? NaN,
    firstEvidenceMs: first,
    totalMs: performance.now() - t0,
    status: r?.status === "complete" ? "complete" : `${r?.status ?? "no_result"}${r?.statusReason ? ` (${r.statusReason})` : ""}`,
    overall: r?.overall ?? null,
    llmCalls: r?.timing.llmCalls ?? 0,
    inferenceMs: r?.timing.inferenceMs ?? 0,
    origin: r?.origin ?? "",
  };
}

const pct = (xs: number[], p: number) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return NaN;
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
};
const fmt = (ms: number) => (Number.isFinite(ms) ? (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`) : "—");

function summarize(name: string, samples: Sample[]) {
  const fe = samples.map((s) => s.firstEvidenceMs ?? NaN);
  return {
    scenario: name,
    n: samples.length,
    failures: samples.filter((s) => s.status !== "complete").length,
    ackMedian: pct(samples.map((s) => s.ackMs), 50),
    ackP95: pct(samples.map((s) => s.ackMs), 95),
    firstEvidenceMedian: pct(fe, 50),
    firstEvidenceP95: pct(fe, 95),
    totalMedian: pct(samples.map((s) => s.totalMs), 50),
    totalP95: pct(samples.map((s) => s.totalMs), 95),
    inferenceMedian: pct(samples.map((s) => s.inferenceMs), 50),
    statuses: samples.map((s) => `${s.status}/${s.overall ?? "-"}`),
  };
}

async function unloadModel(model: string) {
  await fetch(`${OLLAMA}/api/generate`, { method: "POST", body: JSON.stringify({ model, keep_alive: 0 }) }).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 1_500));
}

async function main() {
  const health = (await (await fetch(`${BASE}/api/health`)).json()) as { ollama: { model: string; version: string | null; reachable: boolean }; scope: string };
  if (!health.ollama.reachable) throw new Error("Ollama is not reachable from the server; start it first.");
  const conditions = {
    at: new Date().toISOString(),
    base: BASE,
    machine: { platform: `${os.type()} ${os.release()} ${os.arch()}`, cpu: os.cpus()[0]?.model, cores: os.cpus().length, memoryGb: Math.round(os.totalmem() / 1024 ** 3) },
    node: process.version,
    ollama: health.ollama.version,
    model: health.ollama.model,
    coverage: health.scope,
    network: "home broadband (not controlled); live providers as reachable at run time",
    runsPerClaim: RUNS,
  };
  console.log("Conditions:", JSON.stringify(conditions));
  const scenarios: ReturnType<typeof summarize>[] = [];
  const run = async (name: string, claims: string[], mode: "live" | "demo", refresh: boolean, before?: () => Promise<void>) => {
    const samples: Sample[] = [];
    for (let r = 0; r < RUNS; r++) {
      for (const c of claims) {
        if (before) await before();
        try {
          const s = await investigate(c, mode, refresh);
          samples.push(s);
          console.log(`  ${name.padEnd(28)} ${fmt(s.totalMs).padStart(7)}  ack ${fmt(s.ackMs)}  first evidence ${fmt(s.firstEvidenceMs ?? NaN)}  ${s.status}/${s.overall}  ${s.origin}`);
        } catch (err) {
          samples.push({ ackMs: NaN, firstEvidenceMs: null, totalMs: NaN, status: `error:${(err as Error).message}`, overall: null, llmCalls: 0, inferenceMs: 0, origin: "" });
        }
      }
    }
    scenarios.push(summarize(name, samples));
  };

  // Warm the model once so "warm" scenarios are really warm.
  await investigate(DEMO_CLAIMS[1]!, "demo", true).catch(() => undefined);
  await run("demo · uncached · warm", DEMO_CLAIMS, "demo", true);
  await run("demo · exact cache hit", DEMO_CLAIMS, "demo", false);
  if (!SKIP_LIVE) {
    await run("live · uncached · warm", LIVE_CLAIMS, "live", true);
    await run("live · exact cache hit", LIVE_CLAIMS, "live", false);
  }
  if (COLD) await run("demo · uncached · COLD model", [DEMO_CLAIMS[0]!], "demo", true, () => unloadModel(health.ollama.model));

  console.log("\n| Scenario | n | Failures | Ack median / p95 | First evidence median / p95 | Total median / p95 | Inference median |");
  console.log("|---|---|---|---|---|---|---|");
  for (const s of scenarios) {
    console.log(`| ${s.scenario} | ${s.n} | ${s.failures} | ${fmt(s.ackMedian)} / ${fmt(s.ackP95)} | ${fmt(s.firstEvidenceMedian)} / ${fmt(s.firstEvidenceP95)} | ${fmt(s.totalMedian)} / ${fmt(s.totalP95)} | ${fmt(s.inferenceMedian)} |`);
  }
  const dir = path.join(process.cwd(), ".data", "bench");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `bench-${conditions.at.replace(/[:.]/g, "-")}.json`);
  await fs.writeFile(file, JSON.stringify({ conditions, scenarios }, null, 2));
  console.log(`\nSaved ${path.relative(process.cwd(), file)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
