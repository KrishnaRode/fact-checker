import type { Finding, GraphEdge, GraphNode, Passage, SourceRecord } from "@/lib/contracts";
import { canonicalizeUrl, clip, domainOf } from "@/lib/text";

/**
 * Source-independence analysis for ONE investigation.
 * - exact duplicates: identical normalized-content hash (basis: exact_hash)
 * - near duplicates: 5-word shingle Jaccard ≥ 0.5 on the first ~1,500 words (basis: text_similarity)
 *   Similarity does not prove copying or its direction → "possible shared origin".
 * - citations: an article body links to another retrieved source (basis: observed_link)
 * - shared citation: two sources link to the same external document (basis: observed_link)
 * - shared attribution: the same outlet/organisation named in "according to X" phrases
 *   (basis: attribution_text) → possible shared origin only.
 * Different domain names alone never establish independence.
 */
export type ProvDoc = {
  id: string;
  canonicalUrl: string;
  text: string;
  contentHash: string | null;
  links: string[];
  attributions: string[];
  title: string;
  publisher: string | null;
};

export type ProvLink = {
  relation: "cites_source" | "exact_duplicate" | "near_duplicate" | "possible_shared_origin";
  a: string;
  b: string;
  basis: GraphEdge["basis"];
  note: string;
};

export type ProvenanceResult = {
  links: ProvLink[];
  groups: Map<string, string>; // sourceId → origin group id
  status: Map<string, SourceRecord["provenanceStatus"]>;
  /** External URLs cited by ≥1 retrieved sources that were not themselves retrieved. */
  sharedCitations: { url: string; citedBy: string[] }[];
  /** Sources that other retrieved sources cite (likely originals). */
  citedOriginals: string[];
};

function shingles(text: string, k = 5): Set<number> {
  const words = text.toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, " ").split(/\s+/).filter(Boolean).slice(0, 1500);
  const out = new Set<number>();
  for (let i = 0; i + k <= words.length; i++) {
    let h = 2166136261;
    for (const ch of words.slice(i, i + k).join(" ")) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
    out.add(h >>> 0);
  }
  return out;
}

export function jaccard(a: Set<number>, b: Set<number>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  const [small, big] = a.size < b.size ? [a, b] : [b, a];
  for (const x of small) if (big.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

export function analyzeProvenance(docs: ProvDoc[]): ProvenanceResult {
  const links: ProvLink[] = [];
  const parent = new Map<string, string>();
  const strong = new Set<string>(); // ids joined by established relations
  const find = (x: string): string => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)!)!);
      x = parent.get(x)!;
    }
    return x;
  };
  const union = (a: string, b: string) => parent.set(find(a), find(b));
  for (const d of docs) parent.set(d.id, d.id);

  const byUrl = new Map(docs.map((d) => [canonicalizeUrl(d.canonicalUrl), d.id]));
  const sh = new Map(docs.map((d) => [d.id, d.text.length > 300 ? shingles(d.text) : new Set<number>()]));
  const citedOriginals = new Set<string>();

  for (let i = 0; i < docs.length; i++) {
    for (let j = i + 1; j < docs.length; j++) {
      const a = docs[i]!;
      const b = docs[j]!;
      if (a.contentHash && a.contentHash === b.contentHash) {
        links.push({ relation: "exact_duplicate", a: a.id, b: b.id, basis: "exact_hash", note: "Identical article text." });
        union(a.id, b.id);
        strong.add(a.id).add(b.id);
        continue;
      }
      const sim = jaccard(sh.get(a.id)!, sh.get(b.id)!);
      if (sim >= 0.5) {
        links.push({ relation: "near_duplicate", a: a.id, b: b.id, basis: "text_similarity", note: `Largely the same wording (${Math.round(sim * 100)}% overlapping phrases). Direction of copying unknown.` });
        union(a.id, b.id);
      }
    }
  }

  // Direct citations between retrieved sources.
  const citers = new Map<string, string[]>();
  for (const d of docs) {
    for (const l of d.links) {
      const target = byUrl.get(canonicalizeUrl(l));
      if (target && target !== d.id) {
        links.push({ relation: "cites_source", a: d.id, b: target, basis: "observed_link", note: "Links to this source in the article body." });
        union(d.id, target);
        strong.add(d.id).add(target);
        citedOriginals.add(target);
      } else if (!target && domainOf(l) !== domainOf(d.canonicalUrl)) {
        const k = canonicalizeUrl(l);
        citers.set(k, [...(citers.get(k) ?? []), d.id]);
      }
    }
  }

  // Shared external citations: two or more sources linking the same outside document.
  const sharedCitations: ProvenanceResult["sharedCitations"] = [];
  for (const [url, ids] of citers) {
    const uniq = [...new Set(ids)];
    if (uniq.length >= 2) {
      for (let i = 1; i < uniq.length; i++) {
        links.push({ relation: "possible_shared_origin", a: uniq[0]!, b: uniq[i]!, basis: "observed_link", note: `Both link to ${clip(url, 80)}.` });
        union(uniq[0]!, uniq[i]!);
      }
    }
    sharedCitations.push({ url, citedBy: uniq });
  }

  // Shared attribution phrases.
  const byAttr = new Map<string, string[]>();
  for (const d of docs) for (const a of d.attributions) byAttr.set(a.toLowerCase(), [...(byAttr.get(a.toLowerCase()) ?? []), d.id]);
  for (const [name, ids] of byAttr) {
    const uniq = [...new Set(ids)];
    for (let i = 1; i < uniq.length; i++) {
      if (find(uniq[0]!) === find(uniq[i]!)) continue;
      links.push({ relation: "possible_shared_origin", a: uniq[0]!, b: uniq[i]!, basis: "attribution_text", note: `Both attribute information to “${name}”.` });
      union(uniq[0]!, uniq[i]!);
    }
  }

  // Attribution naming another retrieved source's publisher ("according to a notice from X").
  for (const d of docs) {
    for (const a of d.attributions) {
      const target = docs.find((o) => o.id !== d.id && o.publisher && o.publisher.toLowerCase() === a.toLowerCase());
      if (!target || find(target.id) === find(d.id)) continue;
      links.push({ relation: "possible_shared_origin", a: d.id, b: target.id, basis: "attribution_text", note: `Attributes its information to ${target.publisher}, the publisher of this source.` });
      union(d.id, target.id);
    }
  }

  // Name groups G1..Gn for components with ≥2 members.
  const members = new Map<string, string[]>();
  for (const d of docs) members.set(find(d.id), [...(members.get(find(d.id)) ?? []), d.id]);
  const groups = new Map<string, string>();
  const status = new Map<string, SourceRecord["provenanceStatus"]>();
  let g = 1;
  for (const ids of members.values()) {
    if (ids.length < 2) {
      status.set(ids[0]!, "unknown");
      continue;
    }
    const gid = `G${g++}`;
    for (const id of ids) {
      groups.set(id, gid);
      status.set(id, strong.has(id) ? "established" : "possible_shared_origin");
    }
  }
  sharedCitations.sort((a, b) => b.citedBy.length - a.citedBy.length);
  return { links, groups, status, sharedCitations, citedOriginals: [...citedOriginals] };
}

