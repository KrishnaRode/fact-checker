import { FollowUpRequestSchema } from "@/lib/contracts";
import { json, rejectCrossOrigin } from "@/lib/http";
import { answerFollowUp } from "@/lib/investigation/follow-up";
import { checkModel, followUpCaller } from "@/lib/investigation/runtime";
import { getRun } from "@/lib/investigation/run-store";
import { serverConfig } from "@/lib/config";
import { OllamaError } from "@/lib/ollama";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const blocked = rejectCrossOrigin(req);
  if (blocked) return blocked;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ code: "bad_request", message: "The request body is not valid JSON." }, 400);
  }
  const parsed = FollowUpRequestSchema.safeParse(body);
  if (!parsed.success) return json({ code: "invalid_input", message: parsed.error.issues[0]?.message ?? "Invalid request." }, 400);
  const run = getRun(parsed.data.runId);
  if (!run) return json({ code: "run_not_found", message: "This investigation is no longer in memory (the server restarted or it is too old). Investigate again to ask follow-ups." }, 404);
  const model = run.result.model ?? serverConfig.model;
  const ok = await checkModel(model);
  try {
    const answer = await answerFollowUp(run.result, parsed.data.question, ok.ok ? followUpCaller(model, req.signal) : null);
    return json(answer);
  } catch (err) {
    if (err instanceof OllamaError) return json({ code: err.code, message: err.message }, err.code === "aborted" ? 499 : 503);
    return json({ code: "internal", message: "The follow-up could not be answered. Retry." }, 500);
  }
}
