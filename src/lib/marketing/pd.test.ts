import { describe, it, expect } from "vitest";
import { workback, orderByFromReadyBy, deadlineState, daysBetween } from "./workback";
import {
  gateMissing,
  aging,
  deadlineChain,
  nextDeadline,
  riskDot,
  cardFlags,
  brandedSpecRequired,
  marginTone,
  nextStage,
  type PdCardLike,
} from "./pd";

const TODAY = "2026-08-19";

const card = (over: Partial<PdCardLike> = {}): PdCardLike => ({
  stage: "good_ideas",
  stage_entered_at: "2026-08-01T00:00:00Z",
  owner_id: null,
  display_category: null,
  category: null,
  hypothesis: null,
  target_launch_date: null,
  supplier_id: null,
  msrp: null,
  spec_sent_at: null,
  quoted_unit_cost: null,
  moq_qty: null,
  quoted_lead_days: null,
  packaging: null,
  logo_placement: null,
  koozie: null,
  insert_cards: null,
  carton_qty: null,
  cost_basis_confirmed: false,
  sku_code: null,
  linked_sku_id: null,
  linked_factory_order_id: null,
  ...over,
});

describe("workback", () => {
  it("backs off launch → arrive (−12) → ship (−35 sea) → order (−30 make)", () => {
    const ch = workback("2026-12-18");
    expect(ch.arriveBy).toBe("2026-12-06");
    expect(ch.shipBy).toBe("2026-11-01");
    expect(ch.orderBy).toBe("2026-10-02");
  });

  it("air fallback: order by arrive − 15 − 30", () => {
    const ch = workback("2026-12-18");
    expect(ch.orderByAir).toBe("2026-10-22");
  });

  it("spec-by subtracts the sample loop from order-by", () => {
    const ch = workback("2026-12-18", { sampleLoopDays: 35 });
    expect(ch.specBy).toBe("2026-08-28");
  });

  it("orderByFromReadyBy = ready-by − (35 + 30), the split of the old 75", () => {
    expect(orderByFromReadyBy("2026-12-06")).toBe("2026-10-02");
  });

  it("deadlineState thresholds", () => {
    expect(deadlineState("2026-08-18", TODAY)).toBe("late");
    expect(deadlineState("2026-08-25", TODAY)).toBe("tight");
    expect(deadlineState("2026-09-10", TODAY)).toBe("ok");
    expect(daysBetween(TODAY, "2026-08-29")).toBe(10);
  });
});

describe("gateMissing mirrors fn_pd_gate_missing", () => {
  it("good_ideas → ready_to_begin wants category, hypothesis, target", () => {
    expect(gateMissing(card(), "ready_to_begin")).toEqual([
      "display_category",
      "hypothesis",
      "target_launch_date",
    ]);
  });

  it("→ china_working wants factory + spec sent", () => {
    expect(gateMissing(card(), "china_working")).toEqual([
      "supplier_id",
      "spec_sent_at",
    ]);
  });

  it("→ ready_for_confirmation: full spec + margin basis + product for a branded category", () => {
    const m = gateMissing(card({ display_category: "Bongs" }), "ready_for_confirmation");
    expect(m).toEqual([
      "quoted_unit_cost",
      "moq_qty",
      "quoted_lead_days",
      "packaging",
      "logo_placement",
      "koozie",
      "insert_cards",
      "msrp",
      "category",
      "carton_qty",
      "cost_basis",
      "sku_code",
      "product_created",
    ]);
  });

  it("Accessories waive logo/koozie/inserts but still need packaging", () => {
    const m = gateMissing(card({ display_category: "Accessories" }), "ready_for_confirmation");
    expect(m).toContain("packaging");
    expect(m).not.toContain("logo_placement");
    expect(m).not.toContain("koozie");
    expect(m).not.toContain("insert_cards");
    expect(brandedSpecRequired({ display_category: "Accessories" })).toBe(false);
    expect(brandedSpecRequired({ display_category: "Coils" })).toBe(true);
  });

  it("clears once everything is filled and the product exists", () => {
    const full = card({
      display_category: "Coils", quoted_unit_cost: 6.4, moq_qty: 300, quoted_lead_days: 60,
      packaging: "poly", logo_placement: "none", koozie: "No", insert_cards: "fill guide",
      msrp: 34.95, category: "fillable", carton_qty: 50, cost_basis_confirmed: true,
      sku_code: "34-DNA-AMB", linked_sku_id: "sku-1",
    });
    expect(gateMissing(full, "ready_for_confirmation")).toEqual([]);
  });

  it("→ ordered needs the product and a factory order", () => {
    expect(gateMissing(card(), "ordered")).toEqual(["product_created", "factory_order"]);
  });

  it("nextStage walks the lanes and stops at ordered", () => {
    expect(nextStage("good_ideas")).toBe("ready_to_begin");
    expect(nextStage("ordered")).toBeNull();
    expect(nextStage("halted")).toBeNull();
  });
});

