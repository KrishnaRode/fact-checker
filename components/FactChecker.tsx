"use client";

import { Plus } from "lucide-react";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { appConfig } from "@/app.config";
import type { Depth, HealthReport, Mode } from "@/lib/contracts";
import { getHealth, HttpError, streamInvestigation } from "@/lib/client/api";
import { useStoredMode } from "@/lib/client/hooks";
import { initialRunState, runReducer } from "@/lib/client/run-state";
import { SAMPLES } from "@/lib/client/samples";
import { overallView } from "@/lib/client/verdicts";
import { AssessmentView } from "./AssessmentView";
import { ClaimComposer } from "./ClaimComposer";
import { ConnectionStatus } from "./ConnectionStatus";
import { EvidenceInspector } from "./EvidenceInspector";
import type { Selection } from "./EvidenceMap";
import { ErrorState } from "./ErrorState";
import { FollowUpComposer } from "./FollowUpComposer";
import { formatSeconds, InvestigationStream, StageRail, useElapsed } from "./InvestigationStream";
import { SettingsDrawer } from "./SettingsDrawer";
import { VerdictSignal } from "./VerdictSignal";

function Logo() {
  return (
    <svg width="26" height="26" viewBox="0 0 64 64" aria-hidden>
      <circle cx="29" cy="29" r="15" fill="none" stroke="#6d8bff" strokeWidth="5" />
      <path d="M40 40l11 11" stroke="#6d8bff" strokeWidth="6" strokeLinecap="round" />
      <path d="M22.5 29.5l4.5 4.5 8.5-9" fill="none" stroke="#52d49b" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function FactChecker() {
  const [state, dispatch] = useReducer(runReducer, initialRunState);
  const [draft, setDraft] = useState("");
  const [mode, changeMode] = useStoredMode();
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const attemptRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const resultTopRef = useRef<HTMLDivElement>(null);
  const elapsed = useElapsed(state.startedAt, state.endedAt);

  const refreshHealth = useCallback(() => {
    getHealth().then(setHealth).catch(() => setHealth(null));
  }, []);
  useEffect(() => {
    refreshHealth();
    const t = setInterval(refreshHealth, 30_000);
    return () => clearInterval(t);
  }, [refreshHealth]);

  // Leaving the page cancels any running investigation (no orphaned research).
  useEffect(() => () => abortRef.current?.abort(), []);

  const run = useCallback(
    async (input: string, opts: { mode: Mode; depth?: Depth; refresh?: boolean; baseRunId?: string }) => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      const attempt = ++attemptRef.current;
      setSelection(null);
      dispatch({ type: "start", attempt, input, mode: opts.mode, depth: opts.depth ?? "quick", at: Date.now() });
      requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: "smooth" }));
      try {
        const { terminal } = await streamInvestigation(
          { input, mode: opts.mode, depth: opts.depth ?? "quick", refresh: opts.refresh ?? false, baseRunId: opts.baseRunId, referenceTimezone: appConfig.referenceTimezone },
          { signal: ctrl.signal, onEvent: (event) => dispatch({ type: "event", attempt, event, at: Date.now() }) },
        );
        if (!terminal) dispatch({ type: "stream_lost", attempt, at: Date.now() });
      } catch (err) {
        if (ctrl.signal.aborted) return;
        if (err instanceof HttpError) dispatch({ type: "http_error", attempt, code: err.code, message: err.message, at: Date.now() });
        else dispatch({ type: "stream_lost", attempt, at: Date.now() });
      }
    },
    [],
  );

  const submit = () => {
    const input = draft.trim();
    if (!input) return;
    void run(input, { mode });
  };

  const stop = () => {
    abortRef.current?.abort();
    dispatch({ type: "stopped", attempt: attemptRef.current, at: Date.now() });
  };

  const newInvestigation = () => {
    abortRef.current?.abort();
    attemptRef.current++;
    dispatch({ type: "reset" });
    setDraft("");
    setSelection(null);
  };

  const editClaim = () => {
    abortRef.current?.abort();
    attemptRef.current++;
    setDraft(state.input);
    dispatch({ type: "reset" });
  };

  const idle = state.phase === "idle";
  const running = state.phase === "running";
  const result = state.result;
  const view = result ? overallView(result) : null;
  const runMode = state.mode;

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[1080px] flex-col px-4 sm:px-6">
      <header className="flex items-center justify-between gap-3 py-4 sm:py-5">
        <button type="button" onClick={newInvestigation} className="flex min-w-0 items-center gap-2.5 rounded-lg" aria-label={`${appConfig.name} — start a new investigation`}>
          <Logo />
          <span className="text-[16px] font-semibold tracking-tight text-text">{appConfig.name}</span>
          <span className="hidden rounded-full border border-border px-2 py-0.5 text-[11.5px] text-text-faint sm:inline">{appConfig.series}</span>
        </button>
        <ConnectionStatus health={health} mode={idle ? mode : runMode} onOpen={() => setSettingsOpen(true)} />
      </header>

      <main className="flex flex-1 flex-col">
        {idle ? (
          <div className="flex flex-1 flex-col justify-center pb-16 pt-6 sm:pt-10">
            <div className="mx-auto w-full max-w-[920px]">
              <h1 className="font-display text-balance text-center text-[52px] leading-[1.02] text-text sm:text-[76px]">{appConfig.hero}</h1>
              <p className="mt-4 text-center text-[17px] text-text-muted sm:text-[19px]">{appConfig.supportingLine}</p>
              <div className="mt-9 sm:mt-11">
                <ClaimComposer value={draft} onChange={setDraft} onSubmit={submit} onStop={stop} running={false} autoFocus />
              </div>
              {mode === "demo" && (
                <p className="mt-3 text-center text-[13px] text-unresolved" role="status">
                  Demo mode · bundled fictional evidence, no internet search.{" "}
                  <button type="button" onClick={() => changeMode("live")} className="underline underline-offset-2 hover:text-text">
                    Switch to live
                  </button>
                </p>
              )}
              <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-center">
                {SAMPLES.map((s) => (
                  <button
                    key={s.input}
                    type="button"
                    onClick={() => {
                      setDraft(s.input);
                      changeMode(s.mode);
                      requestAnimationFrame(() => document.getElementById("claim-input")?.focus());
                    }}
                    className="group rounded-2xl border border-border bg-panel/50 px-4 py-2.5 text-left transition hover:border-border-strong hover:bg-panel-hover sm:max-w-[290px]"
                  >
                    <span className="block text-[14px] text-text-muted group-hover:text-text">{s.label}</span>
                    <span className={`block text-[11.5px] ${s.mode === "demo" ? "text-unresolved/80" : "text-text-faint"}`}>{s.note}</span>
                  </button>
                ))}
              </div>
              <p className="mx-auto mt-10 max-w-[620px] text-center text-[13px] leading-relaxed text-text-faint">
                The language model runs locally through Ollama. Live checks search the internet, so your search terms go to news feeds and Wikipedia{health?.scope === "broader_web" ? " and the search services you configured" : ""}. Results are evidence assessments as of the time checked — not certified truth.
              </p>
            </div>
          </div>
        ) : (
          <div ref={resultTopRef} className="mx-auto w-full max-w-[880px] space-y-6 pb-20 pt-2">
            {/* The original submission, kept as a compact turn */}
            <div className="flex justify-end">
              <div className="max-w-[88%] rounded-2xl rounded-br-md border border-border bg-panel-hover/80 px-4 py-3">
                <p className="line-clamp-4 whitespace-pre-wrap break-words text-[15px] leading-relaxed text-text">{state.input}</p>
                {runMode === "demo" && <p className="mt-1 text-right text-[11.5px] text-unresolved">Demo · bundled evidence</p>}
              </div>
            </div>

            <article className="rounded-3xl border border-border bg-panel/70 p-5 shadow-[0_30px_100px_-50px_rgba(61,87,201,0.5)] backdrop-blur sm:p-8" aria-busy={running}>
              <div className="flex items-start gap-5">
                <VerdictSignal state={result ? "settled" : "running"} tone={view?.tone ?? "pending"} icon={view?.icon ?? null} label={result ? view!.label : state.error ? "Investigation interrupted" : "Investigating"} size={72} />
                <div className="min-w-0 flex-1 pt-1">
                  {!result && (
                    <>
                      <p className="text-[13px] font-semibold uppercase tracking-[0.1em] text-accent-strong" aria-live="polite">
                        {state.error ? "Interrupted" : state.cancelled ? "Stopped" : state.started?.cached ? "Found a recent check" : "Investigating"}
                      </p>
                      <p className="mt-1.5 text-[15px] text-text-muted">
                        <span className="tabular-nums text-text">{formatSeconds(elapsed)}</span>
                        {state.started && <> · {state.started.mode === "demo" ? "bundled demo corpus" : state.started.scope === "broader_web" ? "broader web search" : "selected sources"} · reference date {new Date(`${state.started.referenceDate}T12:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}</>}
                        {state.depth === "deep" && " · deeper investigation"}
                      </p>
                    </>
                  )}
                  {result && (
                    <p className="text-[13px] text-text-faint">
                      {result.origin === "cached_run" ? "Cached result" : `Investigated in ${formatSeconds(result.timing.totalMs)}`} · {result.mode === "demo" ? <span className="text-unresolved">Demo · bundled evidence</span> : "Live evidence"}
                    </p>
                  )}
                </div>
              </div>

              {!result && (
                <div className="mt-6 space-y-5">
                  <StageRail state={state} />
                  {state.error ? (
                    <ErrorState code={state.error.code} message={state.error.message} retryable={state.error.retryable} onRetry={() => run(state.input, { mode: state.mode, depth: state.depth })} />
                  ) : state.cancelled ? (
                    <div className="rounded-2xl border border-border bg-bg-soft/60 p-4 text-[14.5px] text-text-muted">
                      Stopped. Nothing was concluded.{" "}
                      <button type="button" onClick={() => run(state.input, { mode: state.mode, depth: state.depth })} className="text-accent-strong hover:text-text">
                        Retry
                      </button>
                    </div>
                  ) : null}
                  <InvestigationStream state={state} collapsed={false} />
                </div>
              )}

              {result && (
                <div className="mt-6 space-y-6 animate-rise">
                  <AssessmentView
                    result={result}
                    onInspect={setSelection}
                    onRetry={() => run(state.input, { mode: state.mode, depth: state.depth })}
                    onRefresh={() => run(state.input, { mode: state.mode, depth: state.depth, refresh: true })}
                    onDeeper={() => run(state.input, { mode: state.mode, depth: "deep", baseRunId: result.id })}
                    onEdit={editClaim}
                  />
                  {state.activity.length > 0 && <InvestigationStream state={state} collapsed />}
                </div>
              )}
            </article>

            {result && result.status === "complete" && result.passages.length > 0 && (
              <FollowUpComposer key={result.id} result={result} onInspect={(id) => setSelection({ kind: "passage", id })} onInvestigate={(claim) => run(claim, { mode: state.mode })} />
            )}

            {running ? (
              <div className="flex justify-center">
                <button type="button" onClick={stop} className="rounded-full border border-border-strong px-5 py-2 text-[14px] text-text-muted hover:text-text">
                  Stop investigating
                </button>
              </div>
            ) : (
              <div className="flex justify-center">
                <button type="button" onClick={newInvestigation} className="inline-flex items-center gap-2 rounded-full border border-border px-5 py-2 text-[14px] text-text-muted transition hover:border-border-strong hover:text-text">
                  <Plus size={15} aria-hidden /> New investigation
                </button>
              </div>
            )}
          </div>
        )}
      </main>

      <footer className="flex flex-col items-center justify-between gap-1 border-t border-border/60 py-5 text-[12.5px] text-text-faint sm:flex-row">
        <span>
          {appConfig.series} · {appConfig.seriesLine}
        </span>
        <span>Built by {appConfig.owner} · local AI via Ollama</span>
      </footer>

      {result && <EvidenceInspector result={result} selection={selection} onClose={() => setSelection(null)} onSelect={setSelection} />}
      <SettingsDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} health={health} onRefreshHealth={refreshHealth} mode={idle ? mode : runMode} onModeChange={changeMode} />
    </div>
  );
}
