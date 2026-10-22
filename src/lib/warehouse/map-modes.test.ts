import { describe, expect, it } from "vitest";
import {
  countBucket,
  facesInWalkOrder,
  daysSince,
  heatByLocation,
  heatColor,
  indexByBay,
  locationWords,
  oldestCountDays,
  parseMapLevel,
  parseMapMode,
  rowsForLevel,
  searchLocations,
  stockFill,
  stockRatio,
  type MapLocationRow,
} from "./map-modes";

function row(p: Partial<MapLocationRow> & { id: string; code: string }): MapLocationRow {
  return {
    name: null,
    kind: "bay_level",
    zone: "RTS",
    face: p.code.slice(0, 2),
    bay: Number(p.code.slice(3, 5)),
    level: Number(p.code.slice(6)),
    pickable: false,
    is_overflow: false,
    active: true,
    capacity_cartons: null,
    cartons: 0,
    units: 0,
    last_counted_at: null,
    contents: [],
    ...p,
  };
}

const ctn = (sku: string, qty: number, code: string | null = null, skuId = `id-${sku}`) => ({
  container_id: code ? `c-${code}` : null,
  code,
  sku_id: skuId,
  sku,
  qty,
});

const rows: MapLocationRow[] = [
  row({ id: "a1", code: "02-01-1", pickable: true, cartons: 1, units: 7, contents: [ctn("BW20", 7, "C-OB-0001")] }),
  row({ id: "a2", code: "02-01-2", pickable: true, cartons: 1, units: 12, contents: [ctn("NB2", 12, "C-OB-0002")] }),
  row({
    id: "a3",
    code: "02-01-3",
    is_overflow: true,
    capacity_cartons: 4,
    cartons: 2,
    units: 24,
    contents: [ctn("BW20", 12, "C-OB-0003"), ctn("BW20", 12, "C-OB-0004")],
  }),
  row({ id: "b1", code: "03-02-1", pickable: true, cartons: 0, units: 5, contents: [ctn("BW20", 5)] }),
  row({ id: "b2", code: "03-02-2" }),
  row({ id: "x", code: "IN-01", kind: "floor", face: null, bay: null, level: null, contents: [ctn("ZZ9", 3)] }),
];

describe("url params", () => {
  it("fall back to browse / all", () => {
    expect(parseMapMode("heat")).toBe("heat");
    expect(parseMapMode("route")).toBe("browse");
    expect(parseMapLevel("2")).toBe("2");
    expect(parseMapLevel(null)).toBe("all");
  });
});

describe("bays and levels", () => {
  it("indexes bay-levels by bay, levels ascending, named locations left out", () => {
    const idx = indexByBay([...rows].reverse());
    expect([...idx.keys()].sort()).toEqual(["02-01", "03-02"]);
    expect(idx.get("02-01")!.map((r) => r.level)).toEqual([1, 2, 3]);
    expect(rowsForLevel(idx.get("02-01"), "3").map((r) => r.code)).toEqual(["02-01-3"]);
    expect(rowsForLevel(idx.get("02-01"), "all")).toHaveLength(3);
    expect(rowsForLevel(undefined, "1")).toEqual([]);
  });
});

describe("faces in walk order", () => {
  it("orders faces by their first pick_sequence, skipping named and inactive rows", () => {
    const seqRows = [
      { ...row({ id: "1", code: "03-01-1" }), pick_sequence: 3011 },
      { ...row({ id: "2", code: "01-01-1" }), pick_sequence: 1011 },
      { ...row({ id: "3", code: "07-01-1" }), pick_sequence: 11 },
      { ...row({ id: "4", code: "09-01-1", active: false }), pick_sequence: 1 },
      { ...row({ id: "5", code: "IN-01", kind: "floor", face: null }), pick_sequence: null },
    ];
    expect(facesInWalkOrder(seqRows).map((f) => f.face)).toEqual(["07", "01", "03"]);
  });
});

describe("stock", () => {
  it("sums cartons against capacity; one unknown capacity makes it unknown", () => {
    expect(stockFill([rows[2]])).toEqual({ cartons: 2, units: 24, capacity: 4, empty: false, over: false });
    expect(stockFill(rows.slice(0, 3)).capacity).toBeNull();
    expect(stockFill([rows[4]]).empty).toBe(true);
    expect(stockFill([{ ...rows[2], cartons: 5 }]).over).toBe(true);
  });

  it("ratio uses capacity, else the fullest bin; loose units are a sliver", () => {
    expect(stockRatio(stockFill([rows[2]]), 10)).toBe(0.5);
    expect(stockRatio(stockFill([rows[0]]), 4)).toBe(0.25);
    expect(stockRatio(stockFill([rows[3]]), 4)).toBeCloseTo(0.12);
    expect(stockRatio(stockFill([rows[4]]), 4)).toBe(0);
  });
});

