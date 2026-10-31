# Benchmarks

**Targets are not results.** Every number below was measured on the stated date and machine with
`npm run benchmark` (real HTTP + SSE path) or `npm run eval:fixtures`. Raw JSON is in
`.data/bench/` and `.data/eval/`. Fixture (demo) latency is **not** live-provider latency.

## Conditions

| | |
|---|---|
| Date | 31 Oct 2026, 21:00–22:05 IST |
| Machine | MacBook Air, Apple M4 (10 cores), 24 GB RAM, macOS (Darwin 24.5) |
| Memory state | **Heavily loaded:** swap 10.8 → 15.8 GB used of 11–17 GB during runs; Claude desktop and Chrome open |
| Software | Node 25.9.0 · Ollama 0.24.0 · `qwen3:4b` Q4_K_M · production build (`next start`) |
| Network | Home broadband, uncontrolled. Live: feeds + Wikipedia + GDELT, no optional keys ("selected-source coverage") |
| Budget | Quick: 30 s + 9 s per extra claim |

Decode speed of `qwen3:4b` measured on this machine: **~25 tok/s** with lighter load
(early afternoon) and **~11–14 tok/s** under the swap pressure above. Assessment output is
130–350 tokens, so **local inference is the bottleneck** (≈ 90–99 % of an uncached run).

## Results

### Run A — 21:13 IST, 3 runs/claim, `--cold`

| Scenario | n | Failures | Ack median / p95 | First evidence median / p95 | Total median / p95 |
|---|---|---|---|---|---|
| Demo · uncached · warm | 9 | 1 ¹ | 23 ms / 300 ms | 23 ms / 300 ms | 17.8 s / (2,389 s ¹) |
| Demo · exact cache hit | 9 | 0 | 2 ms / 5 ms | — | **2 ms / 5 ms** |
| **Live · uncached · warm** | 6 | 0 | 25 ms / 27 ms | **1.6 s / 1.7 s** | **19.5 s / 20.1 s** |
| Live · exact cache hit | 6 | 0 | 3 ms / 4 ms | — | **3 ms / 5 ms** |
| Demo · uncached · cold model ² | 3 | 0 | 20 ms / 23 ms | 20 ms / 23 ms | 14.4 s / 14.7 s |

### Run B — 22:02 IST, 3 runs/claim, fixtures only (reproduction attempt for ¹)

| Scenario | n | Failures | Ack median / p95 | First evidence median / p95 | Total median / p95 |
|---|---|---|---|---|---|
| Demo · uncached · warm | 9 | 0 | 22 ms / 25 ms | 22 ms / 25 ms | **9.4 s / 12.4 s** |
| Demo · exact cache hit | 9 | 0 | 3 ms / 6 ms | — | 3 ms / 6 ms |

### Earlier run (25 s budget, before trimming prompt/output tokens), 21:05 IST

Live · uncached: n = 6, **2 failures** (both ended *Investigation incomplete* at the 25 s
budget), median 24.0 s. This is why the quick budget was raised to 30 s and evidence/output
caps were cut (≤ 7 passages / 6,000 chars; shorter explanations). After that, Run A had
0/6 live failures.

¹ **Unreproduced anomaly.** One request in Run A was acknowledged after 300 ms (others ~20 ms)
and returned `partial` after ~40 minutes. Swap usage rose by ~5 GB during Run A. The
orchestrator's budget timer should end any run near 30 s, so the most likely cause is a
process-wide stall under swap thrashing. A step that ignores cancellation is not ruled out.
Mitigations added afterwards:
- a hard watchdog in `/api/investigate` that ends the stream after budget + slack;
- logging of any run that overshoots its budget, with its event timeline;
- the benchmark now records the server's stated reason.

Run B (9/9) did not reproduce it and logged no overshoots. **Treat this as open** until it
holds across more runs.

² "Cold" = the model was unloaded (`keep_alive: 0`) before each run. Model load measured
~3 s (7.4 s total for a tiny prompt vs 3.8 s warm in an earlier probe). Under the swap pressure,
cold runs were not slower than Run A's warm runs, which tells you how noisy this machine was.

### Other measured paths (single runs, not statistics)

| Path | Result |
|---|---|
| Live **URL** input (BBC article; planner + assessment = 2 LLM calls) | 37–39 s total; planner ~14.5 s; first evidence 10–170 ms (the submitted article) |
| Two-claim submission (fixture) | 15–25 s; one assessment call for both claims |
| No relevant evidence (fixture) | **25 ms**, 0 LLM calls |
| Ollama offline | Partial result with sources, in under 1 s after retrieval |

## Against the targets

| Target (reference machine) | Measured | Verdict |
|---|---|---|
| UI acknowledgement ≤ 200 ms | First server event 20–27 ms median; the composer switches instantly on submit | **Met** |
| Exact cache hit ≈ 1–2 s | 2–6 ms server; e2e asserts < 3 s in the browser | **Met** |
| First useful evidence 3–5 s (healthy providers) | Live 1.6 s median / 1.7 s p95 | **Met** |
| Compact quick assessment ≈ 10–20 s (warm) | Live 19.5 s median / 20.1 s p95 (Run A); fixtures 9.4 s (B) – 17.8 s (A) median | **Borderline**: at the top of the range under memory pressure |
| Cold load, long articles, deep checks measured separately | Cold: see ²; URL/article: 37–39 s; deep: **not yet benchmarked** | Partly pending |

**Bottleneck:** local decode throughput (11–25 tok/s on this machine, depending on memory
pressure). Retrieval is 1.5–6 s live.

**Next optimizations:** stream partial findings per claim, cut planner output further, and try
`qwen3:8b` only where quality demands it (it was not installed; not measured).

## Pending measurements

- Deep investigation ("Investigate further") latency distribution.
- Runs on an unloaded machine (no swap pressure) for a clean baseline.
- `qwen3:8b` quality/latency (model not installed; nothing was downloaded without asking).
- Live runs with Brave / Google Fact Check keys (no keys available during implementation).
- Larger samples (n ≥ 30 per scenario) for meaningful p95s.

## Semantic quality (fixtures, real `qwen3:4b`)

Run with `npm run eval:fixtures` against 8 human-reviewed fictional cases:

| Final run | Within reviewed expectations | Exact match |
|---|---|---|
| 31 Oct 2026, 21:13 IST | **8 / 8** | 6 / 8 |

The non-exact cases:
- *old-event-as-current* → *Not enough evidence* (reviewer: *Misleading context*).
- *mixed-claims* → claim 2 *Not enough evidence* (reviewer: *Contradicted*).

During benchmarking, *prompt-injection* varied between *Contradicted* and *Not enough evidence*,
both acceptable. It was never *Supported*.

These are 8 cases, so small-sample quality signals, not accuracy claims.
