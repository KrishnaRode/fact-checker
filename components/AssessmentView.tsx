"use client";

import { AlertTriangle, Clock, Download, FileJson, Layers, Pencil, RefreshCw, RotateCcw, Telescope } from "lucide-react";
import type { InvestigationResult } from "@/lib/contracts";
import { download, toExportJson, toMarkdown } from "@/lib/client/export";
import { overallView } from "@/lib/client/verdicts";
import { ClaimFindings, FindingDetail } from "./ClaimFindings";
import { EvidenceMap, type Selection } from "./EvidenceMap";
import { formatSeconds } from "./InvestigationStream";

const PROVIDER_NAMES: Record<string, string> = {
  rss: "Selected news feeds",
  wikipedia: "Wikipedia",
  gdelt: "GDELT",
  brave: "Brave Search",
  google_fact_check: "Google Fact Check Tools",
  demo_corpus: "Demo corpus",
};

function when(iso: string, tz: string) {
  return new Date(iso).toLocaleString("en-IN", { timeZone: tz, day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** The answer, in the order the spec asks for: verdict → why → per claim → evidence → coverage → map. */
export function AssessmentView({
  result,
  onInspect,
  onRetry,
  onRefresh,
  onDeeper,
  onEdit,
}: {
  result: InvestigationResult;
  onInspect: (s: Selection) => void;
  onRetry: () => void;
  onRefresh: () => void;
  onDeeper: () => void;
  onEdit: () => void;
}) {
  const v = overallView(result);
  const single = result.findings.length === 1 && result.uncheckedClaims.length === 0 ? result.findings[0] : null;
  const inspectPassage = (id: string) => onInspect({ kind: "passage", id });
  const readable = result.sources.filter((s) => s.access === "full_text").length;
  const inaccessible = result.sources.length - readable;
  const failedProviders = result.coverage.providersAttempted.filter((p) => !result.coverage.providersSucceeded.includes(p));

  return (
    <div className="space-y-8">
      {/* 1–2. Verdict label, one-sentence finding, short explanation */}
      <div>
        <p className={`tone-${v.tone} text-[13px] font-semibold uppercase tracking-[0.1em]`} style={{ color: "var(--tone)" }}>
          {v.label}
        </p>
        <h2 className="font-display mt-2 text-balance text-[30px] leading-[1.15] text-text sm:text-[38px]">{result.status === "complete" ? result.summary : v.meaning}</h2>
        {result.status !== "complete" && result.statusReason && (
          <div className="mt-4 flex gap-3 rounded-2xl border border-border-strong bg-panel-raised p-4 text-[15px] leading-relaxed text-text-muted">
            <AlertTriangle size={18} className="mt-0.5 shrink-0 text-unresolved" aria-hidden />
            <div>
              <p className="text-text">{result.statusReason}</p>
              {result.status !== "cancelled" && result.sources.length > 0 && <p className="mt-1">{readable} source{readable === 1 ? " was" : "s were"} read before the run stopped; they are listed below for your own inspection.</p>}
              <button type="button" onClick={onRetry} className="mt-3 inline-flex items-center gap-2 rounded-full border border-border-strong px-3.5 py-1.5 text-[13.5px] text-text hover:border-text-faint">
                <RotateCcw size={14} aria-hidden /> Retry
              </button>
            </div>
          </div>
        )}
        {result.status === "complete" && <p className="mt-3 text-[14px] text-text-faint">{v.meaning}</p>}
      </div>

      {result.uncheckedClaims.length > 0 && (
        <div className="rounded-2xl border border-unresolved/35 bg-unresolved/[0.05] p-4">
          <p className="flex items-center gap-2 text-[15px] font-medium text-text">
            <Layers size={16} className="text-unresolved" aria-hidden /> Only {result.findings.length} of {result.findings.length + result.uncheckedClaims.length} claims were checked
          </p>
          <p className="mt-1 text-[14px] text-text-muted">The whole submission has not been verified. These were deferred:</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-[14px] text-text-muted">
            {result.uncheckedClaims.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
      )}

      {result.assumptions.length > 0 && (
        <div className="flex items-start gap-3 text-[14px] text-text-muted">
          <Clock size={15} className="mt-0.5 shrink-0 text-text-faint" aria-hidden />
          <p>
            {result.assumptions.join(" ")}{" "}
            <button type="button" onClick={onEdit} className="inline-flex items-center gap-1 text-accent-strong hover:text-text">
              <Pencil size={12} aria-hidden /> Edit the claim
            </button>
          </p>
        </div>
      )}

      {/* 3–4. Findings with evidence */}
      {single ? <FindingDetail finding={single} result={result} onInspect={inspectPassage} showClaim={false} /> : result.findings.length > 0 && <ClaimFindings result={result} onInspect={inspectPassage} />}

      {/* 5. Time, freshness and coverage */}
      <section aria-label="Coverage and freshness" className="grid gap-3 rounded-2xl border border-border bg-bg-soft/60 p-4 text-[13.5px] leading-relaxed text-text-muted sm:grid-cols-2">
        <div>
          <p className="text-text">
            Checked {when(result.assessedAt, result.referenceTimezone)}
            {result.origin === "cached_run" && <span className="ml-2 rounded-full border border-border-strong px-2 py-px text-[11.5px] text-text-muted">Cached result</span>}
            {result.mode === "demo" && <span className="ml-2 rounded-full border border-unresolved/40 px-2 py-px text-[11.5px] text-unresolved">Demo · bundled evidence</span>}
          </p>
          <p>
            Reference date {new Date(`${result.referenceDate}T12:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })} ({result.referenceTimezone.replace("_", " ")})
            {result.origin === "cached_run" && result.cacheExpiresAt && <> · reused until {when(result.cacheExpiresAt, result.referenceTimezone)}</>}
          </p>
          <p>
            {result.origin === "cached_run" ? "Served from cache" : `${formatSeconds(result.timing.totalMs)} total`}
            {result.origin === "fresh_run" && result.timing.firstEvidenceMs != null && <> · first evidence at {formatSeconds(result.timing.firstEvidenceMs)}</>}
            {result.model && <> · {result.model} on this computer</>}
          </p>
        </div>
        <div>
          <p className="text-text">{result.mode === "demo" ? "Bundled fictional corpus — no internet search" : result.coverage.scope === "broader_web" ? "Broader web search enabled" : "Selected-source coverage"}</p>
          <p>
            {result.sources.length} source{result.sources.length === 1 ? "" : "s"} considered · {readable} read in full{inaccessible ? ` · ${inaccessible} not readable` : ""}
          </p>
          <p>Answered: {result.coverage.providersSucceeded.map((p) => PROVIDER_NAMES[p] ?? p).join(", ") || "none"}{failedProviders.length ? ` · unavailable: ${failedProviders.map((p) => PROVIDER_NAMES[p] ?? p).join(", ")}` : ""}</p>
        </div>
        {result.coverage.warnings.length > 0 && (
          <ul className="space-y-0.5 text-[13px] text-text-faint sm:col-span-2">
            {result.coverage.warnings.map((w) => (
              <li key={w}>· {w}</li>
            ))}
          </ul>
        )}
      </section>

      {/* Actions */}
      <div className="flex flex-wrap gap-2">
        {result.status === "complete" && (
          <button type="button" onClick={onDeeper} className="inline-flex items-center gap-2 rounded-full border border-accent/50 bg-accent/10 px-4 py-2 text-[14px] font-medium text-accent-strong transition hover:bg-accent/20">
            <Telescope size={15} aria-hidden /> Investigate further
          </button>
        )}
        <button type="button" onClick={onRefresh} className="inline-flex items-center gap-2 rounded-full border border-border px-4 py-2 text-[14px] text-text-muted transition hover:border-border-strong hover:text-text">
          <RefreshCw size={14} aria-hidden /> Refresh
        </button>
        <button type="button" onClick={() => download(`fact-check-${result.id}.md`, toMarkdown(result), "text/markdown")} className="inline-flex items-center gap-2 rounded-full border border-border px-4 py-2 text-[14px] text-text-muted transition hover:border-border-strong hover:text-text">
          <Download size={14} aria-hidden /> Markdown
        </button>
        <button type="button" onClick={() => download(`fact-check-${result.id}.json`, toExportJson(result), "application/json")} className="inline-flex items-center gap-2 rounded-full border border-border px-4 py-2 text-[14px] text-text-muted transition hover:border-border-strong hover:text-text">
          <FileJson size={14} aria-hidden /> JSON
        </button>
      </div>

      {/* 6. Evidence map + sources */}
      {result.sources.length > 0 && (
        <details className="group rounded-2xl border border-border bg-panel/50 p-4 sm:p-5" open={result.findings.length > 0 && result.passages.length > 0 ? undefined : true}>
          <summary className="flex items-center justify-between text-[15px] font-medium text-text">
            Evidence map &amp; sources
            <span className="text-text-faint transition group-open:rotate-180" aria-hidden>
              ▾
            </span>
          </summary>
          <div className="mt-4 space-y-6">
            <EvidenceMap result={result} onSelect={onInspect} />
            <div>
              <p className="mb-2 text-[12px] font-semibold uppercase tracking-[0.08em] text-text-faint">All sources</p>
              <ul className="divide-y divide-border">
                {result.sources.map((s) => (
                  <li key={s.id}>
                    <button type="button" onClick={() => onInspect({ kind: "source", id: s.id })} className="flex w-full items-baseline gap-3 py-2 text-left text-[13.5px] hover:text-text">
                      <span className="w-7 shrink-0 font-mono text-text-faint">{s.id}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-text-muted">{s.title}</span>
                        <span className="text-[12.5px] text-text-faint">
                          {s.publisher ?? "Unknown"} · {s.publishedAt ? new Date(s.publishedAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "date unknown"}
                          {s.access !== "full_text" && <span className="text-unresolved"> · {s.access === "snippet_only" ? "snippet only" : s.access}</span>}
                          {s.originGroupId && <span> · origin {s.originGroupId}</span>}
                          {s.kind === "user_submitted" && <span> · your article (not counted as corroboration)</span>}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </details>
      )}
    </div>
  );
}
