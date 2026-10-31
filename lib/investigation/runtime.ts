import "server-only";
import { cachePolicy } from "@/app.config";
import { cacheGet, cacheSet } from "@/lib/cache";
import { serverConfig } from "@/lib/config";
import { ModelAssessmentSchema, ModelFollowUpSchema, ModelPlanSchema, type InvestigationResult, type Mode } from "@/lib/contracts";
import { chatStructured, loadedModels, ollamaTags, OllamaError } from "@/lib/ollama";
import { demoDocumentSource, loadCorpus } from "@/lib/providers/demo";
import { coverageScope, providersFor } from "@/lib/providers";
import { zonedToday } from "@/lib/text";
import type { FollowUpCaller } from "./follow-up";
import type { ModelCheck, OrchestratorDeps } from "./orchestrator";
import { liveDocumentSource } from "./retrieval";

/** Wire the real providers, fetchers, cache and local model for a request. */
export async function createDeps(mode: Mode, timeZone: string, model = serverConfig.model): Promise<OrchestratorDeps> {
  const referenceDate = mode === "demo" ? (await loadCorpus()).referenceDate : zonedToday(timeZone).iso;
  return {
    providers: providersFor(mode),
    documents: mode === "demo" ? demoDocumentSource : liveDocumentSource,
    scope: coverageScope(mode),
    referenceDate,
    modelName: model,
    checkModel: () => checkModel(model),
    callAssessment: async ({ system, user, timeoutMs, signal }) => {
      const r = await chatStructured({ model, schema: ModelAssessmentSchema, messages: [{ role: "system", content: system }, { role: "user", content: user }], signal, timeoutMs });
      return { value: r.value, ms: r.ms, loadMs: r.loadMs };
    },
    callPlanner: async (system, user, timeoutMs, signal) => {
      const r = await chatStructured({ model, schema: ModelPlanSchema, messages: [{ role: "system", content: system }, { role: "user", content: user }], signal, timeoutMs, maxTokens: 450 });
      return r.value;
    },
    cache: {
      async get(key) {
        const hit = await cacheGet<InvestigationResult>("runs", key);
        return hit ? { value: hit.value, expiresAt: hit.expiresAt } : null;
      },
      async set(key, value, ttlMs) {
        await cacheSet("runs", key, value, ttlMs, cachePolicy.maxAssessments);
      },
    },
  };
}

export async function checkModel(model: string): Promise<ModelCheck> {
  try {
    const tags = await ollamaTags();
    if (!tags.models.includes(model) && !tags.models.includes(`${model}:latest`)) {
      return { ok: false, code: "model_missing", message: `The local model ${model} is not installed. Run: ollama pull ${model}` };
    }
    const loaded = await loadedModels();
    return { ok: true, warm: loaded.includes(model) };
  } catch (err) {
    if (err instanceof OllamaError) return { ok: false, code: err.code, message: err.message };
    return { ok: false, code: "offline", message: "Ollama is not running. Start Ollama and retry." };
  }
}

export function followUpCaller(model = serverConfig.model, signal?: AbortSignal): FollowUpCaller {
  return async (system, user) => {
    const r = await chatStructured({ model, schema: ModelFollowUpSchema, messages: [{ role: "system", content: system }, { role: "user", content: user }], signal: signal ?? AbortSignal.timeout(30_000), timeoutMs: 25_000, maxTokens: 500 });
    return { value: r.value, ms: r.ms };
  };
}
