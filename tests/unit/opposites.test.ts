import { describe, expect, it } from "vitest";
import { findOpposites } from "@/lib/investigation/opposites";

describe("deterministic opposite detection", () => {
  it.each([
    ["The museum has shut down permanently.", "The museum is not closing permanently.", "negated"],
    ["The museum has shut down permanently.", "The museum will close temporarily for a week.", "antonym"],
    ["Tap water had dangerous lead levels.", "Lead was below the laboratory detection limit in all samples.", "antonym"],
    ["The Sensex fell this week.", "The Sensex rose 1.6% this week.", "antonym"],
    ["The minister was acquitted.", "The court granted the minister interim bail.", "antonym"],
    ["Entry will be free for everyone.", "Adult entry remains 120 rupees.", "price"],
  ])("%s ↔ %s", (claim, sentence, kind) => {
    expect(findOpposites(claim, [sentence])[0]?.kind).toBe(kind);
  });
  it("stays quiet when the report uses the claim's own wording", () => {
    expect(findOpposites("The museum reopens on 3 November.", ["The museum will reopen on 3 November.", "It will close temporarily from 26 October."])).toEqual([]);
    expect(findOpposites("The Sensex rose this week.", ["The Sensex rose 1.6% this week."])).toEqual([]);
    expect(findOpposites("The High Court granted bail.", ["Lead was below the safety limit."])).toEqual([]);
    // "jumped" (from a building) is not a price movement.
    expect(findOpposites("A woman and her son jumped from the 25th floor.", ["They died after a fall from the 18th floor."])).toEqual([]);
  });
});
