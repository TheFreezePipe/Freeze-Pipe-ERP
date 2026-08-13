import { describe, it, expect } from "vitest";
import {
  buildTransitRows,
  windowStats,
  trailingMedianSeries,
  transitBand,
  inTransitSummary,
  percentile,
  ON_TIME_GRACE_DAYS,
  P90_MIN_N,
  TREND_MIN_N,
  type TransitShipmentSource,
} from "./transit-report";

const TODAY = "2026-08-13";
let seq = 0;
const ship = (over: Partial<TransitShipmentSource>): TransitShipmentSource => ({
  id: `id-${++seq}`,
  shipment_number: `S${seq}`,
  freight_type: "sea",
  status: "delivered",
  ship_date: null,
  actual_arrival_date: null,
  eta_original: null,
  receipt_confirmed_at: null,
  china_customs_delay: false,
  ...over,
});

/** Arrived sea shipment: `transit` days ending `arrival`, optional extras. */
const arrived = (
  arrival: string,
  transit: number,
  over: Partial<TransitShipmentSource> = {},
): TransitShipmentSource => {
  const shipDate = new Date(Date.parse(arrival + "T00:00:00Z") - transit * 86_400_000)
    .toISOString()
    .slice(0, 10);
  return ship({ ship_date: shipDate, actual_arrival_date: arrival, ...over });
};

describe("buildTransitRows", () => {
  it("keeps only arrived sea shipments with both dates, sorted by arrival", () => {
    const rows = buildTransitRows([
      arrived("2026-08-01", 35),
      arrived("2026-07-01", 30),
      ship({ freight_type: "air", ship_date: "2026-08-01", actual_arrival_date: "2026-08-03" }),
      ship({ ship_date: "2026-07-01" }), // still on the water
      ship({ actual_arrival_date: "2026-07-15" }), // no ship date
    ]);
    expect(rows.map((r) => r.arrivalDate)).toEqual(["2026-07-01", "2026-08-01"]);
  });

  it("drops negative transits and clamps negative dwell to zero", () => {
    const rows = buildTransitRows([
      ship({ ship_date: "2026-08-10", actual_arrival_date: "2026-08-01" }), // negative
      arrived("2026-08-01", 30, { receipt_confirmed_at: "2026-07-30T12:00:00Z" }), // confirm before arrival
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].dwellDays).toBe(0);
  });

  it("computes slip vs the original promise and null when unpromised", () => {
    const rows = buildTransitRows([
      arrived("2026-08-05", 30, { eta_original: "2026-08-01" }),
      arrived("2026-08-06", 30),
    ]);
    expect(rows[0].slipDays).toBe(4);
    expect(rows[1].slipDays).toBeNull();
  });
});

