"use client";

import { useMemo, useState } from "react";
import { useMediaQuery } from "@/lib/client/hooks";
import type { GraphEdge, InvestigationResult } from "@/lib/contracts";

/**
 * Claim–evidence map for one investigation. Stable three-column layout (claims · passages ·
 * sources), origin groups bracketed, provenance links drawn between sources. Every node is
 * keyboard-selectable and opens the inspector; a list view carries the same information.
 */
type Selection = { kind: "passage" | "source"; id: string };

const W = 960;
const ROW = 58;
const COL = { claim: 20, passage: 360, source: 650 };
const NODE_W = { claim: 280, passage: 220, source: 230 };

const EDGE_STYLE: Record<GraphEdge["relation"], { stroke: string; dash?: string; label: string }> = {
  supports_claim: { stroke: "var(--color-supported)", label: "supports" },
  contradicts_claim: { stroke: "var(--color-contradicted)", label: "contradicts" },
  provides_context: { stroke: "var(--color-neutral)", dash: "4 4", label: "context" },
  contains_passage: { stroke: "var(--color-text-faint)", label: "contains" },
  cites_source: { stroke: "var(--color-accent)", label: "cites" },
  exact_duplicate: { stroke: "var(--color-accent-strong)", dash: "2 4", label: "identical text" },
  near_duplicate: { stroke: "var(--color-accent-strong)", dash: "6 4", label: "near-duplicate" },
  possible_shared_origin: { stroke: "var(--color-accent-strong)", dash: "1 5", label: "possible shared origin" },
};

const BASIS: Record<GraphEdge["basis"], string> = {
  extraction: "extracted from the page",
  model_inferred: "model-inferred, citation validated",
  observed_link: "observed hyperlink",
  exact_hash: "identical content hash",
  text_similarity: "text similarity",
  attribution_text: "attribution in the text",
};

