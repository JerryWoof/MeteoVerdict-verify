import { describe, expect, it } from "vitest";
import { DIM_OPACITY, FOCUS_WIDTH, barLeadEmphasis, seriesEmphasis } from "./chartEmphasis";

describe("bar lead emphasis", () => {
  it("bolds every bar in the hovered lead and dims the other leads", () => {
    const hovered = barLeadEmphasis(1, 1, null);
    const sameLeadAgain = barLeadEmphasis(1, 1, null);
    const otherLead = barLeadEmphasis(0, 1, null);
    const laterLead = barLeadEmphasis(2, 1, null);

    expect(hovered).toEqual(sameLeadAgain);
    expect(hovered).toEqual({ opacity: 1, width: FOCUS_WIDTH });
    expect(otherLead).toEqual({ opacity: DIM_OPACITY, width: 2 });
    expect(laterLead.opacity).toBe(DIM_OPACITY);
  });

  it("treats D+0 as a real column, not as no selection", () => {
    expect(barLeadEmphasis(0, 0, null)).toEqual({ opacity: 1, width: FOCUS_WIDTH });
    expect(barLeadEmphasis(1, 0, null).opacity).toBe(DIM_OPACITY);
    expect(barLeadEmphasis(0, null, 0).opacity).toBe(1);
    expect(barLeadEmphasis(3, null, 0).opacity).toBe(DIM_OPACITY);
  });

  it("keeps a pinned lead until another lead is hovered", () => {
    expect(barLeadEmphasis(2, null, 2).width).toBe(FOCUS_WIDTH);
    expect(barLeadEmphasis(1, null, 2).opacity).toBe(DIM_OPACITY);
    expect(barLeadEmphasis(1, 1, 2)).toEqual({ opacity: 1, width: FOCUS_WIDTH });
    expect(barLeadEmphasis(2, 1, 2).opacity).toBe(DIM_OPACITY);
  });

  it("leaves the chart alone when nothing is hovered or pinned", () => {
    expect(barLeadEmphasis(0, null, null)).toEqual({ opacity: 1, width: 2 });
    expect(barLeadEmphasis(4, null, null)).toEqual({ opacity: 1, width: 2 });
  });
});

describe("series emphasis", () => {
  it("still bolds one line and dims the others", () => {
    expect(seriesEmphasis("icon", "icon", null, 2)).toEqual({ opacity: 1, width: FOCUS_WIDTH });
    expect(seriesEmphasis("ukmo", "icon", null, 2)).toEqual({ opacity: DIM_OPACITY, width: 2 });
    expect(seriesEmphasis("icon", null, null, 2)).toEqual({ opacity: 1, width: 2 });
  });
});
