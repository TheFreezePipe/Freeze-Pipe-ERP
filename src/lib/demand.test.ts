import { describe, it, expect } from "vitest";
import { getEffectiveDemand } from "./demand";

describe("getEffectiveDemand", () => {
  it("prefers the live forecast when present", () => {
    const map = new Map([["s1", 120]]);
    expect(getEffectiveDemand("s1", 50, map)).toBe(120);
  });

  it("honors a forecast of 0", () => {
    const map = new Map([["s1", 0]]);
    expect(getEffectiveDemand("s1", 50, map)).toBe(0);
  });

  it("falls back to monthly_demand when there's no forecast", () => {
    expect(getEffectiveDemand("s1", 50, new Map())).toBe(50);
  });

  it("treats NULL monthly_demand as 0 (regression: NB7-Base crash)", () => {
    // product_skus.monthly_demand is nullable; a null must not leak out as a
    // value callers then .toString()/divide on.
    expect(getEffectiveDemand("s1", null)).toBe(0);
    expect(getEffectiveDemand("s1", null, new Map())).toBe(0);
  });

  it("treats undefined monthly_demand as 0", () => {
    expect(getEffectiveDemand("s1")).toBe(0);
  });
});
