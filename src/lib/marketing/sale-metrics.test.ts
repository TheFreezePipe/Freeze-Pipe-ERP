import { describe, expect, it } from "vitest";
import laborDay from "./__fixtures__/sale-labor-day-2026.json";
import fallLive from "./__fixtures__/sale-fall-2026-live.json";
import bfUpcoming from "./__fixtures__/sale-black-friday-2026-upcoming.json";
import { bandWord, computeSaleMetrics, judge, type SaleInput } from "./sale-metrics";

// Fixtures are rpc_sale_metrics outputs captured from production on
// 2026-10-13 (Labor Day as of Oct 13; Fall Sale as of Oct 5 2:00 pm ET,
// public day 1; Black Friday before early access).
const LD = laborDay as unknown as SaleInput;
const FALL = fallLive as unknown as SaleInput;
const BF = bfUpcoming as unknown as SaleInput;

describe("judge", () => {
  it("colours only when |z| ≥ 2", () => {
    expect(judge(120, 100).tone).toBe("g"); // z = 2 exactly → coloured
    expect(judge(119, 100).tone).toBe("k");
    expect(judge(140, 100).tone).toBe("g");
    expect(judge(60, 100).tone).toBe("r");
  });
  it("uses the ±10% band for plans", () => {
    expect(judge(109, 100, { mode: "band" }).tone).toBe("k");
    expect(judge(111, 100, { mode: "band" }).tone).toBe("g");
    expect(judge(89, 100, { mode: "band" }).tone).toBe("r");
  });
  it("flags small references", () => {
    expect(judge(15, 10).small).toBe(true);
    expect(judge(null, null).delta).toBeNull();
  });
  it("names the band", () => {
    expect(bandWord(1)).toBe("Within noise");
    expect(bandWord(2.5)).toBe("Likely up");
    expect(bandWord(-4)).toBe("Clearly down");
  });
});

describe("Labor Day 2026 (ended)", () => {
  const M = computeSaleMetrics(LD);
  it("is an ended sale with the whole window closed", () => {
    expect(M.phase).toBe("ended");
    expect(M.live).toBe(false);
    expect(M.G.full.done).toBe(12); // EA Aug 27–31 + public Sep 1–7
    expect(M.G.ea.rows.length).toBe(5);
    expect(M.G.main.rows.length).toBe(7);
    expect(M.G.post.rows.length).toBe(14);
  });
  it("matches the replayed order counts", () => {
    expect(M.G.ea.A.orders).toBe(539);
    expect(M.G.full.A.orders).toBeGreaterThan(1700);
    expect(M.scorecard.orders.actual).toBe(M.G.full.A.orders);
  });
  it("reads the frozen baseline", () => {
    expect(M.base.days).toBe(23);
    expect(M.base.ordersDay).toBeCloseTo(96.65, 1);
    expect(M.base.short).toBe(false);
    expect(M.days.filter((d) => d.phase === "main").every((d) => d.base.orders > 60)).toBe(true);
  });
  it("judges public lift as clearly up and the sale as beating the derived plan or not, never both empty", () => {
    expect(M.G.main.lift.orders.delta).toBeGreaterThan(0.4);
    expect(M.status.liftBand).toBe("Clearly up");
    expect(M.status.pace).toBeNull();
    expect(M.status.planResult).not.toBeNull();
    expect(M.status.result).toBe("provisional");
  });
  it("counts the sale code from the ShipStation discount lines", () => {
    const offer = M.offers[0];
    expect(offer.code).toBe("labor");
    expect(offer.redemptions).toBe(797);
    expect(offer.discount).toBeCloseTo(14988.53, 0);
    expect(offer.structure.find((f) => f[0] === "Redemption")?.[1]).toMatch(/% of orders/);
    expect(M.codes.find((c) => c.code === "freedom")?.kind).toBe("other_sale");
    expect(M.alerts.some((a) => a.code === "other_sale_code")).toBe(true);
  });
  it("leaves revenue pending and models margin at list", () => {
    expect(M.scorecard.paid.actual).toBeNull();
    expect(M.scorecard.paid.pending).toBe(true);
    expect(M.margin.priceBasis).toBe("modeled");
    expect(M.margin.quality).toBe("provisional");
    expect(M.margin.saleDisc).toBeGreaterThan(14000);
    expect(Number.isFinite(M.margin.net)).toBe(true);
    expect(M.margin.post14).not.toBeNull(); // 14 post days have passed by Oct 13
  });
  it("builds products with shares that sum to at most 1", () => {
    expect(M.products.length).toBeGreaterThan(10);
    const share = M.products.reduce((s, p) => s + p.share, 0) + (M.other?.share ?? 0);
    expect(share).toBeLessThanOrEqual(1.0001);
    expect(M.products.every((p) => p.runway === "lasted" || p.runway === "ran_out")).toBe(true);
  });
});

describe("Fall Sale (live, public day 1, 2:00 pm ET)", () => {
  const M = computeSaleMetrics(FALL);
  it("is live, in the 24-hour reading window, with a partial day", () => {
    expect(M.phase).toBe("live");
    expect(M.status.pace).toBe("reading");
    const today = M.days.find((d) => d.k === "2026-10-05");
    expect(today?.partial).toBe(true);
    expect(today?.orders).toBe(46);
    expect(M.h).toBeGreaterThan(0.2);
    expect(M.h).toBeLessThan(0.8);
    expect(M.scorecard.orders.planD.delta).not.toBeNull(); // computed; the page hides it while Reading
    expect(M.scorecard.orders.note[0]).toMatch(/by now/);
  });
  it("counts early access against the baseline only", () => {
    expect(M.G.ea.A.orders).toBe(356);
    expect(M.G.ea.done).toBe(4);
    expect(M.G.main.done).toBe(1);
    expect(M.G.post.done).toBe(0);
    expect(M.margin.post14).toBeNull();
  });
  it("reads both offers' codes and the gift attach", () => {
    const coil = M.offers.find((o) => o.code === "coil");
    expect(coil?.redemptions).toBe(14);
    expect(coil?.structure.find((f) => f[0] === "Attach")).toBeTruthy();
    const fall10 = M.offers.filter((o) => o.code === "fall10");
    expect(fall10.length).toBe(3);
    expect(M.codes.find((c) => c.code === "labor")?.kind).toBe("other_sale");
  });
  it("marks gift runway on the HT-5 coil", () => {
    const gift = M.products.find((p) => p.role === "gift");
    expect(gift?.sku).toBe("HT-5");
    expect(["sellable0", "runs_out", "lasts"]).toContain(gift?.runway);
  });
});

describe("Black Friday (upcoming)", () => {
  const M = computeSaleMetrics(BF);
  it("has a plan and no actuals", () => {
    expect(M.phase).toBe("upcoming");
    expect(M.status.pace).toBe("upcoming");
    expect(M.planSource).toBe("derived");
    expect(M.planOrders).toBeGreaterThan(1000);
    expect(M.scorecard.orders.actual).toBeNull();
    expect(M.G.full.done).toBe(0);
    expect(M.days.every((d) => d.future)).toBe(true);
    expect(M.alerts.some((a) => a.code === "plan_missing")).toBe(true);
  });
  it("previews the baseline with 20 clean days", () => {
    expect(M.base.days).toBe(20);
    expect(M.base.short).toBe(false);
    expect(M.base.frozen).toBe(false);
  });
  it("shows offers as scheduled with plan facts", () => {
    expect(M.offers.every((o) => o.status === "scheduled" || o.status === "missing_code")).toBe(true);
  });
});
