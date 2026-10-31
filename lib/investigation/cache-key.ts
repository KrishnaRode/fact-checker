import { cachePolicy } from "@/app.config";
import type { Depth, Mode } from "@/lib/contracts";
import { sha256 } from "@/lib/text";

/**
 * Exact-match assessment cache key. The input is normalized only for Unicode form and
 * whitespace: any change to a date, number, name, negation or place is a different key.
 * Temporal reference, provider configuration and model/prompt/schema/evidence versions are
 * all part of the key, so results are never reused across incompatible contexts.
 */
export function normalizeForKey(input: string): string {
  return input.normalize("NFC").replace(/\s+/g, " ").trim();
}

export function assessmentCacheKey(p: {
  input: string;
  mode: Mode;
  depth: Depth;
  referenceDate: string;
  referenceTimezone: string;
  providerIds: string[];
  model: string;
  language?: string;
}): string {
  return sha256(
    JSON.stringify({
      v: [cachePolicy.promptVersion, cachePolicy.schemaVersion, cachePolicy.evidenceVersion],
      input: normalizeForKey(p.input),
      mode: p.mode,
      depth: p.depth,
      ref: p.referenceDate,
      tz: p.referenceTimezone,
      providers: [...p.providerIds].sort(),
      model: p.model,
      lang: p.language ?? "en",
    }),
  );
}