describe("aging / chain / risk / flags", () => {
  it("aging tones against expected days", () => {
    expect(aging(card({ stage: "china_working", stage_entered_at: "2026-08-10T00:00:00Z" }), TODAY)).toMatchObject({ days: 9, expected: 21, tone: "ok" });
    expect(aging(card({ stage: "china_working", stage_entered_at: "2026-07-20T00:00:00Z" }), TODAY).tone).toBe("amber");
    expect(aging(card({ stage: "china_working", stage_entered_at: "2026-06-01T00:00:00Z" }), TODAY).tone).toBe("red");
    expect(aging(card({ stage: "ordered" }), TODAY).expected).toBeNull();
  });

  it("no target date → no chain, no dot", () => {
    expect(deadlineChain(card(), TODAY)).toBeNull();
    expect(riskDot(card(), TODAY)).toBeNull();
  });

  it("chain marks spec-by done once the spec is sent and carries the air fallback on order-by", () => {
    const c = card({ stage: "prototype_sent", target_launch_date: "2026-12-18", spec_sent_at: "2026-07-14" });
    const rows = deadlineChain(c, TODAY)!;
    expect(rows.map((r) => r.label)).toEqual(["Spec by", "Order by", "Ship by", "Arrive by", "Launch"]);
    expect(rows[0].state).toBe("done");
    expect(rows[1].date).toBe("2026-10-02");
    expect(rows[1].air?.date).toBe("2026-10-22");
    expect(nextDeadline(rows)?.key).toBe("orderBy");
    expect(riskDot(c, TODAY)).toBe("g"); // 44 days out
  });

  it("flags a passed deadline and an order-by inside 14d without a PO", () => {
    const late = card({ stage: "ready_for_confirmation", target_launch_date: "2026-11-01", spec_sent_at: "2026-06-20" });
    expect(cardFlags(late, TODAY)).toEqual(["Order by passed"]);
    const tight = card({ stage: "prototype_sent", target_launch_date: "2026-11-10", spec_sent_at: "2026-06-20" });
    // order-by = 11-10 − 12 − 35 − 30 = 08-24 → 5 days out → tight
    expect(cardFlags(tight, TODAY)).toEqual(["Order by inside 14d"]);
    expect(cardFlags(tight, TODAY, { hasFactoryOrderLine: true })).toEqual([]);
  });

  it("ordered / halted / purgatory cards never flag", () => {
    expect(cardFlags(card({ stage: "ordered", target_launch_date: "2026-01-01" }), TODAY)).toEqual([]);
    expect(cardFlags(card({ stage: "purgatory", target_launch_date: "2026-01-01" }), TODAY)).toEqual([]);
  });

  it("margin tone thresholds", () => {
    expect(marginTone(0.55)).toBe("ok");
    expect(marginTone(0.45)).toBe("amber");
    expect(marginTone(0.3)).toBe("red");
    expect(marginTone(null)).toBeNull();
  });
});
