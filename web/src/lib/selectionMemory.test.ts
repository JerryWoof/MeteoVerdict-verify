import { describe, expect, it } from "vitest";
import { loadSelection, saveSelection } from "./selectionMemory";

function memory(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
}

describe("selection memory", () => {
  it("keeps each page's ticks separate and treats a missing key as not customized", () => {
    const store = memory();
    expect(loadSelection("overview", store)).toBeNull();
    saveSelection("overview", ["blend", "ai"], store);
    saveSelection("snapshots", ["dwd_icon_d2"], store);
    expect(loadSelection("overview", store)).toEqual(["blend", "ai"]);
    expect(loadSelection("snapshots", store)).toEqual(["dwd_icon_d2"]);
  });
});