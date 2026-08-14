import { describe, it, expect } from "vitest";
import {
  buildPrefillRows,
  buildSkuProof,
  windowTotals,
  monthlyStacks,
  skuRollup,
  inboundSummary,
  fillPaceFromDailyTotals,
  workingDaysUntil,
  paceVerdict,
  FILL_PACE_MIN_DAYS,
  type PrefillLineSource,
  type PrefillShipmentSource,
} from "./prefill-report";

const TODAY = "2026-08-14";
let seq = 0;

const ship = (over: Partial<PrefillShipmentSource>): PrefillShipmentSource => ({
  id: `ship-${++seq}`,
  status: "delivered",
  ship_date: "2026-06-01",
  actual_arrival_date: "2026-07-01",
  eta: null,
  ...over,
});

const line = (
  shipmentId: string,
  sku: string,
  qty: number,
  prefilled: number | null,
  over: Partial<PrefillLineSource> = {},
): PrefillLineSource => ({
  sku_id: `id-${sku}`,
  freight_shipment_id: shipmentId,
  quantity: qty,
  quantity_prefilled: prefilled,
  quantity_received: 0,
  product: { sku, product_name: `${sku} name`, category: "fillable" },
  ...over,
});

describe("buildPrefillRows", () => {
  it("keeps only arrived, fillable, tracked lines on arrival basis", () => {
    const s1 = ship({ actual_arrival_date: "2026-07-10" });
    const s2 = ship({ actual_arrival_date: null, status: "on_the_water" });
    const rows = buildPrefillRows(
      [
        line(s1.id, "BW20", 100, 40),
        line(s1.id, "BOX", 50, 0, { product: { sku: "BOX", product_name: "b", category: "accessory" } }),
        line(s1.id, "BW21", 60, null), // untracked split
        line(s2.id, "BW22", 80, 0), // still on the water
      ],
      [s1, s2],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sku: "BW20", arrivalDate: "2026-07-10", qty: 100, prefilled: 40 });
  });

  it("clamps bogus prefilled values to the line quantity", () => {
    const s1 = ship({});
    const rows = buildPrefillRows([line(s1.id, "X", 100, 250)], [s1]);
    expect(rows[0].prefilled).toBe(100);
  });
});

describe("windowTotals + monthlyStacks", () => {
  const s1 = ship({ actual_arrival_date: "2026-08-01" });
  const s2 = ship({ actual_arrival_date: "2026-07-01" });
  const s3 = ship({ actual_arrival_date: "2026-02-01" });
  const rows = buildPrefillRows(
    [line(s1.id, "A", 300, 100), line(s2.id, "B", 200, 200), line(s3.id, "C", 500, 0)],
    [s1, s2, s3],
  );

  it("windows by arrival date and counts distinct shipments", () => {
    const t90 = windowTotals(rows, 90, TODAY);
    expect(t90).toEqual({ units: 500, prefilled: 300, unfilled: 200, shipmentCount: 2 });
    const all = windowTotals(rows, Infinity, TODAY);
    expect(all.units).toBe(1000);
  });

  it("stacks by month with the thin flag on small months", () => {
    const m = monthlyStacks(rows, Infinity, TODAY);
    expect(m.map((x) => x.month)).toEqual(["2026-02", "2026-07", "2026-08"]);
    expect(m[2]).toMatchObject({ units: 300, prefilled: 100, pct: 33, thin: true }); // 1 shipment
    expect(m[0]).toMatchObject({ units: 500, thin: true }); // 1 shipment despite 500u
  });

  it("marks a month confident with enough units and shipments", () => {
    const a = ship({ actual_arrival_date: "2026-08-02" });
    const b = ship({ actual_arrival_date: "2026-08-20" });
    const m = monthlyStacks(
      buildPrefillRows([line(a.id, "A", 150, 0), line(b.id, "B", 150, 150)], [a, b]),
      90,
      TODAY,
    );
    expect(m[0].thin).toBe(false);
  });
});

