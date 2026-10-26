import { describe, expect, it } from "vitest";
import { stationDetail } from "./modelDetail";
import type { StationBlock } from "../types";

function block(series: string[], ids: string[], n: number[], mae: (number | null)[][]): StationBlock {
  return { series, ids, n, mae };
}

describe("stationDetail", () => {
  it("ranks a station by MAE on that lead’s common hours and keeps the network order out of it", () => {
    const byStation = {
      "0": block(
        ["ai", "icon"],
        ["easy", "hard"],
        [10, 10],
        [
          [1, 3],
          [2, 0.5],
        ],
      ),
    };
    const rows = stationDetail(["hard", "easy"], byStation, [0], "ai", ["ai", "icon"]);
    expect(rows.map((row) => row.id)).toEqual(["easy", "hard"]);
    expect(rows[0]).toMatchObject({ mae: 1, n: 10, place: 1, compared: 2 });
    expect(rows[1]).toMatchObject({ mae: 3, n: 10, place: 2, compared: 2 });
  });

  it("averages the lead scores a station has, with equal weight, and sums the pairs", () => {
    const byStation = {
      "0": block(["ai", "icon"], ["s"], [10], [[1], [4]]),
      "1": block(["ai", "icon"], ["s"], [4], [[3], [0]]),
    };
    const [row] = stationDetail(["s"], byStation, [0, 1], "ai", ["ai", "icon"]);
    expect(row).toMatchObject({ mae: 2, n: 14, place: 1, compared: 2 });
    const icon = stationDetail(["s"], byStation, [0, 1], "icon", ["ai", "icon"])[0];
    expect(icon).toMatchObject({ mae: 2, n: 14, place: 2, compared: 2 });
  });

  it("skips a lead the series does not have instead of filling it", () => {
    const byStation = {
      "0": block(["ai", "other"], ["s"], [8], [[1.5], [1.5]]),
      "1": block(["other"], ["s"], [8], [[9]]),
    };
    const [row] = stationDetail(["s"], byStation, [0, 1], "ai", ["ai", "other"]);
    expect(row).toMatchObject({ mae: 1.5, n: 8, place: 1, compared: 2 });
  });
});
