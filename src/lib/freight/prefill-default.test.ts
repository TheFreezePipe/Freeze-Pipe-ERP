import { describe, it, expect } from "vitest";
import { buildPrefillRateBySku, suggestPrefilled } from "./prefill-default";

const line = (sku: string, ship: string, qty: number, pref: number) => ({
  sku_id: sku,
  freight_shipment_id: ship,
  quantity: qty,
  quantity_prefilled: pref,
});

describe("prefill history default", () => {
  it("suggests pre-filled for a SKU consistently shipped filled across shipments", () => {
    // The BW33-14P pattern: pre-filled every time it ever shipped.
    const map = buildPrefillRateBySku([
      line("bw33", "s1", 96, 96),
      line("bw33", "s2", 4, 4),
    ]);
    expect(suggestPrefilled(map.get("bw33"))).toBe(true);
  });

  it("does not suggest from a single shipment, however filled", () => {
    const map = buildPrefillRateBySku([line("new", "s1", 100, 100)]);
    expect(suggestPrefilled(map.get("new"))).toBe(false);
  });

  it("does not suggest for majority-raw history", () => {
    const map = buildPrefillRateBySku([
      line("bw20", "s1", 500, 0),
      line("bw20", "s2", 300, 100),
    ]);
    expect(suggestPrefilled(map.get("bw20"))).toBe(false);
  });

  it("suggests at exactly the 70% threshold over two shipments", () => {
    const map = buildPrefillRateBySku([
      line("x", "s1", 50, 50),
      line("x", "s2", 50, 20),
    ]);
    expect(suggestPrefilled(map.get("x"))).toBe(true); // 70/100
  });

  it("clamps bogus prefilled values and ignores zero-qty and null-sku lines", () => {
    const map = buildPrefillRateBySku([
      line("y", "s1", 100, 250), // clamped to 100
      line("y", "s2", 100, -5), // clamped to 0
      { sku_id: null as unknown as string, freight_shipment_id: "s3", quantity: 50, quantity_prefilled: 50 },
      line("y", "s4", 0, 0), // ignored
    ]);
    const h = map.get("y")!;
    expect(h.totalUnits).toBe(200);
    expect(h.prefilledUnits).toBe(100);
    expect(h.shipmentCount).toBe(2);
    expect(suggestPrefilled(h)).toBe(false); // 50%
  });

  it("no history → no suggestion", () => {
    expect(suggestPrefilled(undefined)).toBe(false);
  });
});