/* ── Evidence graph ───────────────────────────────────────────────────────── */

export function buildGraph(findings: Finding[], claims: string[], sources: SourceRecord[], passages: Passage[], prov: ProvLink[]): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const cited = new Set(findings.flatMap((f) => [...f.supportingPassageIds, ...f.contradictingPassageIds, ...f.contextPassageIds]));
  claims.forEach((c, i) => nodes.push({ id: `claim:${i}`, type: "claim", label: clip(c, 90), refId: findings[i]?.id ?? `C${i + 1}` }));
  const usedPassages = passages.filter((p) => cited.has(p.id) || findings.length === 0);
  const usedSources = new Set(usedPassages.map((p) => p.sourceId));
  for (const l of prov) {
    usedSources.add(l.a);
    usedSources.add(l.b);
  }
  for (const s of sources) {
    if (!usedSources.has(s.id)) continue;
    nodes.push({ id: `source:${s.id}`, type: "source", label: s.publisher ?? domainOf(s.url), refId: s.id });
  }
  for (const p of usedPassages) {
    nodes.push({ id: `passage:${p.id}`, type: "passage", label: p.id, refId: p.id });
    edges.push({ id: `e:${p.sourceId}>${p.id}`, from: `source:${p.sourceId}`, to: `passage:${p.id}`, relation: "contains_passage", basis: "extraction", note: null });
  }
  findings.forEach((f, i) => {
    const add = (ids: string[], relation: GraphEdge["relation"]) => {
      for (const pid of ids) edges.push({ id: `e:${pid}>${i}:${relation}`, from: `passage:${pid}`, to: `claim:${i}`, relation, basis: "model_inferred", note: null });
    };
    add(f.supportingPassageIds, "supports_claim");
    add(f.contradictingPassageIds, "contradicts_claim");
    add(f.contextPassageIds, "provides_context");
  });
  const nodeIds = new Set(nodes.map((n) => n.id));
  for (const l of prov) {
    const from = `source:${l.a}`;
    const to = `source:${l.b}`;
    if (!nodeIds.has(from) || !nodeIds.has(to)) continue;
    edges.push({ id: `e:${l.a}~${l.b}:${l.relation}`, from, to, relation: l.relation, basis: l.basis, note: l.note });
  }
  return { nodes, edges };
}
