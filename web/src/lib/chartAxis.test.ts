import { describe, expect, it } from "vitest";
import { forecastDates, fullAxis, leadDayAxis, showClockTick } from "./chartAxis";

describe("chart axis", () => {
  it("draws a lead day from 00:00 through the next 00:00", () => {
    const ticks = leadDayAxis("2026-10-25T06:00:00Z", 0);
    expect(ticks[0].clock).toBe("00:00");
    expect(ticks[0].iso).toBe("2026-10-25T00:00:00.000Z");
    expect(ticks[0].dayStart).toBe(true);
    expect(ticks[0].lead).toBe(0);
    expect(ticks[ticks.length - 1].clock).toBe("00:00");
    expect(ticks[ticks.length - 1].iso).toBe("2026-10-26T00:00:00.000Z");
    expect(ticks[ticks.length - 1].terminal).toBe(true);
    expect(ticks[ticks.length - 1].dayStart).toBe(false);
    expect(ticks).toHaveLength(25);
    expect(forecastDates(ticks)).toEqual(["25.10.2026"]);
    expect(ticks.filter((tick) => showClockTick(tick, 24)).map((tick) => tick.clock)).toEqual([
      "00:00",
      "06:00",
      "12:00",
      "18:00",
      "00:00",
    ]);
  });

  it("labels the next calendar day as D+1 and lists every date the full window covers", () => {
    const ticks = fullAxis("2026-10-25T18:00:00Z", "2026-10-27T13:00:00Z");
    expect(ticks[0].iso).toBe("2026-10-25T00:00:00.000Z");
    expect(ticks[ticks.length - 1].iso).toBe("2026-10-28T00:00:00.000Z");
    expect(ticks.find((tick) => tick.iso === "2026-10-26T00:00:00.000Z")?.lead).toBe(1);
    expect(forecastDates(ticks)).toEqual(["25.10.2026", "26.10.2026", "27.10.2026"]);
  });
});