describe("windowStats", () => {
  it("computes the tile numbers for a small window", () => {
    const rows = buildTransitRows([
      arrived("2026-08-01", 30, { eta_original: "2026-07-30", receipt_confirmed_at: "2026-08-01T09:00:00Z" }), // slip 2 on-time
      arrived("2026-08-03", 40, { eta_original: "2026-07-28", receipt_confirmed_at: "2026-08-05T09:00:00Z" }), // slip 6 late, dwell 2
      arrived("2026-08-05", 35, { eta_original: "2026-08-02", receipt_confirmed_at: "2026-08-05T21:00:00Z" }), // slip 3 on-time (boundary)
    ]);
    const s = windowStats(rows, 30, TODAY);
    expect(s.n).toBe(3);
    expect(s.medianTransit).toBe(35);
    expect(s.avgTransit).toBeCloseTo(35);
    expect([s.minTransit, s.maxTransit]).toEqual([30, 40]);
    expect(s.onTimeCount).toBe(2); // slip 3 = exactly the grace line, still on time
    expect(s.withPromise).toBe(3);
    expect(s.lateMedianSlip).toBe(6);
    expect(s.s2sMedian).toBe(35); // 30+0, 40+2, 35+0 → median 35
    expect(s.s2sWorst).toEqual({ days: 42, number: rows[1].number });
    expect(s.dwellMedian).toBe(0);
    expect(s.dwellMax).toBe(2);
  });

  it("suppresses P90 below the minimum sample and shows it at the threshold", () => {
    const under = buildTransitRows(
      Array.from({ length: P90_MIN_N - 1 }, (_, i) =>
        arrived(`2026-07-${String(i + 1).padStart(2, "0")}`, 30 + i, { receipt_confirmed_at: "2026-08-01T00:00:00Z" }),
      ),
    );
    expect(windowStats(under, 90, TODAY).s2sP90).toBeNull();

    const at = buildTransitRows(
      Array.from({ length: P90_MIN_N }, (_, i) =>
        arrived(`2026-07-${String(i + 1).padStart(2, "0")}`, 30 + i, { receipt_confirmed_at: `2026-07-${String(i + 1).padStart(2, "0")}T12:00:00Z` }),
      ),
    );
    expect(windowStats(at, 90, TODAY).s2sP90).not.toBeNull();
  });

  it("hides the trend below TREND_MIN_N and handles the empty window", () => {
    const four = buildTransitRows(
      Array.from({ length: TREND_MIN_N - 1 }, (_, i) => arrived(`2026-08-0${i + 1}`, 30)),
    );
    expect(windowStats(four, 30, TODAY).showTrend).toBe(false);

    const empty = windowStats([], 30, TODAY);
    expect(empty.n).toBe(0);
    expect(empty.s2sWorst).toBeNull();
    expect(empty.lateMedianSlip).toBeNull();
  });

  it("windows by arrival date inclusively", () => {
    const rows = buildTransitRows([arrived("2026-07-14", 30), arrived("2026-07-13", 30)]);
    expect(windowStats(rows, 30, TODAY).n).toBe(1); // cutoff = 2026-07-14
  });

  it("excludes unconfirmed arrivals from ship-to-sellable but not transit", () => {
    const rows = buildTransitRows([
      arrived("2026-08-01", 30, { receipt_confirmed_at: "2026-08-02T00:00:00Z" }),
      arrived("2026-08-03", 50), // arrived, not yet checked in
    ]);
    const s = windowStats(rows, 30, TODAY);
    expect(s.n).toBe(2);
    expect(s.maxTransit).toBe(50);
    expect(s.s2sMedian).toBe(31); // only the confirmed one
    expect(s.s2sWorst?.days).toBe(31);
  });
});

describe("trailingMedianSeries / transitBand / percentile", () => {
  it("computes a trailing-5 median per arrival", () => {
    const rows = buildTransitRows(
      [28, 30, 40, 34, 36, 50].map((t, i) => arrived(`2026-07-0${i + 1}`, t)),
    );
    const series = trailingMedianSeries(rows);
    expect(series[0]).toBe(28);
    expect(series[1]).toBe(29);
    expect(series[4]).toBe(34); // median of 28,30,40,34,36
    expect(series[5]).toBe(36); // median of 30,40,34,36,50
  });

  it("computes the full-history band", () => {
    const rows = buildTransitRows(
      [20, 30, 40, 50].map((t, i) => arrived(`2026-07-0${i + 1}`, t)),
    );
    expect(transitBand(rows)).toEqual({ p25: 27.5, p75: 42.5, p90: 47 });
  });

  it("percentile interpolates and survives empty input", () => {
    expect(percentile([10, 20], 0.5)).toBe(15);
    expect(percentile([], 0.9)).toBe(0);
  });
});

describe("inTransitSummary", () => {
  it("summarizes open sea shipments with the oldest flagged", () => {
    const s = inTransitSummary(
      [
        ship({ status: "on_the_water", ship_date: "2026-08-01" }),
        ship({ status: "high_risk", ship_date: "2026-05-27", shipment_number: "431" }),
        ship({ status: "delivered", ship_date: "2026-06-01", actual_arrival_date: "2026-07-01" }),
        ship({ freight_type: "air", status: "tracking", ship_date: "2026-08-01" }),
      ],
      TODAY,
    );
    expect(s).toEqual({ count: 2, oldestDays: 78, oldestNumber: "431", oldestHighRisk: true });
  });

  it("returns null when nothing is on the water", () => {
    expect(inTransitSummary([ship({ status: "delivered" })], TODAY)).toBeNull();
  });
});

describe("grace constant sanity", () => {
  it("uses the agreed 3-day grace", () => {
    expect(ON_TIME_GRACE_DAYS).toBe(3);
  });
});
