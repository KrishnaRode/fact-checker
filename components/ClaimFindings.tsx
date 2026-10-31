"use client";

import { Check, HelpCircle, Info, Minus, Quote, ShieldAlert, X } from "lucide-react";
import type { Finding, InvestigationResult, Passage, SourceRecord } from "@/lib/contracts";
import { VERDICT_VIEW } from "@/lib/client/verdicts";

const SMALL_ICON = { check: Check, cross: X, context: Info, question: HelpCircle, minus: Minus, incomplete: Minus, stop: Minus };

export function VerdictBadge({ verdict }: { verdict: Finding["verdict"] }) {
  const v = VERDICT_VIEW[verdict];
  const Icon = SMALL_ICON[v.icon];
  return (
    <span className={`tone-${v.tone} inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12.5px] font-medium`} style={{ color: "var(--tone)", borderColor: "color-mix(in oklab, var(--tone) 40%, transparent)", background: "color-mix(in oklab, var(--tone) 9%, transparent)" }}>
      <Icon size={13} strokeWidth={2.6} aria-hidden />
      {v.label}
    </span>
  );
}

/** Model prose with [P3] references turned into buttons that open the passage. */
export function CitedText({ text, onInspect, known }: { text: string; onInspect: (id: string) => void; known: Set<string> }) {
  // Bracketed [P3] and bare P3 references to known passages both become buttons.
  const parts = text.split(/(\[?\bP\d{1,3}\b\]?(?:\s*,?\s*\[?\bP\d{1,3}\b\]?)*)/g);
  return (
    <>
      {parts.map((part, i) => {
        const ids = [...part.matchAll(/\bP(\d{1,3})\b/g)].map((m) => `P${m[1]}`).filter((id) => known.has(id));
        if (!ids.length && /^\[?P\d/.test(part)) return <span key={i}>{part}</span>;
        if (!ids.length) return <span key={i}>{part}</span>;
        return (
          <span key={i} className="whitespace-nowrap">
            {ids.map((id) =>
              known.has(id) ? (
                <button key={id} type="button" onClick={() => onInspect(id)} className="mx-0.5 rounded-md border border-border-strong bg-panel-hover px-1.5 py-px align-[1px] font-mono text-[11.5px] text-accent-strong transition hover:border-accent hover:text-text" aria-label={`Open evidence passage ${id}`}>
                  {id}
                </button>
              ) : null,
            )}
          </span>
        );
      })}
    </>
  );
}

export function PassageCard({ passage, source, stance, onInspect }: { passage: Passage; source: SourceRecord | undefined; stance: "supports" | "contradicts" | "context"; onInspect: (id: string) => void }) {
  const tone = stance === "supports" ? "supported" : stance === "contradicts" ? "contradicted" : "neutral";
  return (
    <li>
      <button type="button" onClick={() => onInspect(passage.id)} className={`tone-${tone} group block w-full rounded-xl border border-border bg-bg-soft/70 p-3.5 text-left transition hover:border-border-strong hover:bg-panel-hover`}>
        <div className="flex items-start gap-3">
          <span className="mt-0.5 h-auto w-[3px] self-stretch rounded-full" style={{ background: "var(--tone)" }} aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="line-clamp-4 text-[14.5px] leading-relaxed text-text">
              <Quote size={12} className="mr-1 inline -translate-y-0.5 text-text-faint" aria-hidden />
              {passage.text}
            </p>
            <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-text-faint">
              <span className="font-mono text-accent-strong">{passage.id}</span>
              <span className="text-text-muted">{source?.publisher ?? source?.title ?? "Unknown source"}</span>
              {source?.publishedAt && <span>· {new Date(source.publishedAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}</span>}
              {passage.retrievalKind !== "article_body" && <span className="text-unresolved">· {passage.retrievalKind === "feed_excerpt" ? "feed summary" : "search snippet"} only</span>}
              {source?.originGroupId && <span>· origin group {source.originGroupId}</span>}
              {passage.isQuotation && <span>· quoted statement</span>}
              {passage.suspectedInjection && (
                <span className="inline-flex items-center gap-1 text-unresolved">
                  · <ShieldAlert size={12} aria-hidden /> contains instructions aimed at AI
                </span>
              )}
            </p>
          </div>
        </div>
      </button>
    </li>
  );
}

function EvidenceGroup({ title, ids, stance, result, onInspect }: { title: string; ids: string[]; stance: "supports" | "contradicts" | "context"; result: InvestigationResult; onInspect: (id: string) => void }) {
  if (!ids.length) return null;
  const passages = new Map(result.passages.map((p) => [p.id, p]));
  const sources = new Map(result.sources.map((s) => [s.id, s]));
  const cited = new Set(result.graph.edges.filter((e) => e.relation === "cites_source").map((e) => e.to.slice(7)));
  // Passages from one origin group are one line of evidence: show the likely original
  // (cited by others, else earliest) and fold the copies beneath it.
  const groups = new Map<string, string[]>();
  for (const id of ids) {
    const p = passages.get(id);
    if (!p) continue;
    const g = sources.get(p.sourceId)?.originGroupId ?? `solo:${id}`;
    groups.set(g, [...(groups.get(g) ?? []), id]);
  }
  const rank = (id: string) => {
    const s = sources.get(passages.get(id)!.sourceId);
    return (s && cited.has(s.id) ? 0 : 1) * 1e13 + (s?.publishedAt ? new Date(s.publishedAt).getTime() : 9e12);
  };
  return (
    <div>
      <h4 className="mb-2 text-[12px] font-semibold uppercase tracking-[0.08em] text-text-faint">{title}</h4>
      <ul className="space-y-2">
        {[...groups.values()].map((members) => {
          const [lead, ...copies] = [...members].sort((a, b) => rank(a) - rank(b));
          const p = passages.get(lead!)!;
          return (
            <li key={lead} className="space-y-1.5">
              <ul>
                <PassageCard passage={p} source={sources.get(p.sourceId)} stance={stance} onInspect={onInspect} />
              </ul>
              {copies.length > 0 && (
                <details className="ml-4 text-[13px] text-text-faint">
                  <summary className="py-1 hover:text-text-muted">
                    + {copies.length} more from the same origin ({copies.map((c) => sources.get(passages.get(c)!.sourceId)?.publisher ?? c).join(", ")}) — counted as one line of evidence
                  </summary>
                  <ul className="mt-1.5 space-y-2">
                    {copies.map((c) => (
                      <PassageCard key={c} passage={passages.get(c)!} source={sources.get(passages.get(c)!.sourceId)} stance={stance} onInspect={onInspect} />
                    ))}
                  </ul>
                </details>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function FindingDetail({ finding, result, onInspect, showClaim }: { finding: Finding; result: InvestigationResult; onInspect: (id: string) => void; showClaim: boolean }) {
  const known = new Set(result.passages.map((p) => p.id));
  return (
    <div className="space-y-5">
      {showClaim && (
        <div className="space-y-2">
          <VerdictBadge verdict={finding.verdict} />
          <p className="text-[17px] leading-snug text-text">“{finding.claim}”</p>
          <p className="text-[15px] leading-relaxed text-text-muted">
            <CitedText text={finding.headline} onInspect={onInspect} known={known} />
          </p>
        </div>
      )}
      <p className="text-[15.5px] leading-relaxed text-text-muted">
        <CitedText text={finding.explanation} onInspect={onInspect} known={known} />
      </p>
      <div className="grid gap-5">
        <EvidenceGroup title="Supporting evidence" ids={finding.supportingPassageIds} stance="supports" result={result} onInspect={onInspect} />
        <EvidenceGroup title="Conflicting evidence" ids={finding.contradictingPassageIds} stance="contradicts" result={result} onInspect={onInspect} />
        <EvidenceGroup title="Context" ids={finding.contextPassageIds} stance="context" result={result} onInspect={onInspect} />
      </div>
      {(finding.missingEvidence.length > 0 || finding.limitations.length > 0 || finding.validationNotes.length > 0) && (
        <dl className="grid gap-3 rounded-xl border border-border bg-bg-soft/50 p-4 text-[14px] leading-relaxed">
          {finding.missingEvidence.length > 0 && (
            <div>
              <dt className="text-[12px] font-semibold uppercase tracking-[0.08em] text-text-faint">Still unresolved</dt>
              <dd className="mt-1 text-text-muted">{finding.missingEvidence.join(" · ")}</dd>
            </div>
          )}
          {finding.limitations.length > 0 && (
            <div>
              <dt className="text-[12px] font-semibold uppercase tracking-[0.08em] text-text-faint">Limitations</dt>
              <dd className="mt-1 text-text-muted">{finding.limitations.join(" · ")}</dd>
            </div>
          )}
          {finding.validationNotes.length > 0 && (
            <div>
              <dt className="text-[12px] font-semibold uppercase tracking-[0.08em] text-text-faint">Evidence checks</dt>
              <dd className="mt-1 text-text-muted">
                {finding.modelProposedVerdict && (
                  <span className="text-text">
                    The local model proposed “{VERDICT_VIEW[finding.modelProposedVerdict].label}”; the evidence checks changed it.{" "}
                  </span>
                )}
                {finding.validationNotes.join(" ")}
              </dd>
            </div>
          )}
        </dl>
      )}
    </div>
  );
}

/** Per-claim list for multi-claim submissions. */
export function ClaimFindings({ result, onInspect }: { result: InvestigationResult; onInspect: (id: string) => void }) {
  return (
    <ol className="space-y-4">
      {result.findings.map((f) => (
        <li key={f.id} className="rounded-2xl border border-border bg-panel/70 p-5">
          <p className="mb-3 font-mono text-[12px] text-text-faint">Claim {f.id.slice(1)} of {result.findings.length + result.uncheckedClaims.length}</p>
          <FindingDetail finding={f} result={result} onInspect={onInspect} showClaim />
        </li>
      ))}
    </ol>
  );
}
