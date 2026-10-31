import { appConfig } from "@/app.config";
import { serverConfig } from "@/lib/config";
import type { HealthReport } from "@/lib/contracts";
import { json } from "@/lib/http";
import { loadedModels, modelCapabilities, ollamaTags } from "@/lib/ollama";
import { coverageScope, providerStatuses } from "@/lib/providers";
import { feedIndexInfo, warmFeedIndex } from "@/lib/providers/rss";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  warmFeedIndex();
  const model = serverConfig.model;
  const report: HealthReport = {
    app: appConfig.name,
    ollama: { host: serverConfig.ollamaHost, reachable: false, version: null, model, modelInstalled: false, installedModels: [], thinkingCapable: null, warm: null, message: null },
    providers: providerStatuses(),
    scope: coverageScope("live"),
    feedIndex: { entries: 0, refreshedAt: null },
    dataDir: serverConfig.dataDir,
  };
  const [tags, feedInfo] = await Promise.all([ollamaTags().catch(() => null), feedIndexInfo()]);
  report.feedIndex = { entries: feedInfo.entries, refreshedAt: feedInfo.refreshedAt };
  if (!tags) {
    report.ollama.message = "Ollama is not running. Start Ollama and retry.";
  } else {
    report.ollama.reachable = true;
    report.ollama.version = tags.version;
    report.ollama.installedModels = tags.models;
    report.ollama.modelInstalled = tags.models.includes(model) || tags.models.includes(`${model}:latest`);
    if (report.ollama.modelInstalled) {
      const [caps, loaded] = await Promise.all([modelCapabilities(model).catch(() => [] as string[]), loadedModels()]);
      report.ollama.thinkingCapable = caps.includes("thinking");
      report.ollama.warm = loaded.includes(model);
    } else {
      report.ollama.message = `The model ${model} is not installed. Run: ollama pull ${model}`;
    }
  }
  return json(report);
}