describe("counted", () => {
  const now = new Date("2026-10-22T12:00:00Z");
  it("days since a count, bucketed", () => {
    expect(daysSince("2026-10-20T12:00:00Z", now)).toBe(2);
    expect(daysSince(null, now)).toBeNull();
    expect(countBucket(2)).toBe("week");
    expect(countBucket(30)).toBe("month");
    expect(countBucket(31)).toBe("quarter");
    expect(countBucket(400)).toBe("old");
    expect(countBucket(null)).toBe("never");
  });

  it("the stalest level wins and never counted beats any date", () => {
    const a = row({ id: "1", code: "01-01-1", last_counted_at: "2026-10-01T12:00:00Z" });
    const b = row({ id: "2", code: "01-01-2", last_counted_at: "2026-10-21T12:00:00Z" });
    expect(oldestCountDays([a, b], now)).toBe(21);
    expect(oldestCountDays([a, row({ id: "3", code: "01-01-3" })], now)).toBeNull();
  });
});

describe("heat", () => {
  it("spreads a SKU's demand over its pick bins only when it has some", () => {
    const heat = heatByLocation(rows, new Map([["id-BW20", 90], ["id-NB2", 30], ["id-ZZ9", 6]]));
    // BW20 is on two pick bins (a1, b1) and an overflow bin (a3): 45 each on the pick bins
    expect(heat.byLocation.get("a1")).toBe(45);
    expect(heat.byLocation.get("b1")).toBe(45);
    expect(heat.byLocation.has("a3")).toBe(false);
    expect(heat.byLocation.get("a2")).toBe(30);
    // ZZ9 sits only on a floor location: all of it lands there
    expect(heat.byLocation.get("x")).toBe(6);
    expect(heat.max).toBe(45);
    expect(heat.stockedBins).toBe(5);
  });

  it("reports no stocked bins on an empty warehouse", () => {
    const heat = heatByLocation([rows[4]], new Map([["id-BW20", 90]]));
    expect(heat.stockedBins).toBe(0);
    expect(heat.byLocation.size).toBe(0);
  });

  it("ramps from slate to yellow", () => {
    expect(heatColor(0)).toBe("rgb(30, 41, 59)");
    expect(heatColor(1)).toBe("rgb(253, 224, 71)");
  });
});

describe("search", () => {
  it("an exact SKU lights every bin holding it and totals only that SKU", () => {
    const r = searchLocations(rows, [], "bw20");
    expect([...r.ids].sort()).toEqual(["a1", "a3", "b1"]);
    expect(r.match).toBe("exact");
    expect(r.units).toBe(36);
    expect(r.cartons).toBe(3);
  });

  it("an LPN from the containers list lights its location, with or without the % prefix", () => {
    const r = searchLocations(rows, [{ code: "C-466-007", location_id: "b2" }], "%C-466-007");
    expect([...r.ids]).toEqual(["b2"]);
  });

  it("an LPN in the contents lights its bin", () => {
    expect([...searchLocations(rows, [], "C-OB-0002").ids]).toEqual(["a2"]);
  });

  it("a face or bay prefix lights its locations", () => {
    expect([...searchLocations(rows, [], "03").ids].sort()).toEqual(["b1", "b2"]);
    expect([...searchLocations(rows, [], "02-01").ids].sort()).toEqual(["a1", "a2", "a3"]);
    expect([...searchLocations(rows, [], "IN-01").ids]).toEqual(["x"]);
  });

  it("falls back to contains for three or more characters", () => {
    const r = searchLocations(rows, [], "OB-000");
    expect(r.match).toBe("partial");
    expect(r.ids.size).toBe(3);
    expect(searchLocations(rows, [], "NB").match).toBe("none");
    expect(searchLocations(rows, [], "  ").ids.size).toBe(0);
  });
});

describe("words", () => {
  it("spells out a bay-level and names a floor location", () => {
    expect(locationWords(rows[1])).toBe("Face 02 · Bay 01 · Level 2");
    expect(locationWords({ kind: "station", name: "Pack station 1", face: null, bay: null, level: null, is_overflow: false })).toBe(
      "Pack station 1 · Station",
    );
  });
});