describe("ask list: proof and ranking", () => {
  it("ranks by unfilled and cites factory-demonstrated capability", () => {
    const s1 = ship({ actual_arrival_date: "2026-08-01", ship_date: "2026-07-01" });
    const s2 = ship({ actual_arrival_date: "2026-08-05", ship_date: "2026-07-05" });
    const s3 = ship({ actual_arrival_date: null, status: "on_the_water", ship_date: "2026-08-01" });
    const lines = [
      line(s1.id, "BW20DNA", 500, 0),
      line(s2.id, "BW20DNA", 300, 300),
      line(s3.id, "BW20DNA", 175, 175), // in transit still counts as proof
      line(s1.id, "NB2", 400, 0),
    ];
    const proof = buildSkuProof(lines, [s1, s2, s3]);
    expect(proof.get("BW20DNA")).toEqual({
      shipments: 3,
      prefilledShipments: 2,
      lastShipDate: "2026-08-01",
    });
    expect(proof.get("NB2")?.prefilledShipments).toBe(0);

    const ranked = skuRollup(buildPrefillRows(lines, [s1, s2, s3]), 90, TODAY, proof);
    expect(ranked[0].sku).toBe("BW20DNA"); // 500 unfilled beats NB2's 400
    expect(ranked[0].proof?.prefilledShipments).toBe(2);
  });
});

describe("inboundSummary", () => {
  it("splits remaining units proportionally and buckets by ETA", () => {
    const near = ship({ status: "on_the_water", actual_arrival_date: null, eta: "2026-08-20" });
    const mid = ship({ status: "tracking", actual_arrival_date: null, eta: "2026-09-05" });
    const unknown = ship({ status: "pending", actual_arrival_date: null, eta: null });
    const summary = inboundSummary(
      [
        line(near.id, "A", 100, 40, { quantity_received: 50 }), // 50 remaining, 60% unfilled → 30
        line(mid.id, "B", 200, 0), // 200 unfilled, 15-28d out
        line(unknown.id, "C", 80, 80), // fully prefilled — no fill work
      ],
      [near, mid, unknown],
      TODAY,
    );
    expect(summary.shipments).toBe(3);
    expect(summary.units).toBe(330);
    expect(summary.unfilled).toBe(230);
    expect(summary.buckets).toEqual([30, 200, 0]);
    expect(summary.lastEta).toBe("2026-09-05");
  });

  it("ignores delivered shipments and fully-received lines", () => {
    const done = ship({ status: "delivered" });
    const open = ship({ status: "on_the_water", actual_arrival_date: null });
    const s = inboundSummary(
      [line(done.id, "A", 100, 0), line(open.id, "B", 60, 0, { quantity_received: 60 })],
      [done, open],
      TODAY,
    );
    expect(s.units).toBe(0);
    expect(s.shipments).toBe(0);
  });
});

describe("fill pace + runway verdict", () => {
  it("takes the median over active days only and suppresses below the floor", () => {
    const nine = Array(FILL_PACE_MIN_DAYS - 1).fill(100);
    expect(fillPaceFromDailyTotals([...nine, 0, 0]).unitsPerActiveDay).toBeNull();
    const pace = fillPaceFromDailyTotals([50, 0, 100, 150, 100, 100, 100, 100, 100, 100, 900]);
    expect(pace.activeDays).toBe(10);
    expect(pace.unitsPerActiveDay).toBe(100); // the 900 outlier doesn't drag a median
  });

  it("counts working days and judges the runway", () => {
    expect(workingDaysUntil("2026-08-21", "2026-08-14")).toBe(5); // Fri → next Fri
    expect(paceVerdict(10, 20)).toBe("room");
    expect(paceVerdict(20, 20)).toBe("par");
    expect(paceVerdict(30, 20)).toBe("over");
    expect(paceVerdict(5, 0)).toBe("over");
  });
});
