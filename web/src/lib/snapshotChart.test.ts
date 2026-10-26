import { describe, expect, it } from "vitest";
import { OBS_DASH, OBS_NAME, buildSnapshotChart, type StationGrid } from "./snapshotChart";

function grid(): StationGrid {
  const hours = 48;
  const obs = Array.from({ length: hours }, (_, hour) => 10 + (hour === 0 ? 0 : 0));
  const ai = Array.from({ length: hours }, (_, hour) => 11 + hour * 0.01);
  const modelA = Array.from({ length: hours }, () => 12);
  const modelB = Array.from({ length: hours }, (_, hour) => (hour < 24 ? 8 : 9));
  return {
    id: "20261024T0000Z",
    snapshotTime: "2026-10-24T00:00:00Z",
    lead0: 0,
    hours,
    seriesIds: ["ai", "model_a", "model_b"],
    obs,
    values: [ai, modelA, modelB],
  };
}

describe("buildSnapshotChart", () => {
  it("draws one solid line per selected model and a dotted observation on top", () => {
    const chart = buildSnapshotChart({
      grids: [grid()],
      selected: ["ai", "model_a", "model_b"],
      lead: "all",
      names: { ai: "MeteoVerdict AI", model_a: "Model A", model_b: "Model B" },
      color: (id) => id,
    });
    expect(chart.series).toHaveLength(4);
    expect(chart.series.slice(0, 3).map((line) => line.dash)).toEqual([undefined, undefined, undefined]);
    expect(chart.series.slice(0, 3).map((line) => line.id)).toEqual([
      "20261024T0000Z:ai",
      "20261024T0000Z:model_a",
      "20261024T0000Z:model_b",
    ]);
    expect(chart.series[0].values[0]).toBe(11);
    expect(chart.series[1].values[0]).toBe(12);
    expect(chart.series[2].values[0]).toBe(8);
    const obs = chart.series[3];
    expect(obs.id).toBe("obs");
    expect(obs.name).toBe(OBS_NAME);
    expect(obs.dash).toBe(OBS_DASH);
    expect(obs.values[0]).toBe(10);
    expect(chart.obsPoints).toBe(48);
    expect(chart.times[0]).toBe("2026-10-24T00:00:00.000Z");
  });

  it("keeps lead 0 in the all-leads chart and drops it from D+1", () => {
    const all = buildSnapshotChart({
      grids: [grid()],
      selected: ["ai"],
      lead: "all",
      names: {},
      color: () => "#000",
    });
    const d0 = buildSnapshotChart({
      grids: [grid()],
      selected: ["ai"],
      lead: 0,
      names: {},
      color: () => "#000",
    });
    const d1 = buildSnapshotChart({
      grids: [grid()],
      selected: ["ai"],
      lead: 1,
      names: {},
      color: () => "#000",
    });
    expect(all.times).toHaveLength(48);
    expect(d0.times).toHaveLength(24);
    expect(d0.times[0]).toBe("2026-10-24T00:00:00.000Z");
    expect(d1.times).toHaveLength(24);
    expect(d1.times[0]).toBe("2026-10-25T00:00:00.000Z");
    expect(d1.series.find((line) => line.id === "obs")?.values[0]).toBe(10);
  });

  it("keeps the whole UTC day of observations, including hours before the snapshot", () => {
    const hours = 30;
    const obs = Array.from({ length: hours }, (_, hour) => (hour < 24 ? 10 + hour * 0.1 : null));
    const ai = Array.from({ length: hours }, (_, hour) => (hour >= 6 && hour < 24 ? 11 : null));
    const chart = buildSnapshotChart({
      grids: [{
        id: "20261025T0600Z",
        snapshotTime: "2026-10-25T06:00:00Z",
        lead0: -6,
        hours,
        seriesIds: ["ai"],
        obs,
        values: [ai],
      }],
      selected: ["ai"],
      lead: "all",
      names: { ai: "MeteoVerdict AI" },
      color: () => "#0f6b66",
    });
    expect(chart.times[0]).toBe("2026-10-25T00:00:00.000Z");
    expect(chart.obsPoints).toBe(24);
    const model = chart.series[0];
    const observed = chart.series[1];
    expect(model.values[0]).toBeNull();
    expect(model.values[6]).toBe(11);
    expect(observed.dash).toBe(OBS_DASH);
    expect(observed.values[0]).toBe(10);
    expect(observed.values[6]).toBeCloseTo(10.6);
  });

  it("omits the observation line when that station has no obs in the window", () => {
    const source = grid();
    source.obs = source.obs.map(() => null);
    const chart = buildSnapshotChart({
      grids: [source],
      selected: ["model_a"],
      lead: 0,
      names: { model_a: "Model A" },
      color: () => "#111",
    });
    expect(chart.series.map((line) => line.id)).toEqual(["20261024T0000Z:model_a"]);
    expect(chart.obsPoints).toBe(0);
  });
});
