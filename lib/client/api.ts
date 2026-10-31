import { FollowUpResponseSchema, InvestigationEventSchema, type FollowUpResponse, type HealthReport, type InvestigateRequest, type InvestigationEvent } from "@/lib/contracts";
import { SSEParser } from "@/lib/sse";

export class HttpError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

/**
 * POST /api/investigate and parse the SSE stream incrementally. Resolves when the stream
 * ends; `onEvent` receives validated events in order. Abort via `signal` (Stop / new run).
 */
export async function streamInvestigation(
  body: Partial<InvestigateRequest> & { input: string },
  opts: { signal: AbortSignal; onEvent: (e: InvestigationEvent) => void },
): Promise<{ terminal: boolean }> {
  const res = await fetch("/api/investigate", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) {
    const j = (await res.json().catch(() => null)) as { code?: string; message?: string } | null;
    throw new HttpError(j?.code ?? "http_error", j?.message ?? `The server answered with HTTP ${res.status}.`, res.status);
  }
  let terminal = false;
  const parser = new SSEParser((data) => {
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      return;
    }
    const parsed = InvestigationEventSchema.safeParse(json);
    if (!parsed.success) return;
    if (parsed.data.type === "result" || parsed.data.type === "cancelled" || parsed.data.type === "error") terminal = true;
    opts.onEvent(parsed.data);
  });
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.push(value);
    }
    parser.end();
  } finally {
    reader.releaseLock();
  }
  return { terminal };
}

export async function askFollowUp(runId: string, question: string, signal: AbortSignal): Promise<FollowUpResponse> {
  const res = await fetch("/api/follow-up", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId, question }), signal });
  const j = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const e = j as { code?: string; message?: string } | null;
    throw new HttpError(e?.code ?? "http_error", e?.message ?? "The follow-up could not be answered.", res.status);
  }
  return FollowUpResponseSchema.parse(j);
}

export async function getHealth(signal?: AbortSignal): Promise<HealthReport> {
  const res = await fetch("/api/health", { signal, cache: "no-store" });
  return (await res.json()) as HealthReport;
}

export async function getCacheStats(): Promise<{ dataDir: string; buckets: Record<string, { entries: number; bytes: number }> }> {
  return (await fetch("/api/cache", { cache: "no-store" })).json();
}

export async function resetLocalData(): Promise<void> {
  const res = await fetch("/api/cache", { method: "DELETE" });
  if (!res.ok) throw new Error("Reset failed.");
}
