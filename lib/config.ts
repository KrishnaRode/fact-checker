import "server-only";
import path from "node:path";
import { appConfig } from "@/app.config";

/**
 * Server runtime configuration. Branding/budgets live in app.config.ts; this file only
 * overlays environment variables. Secrets never leave the server.
 */
export const serverConfig = {
  get ollamaHost(): string {
    const raw = process.env.OLLAMA_HOST?.trim() || appConfig.ollamaHost;
    const withScheme = raw.startsWith("http") ? raw : `http://${raw}`;
    return withScheme.replace(/\/+$/, "");
  },
  get model(): string {
    return process.env.FACTCHECK_MODEL?.trim() || appConfig.defaultModel;
  },
  get dataDir(): string {
    return path.resolve(/*turbopackIgnore: true*/ process.env.FACTCHECK_DATA_DIR?.trim() || path.join(process.cwd(), ".data"));
  },
  get braveApiKey(): string | null {
    return process.env.BRAVE_SEARCH_API_KEY?.trim() || null;
  },
  get googleFactCheckKey(): string | null {
    return process.env.GOOGLE_FACT_CHECK_API_KEY?.trim() || null;
  },
  get disableGdelt(): boolean {
    return process.env.FACTCHECK_DISABLE_GDELT === "1";
  },
};

/** Remove configured secrets from any string before it is logged or returned. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const secret of [serverConfig.braveApiKey, serverConfig.googleFactCheckKey]) {
    if (secret && secret.length > 4) out = out.split(secret).join("[redacted]");
  }
  return out.replace(/([?&]key=)[^&\s"]+/gi, "$1[redacted]");
}
