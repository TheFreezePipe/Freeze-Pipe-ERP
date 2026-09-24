import { describe, it, expect } from "vitest";
import {
  SALE_PALETTE,
  SALE_PALETTE_ENTRIES,
  saleColorMap,
  saleTextColor,
  assignSaleLanes,
  saleRoleOnDay,
  saleSegmentOnDay,
  spanFirstDay,
  weekKeyOf,
  indexSaleSpans,
  formatDayKeyShort,
  formatSpanRange,
  hexToRgba,
  type SaleSpanInput,
} from "./sale-spans";
import { shiftDayKey } from "@/lib/marketing-format";

function span(over: Partial<SaleSpanInput> & { id: string; start: string; end: string }): SaleSpanInput {
  return { name: over.id, color: "#000", eaStart: null, past: false, approval: null, ...over };
}

/** Weekday (0 = Sun) of a YYYY-MM-DD key, local math like the calendar. */
function dowOf(key: string): number {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).getDay();
}

describe("SALE_PALETTE", () => {
  it("has eight hues, each with a text step, and never the launch violet or broadcast cyan", () => {
    expect(SALE_PALETTE).toHaveLength(8);
    expect(SALE_PALETTE_ENTRIES).toHaveLength(8);
    expect(new Set(SALE_PALETTE).size).toBe(8);
    expect(SALE_PALETTE).not.toContain("#a78bfa");
    expect(SALE_PALETTE).not.toContain("#22d3ee");
    for (const p of SALE_PALETTE_ENTRIES) {
      expect(saleTextColor(p.solid)).toBe(p.text);
      expect(saleTextColor(p.solid.toUpperCase())).toBe(p.text);
    }
    expect(SALE_PALETTE[0]).toBe("#fbbf24");
    expect(saleTextColor("#fbbf24")).toBe("#fcd34d");
  });

  it("falls back to a neutral text step for an unknown solid", () => {
    expect(saleTextColor("#9a9a9a")).toBe("#e6e6e6");
  });

  it("hexToRgba expands a 6-digit hex and passes anything else through", () => {
    expect(hexToRgba("#fbbf24", 0.18)).toBe("rgba(251,191,36,0.18)");
    expect(hexToRgba("#FBBF24", 1)).toBe("rgba(251,191,36,1)");
    expect(hexToRgba("hsl(45, 85%, 55%)", 0.5)).toBe("hsl(45, 85%, 55%)");
  });
});

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

describe("formatDayKeyShort / formatSpanRange", () => {
  it("formats 'Mon d' and an en-dash range, collapsing one-day sales", () => {
    expect(formatDayKeyShort("2026-09-24")).toBe("Sep 24");
    expect(formatDayKeyShort("2027-01-06")).toBe("Jan 6");
    expect(formatSpanRange({ start: "2026-09-24", end: "2026-10-02" })).toBe("Sep 24 – Oct 2");
    expect(formatSpanRange({ start: "2026-12-01", end: "2026-12-01" })).toBe("Dec 1");
  });
});

