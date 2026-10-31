import "server-only";
import { z } from "zod";
import { appConfig, budgets } from "@/app.config";
import { serverConfig } from "@/lib/config";

/**
 * Local Ollama client — the ONLY language-model path in the product. No cloud fallback.
 * - /api/chat with a JSON-schema `format` and low temperature.
 * - `think: false` only when /api/show reports the "thinking" capability.
 * - Inference is serialized (one call at a time) to avoid GPU/memory contention;
 *   retrieval stays concurrent elsewhere.
 * - Every call honours an AbortSignal so Stop/new-run cancels local work too.
 */

export class OllamaError extends Error {
  constructor(
    public code: "offline" | "model_missing" | "timeout" | "aborted" | "malformed" | "busy" | "http",
    message: string,
  ) {
    super(message);
    this.name = "OllamaError";
  }
}

const capabilityCache = new Map<string, { at: number; caps: string[] }>();

export async function ollamaTags(signal?: AbortSignal): Promise<{ version: string | null; models: string[] }> {
  const host = serverConfig.ollamaHost;
  const s = signal ? AbortSignal.any([signal, AbortSignal.timeout(2_500)]) : AbortSignal.timeout(2_500);
  try {
    const [v, t] = await Promise.all([
      fetch(`${host}/api/version`, { signal: s }).then((r) => r.json() as Promise<{ version?: string }>),
      fetch(`${host}/api/tags`, { signal: s }).then((r) => r.json() as Promise<{ models?: { name: string }[] }>),
    ]);
    return { version: v.version ?? null, models: (t.models ?? []).map((m) => m.name) };
  } catch {
    throw new OllamaError("offline", "Ollama is not running. Start Ollama and retry.");
  }
}

export async function loadedModels(): Promise<string[]> {
  try {
    const r = await fetch(`${serverConfig.ollamaHost}/api/ps`, { signal: AbortSignal.timeout(1_500) });
    const j = (await r.json()) as { models?: { name: string }[] };
    return (j.models ?? []).map((m) => m.name);
  } catch {
    return [];
  }
}

export async function modelCapabilities(model: string): Promise<string[]> {
  const hit = capabilityCache.get(model);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.caps;
  try {
    const r = await fetch(`${serverConfig.ollamaHost}/api/show`, {
      method: "POST",
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(3_000),
    });
    if (r.status === 404) throw new OllamaError("model_missing", `The model ${model} is not installed. Run: ollama pull ${model}`);
    const j = (await r.json()) as { capabilities?: string[] };
    const caps = j.capabilities ?? [];
    capabilityCache.set(model, { at: Date.now(), caps });
    return caps;
  } catch (err) {
    if (err instanceof OllamaError) throw err;
    throw new OllamaError("offline", "Ollama is not running. Start Ollama and retry.");
  }
}

/* ── Serialized inference queue ───────────────────────────────────────────── */

let tail: Promise<unknown> = Promise.resolve();
let queued = 0;

function serialize<T>(fn: () => Promise<T>, signal: AbortSignal): Promise<T> {
  queued++;
  const run = tail.then(
    () => {
      if (signal.aborted) throw new OllamaError("aborted", "Cancelled.");
      return fn();
    },
    () => {
      if (signal.aborted) throw new OllamaError("aborted", "Cancelled.");
      return fn();
    },
  );
  tail = run.catch(() => undefined).finally(() => queued--);
  return run;
}

export function inferenceQueueDepth(): number {
  return queued;
}

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type StructuredResult<T> = { value: T; raw: string; ms: number; loadMs: number; promptTokens: number | null; outputTokens: number | null };

/**
 * One schema-constrained chat call. Parses and validates with Zod; on failure throws
 * OllamaError("malformed") carrying the validation message (the caller decides whether a
 * single bounded repair attempt fits the remaining budget).
 */
export async function chatStructured<S extends z.ZodType>(opts: {
  model?: string;
  schema: S;
  messages: ChatMessage[];
  signal: AbortSignal;
  timeoutMs: number;
  maxTokens?: number;
}): Promise<StructuredResult<z.infer<S>>> {
  const model = opts.model ?? serverConfig.model;
  const caps = await modelCapabilities(model);
  const jsonSchema = z.toJSONSchema(opts.schema, { target: "draft-7" }) as Record<string, unknown>;
  delete jsonSchema.$schema;

  const deadline = Date.now() + opts.timeoutMs;
  return serialize(async () => {
    const started = Date.now();
    const left = deadline - started;
    if (left < 1_000) throw new OllamaError("timeout", "The local model was busy and the time budget ran out before it could start.");
    const signal = AbortSignal.any([opts.signal, AbortSignal.timeout(left)]);
    let res: Response;
    try {
      res = await fetch(`${serverConfig.ollamaHost}/api/chat`, {
        method: "POST",
        signal,
        body: JSON.stringify({
          model,
          messages: opts.messages,
          stream: false,
          format: jsonSchema,
          keep_alive: appConfig.keepAlive,
          ...(caps.includes("thinking") ? { think: false } : {}),
          options: { temperature: 0.1, num_ctx: budgets.modelNumCtx, num_predict: opts.maxTokens ?? budgets.modelMaxOutputTokens },
        }),
      });
    } catch (err) {
      if (opts.signal.aborted) throw new OllamaError("aborted", "Cancelled.");
      if ((err as Error)?.name === "TimeoutError" || signal.aborted) throw new OllamaError("timeout", "The local model did not finish within the time budget.");
      throw new OllamaError("offline", "Ollama is not running. Start Ollama and retry.");
    }
    if (res.status === 404) throw new OllamaError("model_missing", `The model ${model} is not installed. Run: ollama pull ${model}`);
    if (res.status === 503) throw new OllamaError("busy", "Ollama is busy with another request. Retry in a moment.");
    if (!res.ok) throw new OllamaError("http", `Ollama returned HTTP ${res.status}.`);
    let body: { message?: { content?: string }; load_duration?: number; prompt_eval_count?: number; eval_count?: number; done_reason?: string };
    try {
      body = await res.json();
    } catch {
      if (opts.signal.aborted) throw new OllamaError("aborted", "Cancelled.");
      throw new OllamaError("timeout", "The local model did not finish within the time budget.");
    }
    const raw = body.message?.content ?? "";
    const ms = Date.now() - started;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new OllamaError("malformed", body.done_reason === "length" ? "The model's answer was cut off (output limit)." : "The model returned text that is not valid JSON.");
    }
    const parsed = opts.schema.safeParse(json);
    if (!parsed.success) {
      throw new OllamaError("malformed", `The model's answer did not match the schema: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
    }
    if (process.env.FACTCHECK_DEBUG_MODEL === "1") {
      console.log(`[ollama] ${model} ${ms}ms load=${Math.round((body.load_duration ?? 0) / 1e6)}ms prompt=${body.prompt_eval_count} out=${body.eval_count}`);
    }
    return {
      value: parsed.data,
      raw,
      ms,
      loadMs: Math.round((body.load_duration ?? 0) / 1e6),
      promptTokens: body.prompt_eval_count ?? null,
      outputTokens: body.eval_count ?? null,
    };
  }, opts.signal);
}
