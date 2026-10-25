import { describe, expect, it } from "vitest";
import { decodeRow, preselect } from "./codec";
import { scoreRows } from "./score";

describe("delta-tenths", () => {
  it("matches the Python encoder on a signed gap", () => {
    expect(decodeRow("100,,2,,-114", 5)).toEqual([10, null, 10.2, null, -1.2]);
    expect(decodeRow("", 3)).toEqual([null, null, null]);
  });
});

describe("preselect", () => {
  it("keeps the AI on the chart plus the two closest other series", () => {
    const series = ["model_a", "ai", "model_b", "model_c"];
    const mae = [0.5, 2, 0.8, 0.7];
    expect(preselect(series, mae)).toEqual(["ai", "model_a", "model_c"]);
  });
});

describe("scoreRows", () => {
  it("ranks by MAE and leaves a sparse series out of the common set", () => {
    const full = Array.from({ length: 24 }, (_, index) => ({
      obs: 10,
      values: {
        ai: 11,
        model_a: 12,
        model_b: 7,
        model_c: index < 2 ? 10 : null,
        sparse: index < 8 ? 9 : null,
      },
    }));
    const scored = scoreRows(full, 6, 0.5);
    expect(scored).not.toBeNull();
    expect(scored!.series).toEqual(["ai", "model_a", "model_b"]);
    expect(scored!.mae).toEqual([1, 2, 3]);
    expect(scored!.n).toBe(24);
    expect(scored!.excluded.map((row) => row.k).sort()).toEqual(["model_c", "sparse"]);
    expect(scored!.excluded.find((row) => row.k === "sparse")?.reason).toBe("would_shrink_common_set");
  });
});
