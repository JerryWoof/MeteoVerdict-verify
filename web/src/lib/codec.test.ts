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
  it("starts with MeteoVerdict, the AI, ICON-D2 and ALADIN, then the best series not already included", () => {
    const series = ["model_b", "ai", "blend", "dwd_icon_d2", "chmi_aladin_cz_1km", "model_a"];
    const mae = [0.3, 0.9, 0.5, 0.8, 0.7, 0.4];
    expect(preselect(series, mae)).toEqual(["blend", "ai", "dwd_icon_d2", "chmi_aladin_cz_1km", "model_b"]);
  });

  it("skips a missing default and takes the next-best model when the leader is already in the set", () => {
    const series = ["blend", "ai", "model_a", "model_b"];
    const mae = [0.2, 0.4, 0.5, 0.6];
    expect(preselect(series, mae)).toEqual(["blend", "ai", "model_a"]);
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
