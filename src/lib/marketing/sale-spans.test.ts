import { describe, it, expect } from "vitest";
import {
  SALE_PALETTE,
  saleColorMap,
  assignSaleLanes,
  saleRoleOnDay,
  spanFirstDay,
  weekKeyOf,
  indexSaleSpans,
  type SaleSpanInput,
} from "./sale-spans";

function span(over: Partial<SaleSpanInput> & { id: string; start: string; end: string }): SaleSpanInput {
  return { name: over.id, color: "#000", eaStart: null, past: false, approval: null, ...over };
}

describe("saleColorMap", () => {
  it("assigns distinct colors in start-date order, independent of input order", () => {
    const a = { id: "a", starts_at: "2026-10-05T00:00:00+00:00" };
    const b = { id: "b", starts_at: "2026-11-12T00:00:00+00:00" };
    const c = { id: "c", starts_at: "2026-12-01T00:00:00+00:00" };
    const m1 = saleColorMap([c, a, b]);
    const m2 = saleColorMap([a, b, c]);
    expect(m1.get("a")).toBe(SALE_PALETTE[0]);
    expect(m1.get("b")).toBe(SALE_PALETTE[1]);
    expect(m1.get("c")).toBe(SALE_PALETTE[2]);
    expect([...m1.entries()]).toEqual([...m2.entries()].sort());
  });

  it("wraps around the palette", () => {
    const sales = Array.from({ length: SALE_PALETTE.length + 1 }, (_, i) => ({ id: `s${i}`, starts_at: `2026-01-${String(i + 1).padStart(2, "0")}` }));
    const m = saleColorMap(sales);
    expect(m.get("s0")).toBe(m.get(`s${SALE_PALETTE.length}`));
  });
});

describe("assignSaleLanes", () => {
  it("non-overlapping sales share lane 0", () => {
    const lanes = assignSaleLanes([
      span({ id: "fall", start: "2026-10-05", end: "2026-10-09", eaStart: "2026-10-01" }),
      span({ id: "bf", start: "2026-11-12", end: "2026-11-29", eaStart: "2026-11-05" }),
      span({ id: "cm", start: "2026-12-01", end: "2026-12-03" }),
    ]);
    expect(lanes.map((l) => [l.id, l.lane])).toEqual([["fall", 0], ["bf", 0], ["cm", 0]]);
  });

  it("overlapping sales take different lanes, counting early access as occupied", () => {
    const lanes = assignSaleLanes([
      span({ id: "bf", start: "2026-11-12", end: "2026-11-29", eaStart: "2026-11-05" }),
      span({ id: "flash", start: "2026-11-06", end: "2026-11-06" }),
      span({ id: "cm", start: "2026-11-30", end: "2026-12-03" }),
    ]);
    const byId = Object.fromEntries(lanes.map((l) => [l.id, l.lane]));
    expect(byId.bf).toBe(0);
    expect(byId.flash).toBe(1);
    expect(byId.cm).toBe(0);
  });
});

describe("saleRoleOnDay", () => {
  const bf = span({ id: "bf", start: "2026-11-12", end: "2026-11-29", eaStart: "2026-11-05" });
  it("early access start, early access line, start, line, end", () => {
    expect(spanFirstDay(bf)).toBe("2026-11-05");
    expect(saleRoleOnDay(bf, "2026-11-04")).toBeNull();
    expect(saleRoleOnDay(bf, "2026-11-05")).toBe("ea_start");
    expect(saleRoleOnDay(bf, "2026-11-08")).toBe("ea_line");
    expect(saleRoleOnDay(bf, "2026-11-11")).toBe("ea_line");
    expect(saleRoleOnDay(bf, "2026-11-12")).toBe("start");
    expect(saleRoleOnDay(bf, "2026-11-20")).toBe("line");
    expect(saleRoleOnDay(bf, "2026-11-29")).toBe("end");
    expect(saleRoleOnDay(bf, "2026-11-30")).toBeNull();
  });
  it("one-day sale is a single marker; early access on the start day is ignored", () => {
    expect(saleRoleOnDay(span({ id: "x", start: "2026-12-01", end: "2026-12-01" }), "2026-12-01")).toBe("single");
    const same = span({ id: "y", start: "2026-12-01", end: "2026-12-03", eaStart: "2026-12-01" });
    expect(spanFirstDay(same)).toBe("2026-12-01");
    expect(saleRoleOnDay(same, "2026-12-01")).toBe("start");
  });
});

describe("weekKeyOf / indexSaleSpans", () => {
  it("week key is the Sunday", () => {
    expect(weekKeyOf("2026-11-12")).toBe("2026-11-08"); // Thu -> Sun
    expect(weekKeyOf("2026-11-08")).toBe("2026-11-08");
    expect(weekKeyOf("2026-11-14")).toBe("2026-11-08"); // Sat
  });
  it("indexes every drawn day and reserves lanes per week", () => {
    const lanes = assignSaleLanes([
      span({ id: "bf", start: "2026-11-12", end: "2026-11-14", eaStart: "2026-11-10" }),
      span({ id: "flash", start: "2026-11-13", end: "2026-11-13" }),
    ]);
    const { byDay, lanesByWeek } = indexSaleSpans(lanes);
    expect([...byDay.keys()].sort()).toEqual(["2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14"]);
    expect(byDay.get("2026-11-13")?.map((s) => s.id).sort()).toEqual(["bf", "flash"]);
    expect(lanesByWeek.get("2026-11-08")).toBe(2);
  });
});
