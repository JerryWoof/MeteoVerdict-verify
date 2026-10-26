import { describe, expect, it } from "vitest";
import {
  calendarDayFacts,
  combineLeadFacts,
  emptyLeadTitle,
  factsFromHours,
  leadState,
  releaseCoverageThin,
} from "./coverage";

describe("lead coverage", () => {
  it("counts observation hours inside each 24 h lead and ignores hours before the snapshot", () => {
    const obs = Array.from({ length: 30 }, (_, hour) => hour >= 6 && hour < 24);
    const model = Array.from({ length: 30 }, (_, hour) => hour >= 6 && hour < 18);
    const facts = factsFromHours(-6, obs, model);
    expect(facts[0]).toEqual({ hasSeries: true, obsHours: 18 });
    expect(facts[1].hasSeries).toBe(false);
    expect(leadState(true, 18, 24)).toBe("ok");
    expect(leadState(true, 12, 24)).toBe("ok");
    expect(leadState(true, 11, 24)).toBe("thin");
    expect(leadState(false, 0, 0)).toBe("empty");
  });

  it("grays a release under half of D+0 and leaves 12/24 active", () => {
    expect(releaseCoverageThin(11)).toBe(true);
    expect(releaseCoverageThin(12)).toBe(false);
    expect(releaseCoverageThin(0)).toBe(true);
    expect(releaseCoverageThin(undefined)).toBe(false);
  });

  it("counts a calendar day from midnight, so a 06:00 release has no model in the first six hours", () => {
    const obs = Array.from({ length: 24 }, () => true);
    const model = Array.from({ length: 24 }, (_, hour) => hour >= 6);
    const facts = calendarDayFacts("2026-10-25T06:00:00Z", -6, obs, model);
    expect(facts[0]).toEqual({ hasSeries: true, obsHours: 24 });
    expect(leadState(true, facts[0].obsHours, 24)).toBe("ok");
  });

  it("combines only the releases that forecast the lead", () => {
    const combined = combineLeadFacts([
      { hasSeries: true, obsHours: 24 },
      { hasSeries: false, obsHours: 0 },
      { hasSeries: true, obsHours: 6 },
    ]);
    expect(combined).toEqual({ hasSeries: true, obsHours: 30, windowHours: 48 });
    expect(leadState(combined.hasSeries, combined.obsHours, combined.windowHours)).toBe("ok");
    expect(emptyLeadTitle(2)).toBe("D+2 has no scored station-hours");
  });
});
