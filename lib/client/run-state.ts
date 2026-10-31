import type { Depth, EventPayload, InvestigationEvent, InvestigationResult, Mode, Stage } from "@/lib/contracts";

/**
 * Client-side state for one investigation. Pure reducer so the stale-run guard is testable:
 * every action carries the local attempt number, and actions from an older attempt are ignored.
 */
export type StageStatus = "pending" | "active" | "done";

export type ActivityItem =
  | { kind: "discovered"; key: string; at: number; title: string; publisher: string | null; provider: string; url: string }
  | { kind: "fetched"; key: string; at: number; sourceId: string; title: string; publisher: string | null; access: string; url: string; note: string | null }
  | { kind: "observation"; key: string; at: number; message: string }
  | { kind: "provenance"; key: string; at: number; message: string }
  | { kind: "warning"; key: string; at: number; provider: string; message: string }
  | { kind: "claim"; key: string; at: number; claim: string; assumptions: string[]; checkable: boolean };

export type RunState = {
  attempt: number;
  phase: "idle" | "running" | "done" | "error";
  runId: string | null;
  input: string;
  mode: Mode;
  depth: Depth;
  startedAt: number;
  endedAt: number | null;
  stages: Record<Stage, StageStatus>;
  stageDetail: Partial<Record<Stage, string | null>>;
  activity: ActivityItem[];
  passages: { passageId: string; sourceId: string; preview: string }[];
  started: EventPayload<"started"> | null;
  result: InvestigationResult | null;
  error: { code: string; message: string; retryable: boolean } | null;
  cancelled: boolean;
  lastSequence: number;
};

export const STAGES: Stage[] = ["understand", "retrieve", "extract", "compare", "validate"];

const freshStages = (): Record<Stage, StageStatus> => ({ understand: "pending", retrieve: "pending", extract: "pending", compare: "pending", validate: "pending" });

export const initialRunState: RunState = {
  attempt: 0,
  phase: "idle",
  runId: null,
  input: "",
  mode: "live",
  depth: "quick",
  startedAt: 0,
  endedAt: null,
  stages: freshStages(),
  stageDetail: {},
  activity: [],
  passages: [],
  started: null,
  result: null,
  error: null,
  cancelled: false,
  lastSequence: -1,
};

export type RunAction =
  | { type: "start"; attempt: number; input: string; mode: Mode; depth: Depth; at: number }
  | { type: "event"; attempt: number; event: InvestigationEvent; at: number }
  | { type: "http_error"; attempt: number; code: string; message: string; at: number }
  | { type: "stream_lost"; attempt: number; at: number }
  | { type: "stopped"; attempt: number; at: number }
  | { type: "reset" };

export function runReducer(state: RunState, action: RunAction): RunState {
  if (action.type === "reset") return { ...initialRunState, attempt: state.attempt, mode: state.mode, depth: state.depth };
  if (action.type === "start") {
    return { ...initialRunState, attempt: action.attempt, phase: "running", input: action.input, mode: action.mode, depth: action.depth, startedAt: action.at };
  }
  // Stale guard: anything from an older attempt (Stop, Retry or a new run happened) is ignored.
  if (action.attempt !== state.attempt) return state;

  switch (action.type) {
    case "http_error":
      return { ...state, phase: "error", endedAt: action.at, error: { code: action.code, message: action.message, retryable: action.code !== "invalid_input" } };
    case "stream_lost":
      if (state.phase !== "running") return state;
      return { ...state, phase: "error", endedAt: action.at, error: { code: "stream_interrupted", message: "The connection to the investigation was interrupted before it finished.", retryable: true } };
    case "stopped":
      if (state.phase !== "running") return state;
      return { ...state, phase: "done", cancelled: true, endedAt: action.at, stages: settle(state.stages) };
    case "event":
      return applyEvent(state, action.event, action.at);
  }
}

function settle(stages: Record<Stage, StageStatus>): Record<Stage, StageStatus> {
  const out = { ...stages };
  for (const s of STAGES) if (out[s] === "active") out[s] = "pending";
  return out;
}

function applyEvent(state: RunState, e: InvestigationEvent, at: number): RunState {
  if (state.runId && e.runId !== state.runId) return state;
  if (e.sequence <= state.lastSequence) return state;
  if (state.phase !== "running") return state;
  const s: RunState = { ...state, runId: e.runId, lastSequence: e.sequence };
  const key = `${e.runId}:${e.sequence}`;
  switch (e.type) {
    case "started":
      return { ...s, started: e.payload };
    case "stage_started":
      return { ...s, stages: { ...s.stages, [e.payload.stage]: "active" } };
    case "stage_completed":
      return { ...s, stages: { ...s.stages, [e.payload.stage]: "done" }, stageDetail: { ...s.stageDetail, [e.payload.stage]: e.payload.detail } };
    case "claim_identified":
      return { ...s, activity: [...s.activity, { kind: "claim", key, at, claim: e.payload.claim, assumptions: e.payload.assumptions, checkable: e.payload.checkable }] };
    case "source_discovered":
      return { ...s, activity: [...s.activity, { kind: "discovered", key, at, title: e.payload.title, publisher: e.payload.publisher, provider: e.payload.provider, url: e.payload.url }] };
    case "source_fetched":
      return { ...s, activity: [...s.activity, { kind: "fetched", key, at, sourceId: e.payload.sourceId, title: e.payload.title, publisher: e.payload.publisher, access: e.payload.access, url: e.payload.url, note: e.payload.note }] };
    case "passage_selected":
      return { ...s, passages: [...s.passages, e.payload] };
    case "provenance_linked":
      return { ...s, activity: [...s.activity, { kind: "provenance", key, at, message: e.payload.message }] };
    case "observation":
      return { ...s, activity: [...s.activity, { kind: "observation", key, at, message: e.payload.message }] };
    case "provider_warning":
      return { ...s, activity: [...s.activity, { kind: "warning", key, at, provider: e.payload.provider, message: e.payload.message }] };
    case "result": {
      const r = e.payload.result;
      return { ...s, phase: "done", result: r, endedAt: at, stages: r.status === "complete" ? { understand: "done", retrieve: "done", extract: "done", compare: "done", validate: "done" } : settle(s.stages) };
    }
    case "error":
      return { ...s, phase: "error", endedAt: at, error: e.payload, stages: settle(s.stages) };
    case "cancelled":
      return { ...s, phase: "done", cancelled: true, endedAt: at, stages: settle(s.stages) };
  }
}
