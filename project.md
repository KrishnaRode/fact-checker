# Project definition — Fact Checker

| Field | Value |
|---|---|
| Product | **Fact Checker** |
| Hero | Before you believe it. |
| Supporting line | Bring a claim. Follow the evidence. |
| Primary action | Investigate |
| Owner | Krishna Rode |
| Series | The Sunday Builds — *Free AI. Real Problems. Every Sunday.* |
| Build number | *unset until confirmed* |
| Repository | https://github.com/KrishnaRode/fact-checker |
| Default model | `qwen3:4b` (quality option `qwen3:8b`) via Ollama |
| Port | 3016 (loopback) |

All of the above lives in one place: [`app.config.ts`](app.config.ts). It also holds budgets,
feeds and cache policy. `run.sh` reads the model and port from it.

## Problem

Alarming headlines and forwards spread faster than anyone can check them. People need a quick,
understandable investigation: what the evidence supports, contradicts or leaves open. A
confident paragraph from a chatbot does not meet that need.

## Input → output

- **Input:** a claim, a forward, or a public news article URL (≤ 12,000 chars).
- **Processing:** `POST /api/investigate`. Streams typed events: understand → retrieve → extract
  and link → compare (local model) → validate.
- **Output:** an `InvestigationResult` ([`lib/contracts.ts`](lib/contracts.ts)) containing:
  - a code-derived overall label;
  - per-claim findings citing passage ids;
  - sources with dates and access state;
  - provenance groups;
  - an evidence graph;
  - coverage and timing.

## Scope shipped

Everything in the "ship this first" list: text and URL input, ≤ 3 claims with deferral, real
retrieval with independent failures, passages with offsets, provenance and syndication grouping,
local assessment, streaming activity, map and inspector, verdict signal, follow-ups, stop, retry,
refresh, deeper investigation, cache and reset, demo fixtures, benchmark, and the launcher.

Deferred, with no UI controls: deepfake/image analysis, call capture, social ingestion, accounts,
billing, teams, graph databases, internet-scale crawling, Marathi/Hindi.
