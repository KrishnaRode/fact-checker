"use client";

import { Check, Cpu, Database, Globe2, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { appConfig, seriesLabel } from "@/app.config";
import type { HealthReport, Mode } from "@/lib/contracts";
import { getCacheStats, resetLocalData } from "@/lib/client/api";
import { connectionSummary } from "./ConnectionStatus";

function Section({ icon: Icon, title, children }: { icon: typeof Cpu; title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-border pt-5">
      <h3 className="flex items-center gap-2 text-[13px] font-semibold uppercase tracking-[0.08em] text-text-faint">
        <Icon size={14} aria-hidden /> {title}
      </h3>
      <div className="mt-3 space-y-3 text-[14px] leading-relaxed text-text-muted">{children}</div>
    </section>
  );
}

function Code({ children }: { children: string }) {
  return <code className="block overflow-x-auto rounded-lg border border-border bg-bg-soft px-3 py-2 font-mono text-[12.5px] text-text">{children}</code>;
}

export function SettingsDrawer({ open, onClose, health, onRefreshHealth, mode, onModeChange, recheck }: { open: boolean; onClose: () => void; health: HealthReport | null; onRefreshHealth: () => void; mode: Mode; onModeChange: (m: Mode) => void; recheck: (() => void) | null }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const [stats, setStats] = useState<Awaited<ReturnType<typeof getCacheStats>> | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [resetDone, setResetDone] = useState(false);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    onRefreshHealth();
    getCacheStats().then(setStats).catch(() => setStats(null));
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, onRefreshHealth]);

  if (!open) return null;
  const s = connectionSummary(health);
  const entries = stats ? Object.values(stats.buckets).reduce((a, b) => a + b.entries, 0) : null;
  const bytes = stats ? Object.values(stats.buckets).reduce((a, b) => a + b.bytes, 0) : 0;

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <button type="button" aria-label="Close settings" className="absolute inset-0 bg-black/55 backdrop-blur-[2px] animate-fade" onClick={onClose} />
      <aside className="scroll-thin absolute inset-y-0 right-0 w-full max-w-[460px] overflow-y-auto border-l border-border bg-panel p-6 shadow-2xl animate-rise sm:p-7">
        <div className="flex items-center justify-between">
          <h2 id="settings-title" className="text-[18px] font-semibold text-text">
            Settings &amp; coverage
          </h2>
          <button ref={closeRef} type="button" onClick={onClose} className="grid h-9 w-9 place-items-center rounded-full border border-border text-text-muted hover:text-text" aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="mt-6 space-y-6">
          <section>
            <p className="text-[13px] font-semibold uppercase tracking-[0.08em] text-text-faint">Evidence mode</p>
            <div role="radiogroup" aria-label="Evidence mode" className="mt-3 grid grid-cols-2 gap-2">
              {(
                [
                  ["live", "Live", "Searches the internet now"],
                  ["demo", "Demo", "Bundled fictional evidence"],
                ] as const
              ).map(([m, label, hint]) => (
                <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => onModeChange(m)} className={`rounded-xl border p-3 text-left transition ${mode === m ? "border-accent bg-accent/10" : "border-border hover:border-border-strong"}`}>
                  <span className="flex items-center justify-between text-[14.5px] font-medium text-text">
                    {label} {mode === m && <Check size={15} className="text-accent" aria-hidden />}
                  </span>
                  <span className="mt-0.5 block text-[12.5px] text-text-faint">{hint}</span>
                </button>
              ))}
            </div>
            <p className="mt-2 text-[12.5px] text-text-faint">Applies to your next investigation.</p>
            {recheck && (
              <button type="button" onClick={recheck} className="mt-3 inline-flex items-center gap-2 rounded-full bg-accent px-4 py-2 text-[14px] font-semibold text-bg hover:bg-accent-strong">
                <Globe2 size={15} aria-hidden /> Re-check this claim {mode === "live" ? "live" : "in demo mode"}
              </button>
            )}
            <p className="mt-2 text-[12.5px] text-text-faint">Demo mode runs the same pipeline, validators and local model over a fictional bundled corpus. It never touches the network and is always labelled.</p>
          </section>

          <Section icon={Cpu} title="Local model">
            <p>
              <span className="text-text">{s.text}.</span> All language-model work runs on this computer through Ollama ({health?.ollama.host ?? "…"}). There is no cloud model and no fallback to one.
            </p>
            <p>
              Model: <span className="font-mono text-text">{health?.ollama.model ?? appConfig.defaultModel}</span>
              {health?.ollama.version && <span className="text-text-faint"> · Ollama {health.ollama.version}</span>}
              {health?.ollama.thinkingCapable != null && <span className="text-text-faint"> · thinking disabled for speed</span>}
            </p>
            <details className="rounded-xl border border-border bg-bg-soft/60 p-3">
              <summary className="text-[13.5px] text-text">Setup and model commands</summary>
              <div className="mt-3 space-y-2 text-[13px]">
                <p>Start Ollama:</p>
                <Code>ollama serve</Code>
                <p>Install the fast default model (≈2.5 GB):</p>
                <Code>{`ollama pull ${appConfig.defaultModel}`}</Code>
                <p>Optional quality model (≈5 GB) — set FACTCHECK_MODEL={appConfig.qualityModel} in .env.local and restart:</p>
                <Code>{`ollama pull ${appConfig.qualityModel}`}</Code>
                {health?.ollama.installedModels.length ? <p className="text-text-faint">Installed: {health.ollama.installedModels.join(", ")}</p> : null}
              </div>
            </details>
          </Section>

          <Section icon={Globe2} title={health?.scope === "broader_web" ? "Sources · broader web search enabled" : "Sources · selected-source coverage"}>
            <p>Live checks need the internet: search queries go to the services below even though the model runs locally. Coverage is limited — a missing result is a coverage gap, not evidence.</p>
            <ul className="space-y-2">
              {health?.providers.map((p) => (
                <li key={p.id} className="rounded-xl border border-border bg-bg-soft/50 p-3">
                  <p className="flex items-center justify-between gap-2 text-[14px] text-text">
                    {p.name}
                    <span className={`text-[12px] ${p.enabled ? "text-supported" : "text-text-faint"}`}>{p.enabled ? "On" : p.kind === "optional" ? "Needs your key" : "Off"}</span>
                  </p>
                  <p className="mt-0.5 text-[12.5px] text-text-faint">{p.note}</p>
                </li>
              ))}
            </ul>
            {health && <p className="text-[12.5px] text-text-faint">Feed index: {health.feedIndex.entries} recent items{health.feedIndex.refreshedAt ? `, refreshed ${new Date(health.feedIndex.refreshedAt).toLocaleTimeString("en-IN")}` : " (builds on first live check)"}.</p>}
          </Section>

          <Section icon={Database} title="Privacy & local data">
            <p>No conversation history is saved. To stay fast, recent page text, the feed index and validated assessments are cached on this computer for a few hours.</p>
            {stats && (
              <p className="text-[13px] text-text-faint">
                {entries} cached item{entries === 1 ? "" : "s"} · {(bytes / 1024 / 1024).toFixed(1)} MB · <span className="break-all font-mono">{stats.dataDir}</span>
              </p>
            )}
            {confirming ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-text">Delete all cached evidence and assessments?</span>
                <button
                  type="button"
                  onClick={async () => {
                    await resetLocalData();
                    setConfirming(false);
                    setResetDone(true);
                    setStats(await getCacheStats().catch(() => null));
                  }}
                  className="rounded-full bg-contradicted px-3.5 py-1.5 text-[13px] font-semibold text-bg"
                >
                  Delete
                </button>
                <button type="button" onClick={() => setConfirming(false)} className="rounded-full border border-border px-3.5 py-1.5 text-[13px]">
                  Cancel
                </button>
              </div>
            ) : (
              <button type="button" onClick={() => { setConfirming(true); setResetDone(false); }} className="inline-flex items-center gap-2 rounded-full border border-border px-3.5 py-1.5 text-[13px] text-text hover:border-contradicted/60">
                <Trash2 size={14} aria-hidden /> Reset local data
              </button>
            )}
            {resetDone && <p className="text-[13px] text-supported" role="status">Local data deleted.</p>}
          </Section>

          <section className="border-t border-border pt-5 text-[13px] leading-relaxed text-text-faint">
            <p className="text-text-muted">
              {appConfig.name} · {seriesLabel}
            </p>
            <p>{appConfig.seriesLine} Built by {appConfig.owner}.</p>
            <p className="mt-2">Fact Checker gives evidence-linked assessments as of the time checked. It cannot certify truth, judge intent or guarantee accuracy.</p>
          </section>
        </div>
      </aside>
    </div>
  );
}
