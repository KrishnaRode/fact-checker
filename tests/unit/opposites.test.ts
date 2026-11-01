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
  it("reads who beat whom from word order", () => {
    const claim = "Australia beat South Africa 2-1 and are still No.1 in the ICC Test rankings.";
    expect(findOpposites(claim, ["South Africa dismantle Australia to clinch series and strengthen WTC defence."])[0]?.claimWord).toBe("Australia beat South Africa");
    expect(findOpposites(claim, ["Australia lose their No.1 ICC, WTC positions after 2-1 defeat against South Africa."])[0]?.kind).toBe("antonym");
    expect(findOpposites(claim, ["Australia beat South Africa 2-1 in a thrilling decider."])).toEqual([]);
    // The first team named is the subject: South Africa did not lose here.
    expect(findOpposites("South Africa beat Australia to win the Test series 2-1.", ["Australia suffered a shock collapse on the final day of their South Africa tour as they lost the Newlands Test by 176 runs."])).toEqual([]);
    // Loose "A … lose" phrasing is not a result.
    expect(findOpposites("South Africa beat Australia to win the Test series 2-1.", ["South Africa had to lose only two wickets to chase it down."])).toEqual([]);
    expect(findOpposites("South Africa beat Australia to win the Test series 2-1.", ["South Africa lost to Australia in the final Test."])[0]?.kind).toBe("antonym");
  });
  it("catches 'without X' about the claim's own key word", () => {
    expect(findOpposites("UK weather alert: 10 days of non-stop rain coming!", ["UK could see 10 days without rain after 'wettest week in two years'."])[0]?.reportWords).toMatch(/without rain/);
    expect(findOpposites("The UK will have no rain for 10 days.", ["UK could see 10 days without rain."])).toEqual([]);
  });

  it("stays quiet when the report uses the claim's own wording", () => {
    expect(findOpposites("The museum reopens on 3 November.", ["The museum will reopen on 3 November.", "It will close temporarily from 26 October."])).toEqual([]);
    expect(findOpposites("The Sensex rose this week.", ["The Sensex rose 1.6% this week."])).toEqual([]);
    expect(findOpposites("The High Court granted bail.", ["Lead was below the safety limit."])).toEqual([]);
    // "jumped" (from a building) is not a price movement.
    expect(findOpposites("A woman and her son jumped from the 25th floor.", ["They died after a fall from the 18th floor."])).toEqual([]);
  });
});
