import { describe, expect, it } from "vitest";
import { firstScoredLead, leadOpensAfterObservations, leadPairCount, leadWindow } from "./leads";
import { inLead } from "./score";
import type { LeadScore, VariableScore } from "../types";

function lead(n: number): LeadScore {
  return {
    n,
    ai_pairs: n,
    floor: 24,
    snaps: 1,
    stations: 1,
    series: n > 0 ? ["ai"] : [],
    mae: n > 0 ? [1] : [],
    bias: n > 0 ? [0] : [],
    rmse: n > 0 ? [1] : [],
    excluded: [],
    dropped_run_unavailable: {},
    short: false,
  };
}

function variable(leads: Record<string, LeadScore>): VariableScore {
  return {
    leads,
    overall: { leads_used: [], series: [], mae: [], bias: [], rmse: [], n_by_lead: {}, leads_for: {} },
    by_day: { days: [], leads: {} },
    by_station: {},
  };
}

describe("inLead", () => {
  it("treats D+0 as the first 24 hours and all-leads as D+0 through D+5", () => {
    expect(inLead(0, 0)).toBe(true);
    expect(inLead(23, 0)).toBe(true);
    expect(inLead(24, 0)).toBe(false);
    expect(inLead(0, "all")).toBe(true);
    expect(inLead(143, "all")).toBe(true);
    expect(inLead(144, "all")).toBe(false);
    expect(inLead(24, 1)).toBe(true);
    expect(inLead(0, 2)).toBe(false);
  });
});

describe("lead selection", () => {
  it("defaults to the first lead that has pairs, skipping empty later bands", () => {
    const active = variable({ 0: lead(100), 1: lead(40) });
    expect(firstScoredLead([0, 1, 2, 3, 4, 5], active)).toBe(0);
    expect(firstScoredLead([0, 1, 2, 3, 4, 5], variable({ 1: lead(40) }))).toBe(1);
    expect(firstScoredLead([0, 1, 2], variable({}))).toBe("all");
    expect(leadPairCount(variable({ 2: lead(0) }), 2)).toBe(0);
    expect(leadPairCount(null, 0)).toBe(0);
  });

  it("explains an empty lead whose window opens after the latest observation", () => {
    expect(leadWindow(0).label).toBe("0–23 h after the snapshot");
    expect(leadWindow(2).start).toBe(48);
    const d0 = leadOpensAfterObservations(0, "2026-10-24T00:00:00Z", "2026-10-25");
    const d2 = leadOpensAfterObservations(2, "2026-10-24T00:00:00Z", "2026-10-25");
    expect(d0.afterObservations).toBe(false);
    expect(d2.afterObservations).toBe(true);
    expect(d2.opensAt).toBe("2026-10-26T00:00:00.000Z");
  });
});
