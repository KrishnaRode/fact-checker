import { excludedSources } from "@/app.config";
import { json, rejectCrossOrigin } from "@/lib/http";
import { providerStatuses } from "@/lib/providers";
import { checkAllFeeds, feedStatuses } from "@/lib/providers/rss";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Every source the app reads from, with live health — powers /how-it-works. */
export async function GET(): Promise<Response> {
  return json({ feeds: await feedStatuses(), services: providerStatuses().filter((p) => p.id !== "rss"), excluded: excludedSources, at: new Date().toISOString() });
}

/** "Check all feeds now": fetch every feed once (bounded, ~10–30 s). */
export async function POST(req: Request): Promise<Response> {
  const blocked = rejectCrossOrigin(req);
  if (blocked) return blocked;
  await checkAllFeeds();
  return json({ feeds: await feedStatuses(), services: providerStatuses().filter((p) => p.id !== "rss"), excluded: excludedSources, at: new Date().toISOString() });
}