function clipLabel(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

export function EvidenceMap({ result, onSelect }: { result: InvestigationResult; onSelect: (s: Selection) => void }) {
  const narrow = useMediaQuery("(max-width: 640px)");
  const [chosen, setView] = useState<"map" | "list" | null>(null);
  const view = chosen ?? (narrow ? "list" : "map");
  const [focus, setFocus] = useState<string | null>(null);

  const layout = useMemo(() => {
    const { nodes, edges } = result.graph;
    const claims = nodes.filter((n) => n.type === "claim");
    const passages = nodes.filter((n) => n.type === "passage");
    const srcById = new Map(result.sources.map((s) => [s.id, s]));
    // Group sources by origin so a group's members sit together.
    const sources = nodes
      .filter((n) => n.type === "source")
      .sort((a, b) => (srcById.get(a.refId)?.originGroupId ?? "~" + a.refId).localeCompare(srcById.get(b.refId)?.originGroupId ?? "~" + b.refId));
    const rows = Math.max(claims.length, passages.length, sources.length, 1);
    const height = rows * ROW + 40;
    const pos = new Map<string, { x: number; y: number; w: number }>();
    const place = (list: typeof nodes, col: keyof typeof COL) => {
      const offset = ((rows - list.length) * ROW) / 2;
      list.forEach((n, i) => pos.set(n.id, { x: COL[col], y: 20 + offset + i * ROW + ROW / 2, w: NODE_W[col] }));
    };
    place(claims, "claim");
    // Order passages by their source order to reduce crossings.
    const sourceOrder = new Map(sources.map((s, i) => [s.refId, i]));
    const pById = new Map(result.passages.map((p) => [p.id, p]));
    passages.sort((a, b) => (sourceOrder.get(pById.get(a.refId)?.sourceId ?? "") ?? 0) - (sourceOrder.get(pById.get(b.refId)?.sourceId ?? "") ?? 0));
    place(passages, "passage");
    place(sources, "source");
    const groups = new Map<string, number[]>();
    for (const s of sources) {
      const g = srcById.get(s.refId)?.originGroupId;
      if (g) groups.set(g, [...(groups.get(g) ?? []), pos.get(s.id)!.y]);
    }
    return { nodes, edges, claims, passages, sources, height, pos, groups, srcById };
  }, [result]);

  const connected = useMemo(() => {
    if (!focus) return null;
    const set = new Set([focus]);
    for (const e of layout.edges) if (e.from === focus || e.to === focus) set.add(e.from).add(e.to);
    return set;
  }, [focus, layout.edges]);

  if (!layout.nodes.length) return <p className="text-[14px] text-text-faint">No evidence to map for this run.</p>;

  const activate = (nodeId: string) => {
    const n = layout.nodes.find((x) => x.id === nodeId);
    if (!n) return;
    if (n.type === "passage") onSelect({ kind: "passage", id: n.refId });
    else if (n.type === "source") onSelect({ kind: "source", id: n.refId });
  };

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div role="tablist" aria-label="Evidence view" className="inline-flex rounded-full border border-border bg-bg-soft p-0.5 text-[13px]">
          {(["map", "list"] as const).map((v) => (
            <button key={v} role="tab" aria-selected={view === v} type="button" onClick={() => setView(v)} className={`rounded-full px-3 py-1 capitalize transition ${view === v ? "bg-panel-hover text-text" : "text-text-faint hover:text-text-muted"}`}>
              {v}
            </button>
          ))}
        </div>
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-text-faint" aria-label="Legend">
          {(["supports_claim", "contradicts_claim", "provides_context", "cites_source", "near_duplicate"] as const).map((r) => (
            <li key={r} className="inline-flex items-center gap-1.5">
              <svg width="22" height="6" aria-hidden>
                <line x1="0" y1="3" x2="22" y2="3" stroke={EDGE_STYLE[r].stroke} strokeWidth="2" strokeDasharray={EDGE_STYLE[r].dash} />
              </svg>
              {EDGE_STYLE[r].label}
            </li>
          ))}
        </ul>
      </div>

      {view === "map" ? (
        <div className="scroll-thin overflow-x-auto rounded-2xl border border-border bg-bg-soft/60">
          <svg viewBox={`0 0 ${W} ${layout.height}`} className="block min-w-[720px]" width="100%" role="group" aria-label="Evidence map: claims, evidence passages and sources">
            {[...layout.groups.entries()].map(([g, ys]) => {
              const top = Math.min(...ys) - ROW / 2 + 6;
              const bottom = Math.max(...ys) + ROW / 2 - 6;
              return (
                <g key={g}>
                  <rect x={COL.source - 10} y={top} width={NODE_W.source + 20} height={bottom - top} rx="12" fill="rgba(109,139,255,0.05)" stroke="rgba(109,139,255,0.35)" strokeDasharray="3 4" />
                  <text x={COL.source + NODE_W.source + 18} y={top + 14} fontSize="11" fill="var(--color-text-faint)">
                    {g}
                  </text>
                </g>
              );
            })}
            {layout.edges.map((e) => {
              const a = layout.pos.get(e.from);
              const b = layout.pos.get(e.to);
              if (!a || !b) return null;
              const st = EDGE_STYLE[e.relation];
              const dim = connected && !(connected.has(e.from) && connected.has(e.to));
              let d: string;
              if (e.from.startsWith("source:") && e.to.startsWith("source:")) {
                const x = a.x + a.w;
                const bulge = 40 + Math.abs(b.y - a.y) * 0.25;
                d = `M${x} ${a.y} C${x + bulge} ${a.y}, ${x + bulge} ${b.y}, ${x} ${b.y}`;
              } else if (e.relation === "contains_passage") {
                // source (right) → passage (middle)
                d = `M${a.x} ${a.y} C${a.x - 40} ${a.y}, ${b.x + b.w + 40} ${b.y}, ${b.x + b.w} ${b.y}`;
              } else {
                // passage (middle) → claim (left)
                d = `M${a.x} ${a.y} C${a.x - 40} ${a.y}, ${b.x + b.w + 40} ${b.y}, ${b.x + b.w} ${b.y}`;
              }
              return (
                <path key={e.id} d={d} fill="none" stroke={st.stroke} strokeWidth={e.relation === "contains_passage" ? 1.2 : 2} strokeDasharray={st.dash} opacity={dim ? 0.12 : e.relation === "contains_passage" ? 0.55 : 0.9} className="transition-opacity duration-200">
                  <title>{`${st.label} — ${BASIS[e.basis]}${e.note ? `: ${e.note}` : ""}`}</title>
                </path>
              );
            })}
            {layout.nodes.map((n) => {
              const p = layout.pos.get(n.id);
              if (!p) return null;
              const src = n.type === "source" ? layout.srcById.get(n.refId) : undefined;
              const dim = connected && !connected.has(n.id);
              const interactive = n.type !== "claim";
              const label = n.type === "passage" ? `${n.label} · ${clipLabel(result.passages.find((x) => x.id === n.refId)?.text ?? "", 26)}` : clipLabel(n.label, n.type === "claim" ? 40 : 30);
              return (
                <g
                  key={n.id}
                  role={interactive ? "button" : undefined}
                  tabIndex={interactive ? 0 : undefined}
                  aria-label={interactive ? `${n.type === "passage" ? "Evidence passage" : "Source"} ${n.label}. Open details.` : `Claim: ${n.label}`}
                  onClick={() => interactive && activate(n.id)}
                  onKeyDown={(ev) => {
                    if (interactive && (ev.key === "Enter" || ev.key === " ")) {
                      ev.preventDefault();
                      activate(n.id);
                    }
                  }}
                  onMouseEnter={() => setFocus(n.id)}
                  onMouseLeave={() => setFocus(null)}
                  onFocus={() => setFocus(n.id)}
                  onBlur={() => setFocus(null)}
                  opacity={dim ? 0.35 : 1}
                  className={`transition-opacity duration-200 focus:outline-none ${interactive ? "cursor-pointer" : ""}`}
                >
                  <rect x={p.x} y={p.y - 19} width={p.w} height="38" rx="10" fill={n.type === "claim" ? "#141826" : "#0e1119"} stroke={focus === n.id ? "var(--color-accent)" : n.type === "claim" ? "var(--color-border-strong)" : "var(--color-border)"} strokeWidth={focus === n.id ? 2 : 1} />
                  <text x={p.x + 12} y={p.y + 4.5} fontSize="13" fill={n.type === "claim" ? "var(--color-text)" : "var(--color-text-muted)"}>
                    {label}
                  </text>
                  {src && src.access !== "full_text" && (
                    <text x={p.x + p.w - 12} y={p.y + 4.5} fontSize="11" textAnchor="end" fill="var(--color-unresolved)">
                      {src.access === "snippet_only" ? "snippet" : src.access}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        </div>
      ) : (
        <EvidenceList result={result} onSelect={onSelect} />
      )}
      <p className="mt-2 text-[12px] text-text-faint">Claim links are the local model&apos;s reading, with citations validated by code. Links between sources come from observed hyperlinks, identical text or text similarity — similarity alone does not prove who copied whom.</p>
    </div>
  );
}

function EvidenceList({ result, onSelect }: { result: InvestigationResult; onSelect: (s: Selection) => void }) {
  const sources = new Map(result.sources.map((s) => [s.id, s]));
  const passages = new Map(result.passages.map((p) => [p.id, p]));
  const provenance = result.graph.edges.filter((e) => e.from.startsWith("source:") && e.to.startsWith("source:"));
  return (
    <div className="space-y-4">
      {result.findings.map((f) => (
        <div key={f.id} className="rounded-2xl border border-border bg-bg-soft/60 p-4">
          <p className="text-[14px] text-text">“{f.claim}”</p>
          <ul className="mt-2 space-y-1.5">
            {(
              [
                ["supports", f.supportingPassageIds, "text-supported"],
                ["contradicts", f.contradictingPassageIds, "text-contradicted"],
                ["context", f.contextPassageIds, "text-neutral"],
              ] as const
            ).flatMap(([label, ids, cls]) =>
              ids.map((id) => {
                const p = passages.get(id);
                const s = p ? sources.get(p.sourceId) : undefined;
                return (
                  <li key={label + id}>
                    <button type="button" onClick={() => onSelect({ kind: "passage", id })} className="flex w-full items-baseline gap-2 rounded-lg px-2 py-1 text-left text-[13.5px] hover:bg-panel-hover">
                      <span className={`${cls} w-20 shrink-0 font-medium`}>{label}</span>
                      <span className="font-mono text-accent-strong">{id}</span>
                      <span className="truncate text-text-muted">{s?.publisher ?? s?.title}</span>
                    </button>
                  </li>
                );
              }),
            )}
          </ul>
        </div>
      ))}
      {provenance.length > 0 && (
        <div className="rounded-2xl border border-border bg-bg-soft/60 p-4">
          <p className="text-[12px] font-semibold uppercase tracking-[0.08em] text-text-faint">Source relationships</p>
          <ul className="mt-2 space-y-1.5 text-[13.5px] text-text-muted">
            {provenance.map((e) => (
              <li key={e.id}>
                <button type="button" onClick={() => onSelect({ kind: "source", id: e.from.slice(7) })} className="text-left hover:text-text">
                  {sources.get(e.from.slice(7))?.publisher} ↔ {sources.get(e.to.slice(7))?.publisher}: {EDGE_STYLE[e.relation].label} ({BASIS[e.basis]})
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export type { Selection };
