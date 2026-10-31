"use client";

import { ExternalLink, GitMerge, ShieldAlert, X } from "lucide-react";
import { useEffect, useRef } from "react";
import type { InvestigationResult } from "@/lib/contracts";
import type { Selection } from "./EvidenceMap";

function safeHref(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

function fmt(d: string | null): string {
  if (!d) return "Unknown";
  return new Date(d).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

const ACCESS: Record<string, string> = {
  full_text: "Full article text read",
  snippet_only: "Only a snippet or summary was available",
  blocked: "Blocked (paywall, robots.txt or sign-in)",
  failed: "Could not be read",
};
const PROVENANCE: Record<string, string> = {
  established: "Relationship established (identical text or a direct link)",
  possible_shared_origin: "Possible shared origin (similar text or the same attribution)",
  unknown: "Unknown — no link to other sources was observed; that does not prove independence",
};

/** Side drawer (bottom sheet on mobile) with the exact passage and its source metadata. */
export function EvidenceInspector({ result, selection, onClose, onSelect }: { result: InvestigationResult; selection: Selection | null; onClose: () => void; onSelect: (s: Selection) => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!selection) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selection, onClose]);
  if (!selection) return null;

  const passage = selection.kind === "passage" ? result.passages.find((p) => p.id === selection.id) : undefined;
  const source = result.sources.find((s) => s.id === (passage ? passage.sourceId : selection.id));
  if (!source) return null;
  const href = result.mode === "demo" ? null : safeHref(source.url);
  const relations = result.graph.edges.filter((e) => e.from.startsWith("source:") && e.to.startsWith("source:") && (e.from === `source:${source.id}` || e.to === `source:${source.id}`));
  const otherPassages = result.passages.filter((p) => p.sourceId === source.id && p.id !== passage?.id);
  const usage = passage
    ? result.findings.flatMap((f) => [
        ...(f.supportingPassageIds.includes(passage.id) ? [`supports claim ${f.id.slice(1)}`] : []),
        ...(f.contradictingPassageIds.includes(passage.id) ? [`contradicts claim ${f.id.slice(1)}`] : []),
        ...(f.contextPassageIds.includes(passage.id) ? [`context for claim ${f.id.slice(1)}`] : []),
      ])
    : [];

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="Evidence details">
      <button type="button" aria-label="Close evidence details" className="absolute inset-0 bg-black/55 backdrop-blur-[2px] animate-fade" onClick={onClose} />
      <aside className="scroll-thin absolute inset-x-0 bottom-0 max-h-[86dvh] overflow-y-auto rounded-t-3xl border border-border bg-panel p-5 shadow-2xl animate-rise sm:inset-y-0 sm:left-auto sm:right-0 sm:max-h-none sm:w-[480px] sm:rounded-none sm:rounded-l-3xl sm:p-7">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-[12px] font-semibold uppercase tracking-[0.08em] text-text-faint">{passage ? `Evidence passage ${passage.id}` : `Source ${source.id}`}</p>
            <h3 className="mt-1 text-[18px] font-semibold leading-snug text-text">{source.title}</h3>
            <p className="mt-1 text-[14px] text-text-muted">{source.publisher ?? "Unknown publisher"}</p>
          </div>
          <button ref={closeRef} type="button" onClick={onClose} className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-border text-text-muted hover:text-text" aria-label="Close">
            <X size={16} />
          </button>
        </div>

        {passage && (
          <figure className="mt-5">
            <blockquote className="rounded-2xl border border-border bg-bg-soft p-4 text-[15.5px] leading-relaxed text-text whitespace-pre-line">{passage.text}</blockquote>
            <figcaption className="mt-2 text-[12.5px] leading-relaxed text-text-faint">
              Exact extracted text ({passage.retrievalKind === "article_body" ? "article body" : passage.retrievalKind === "feed_excerpt" ? "feed summary" : passage.retrievalKind === "social_post" ? "public social post" : "search snippet"}), characters {passage.normalizedStart.toLocaleString()}–{passage.normalizedEnd.toLocaleString()} of the normalized page text.
              {usage.length > 0 && <span className="block text-text-muted">Used as: {usage.join(", ")}.</span>}
              {passage.isQuotation && <span className="block">Mostly a quoted statement — it shows what was said, not that it is true.</span>}
            </figcaption>
            {passage.suspectedInjection && (
              <p className="mt-3 flex gap-2 rounded-xl border border-unresolved/30 bg-unresolved/5 p-3 text-[13px] text-text-muted">
                <ShieldAlert size={16} className="mt-0.5 shrink-0 text-unresolved" aria-hidden />
                This passage contains text addressed to AI systems. It was treated as page content only; it could not change instructions, tools or the label.
              </p>
            )}
          </figure>
        )}

        <dl className="mt-5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[13.5px]">
          <dt className="text-text-faint">Published</dt>
          <dd className="text-text-muted">{fmt(source.publishedAt)}</dd>
          {source.modifiedAt && (
            <>
              <dt className="text-text-faint">Updated</dt>
              <dd className="text-text-muted">{fmt(source.modifiedAt)}</dd>
            </>
          )}
          <dt className="text-text-faint">Read</dt>
          <dd className="text-text-muted">{fmt(source.fetchedAt)}</dd>
          <dt className="text-text-faint">Access</dt>
          <dd className="text-text-muted">
            {ACCESS[source.access]}
            {source.accessNote && <span className="block text-text-faint">{source.accessNote}</span>}
          </dd>
          <dt className="text-text-faint">Found via</dt>
          <dd className="text-text-muted">{source.provider === "demo_corpus" ? "Bundled demo corpus (fictional)" : source.provider === "user_url" ? "Your link" : source.provider === "social_mastodon" ? "Mastodon public hashtag — social lead, low reliability, never counted as evidence" : source.provider === "social_link" ? "A news link shared on social media (the article itself was checked)" : source.provider}</dd>
          {source.revisionId && (
            <>
              <dt className="text-text-faint">Revision</dt>
              <dd className="font-mono text-text-muted">{source.revisionId}</dd>
            </>
          )}
          <dt className="text-text-faint">Independence</dt>
          <dd className="text-text-muted">
            {PROVENANCE[source.provenanceStatus]}
            {source.originGroupId && <span className="block text-text-faint">Origin group {source.originGroupId}</span>}
          </dd>
          {source.dateNotes.length > 0 && (
            <>
              <dt className="text-text-faint">Dates in text</dt>
              <dd className="text-text-muted">{source.dateNotes.join(" · ")}</dd>
            </>
          )}
          {source.factCheckRating && (
            <>
              <dt className="text-text-faint">Fact-check</dt>
              <dd className="text-text-muted">
                {source.factCheckRating.publisher} rated “{source.factCheckRating.reviewedClaim}” as <span className="text-text">{source.factCheckRating.rating}</span>. Whether that matches this exact claim is part of the assessment.
              </dd>
            </>
          )}
        </dl>

        {relations.length > 0 && (
          <div className="mt-5">
            <p className="text-[12px] font-semibold uppercase tracking-[0.08em] text-text-faint">Related sources</p>
            <ul className="mt-2 space-y-1.5">
              {relations.map((e) => {
                const otherId = (e.from === `source:${source.id}` ? e.to : e.from).slice(7);
                const other = result.sources.find((s) => s.id === otherId);
                return (
                  <li key={e.id}>
                    <button type="button" onClick={() => onSelect({ kind: "source", id: otherId })} className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left text-[13.5px] text-text-muted hover:bg-panel-hover">
                      <GitMerge size={14} className="mt-0.5 shrink-0 text-accent-strong" aria-hidden />
                      <span>
                        <span className="text-text">{other?.publisher ?? otherId}</span> — {e.note ?? e.relation.replace(/_/g, " ")}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {otherPassages.length > 0 && (
          <div className="mt-5">
            <p className="text-[12px] font-semibold uppercase tracking-[0.08em] text-text-faint">Other passages from this source</p>
            <ul className="mt-2 space-y-1.5">
              {otherPassages.map((p) => (
                <li key={p.id}>
                  <button type="button" onClick={() => onSelect({ kind: "passage", id: p.id })} className="w-full rounded-lg px-2 py-1.5 text-left text-[13.5px] text-text-muted hover:bg-panel-hover">
                    <span className="font-mono text-accent-strong">{p.id}</span> <span className="line-clamp-2">{p.text}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="mt-6 border-t border-border pt-4">
          {href ? (
            <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex items-center gap-2 text-[14px] font-medium text-accent-strong hover:text-text">
              Open the original page <ExternalLink size={14} aria-hidden />
            </a>
          ) : (
            <p className="text-[13px] text-text-faint">{result.mode === "demo" ? "Fictional demo source — there is no real page to open." : "This source has no openable web address."}</p>
          )}
          <p className="mt-1 break-all font-mono text-[11.5px] text-text-faint">{source.url}</p>
        </div>
      </aside>
    </div>
  );
}
