# Architecture — Fact Checker

A single Next.js 16 (App Router) TypeScript application. Streaming routes run on the Node
runtime. There is no second backend, vector database or agent framework. The product feels
agentic because the orchestrator chooses sources, follows references and compares evidence, not
because several models debate.

```
Browser ──POST /api/investigate──▶ route.ts ──▶ orchestrator ──┬─ providers (concurrent, per-provider deadlines)
   ▲          (SSE events)                                     │    rss · wikipedia · gdelt(slow) · brave? · google_fact_check?
   │                                                           ├─ document source: safe-fetch → robots → readability → cache
   │                                                           ├─ passages (exact slices + offsets)
   │                                                           ├─ provenance (hash · shingles · links · attribution)
   │                                                           ├─ local model (Ollama, serialized, schema-constrained)
   │                                                           └─ validation → overall label in code → graph
   └── /api/follow-up · /api/health · /api/cache
```

## Contracts

[`lib/contracts.ts`](lib/contracts.ts) holds the Zod schemas that are the single source of truth.
It covers the result, sources, passages, findings, graph, the event envelope (with payloads per
type), requests, and model I/O.

Model output is deliberately small: claim index, cited passage ids with a stance, one-sentence
finding, label, explanation, limitations and missing evidence. The schema is ordered *evidence →
finding → verdict*, so the label follows from the cited evidence.

The server owns URLs, dates, access states, counts, provenance and timing. Every event is
validated before it is sent.

## Pipeline ([`lib/investigation/orchestrator.ts`](lib/investigation/orchestrator.ts))

1. **Understand.**
   - Text vs URL. A URL is fetched safely; its article becomes the claim source, never corroboration.
   - A short single-sentence claim needs no model call. A few sentences are split
     deterministically.
   - Long text or an article uses one slim planning call (headline first, ≤ 6 claims). The first
     3 claims are checked; the rest are listed as deferred.
   - Relative dates are resolved against a visible reference date and timezone (Asia/Kolkata by
     default). They become shown assumptions; the claim text is never rewritten.
2. **Retrieve.**
   - Neutral queries: emotive framing is stripped, no "fake/hoax" terms, plus an entity-only query
     for context and conflicting coverage.
   - Fast providers gate the first fetch wave. Slow GDELT feeds a second wave only if it answers
     within the fetch window.
   - Leads are ranked by reciprocal-rank fusion of our title/snippet relevance and each
     provider's own rank. Domains are capped.
3. **Extract and link.**
   - Bounded concurrent fetches, robots-aware, with conditional revalidation.
   - Readability + linkedom; publication/modification dates from JSON-LD and meta tags.
   - Follows one cited reference: cited by ≥ 2 sources, or a URL naming ≥ 2 distinctive claim
     terms.
   - Provenance groups and passage selection.
4. **Compare.** One schema-constrained Ollama call for all claims, with at most one bounded
   repair for structural errors. If no passages were found, the result is deterministic
   (*unresolved*) with no model call.
5. **Validate.**
   - Referential integrity, and exact text-at-offset checks.
   - Eligibility rules (below); the overall label is derived in code.
   - Cache and run store.

Budgets live in `app.config.ts`. Quick: 30 s plus 9 s per extra claim. Deep: 50 s plus 12 s per
extra claim. A budget `AbortController` cancels unfinished work, and the run is labelled
**incomplete**; no verdict is manufactured. The route adds a hard watchdog backstop and logs runs
that overshoot.

## Passages ([`passages.ts`](lib/investigation/passages.ts))

Candidates are paragraphs plus windows of adjacent short paragraphs (≤ 700 chars). Each is an
exact slice of the normalized text, so `text === docText.slice(start, end)`.

Scoring is coverage weighted by the *rarity* of claim terms across the retrieved documents. This
keeps a shared place name from qualifying a passage. BM25 breaks ties, with a length penalty.
Round-robin across sources and a character budget (6,000 quick) bound the prompt.

Passages are flagged when they are mostly a quotation, or when they contain instructions aimed at
AI ("ignore previous instructions", fake `SYSTEM:`/tool calls, `fetch(…)`).

## Validation rules ([`validation.ts`](lib/investigation/validation.ts))

Labels are only ever **downgraded**, never upgraded or coerced to "supported". Each change is
recorded and shown.

- Unknown passage ids are rejected. A missing claim becomes *unresolved*.
- **supported** needs ≥ 1 cited supporting passage that meets all of these:
  - it is article body text from a full-text source;
  - it is not from the submitted article or its copies;
  - it is not flagged as injection.
- Even with such a passage, *supported* is downgraded when:
  - the support is only quotations and the claim is not about a statement;
  - a time-sensitive claim is backed only by Wikipedia;
  - a time-sensitive claim is backed only by articles more than 60 days old.
- **contradicted** needs an eligible contradicting passage. *Missing evidence is not
  contradiction.*
- **misleading_context** needs an eligible cited passage.
- Rule-flagged opinions and predictions become **not_fact_checkable**, with evidence kept as
  context.
- Several cited sources from one origin group add the note *"one line of evidence"*.
- URLs and references to non-existent passages are scrubbed from model prose.
- The overall label is derived in code. It is *mixed* if claims differ or any claim was left
  unchecked, and **null** unless the run is complete.