describe("saleSegmentOnDay", () => {
  // 2026-11-08 is a Sunday (see weekKeyOf), so 11-12 Thu, 11-14 Sat, 11-15 Sun, 11-16 Mon.
  const seg = (s: SaleSpanInput, day: string) => saleSegmentOnDay(s, day, dowOf(day));

  it("returns null outside the span", () => {
    const s = span({ id: "s", start: "2026-11-12", end: "2026-11-13" });
    expect(seg(s, "2026-11-11")).toBeNull();
    expect(seg(s, "2026-11-14")).toBeNull();
  });

  it("single-day sale: cap, rounded both ends, no bleed, label, one-day tooltip", () => {
    const s = span({ id: "flash", name: "Flash", start: "2026-12-01", end: "2026-12-01" });
    expect(seg(s, "2026-12-01")).toEqual({
      role: "single",
      hollow: false,
      cap: true,
      roundL: true,
      roundR: true,
      bleedL: false,
      bleedR: false,
      edgeL: false,
      edgeR: false,
      showLabel: true,
      tooltipParts: ["Flash", "Dec 1"],
    });
  });

  it("early access then open across a Sat/Sun wrap: hollow leader, square wrap, cap on the open day, label on Sunday", () => {
    const s = span({ id: "bf", name: "BF", eaStart: "2026-11-12", start: "2026-11-16", end: "2026-11-20", past: true });
    const thu = seg(s, "2026-11-12")!; // EA start
    expect(thu).toMatchObject({ role: "ea_start", hollow: true, cap: false, roundL: true, roundR: false, bleedL: false, bleedR: true, edgeL: false, edgeR: false, showLabel: true });
    expect(thu.tooltipParts).toEqual(["BF", "early access Nov 12", "Nov 16 – Nov 20", "locked (past)"]);
    const fri = seg(s, "2026-11-13")!;
    expect(fri).toMatchObject({ role: "ea_line", hollow: true, cap: false, roundL: false, roundR: false, bleedL: true, bleedR: true, edgeL: false, edgeR: false, showLabel: false });
    const sat = seg(s, "2026-11-14")!; // wraps into next row: square, to the cell edge, no gap bleed
    expect(sat).toMatchObject({ role: "ea_line", hollow: true, roundR: false, bleedL: true, bleedR: false, edgeR: true, showLabel: false });
    const sun = seg(s, "2026-11-15")!; // continues from previous row: square at the left edge, hosts the row's label
    expect(sun).toMatchObject({ role: "ea_line", hollow: true, cap: false, roundL: false, bleedL: false, edgeL: true, bleedR: true, showLabel: true });
    const mon = seg(s, "2026-11-16")!; // public open: solid + cap, fused (no radius, bleeds both ways)
    expect(mon).toMatchObject({ role: "start", hollow: false, cap: true, roundL: false, roundR: false, bleedL: true, bleedR: true, edgeL: false, edgeR: false, showLabel: false });
    const fri2 = seg(s, "2026-11-20")!; // true last day
    expect(fri2).toMatchObject({ role: "end", hollow: false, cap: false, roundL: false, roundR: true, bleedL: true, bleedR: false, edgeR: false, showLabel: false });
  });

  it("three-week sale shows its name exactly once per week row", () => {
    const s = span({ id: "long", name: "Long", start: "2026-11-10", end: "2026-11-27" }); // Tue → Fri, three rows
    const labelDays: string[] = [];
    for (let k = s.start; k <= s.end; k = shiftDayKey(k, 1)) {
      if (seg(s, k)!.showLabel) labelDays.push(k);
    }
    expect(labelDays).toEqual(["2026-11-10", "2026-11-15", "2026-11-22"]);
    expect(seg(s, "2026-11-10")!.cap).toBe(true);
    expect(seg(s, "2026-11-15")!.cap).toBe(false);
  });

  it("ending on a Sunday: the last piece is square on the left edge, rounded on the right, and hosts the label", () => {
    const s = span({ id: "e", start: "2026-11-12", end: "2026-11-15" });
    expect(seg(s, "2026-11-14")!).toMatchObject({ role: "line", roundR: false, bleedR: false, edgeR: true });
    expect(seg(s, "2026-11-15")!).toMatchObject({ role: "end", roundL: false, roundR: true, bleedL: false, bleedR: false, edgeL: true, edgeR: false, showLabel: true, cap: false });
  });

  it("starting on a Sunday: true first day is rounded (not an edge wrap) and hosts the label", () => {
    const s = span({ id: "s", start: "2026-11-15", end: "2026-11-18" });
    expect(seg(s, "2026-11-15")!).toMatchObject({ role: "start", cap: true, roundL: true, edgeL: false, bleedL: false, bleedR: true, showLabel: true });
  });

  it("ending on a Saturday: true last day is rounded (not an edge wrap), no label", () => {
    const s = span({ id: "s", start: "2026-11-11", end: "2026-11-14" });
    expect(seg(s, "2026-11-14")!).toMatchObject({ role: "end", roundR: true, edgeR: false, bleedR: false, bleedL: true, showLabel: false });
  });

  it("starting on a Saturday: cap + left radius, square into the next row, then a labelled square Sunday piece", () => {
    const s = span({ id: "s", start: "2026-11-14", end: "2026-11-18" });
    expect(seg(s, "2026-11-14")!).toMatchObject({ role: "start", cap: true, roundL: true, roundR: false, bleedL: false, bleedR: false, edgeL: false, edgeR: true, showLabel: true });
    expect(seg(s, "2026-11-15")!).toMatchObject({ role: "line", cap: false, roundL: false, bleedL: false, edgeL: true, bleedR: true, showLabel: true });
    expect(seg(s, "2026-11-18")!).toMatchObject({ role: "end", roundR: true, bleedL: true, bleedR: false, showLabel: false });
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
