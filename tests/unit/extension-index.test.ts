import { describe, expect, it } from "vitest";
import { pruneKeys, searchRecords, toRecords } from "@/extension/src/index-core";
import { decide } from "@/extension/src/rules";

const DAY = 86_400_000;
const now = Date.parse("2026-11-01T12:00:00Z");
const entry = (title: string, daysAgo: number | null, url = `https://x.example/${encodeURIComponent(title)}`) => ({
  url,
  title,
  summary: "",
  publishedAt: daysAgo == null ? null : new Date(now - daysAgo * DAY).toISOString(),
  publisher: "Paper",
  feedId: "f",
});

describe("local news index", () => {
  it("keeps 14 days, drops older items, and dedupes by canonical URL", () => {
    const recs = toRecords([entry("Pune woman and son die after 18th floor fall", 1), entry("Old story about Pune", 20), entry("Undated", null)], now);
    expect(recs[0]!.t).toContain("pune");
    expect(pruneKeys(recs, now)).toEqual([recs[1]!.k]);
    // Same story with tracking parameters → one key.
    const a = toRecords([entry("A", 1, "https://www.x.example/a?utm_source=rss")], now)[0]!;
    const b = toRecords([entry("A", 1, "https://x.example/a")], now)[0]!;
    expect(a.k).toBe(b.k);
  });
  it("caps the index size, dropping the oldest first", () => {
    const recs = toRecords(Array.from({ length: 10 }, (_, i) => entry(`Story ${i}`, i)), now);
    const drop = pruneKeys(recs, now, 14, 6);
    expect(drop).toHaveLength(4);
    expect(drop).toContain(recs[9]!.k);
    expect(drop).not.toContain(recs[0]!.k);
  });
  it("finds a story from days ago by its words, newest first on ties", () => {
    const recs = toRecords([entry("Cricket: India win series", 2), entry("Pune woman, 6-year-old son die after jumping from 18th floor", 9), entry("Pune woman and son fall from 18th floor building", 3)], now);
    const hits = searchRecords(recs, "did a lady and child die by falling from a building in Pune", 5);
    expect(hits.map((h) => h.title)).toEqual(["Pune woman and son fall from 18th floor building", "Pune woman, 6-year-old son die after jumping from 18th floor"]);
  });
});

describe("Wikipedia in evidence-only mode", () => {
  it("is background only — never a 'same details' match", () => {
    const wiki = { url: "https://en.wikipedia.org/wiki/Delhi", title: "Delhi — Wikipedia", publisher: "Wikipedia", publishedAt: null, text: "Delhi is the capital city of India and is home to the Parliament of India.", links: [], readable: true, note: null, isFactCheck: false, isReference: true };
    const r = decide("Delhi is the capital city of India.", [wiki]);
    expect(r.label).toBe("caution");
    expect(r.matches).toHaveLength(0);
    expect(r.background).toHaveLength(1);
  });
});
