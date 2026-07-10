import { describe, it, expect } from "vitest";
import {
  applyDiscountToListD2C,
  DEFAULT_CC_FEE_RATE,
  type ListD2CResult,
} from "./inventory-math";
import type { SKUEconomics } from "@/types/database";

// Discount Lens math (SKU Economics page). These pin the two things the
// lens must get right: discount stacking order (percent first, then
// dollars, clamped at $0) and the credit-card fee rescaling with the
// charged price while every other cost bucket stays put.

const d2c = (totalD2C: number): ListD2CResult => ({
  rawCost: 0,
  importCost: 0,
  mfgCost: 0,
  packShipCost: 0,
  totalD2C,
  contributionMargin: 0,
});

const econWithFee = (credit_card_fees: number | null) =>
  ({ credit_card_fees }) as SKUEconomics;

describe("applyDiscountToListD2C", () => {
  it("percent-off rescales the default cc fee with the price", () => {
    // $100 retail, $40 total D2C of which $3 is the default 3% fee.
    const r = applyDiscountToListD2C(d2c(40), econWithFee(null), 100, 20, 0);
    expect(r.discountedPrice).toBe(80);
    // fee drops $3 -> $2.40, so D2C drops to $39.40
    expect(r.totalD2C).toBeCloseTo(39.4, 10);
    expect(r.marginPerUnit).toBeCloseTo(40.6, 10);
    expect(r.contributionMargin).toBeCloseTo(40.6 / 80, 10);
  });

  it("stacks percent first, then dollars off", () => {
    // 10% then $5 on $100 -> $85 (NOT (100-5)*0.9 = 85.5)
    const r = applyDiscountToListD2C(d2c(40), econWithFee(null), 100, 10, 5);
    expect(r.discountedPrice).toBe(85);
  });

  it("a stored per-SKU fee implies its own rate", () => {
    // Stored $2 fee on $100 retail = 2% rate; 50% off -> fee $1.
    const r = applyDiscountToListD2C(d2c(40), econWithFee(2), 100, 50, 0);
    expect(r.discountedPrice).toBe(50);
    expect(r.totalD2C).toBeCloseTo(40 - 2 + 1, 10);
  });

  it("clamps at $0 and reports null margin %", () => {
    const r = applyDiscountToListD2C(d2c(40), econWithFee(null), 30, 0, 45);
    expect(r.discountedPrice).toBe(0);
    expect(r.contributionMargin).toBeNull();
    // Fee at $0 price is $0; the remaining D2C is pure cost, all negative margin.
    expect(r.marginPerUnit).toBeCloseTo(-(40 - 30 * DEFAULT_CC_FEE_RATE), 10);
  });

  it("ignores negative inputs and caps percent at 100", () => {
    const identical = applyDiscountToListD2C(d2c(40), econWithFee(null), 100, -5, -10);
    expect(identical.discountedPrice).toBe(100);
    expect(identical.totalD2C).toBeCloseTo(40, 10);
    const free = applyDiscountToListD2C(d2c(40), econWithFee(null), 100, 250, 0);
    expect(free.discountedPrice).toBe(0);
  });
});
