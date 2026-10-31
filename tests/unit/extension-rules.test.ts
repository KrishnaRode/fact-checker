import { describe, expect, it } from "vitest";
import { decide, rankItems, type Doc } from "@/extension/src/rules";

const doc = (publisher: string, text: string, over: Partial<Doc> = {}): Doc => ({
  url: `https://${publisher.toLowerCase().replace(/\s+/g, "")}.example/a`,
  title: text.slice(0, 80),
  publisher,
  publishedAt: "2026-10-31T10:00:00Z",
  text,
  links: [],
  readable: true,
  note: null,
  isFactCheck: false,
  ...over,
});

const PUNE = "A woman and her six-year-old son died after jumping from the 18th floor of a residential building in Pune's Wakad on Friday evening, police said. The woman left a suicide note.";
const PUNE_2 = "Pune: A 33-year-old woman and her 6-year-old child died after allegedly jumping from the 18th floor of their building in Wakad on Friday. Police are investigating.";

describe("evidence-only rules (no AI)", () => {
  it("matches independent reports with the same names, numbers and places", () => {
    const r = decide("A woman and her 6-year-old son died after jumping from the 18th floor of a building in Pune.", [doc("Hindustan Times", PUNE), doc("Times of India", PUNE_2)]);
    expect(r.label).toBe("matches");
    expect(r.title).toBe("Same details in independent reports");
    expect(r.independentOrigins).toBe(2);
  });
  it("reports differing details instead of matching a wrong number or city", () => {
    const r = decide("A woman and her son jumped from the 25th floor of a building in Mumbai.", [doc("Hindustan Times", PUNE)]);
    expect(r.label).toBe("differs");
    expect(r.differs[0]!.detail).toMatch(/25th|Mumbai/);
  });
  it("counts copies of one story once", () => {
    const r = decide("A woman and her 6-year-old son died after jumping from the 18th floor of a building in Pune.", [doc("Paper A", PUNE.repeat(3)), doc("Paper B", PUNE.repeat(3), { url: "https://b.example/x" })]);
    expect(r.label).toBe("matches");
    expect(r.independentOrigins).toBe(1);
    expect(r.notes.join(" ")).toMatch(/counted once/);
  });
  it("surfaces denials rather than a match", () => {
    const r = decide("The government will give free laptops to all students in Pune.", [
      doc("PIB", "The government has denied reports that it will give free laptops to all students in Pune, calling the viral message fake news and a rumour."),
    ]);
    expect(r.label).toBe("denial");
  });
  it("flags a published fact-check that disputes a similar claim", () => {
    const r = decide("Akhilesh Yadav wore a saffron turban at his Lucknow press meet.", [
      doc("Alt News", "Media misreport: Akhilesh Yadav put on a red turban at Lucknow press meet, not saffron", { isFactCheck: true, readable: false, title: "Media misreport: Akhilesh Yadav put on a red turban at Lucknow press meet, not saffron" }),
    ]);
    expect(r.label).toBe("disputed");
    expect(r.tone).toBe("contradicted");
  });
  it("never treats missing coverage as false, and names unreadable reports", () => {
    const r = decide("A woman and her son died in Pune.", [doc("NDTV", "", { readable: false, note: "blocked", title: "Pune woman and son die after fall from building" })]);
    expect(r.label).toBe("no_coverage");
    expect(r.summary).toMatch(/not evidence the claim is false/);
    expect(r.unreadable[0]!.publisher).toBe("NDTV");
  });
  it("does not check predictions or opinions", () => {
    expect(decide("The BJP will win the 2027 Uttar Pradesh election.", []).label).toBe("opinion");
  });
  it("ranks feed items by claim coverage", () => {
    const items = [
      { title: "Cricket: India win series", summary: "", url: "https://x.example/1" },
      { title: "Pune woman, 6-year-old son die after jumping from 18th floor", summary: "", url: "https://x.example/2" },
    ];
    expect(rankItems("did a lady and child die by falling from a building in Pune", items, 5)).toEqual([1]);
  });
});

describe("rules detect opposites (regression: demo corpus)", () => {
  it("handles the four demo claims the way a careful reader would", async () => {
    const corpus = (await import("@/fixtures/demo/corpus.json")).default;
    const docs: Doc[] = corpus.documents.map((d) => ({ url: d.url, title: d.title, publisher: d.publisher, publishedAt: d.publishedAt, text: d.paragraphs.join("\n\n").replace(/<[^>]+>/g, ""), links: [], readable: true, note: null, isFactCheck: false }));
    const closure = decide("BREAKING: The Riverbend Museum has shut down permanently from today! Share before they delete this!!", docs);
    expect(closure.label).toBe("opposite");
    expect(closure.opposites[0]!.detail).toMatch(/permanently/);
    expect(decide("The Riverbend Museum reopens on Tuesday 3 November at 10 am.", docs).label).toBe("matches");
    const free = decide("Entry to the Riverbend Museum will be free for everyone when it reopens.", docs);
    expect(free.label).not.toBe("matches");
    expect(["caution", "opposite", "conflict"]).toContain(free.label);
    const old = decide("Harbor Line metro stations are shut today after heavy flooding.", docs, "2026-10-28");
    expect(old.label).toBe("caution");
    expect(old.cautions[0]!.detail).toMatch(/2019/);
    const lead = decide("Kestrel Bay's tap water had dangerous lead levels last week.", docs);
    expect(lead.label).toBe("opposite");
    expect(lead.opposites[0]!.detail).toMatch(/below/);
  });
});
