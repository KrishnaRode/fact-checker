import { XMLParser } from "fast-xml-parser";
import { stripHtml, toIso } from "@/lib/text";

/**
 * RSS/Atom parsing shared by the app server and the browser extension (no DOM needed, so it
 * also runs in the extension's background service worker).
 */
export type FeedEntry = {
  url: string;
  title: string;
  summary: string;
  publishedAt: string | null;
  publisher: string;
  feedId: string;
};

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", textNodeName: "#text", processEntities: true, htmlEntities: true });

function text(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string" || typeof v === "number") return String(v);
  if (Array.isArray(v)) return text(v[0]);
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("#text" in o) return text(o["#text"]);
    if ("@_href" in o) return text(o["@_href"]);
  }
  return "";
}

export function parseFeed(xml: string, feed: { id: string; publisher: string }): FeedEntry[] {
  const doc = parser.parse(xml) as Record<string, unknown>;
  const rss = doc.rss as { channel?: { item?: unknown } } | undefined;
  const atom = doc.feed as { entry?: unknown } | undefined;
  const rawItems = rss?.channel?.item ?? atom?.entry ?? (doc["rdf:RDF"] as { item?: unknown } | undefined)?.item ?? [];
  const items = (Array.isArray(rawItems) ? rawItems : [rawItems]) as Record<string, unknown>[];
  const out: FeedEntry[] = [];
  for (const it of items.slice(0, 120)) {
    let link = text(it.link);
    if (Array.isArray(it.link)) {
      const alt = (it.link as Record<string, unknown>[]).find((l) => !l["@_rel"] || l["@_rel"] === "alternate");
      link = text(alt?.["@_href"] ?? alt);
    }
    if (!link) link = text(it.guid);
    if (!/^https?:\/\//.test(link)) continue;
    const title = stripHtml(text(it.title));
    if (!title) continue;
    out.push({
      url: link.trim(),
      title,
      summary: stripHtml(text(it.description ?? it.summary ?? it.content)).slice(0, 600),
      publishedAt: toIso(text(it.pubDate ?? it.published ?? it.updated ?? it["dc:date"])),
      publisher: feed.publisher,
      feedId: feed.id,
    });
  }
  return out;
}
