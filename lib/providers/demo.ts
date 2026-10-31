import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import { bm25Scores, canonicalizeUrl, coverage, terms } from "@/lib/text";
import { extractArticle } from "@/lib/investigation/extract";
import { hashContent, type DocumentSource, type FetchedDocument } from "@/lib/investigation/retrieval";
import type { Lead, Provider } from "./types";

/**
 * Demo mode: a bundled FICTIONAL corpus searched with the same ranking used for live feeds.
 * Documents are rendered to ordinary HTML pages and pass through the same extractor,
 * passage selection, provenance analysis, local model assessment and validators as live
 * documents. Nothing here is keyed to a particular claim string.
 */
export type DemoDoc = {
  id: string;
  url: string;
  publisher: string;
  kind: "news_article" | "web_page" | "reference";
  title: string;
  publishedAt: string | null;
  modifiedAt?: string | null;
  paragraphs: string[];
};
type Corpus = { referenceDate: string; referenceTimezone: string; documents: DemoDoc[] };

let corpus: Corpus | null = null;
const fixturesDir = () => path.join(process.cwd(), "fixtures", "demo");

export async function loadCorpus(): Promise<Corpus> {
  corpus ??= JSON.parse(await fs.readFile(path.join(fixturesDir(), "corpus.json"), "utf8")) as Corpus;
  return corpus;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Render a corpus entry as a realistic article page (navigation, footer and JSON-LD included). */
export function renderDemoHtml(d: DemoDoc): string {
  const ld = JSON.stringify({ "@context": "https://schema.org", "@type": d.kind === "news_article" ? "NewsArticle" : "WebPage", headline: d.title, datePublished: d.publishedAt ?? undefined, dateModified: d.modifiedAt ?? undefined, publisher: { "@type": "Organization", name: d.publisher } });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(d.title)} | ${esc(d.publisher)}</title>
<meta property="og:site_name" content="${esc(d.publisher)}"><meta property="og:title" content="${esc(d.title)}">
${d.publishedAt ? `<meta property="article:published_time" content="${d.publishedAt}">` : ""}
<link rel="canonical" href="${esc(d.url)}"><script type="application/ld+json">${ld}</script></head>
<body><nav><a href="/">Home</a> <a href="/city">City</a> <a href="/subscribe">Subscribe</a></nav>
<main><article><h1>${esc(d.title)}</h1>${d.paragraphs.map((p) => `<p>${p}</p>`).join("\n")}</article></main>
<footer><p>© ${esc(d.publisher)}. Fictional demo publication. All rights reserved. Privacy · Terms · Contact us for advertising.</p></footer></body></html>`;
}

function bestParagraph(paragraphs: string[], qTerms: string[]): string {
  const plain = paragraphs.map((p) => p.replace(/<[^>]+>/g, ""));
  const scores = plain.map((p) => coverage(qTerms, terms(p)));
  return plain[scores.indexOf(Math.max(...scores))] ?? plain[0] ?? "";
}

export const demoProvider: Provider = {
  id: "demo_corpus",
  name: "Bundled demo corpus (fictional)",
  kind: "core",
  scope: "selected",
  description: "Eleven fictional documents about the invented city of Kestrel Bay. No network access.",
  modes: ["demo"],
  timeoutMs: 2_000,
  cachePolicy: "Read from disk.",
  enabled: () => true,
  disabledReason: () => null,
  async search(q): Promise<Lead[]> {
    const c = await loadCorpus();
    const qTerms = terms(q.queries.join(" ") + " " + q.claims.join(" "));
    const docs = c.documents.map((d) => terms(`${d.title} ${d.title} ${d.paragraphs.join(" ").replace(/<[^>]+>/g, " ")}`));
    const scores = bm25Scores(qTerms, docs);
    return c.documents
      .map((d, i) => ({ d, s: scores[i]!, cov: coverage(qTerms, docs[i]!) }))
      .filter((x) => x.s > 0 && x.cov >= 0.2)
      .sort((a, b) => b.s - a.s)
      .slice(0, q.maxResults)
      .map(({ d }, i) => ({
        url: d.url,
        title: d.title,
        publisher: d.publisher,
        publishedAt: d.publishedAt,
        // Query-dependent snippet, as a search engine would return.
        snippet: bestParagraph(d.paragraphs, qTerms).slice(0, 240),
        provider: "demo_corpus",
        kind: d.kind === "reference" ? "reference" : d.kind,
        providerRank: i,
      }));
  },
};

export const demoDocumentSource: DocumentSource = {
  async fetch(lead): Promise<FetchedDocument> {
    const c = await loadCorpus();
    const d = c.documents.find((x) => canonicalizeUrl(x.url) === canonicalizeUrl(lead.url));
    if (!d) throw new Error("Not in the demo corpus.");
    const ex = extractArticle(renderDemoHtml(d), d.url);
    return {
      url: d.url,
      canonicalUrl: ex.canonicalUrl,
      title: ex.title,
      text: ex.text,
      publisher: ex.publisher,
      publishedAt: ex.publishedAt,
      modifiedAt: ex.modifiedAt ?? (d.modifiedAt ?? null),
      fetchedAt: new Date().toISOString(),
      access: "full_text",
      accessNote: "Bundled fictional demo document.",
      provider: "demo_corpus",
      kind: lead.kind,
      links: ex.links,
      attributions: ex.attributions,
      revisionId: null,
      factCheck: null,
      textKind: "article_body",
      contentHash: hashContent(ex.text),
      fromCache: false,
    };
  },
};
