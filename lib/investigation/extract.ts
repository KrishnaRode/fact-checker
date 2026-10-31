import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import { canonicalizeUrl, domainOf, normalizeText, toIso } from "@/lib/text";

/**
 * HTML → readable article text + metadata. Scripts are never executed (linkedom is a DOM
 * parser, not a browser). Navigation, ads and boilerplate are dropped by Readability; text is
 * rebuilt from block elements so paragraph boundaries survive for passage offsets.
 */
export type ExtractedDocument = {
  title: string;
  text: string;
  publisher: string | null;
  byline: string | null;
  publishedAt: string | null;
  modifiedAt: string | null;
  canonicalUrl: string;
  /** Absolute outbound links found inside the article body. */
  links: string[];
  /** Organisations/outlets named in attribution phrases ("according to X", "X reported"). */
  attributions: string[];
  extractionNote: string | null;
};

type JsonLd = Record<string, unknown>;

function collectJsonLd(document: Document): JsonLd[] {
  const out: JsonLd[] = [];
  for (const s of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
    try {
      const data = JSON.parse(s.textContent ?? "") as unknown;
      const stack = Array.isArray(data) ? [...data] : [data];
      while (stack.length) {
        const item = stack.shift();
        if (!item || typeof item !== "object") continue;
        const obj = item as JsonLd;
        out.push(obj);
        if (Array.isArray(obj["@graph"])) stack.push(...(obj["@graph"] as unknown[]));
      }
    } catch {
      /* malformed JSON-LD is ignored */
    }
  }
  return out;
}

function meta(document: Document, ...names: string[]): string | null {
  for (const n of names) {
    const el = document.querySelector(`meta[property="${n}"], meta[name="${n}"], meta[itemprop="${n}"]`);
    const v = el?.getAttribute("content")?.trim();
    if (v) return v;
  }
  return null;
}

const BLOCKS = "p, h1, h2, h3, h4, li, blockquote, pre, figcaption, td";

function blockText(html: string): string {
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  const parts: string[] = [];
  const els = Array.from(document.querySelectorAll(BLOCKS));
  for (const el of els) {
    // Skip containers whose text is already captured by a nested block.
    if (el.querySelector(BLOCKS)) continue;
    const t = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    if (t) parts.push(t);
  }
  if (!parts.length) return (document.body?.textContent ?? "").replace(/\s+/g, " ").trim();
  return parts.join("\n\n");
}

const ATTRIBUTION_RE =
  /\b(?:according to|reported by|citing|cited by|said in a statement from|a statement from|a notice (?:from|by|published by)|(?:first )?reported)\s+(?:the\s+)?((?:[A-Z][\w&'’.-]*\s?){1,6})/g;

export function findAttributions(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(ATTRIBUTION_RE)) {
    const name = m[1]!.trim().replace(/[.,;:]$/, "");
    if (name.length > 2 && name.split(" ").length <= 6) out.add(name);
  }
  return [...out].slice(0, 8);
}

export function extractArticle(html: string, url: string, maxChars = 80_000): ExtractedDocument {
  const { document } = parseHTML(html);
  const ld = collectJsonLd(document as unknown as Document);
  const article = ld.find((o) => /Article|Report|Posting|WebPage|GovernmentPermit|SpecialAnnouncement/i.test(String(o["@type"] ?? "")));
  const publisherObj = (article?.publisher ?? null) as { name?: string } | null;

  const canonicalHref = (document as unknown as Document).querySelector('link[rel="canonical"]')?.getAttribute("href");
  let canonical = url;
  if (canonicalHref) {
    try {
      const abs = new URL(canonicalHref, url);
      if (abs.protocol === "https:" || abs.protocol === "http:") canonical = abs.href;
    } catch {
      /* ignore */
    }
  }

  const doc = document as unknown as Document;
  const publishedAt =
    toIso(article?.datePublished) ?? toIso(meta(doc, "article:published_time", "datePublished", "pubdate", "date", "dc.date", "DC.date.issued"));
  const modifiedAt = toIso(article?.dateModified) ?? toIso(meta(doc, "article:modified_time", "dateModified", "og:updated_time"));
  const siteName = meta(doc, "og:site_name", "application-name") ?? publisherObj?.name ?? null;
  const metaTitle = meta(doc, "og:title", "twitter:title");

  let title = metaTitle ?? doc.querySelector("title")?.textContent?.trim() ?? "";
  let text = "";
  let byline: string | null = null;
  let links: string[] = [];
  let note: string | null = null;

  try {
    const parsed = new Readability(doc, { charThreshold: 120, keepClasses: false }).parse();
    if (parsed?.content) {
      title = parsed.title?.trim() || title;
      byline = parsed.byline?.trim() || null;
      text = blockText(parsed.content);
      const { document: frag } = parseHTML(`<!doctype html><html><body>${parsed.content}</body></html>`);
      links = Array.from(frag.querySelectorAll("a[href]"))
        .map((a) => {
          try {
            const u = new URL(a.getAttribute("href") ?? "", url);
            return u.protocol === "http:" || u.protocol === "https:" ? canonicalizeUrl(u.href) : null;
          } catch {
            return null;
          }
        })
        .filter((u): u is string => !!u && domainOf(u) !== "");
    }
  } catch {
    note = "The article layout could not be parsed cleanly; using the page's paragraphs.";
  }
  if (!text) {
    const { document: fresh } = parseHTML(html);
    for (const el of Array.from(fresh.querySelectorAll("script, style, nav, header, footer, aside, form, noscript"))) el.remove();
    text = Array.from(fresh.querySelectorAll("p"))
      .map((p) => (p.textContent ?? "").replace(/\s+/g, " ").trim())
      .filter((t) => t.length > 40)
      .join("\n\n");
    if (text) note ??= "Extracted paragraphs without an article structure.";
  }

  const normalized = normalizeText(text);
  const truncated = normalized.length > maxChars;
  return {
    title: (title || url).replace(/\s+/g, " ").trim().slice(0, 300),
    text: truncated ? normalized.slice(0, maxChars) : normalized,
    publisher: siteName,
    byline,
    publishedAt,
    modifiedAt,
    canonicalUrl: canonicalizeUrl(canonical),
    links: [...new Set(links)].slice(0, 200),
    attributions: findAttributions(normalized),
    extractionNote: truncated ? "Very long page: only the first part was read." : note,
  };
}
