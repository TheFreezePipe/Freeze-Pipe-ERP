import { describe, expect, it } from "vitest";
import {
  cartonContents,
  cartonUnits,
  cumulativeUnits,
  describeContents,
  nextCartonPreview,
  splitUnits,
} from "./carton-split";

/** A small seeded generator so the "random" plans are the same on every run. */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe("cartonUnits / splitUnits", () => {
  it("sums to units_total for random plans, and every carton is floor or ceil of the average", () => {
    // one expect at the end: thousands of expect() calls are slow under a busy suite
    const rand = lcg(20261023);
    const bad: string[] = [];
    for (let i = 0; i < 1000; i++) {
      const m = 1 + Math.floor(rand() * 60);
      const u = Math.floor(rand() * 5000);
      const split = splitUnits(u, m);
      const sum = split.reduce((a, b) => a + b, 0);
      const outside = split.some((q) => q < Math.floor(u / m) || q > Math.ceil(u / m));
      if (split.length !== m || sum !== u || outside) bad.push(`U=${u} M=${m}: ${split.join(",")}`);
    }
    expect(bad).toEqual([]);
  });

  it("matches the receipt's cumulative credit after every carton", () => {
    const rand = lcg(7);
    const bad: string[] = [];
    for (let i = 0; i < 300; i++) {
      const m = 1 + Math.floor(rand() * 40);
      const u = Math.floor(rand() * 900);
      let running = 0;
      for (let k = 1; k <= m; k++) {
        running += cartonUnits(u, m, k);
        if (running !== cumulativeUnits(u, m, k)) bad.push(`U=${u} M=${m} k=${k}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("rounds halves up, as Postgres round(numeric) does for positive values", () => {
    // 25 over 4: 6.25, 12.5, 18.75, 25 → 6, 13, 19, 25
    expect(splitUnits(25, 4)).toEqual([6, 7, 6, 6]);
    // 10 over 4: 2.5, 5, 7.5, 10 → 3, 5, 8, 10
    expect(splitUnits(10, 4)).toEqual([3, 2, 3, 2]);
    // 100 over 8: 12.5 each → 13, 12, 13, 12, ...
    expect(splitUnits(100, 8)).toEqual([13, 12, 13, 12, 13, 12, 13, 12]);
    expect(splitUnits(48, 4)).toEqual([12, 12, 12, 12]);
  });

  it("gives empty cartons when there are fewer units than cartons", () => {
    expect(splitUnits(2, 5)).toEqual([0, 1, 0, 1, 0]);
    expect(splitUnits(0, 3)).toEqual([0, 0, 0]);
  });

  it("clamps the cumulative count to the plan and rejects nonsense", () => {
    expect(cumulativeUnits(48, 4, 9)).toBe(48);
    expect(cumulativeUnits(48, 4, -2)).toBe(0);
    expect(() => cartonUnits(48, 4, 0)).toThrow(RangeError);
    expect(() => cartonUnits(48, 4, 5)).toThrow(RangeError);
    expect(() => splitUnits(10, 0)).toThrow(RangeError);
    expect(() => splitUnits(-1, 2)).toThrow(RangeError);
  });
});

describe("cartonContents and previews", () => {
  const mixed = [
    { sku_id: "b", sku: "TP3-B", units_total: 25 },
    { sku_id: "c", sku: "TP3-C", units_total: 10 },
  ];

  it("mixed cartons hold each SKU's own split (the SQL test's 6+3, 7+2, 6+3, 6+2)", () => {
    expect([1, 2, 3, 4].map((k) => cartonContents(mixed, 4, k).total)).toEqual([9, 9, 9, 8]);
    expect(cartonContents(mixed, 4, 2).skus.map((s) => s.units)).toEqual([7, 2]);
  });

  it("describes a single-SKU carton by its units and a mixed one by SKU", () => {
    expect(describeContents(cartonContents([{ sku_id: "a", units_total: 480 }], 40, 7))).toBe("12");
    expect(describeContents(cartonContents(mixed, 4, 1))).toBe("TP3-B×6 + TP3-C×3");
  });

  it("previews the next carton until the group is in", () => {
    expect(nextCartonPreview([{ sku_id: "a", units_total: 480 }], 40, 6)).toBe("carton 7 of 40 holds 12");
    expect(nextCartonPreview(mixed, 4, 3)).toBe("carton 4 of 4 holds TP3-B×6 + TP3-C×2");
    expect(nextCartonPreview(mixed, 4, 4)).toBeNull();
  });
});
