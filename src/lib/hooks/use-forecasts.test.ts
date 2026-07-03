import { describe, it, expect } from "vitest";
import { buildEffectiveDemandMap, FORECAST_HIGH_VOLUME_MONTHLY } from "./use-forecasts";
import { getEffectiveDemand } from "@/lib/demand";

// The layered effective-demand map: engine forecasts (gated to high-volume
// SKUs) overlaid by manual demand_overrides, which always win. These tests
// pin the 2026-07-03 audit fix — before it, overrides were display-only in
// the SKU modal and ignored by every planning surface.

const f = (sku_id: string, forecast_30d: number) => ({ sku_id, forecast_30d });
const o = (sku_id: string, monthly_demand: number) => ({ sku_id, monthly_demand });

describe("buildEffectiveDemandMap", () => {
  it("includes forecasts at/above the trust gate, drops the lumpy tail", () => {
    const m = buildEffectiveDemandMap(
      [f("a", FORECAST_HIGH_VOLUME_MONTHLY), f("b", FORECAST_HIGH_VOLUME_MONTHLY - 1)],
      [],
    );
    expect(m.get("a")).toBe(FORECAST_HIGH_VOLUME_MONTHLY);
    expect(m.has("b")).toBe(false);
  });

  it("override beats a qualifying forecast", () => {
    const m = buildEffectiveDemandMap([f("a", 600)], [o("a", 90)]);
    expect(m.get("a")).toBe(90);
  });

  it("override is included even when the SKU has no qualifying forecast (new launch)", () => {
    // BW64P case: brand-new product, trailing demand ~1/mo, no forecast row.
    const m = buildEffectiveDemandMap([], [o("bw64p", 90)]);
    expect(m.get("bw64p")).toBe(90);
  });

  it("override of 0 is preserved (silences a discontinued SKU), not treated as missing", () => {
    const m = buildEffectiveDemandMap([f("a", 120)], [o("a", 0)]);
    expect(m.get("a")).toBe(0);
    // getEffectiveDemand must return the 0 override, NOT fall back to baseline.
    expect(getEffectiveDemand("a", 250, m)).toBe(0);
  });

  it("getEffectiveDemand end-to-end precedence: override > forecast > baseline > 0", () => {
    const m = buildEffectiveDemandMap([f("fcast", 100)], [o("ovr", 40)]);
    expect(getEffectiveDemand("ovr", 5, m)).toBe(40);   // override wins
    expect(getEffectiveDemand("fcast", 5, m)).toBe(100); // forecast wins over baseline
    expect(getEffectiveDemand("plain", 5, m)).toBe(5);   // baseline
    expect(getEffectiveDemand("nothing", null, m)).toBe(0);
  });

  it("handles undefined inputs (loading states) without throwing", () => {
    const m = buildEffectiveDemandMap(undefined, undefined);
    expect(m.size).toBe(0);
  });
});
