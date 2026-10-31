import { cacheStats, resetCache } from "@/lib/cache";
import { json, rejectCrossOrigin } from "@/lib/http";
import { clearRuns } from "@/lib/investigation/run-store";
import { clearFeedMemory } from "@/lib/providers/rss";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return json(await cacheStats());
}

/** Delete all locally stored evidence, feed index and assessments, and forget in-memory runs. */
export async function DELETE(req: Request): Promise<Response> {
  const blocked = rejectCrossOrigin(req);
  if (blocked) return blocked;
  await resetCache();
  clearRuns();
  clearFeedMemory();
  return json({ ok: true, ...(await cacheStats()) });
}
