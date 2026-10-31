import { randomUUID } from "node:crypto";
import { InvestigateRequestSchema, type InvestigationEvent } from "@/lib/contracts";
import { json, rejectCrossOrigin } from "@/lib/http";
import { EventChannel, encodeSSE } from "@/lib/investigation/events";
import { runInvestigation } from "@/lib/investigation/orchestrator";
import { createDeps } from "@/lib/investigation/runtime";
import { budgets } from "@/app.config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/investigate → text/event-stream of typed InvestigationEvents.
 * Request-validation problems are plain HTTP errors (4xx JSON). Once streaming starts, the
 * run always ends with exactly one terminal event: `result` (complete/partial/failed) or
 * `cancelled`. Client disconnects abort all work: providers, page reads and Ollama.
 */
export async function POST(req: Request): Promise<Response> {
  const blocked = rejectCrossOrigin(req);
  if (blocked) return blocked;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ code: "bad_request", message: "The request body is not valid JSON." }, 400);
  }
  const parsed = InvestigateRequestSchema.safeParse(body);
  if (!parsed.success) {
    return json({ code: "invalid_input", message: parsed.error.issues[0]?.message ?? "Invalid request." }, 400);
  }
  const request = parsed.data;
  try {
    new Intl.DateTimeFormat("en", { timeZone: request.referenceTimezone });
  } catch {
    return json({ code: "invalid_timezone", message: "Unknown time zone." }, 400);
  }

  const runId = randomUUID().slice(0, 12);
  const abort = new AbortController();
  req.signal.addEventListener("abort", () => abort.abort(), { once: true });
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const write = (e: InvestigationEvent) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(encodeSSE(e)));
        } catch {
          open = false;
        }
      };
      const ch = new EventChannel(runId, write);
      const keepAlive = setInterval(() => {
        if (open) {
          try {
            controller.enqueue(encoder.encode(": keep-alive\n\n"));
          } catch {
            open = false;
          }
        }
      }, 10_000);
      // Hard watchdog: the orchestrator enforces its own budget; this is the backstop that
      // guarantees the stream ends even if a step ignores cancellation.
      const b = budgets[request.depth];
      const hardLimitMs = b.totalMs + b.perExtraClaimMs * 2 + 20_000;
      let watchdogFired = false;
      const watchdog = setTimeout(() => {
        watchdogFired = true;
        console.error(`[fact-checker] run ${runId} exceeded ${hardLimitMs} ms; last event: ${ch.log.at(-1)?.type ?? "none"}`);
        abort.abort();
      }, hardLimitMs);
      const t0 = Date.now();
      try {
        const deps = await createDeps(request.mode, request.referenceTimezone, request.model);
        const result = await runInvestigation(request, deps, ch, abort.signal);
        const took = Date.now() - t0;
        if (took > b.totalMs + b.perExtraClaimMs * 2 + 5_000) {
          console.warn(`[fact-checker] slow run ${runId}: ${took} ms, status ${result.status}, events: ${ch.log.map((e) => `${e.type}@${e.elapsedMs}`).join(" ")}`);
        }
        if (watchdogFired) {
          ch.emit("error", { code: "watchdog", message: "The investigation exceeded its hard time limit and was stopped. Retry.", retryable: true });
        } else if (result.status === "cancelled") ch.emit("cancelled", { reason: "Stopped by you." });
        else ch.emit("result", { result });
      } catch (err) {
        console.error("[fact-checker] stream error:", err instanceof Error ? err.message : err);
        ch.emit("error", { code: "internal", message: "The investigation stopped unexpectedly. Retry.", retryable: true });
      } finally {
        clearTimeout(watchdog);
        clearInterval(keepAlive);
        ch.close();
        open = false;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
