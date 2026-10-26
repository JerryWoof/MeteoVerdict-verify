import { describe, expect, it } from "vitest";
import { pickDefaultRelease } from "./releases";

describe("pickDefaultRelease", () => {
  it("selects the oldest release, which is the first row", () => {
    expect(pickDefaultRelease([{ id: "20261023T0600Z" }, { id: "20261024T0000Z" }, { id: "20261025T1800Z" }])).toBe(
      "20261023T0600Z",
    );
    expect(pickDefaultRelease([])).toBe("");
  });
});
