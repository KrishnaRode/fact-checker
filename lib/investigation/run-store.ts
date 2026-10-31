import type { InvestigationResult } from "@/lib/contracts";
import type { FetchedDocument } from "./retrieval";

/**
 * Recent runs kept in memory only (not persisted), so follow-ups and "Investigate further"
 * can reuse validated evidence. No conversation history is written to disk.
 */
export type StoredRun = { result: InvestigationResult; sourceTexts: Map<string, string>; documents: Map<string, FetchedDocument> };

const MAX_RUNS = 30;
const runs = new Map<string, StoredRun>();

export function saveRun(run: StoredRun): void {
  runs.delete(run.result.id);
  runs.set(run.result.id, run);
  while (runs.size > MAX_RUNS) runs.delete(runs.keys().next().value!);
}

export function getRun(id: string): StoredRun | undefined {
  return runs.get(id);
}

export function clearRuns(): void {
  runs.clear();
}
