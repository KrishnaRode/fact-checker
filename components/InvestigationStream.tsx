"use client";

import { AlertTriangle, Check, FileText, GitMerge, Link2, Lock, Search, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { STAGE_LABELS } from "@/lib/contracts";
import { STAGES, type ActivityItem, type RunState } from "@/lib/client/run-state";

export function useElapsed(startedAt: number, endedAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (endedAt) return;
    const t = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(t);
  }, [endedAt]);
  return Math.max(0, (endedAt ?? now) - startedAt);
}

export function formatSeconds(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Stage progress. Stage-based only: no invented percentage or time remaining. */
export function StageRail({ state }: { state: RunState }) {
  return (
    <ol className="grid grid-cols-5 gap-1.5" aria-label="Investigation stages">
      {STAGES.map((s, i) => {
        const st = state.stages[s];
        return (
          <li key={s} className="min-w-0" aria-current={st === "active" ? "step" : undefined}>
            <div className={`h-1 rounded-full transition-colors duration-500 ${st === "done" ? "bg-accent" : st === "active" ? "active-dot bg-accent/70" : "bg-border"}`} />
            <p className={`mt-2 hidden truncate text-[12px] sm:block ${st === "pending" ? "text-text-faint" : "text-text-muted"}`}>
              {STAGE_LABELS[s]}
            </p>
            <span className="sr-only">
              Step {i + 1}: {STAGE_LABELS[s]} — {st}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function ActivityRow({ item }: { item: ActivityItem }) {
  const base = "flex items-start gap-3 py-1.5 text-[14px] leading-snug animate-rise";
  switch (item.kind) {
    case "claim":
      return (
        <li className={base}>
          <Sparkles size={15} className="mt-0.5 shrink-0 text-accent" aria-hidden />
          <span className="text-text-muted">
            Checking: <span className="text-text">“{item.claim}”</span>
            {!item.checkable && <span className="text-text-faint"> — reads as an opinion or prediction</span>}
            {item.assumptions.map((a) => (
              <span key={a} className="mt-1 block text-[13px] text-text-faint">
                Assumption: {a}
              </span>
            ))}
          </span>
        </li>
      );
    case "discovered":
      return (
        <li className={base}>
          <Search size={15} className="mt-0.5 shrink-0 text-text-faint" aria-hidden />
          <span className="min-w-0 text-text-muted">
            <span className="text-text-faint">{item.publisher ?? host(item.url)} · </span>
            <span className="line-clamp-1">{item.title}</span>
          </span>
        </li>
      );
    case "fetched": {
      const ok = item.access === "full_text";
      return (
        <li className={base}>
          {ok ? <FileText size={15} className="mt-0.5 shrink-0 text-accent" aria-hidden /> : <Lock size={15} className="mt-0.5 shrink-0 text-unresolved" aria-hidden />}
          <span className="min-w-0 text-text-muted">
            {ok ? "Read " : "Could not read "}
            <span className="text-text">{item.publisher ?? host(item.url)}</span>
            <span className="text-text-faint"> — {ok ? item.title : (item.note ?? "inaccessible")}</span>
          </span>
        </li>
      );
    }
    case "provenance":
      return (
        <li className={base}>
          <GitMerge size={15} className="mt-0.5 shrink-0 text-accent-strong" aria-hidden />
          <span className="text-text-muted">{item.message}</span>
        </li>
      );
    case "observation":
      return (
        <li className={base}>
          <Link2 size={15} className="mt-0.5 shrink-0 text-accent-strong" aria-hidden />
          <span className="text-text">{item.message}</span>
        </li>
      );
    case "warning":
      return (
        <li className={base}>
          <AlertTriangle size={15} className="mt-0.5 shrink-0 text-unresolved" aria-hidden />
          <span className="text-text-muted">{item.message}</span>
        </li>
      );
  }
}

/** Live activity: only real events from the server, newest at the bottom. */
export function InvestigationStream({ state, collapsed }: { state: RunState; collapsed: boolean }) {
  const discovered = state.activity.filter((a) => a.kind === "discovered").length;
  const fetched = state.activity.filter((a) => a.kind === "fetched");
  const readable = fetched.filter((a) => a.kind === "fetched" && a.access === "full_text").length;
  const visible = collapsed ? state.activity : state.activity.slice(-9);
  const body = (
    <ul className="mt-1" aria-live={collapsed ? "off" : "polite"} aria-relevant="additions">
      {visible.map((a) => (
        <ActivityRow key={a.key} item={a} />
      ))}
      {state.passages.length > 0 && !collapsed && (
        <li className="flex items-start gap-3 py-1.5 text-[14px] text-text-muted animate-rise">
          <Check size={15} className="mt-0.5 shrink-0 text-supported" aria-hidden />
          Selected {state.passages.length} evidence passage{state.passages.length === 1 ? "" : "s"} from {new Set(state.passages.map((p) => p.sourceId)).size} source
          {new Set(state.passages.map((p) => p.sourceId)).size === 1 ? "" : "s"}.
        </li>
      )}
    </ul>
  );
  if (!collapsed) return body;
  return (
    <details className="group rounded-2xl border border-border bg-bg-soft/60 px-4 py-3">
      <summary className="flex items-center justify-between gap-3 text-[14px] text-text-muted">
        <span>
          Investigation activity · {discovered} found · {readable} read{fetched.length > readable ? ` · ${fetched.length - readable} inaccessible` : ""}
        </span>
        <span className="text-text-faint transition group-open:rotate-180" aria-hidden>
          ▾
        </span>
      </summary>
      <div className="scroll-thin mt-2 max-h-80 overflow-y-auto">{body}</div>
    </details>
  );
}