## Provenance ([`provenance.ts`](lib/investigation/provenance.ts))

| Relation | Basis | Status |
|---|---|---|
| exact duplicate | normalized-content SHA-256 | established |
| near duplicate (Jaccard ≥ 0.5 on 5-word shingles, first 1,500 words) | text similarity | possible shared origin |
| cites source | observed hyperlink between retrieved sources | established |
| shared external citation | two sources link the same document | possible shared origin |
| shared attribution / attribution names a retrieved publisher | text | possible shared origin |

Union-find builds origin groups G1…Gn. Independence is never inferred from different domains:
a source with no observed link is *unknown*, not "independent". In the graph, claim edges are
labelled model-inferred (citation validated); source edges carry their observed basis.

## Local model ([`lib/ollama.ts`](lib/ollama.ts))

- `/api/chat` with `format` set to a JSON Schema generated from Zod, and `temperature 0.1`.
- `num_ctx` is 8,192, with capped output.
- `think:false` is sent only when `/api/show` lists the `thinking` capability. qwen3:4b does;
  with a schema format it produced clean JSON in testing.
- `keep_alive` is 15 min.
- One process-wide queue serializes inference; retrieval stays concurrent.
- The AbortSignal is propagated, so Stop cancels the Ollama request.
- Model output never triggers tools: the orchestrator decides every fetch, and URLs in model
  text are removed.

## Streaming

`POST /api/investigate` returns `text/event-stream` (fetch-readable; EventSource can't POST).
Each event has the envelope `{runId, sequence, timestamp, elapsedMs, type, payload}`. Every run
ends with exactly one terminal event: `result`, `cancelled` or `error`. Request-validation
problems are plain 4xx JSON. Keep-alive comments are sent every 10 s.

Client disconnect or Stop aborts providers, page reads and Ollama. The client
([`lib/sse.ts`](lib/sse.ts), [`lib/client/run-state.ts`](lib/client/run-state.ts)) parses
incrementally across arbitrary chunk boundaries. It ignores events from stale attempts and
out-of-order sequences, and aborts on unmount.

## Network safety

[`lib/network/`](lib/network) applies these rules to every outbound internet fetch:

- Public http(s) only; no credentials; ports 80, 443, 8080 and 8443.
- Rejected destinations: loopback, private, link-local and metadata (169.254.169.254), CGNAT,
  multicast, reserved, IPv6 ULA/link-local, and IPv4-mapped forms. The WHATWG parser normalizes
  alternate encodings (`0x7f000001`, `2130706433`) first.
- **DNS rebinding:** validation runs inside undici's connect-time `lookup`, so the checked
  address *is* the connected address. Any private answer fails the connection.
- Redirects are manual (≤ 4) and every hop is revalidated.
- Body size is capped on the *decoded* stream (2.5 MB). Content types are allow-listed; PDFs are
  reported as unsupported.
- robots.txt is honoured (longest-match). Requests to the same host are spaced, and identical
  in-flight fetches are coalesced.
- The Ollama connection is a separate, configured transport, never reachable via user URLs.
- Rendering uses React escaping only (no `dangerouslySetInnerHTML`). External links are http(s)
  only, with `rel="noopener noreferrer nofollow"`.
- State-changing routes reject cross-site `Sec-Fetch-Site` and foreign `Origin`, and POST
  requires JSON. The server binds to 127.0.0.1.

## Cache ([`lib/cache.ts`](lib/cache.ts))

- One JSON file per entry, with atomic writes (temp file + rename), pruned to N newest per bucket.
- **Assessment key:** normalized input (Unicode NFC + whitespace only, so a changed date, number,
  negation or place gives a new key), mode, depth, reference date, timezone, provider set, model,
  and prompt/schema/evidence versions.
- TTL is 6 h, or 15 min for volatile claims. Reads don't extend it.
- Documents use ETag / Last-Modified revalidation, and fall back to the earlier copy with a note
  if a live re-read fails.

## Tests

| Suite | What it proves |
|---|---|
| `tests/unit/validation.test.ts` | eligibility, downgrades, quotations, injection, self-corroboration, derived overall, offset integrity |
| `tests/unit/pipeline.test.ts` | the real orchestrator over the demo corpus with a scripted model: correct attribution, syndication grouping, model-offline → partial, no evidence → no model call, provider failure isolation, injection, cancellation, mixed claims |
| `tests/unit/network.test.ts` | SSRF policy and real undici connections: rebinding, mixed answers, redirects to metadata, size cap, PDF; robots |
| `tests/unit/stream-cache-misc.test.ts` | SSE chunking, stale-run guard, cache-key sensitivity, planning, passages, provenance, feeds, demo/live labels, follow-ups |
| `tests/e2e/app.spec.ts` | Playwright against a production build with the real local model: home and keyboard, demo flow (events, verdict, inspector, map keyboard, follow-up, cache hit), stop, settings/reset, CSRF, 360 px mobile, reduced motion |
| `scripts/eval-fixtures.ts` | semantic quality against 8 human-reviewed fictional cases with the real model |
