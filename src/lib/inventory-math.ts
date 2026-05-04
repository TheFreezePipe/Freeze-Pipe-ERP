/**
 * inventory-math — pure functions over inventory state.
 *
 * Domain logic that's used in production paths (dashboards, modals,
 * priority lists). Has no demo-data dependencies, no React, no Supabase.
 * Was previously embedded in `src/lib/demo-data.ts`, which mixed real
 * domain logic with demo seed fixtures and made it look like the math
 * was demo-only. Split out so the production-vs-demo boundary is clean.
 */

import type { SKUEconomics, ProductSKU } from "@/types/database";

/**
 * Default credit-card processing fee as a fraction of retail price.
 * Industry standard for Stripe / Shopify Payments / similar processors
 * is ~2.9–3.0% (plus a fixed per-transaction fee that's negligible at
 * our AOV). Per-SKU overrides can be stored in `sku_economics.credit_card_fees`;
 * this constant is the fallback when no row-level value exists.
 *
 * Centralized here so the rate can be changed in one place when the
 * processor contract changes. Eventually this should move to a system
 * config table with admin UI.
 */
export const DEFAULT_CC_FEE_RATE = 0.03;

/**
 * Days of stock at current burn rate. Returns a sentinel `999` for SKUs
 * with zero monthly demand (avoids divide-by-zero and makes "infinite
 * runway" sort cleanly to the bottom of any DOS-ascending list).
 */
export function computeDOS(units: number, monthlyDemand: number): number {
  if (monthlyDemand <= 0) return 999;
  return Math.round((units / (monthlyDemand / 30)) * 10) / 10;
}

/**
 * Manufacturing Priority Score
 *
 * Ranks fillable SKUs by how urgently they need manufacturing work today.
 * Higher score = more urgent = should be worked on first.
 *
 * Formula:  demand_pressure × unfilled_ratio × abc_weight
 *
 *   demand_pressure  = daily_demand / max(finished, 1)
 *     → How fast finished stock is depleting. A SKU selling 15/day with
 *       only 60 finished scores 4× higher than one selling 6/day with 144
 *       finished.
 *
 *   unfilled_ratio   = (raw + wip) / max(raw + wip + finished, 1)
 *     → What share of warehouse stock still needs manufacturing. Surfaces
 *       SKUs with large backlogs of unfinished work.
 *
 *   abc_weight       = A: 1.5 | B: 1.0 | C: 0.5
 *     → Business-importance multiplier so higher-revenue SKUs break ties.
 */
export function computeManufacturingPriority(
  raw: number,
  wip: number,
  finished: number,
  monthlyDemand: number,
  abc: string | null,
): { score: number; finishedDOS: number; unfilledPct: number } {
  const dailyDemand = monthlyDemand / 30;
  const unfilled = raw + wip;
  const totalWarehouse = unfilled + finished;
  const finishedDOS = finished / Math.max(dailyDemand, 0.01);

  const demandPressure = dailyDemand / Math.max(finished, 1);
  const unfilledRatio = unfilled / Math.max(totalWarehouse, 1);
  const abcWeight = abc === "A" ? 1.5 : abc === "C" ? 0.5 : 1.0;

  const score = demandPressure * unfilledRatio * abcWeight;
  const unfilledPct = Math.round(unfilledRatio * 100);

  return {
    score,
    finishedDOS: Math.round(finishedDOS * 10) / 10,
    unfilledPct,
  };
}

/**
 * Per-SKU cost rollup driven by the editable fields on `sku_economics`.
 *
 * Splits cost into four buckets so the SKU detail page can display each
 * line item separately and an operator can see where margin is going:
 *
 *   weightedRawCost           = raw materials, weighted by supplier mix
 *   weightedImportingCost     = freight + breakage allowance, weighted by mode
 *   weightedManufacturingCost = labor + materials, weighted by US/CN split
 *   packShipCost              = packing + outbound shipping + payment fees
 *
 * `totalCostPerUnit` is the sum; `contributionMargin` is the standard
 * `(retail − cost) / retail` ratio (returns 0 when retail price is 0).
 */
// ---------------------------------------------------------------------------
// SKU economics totals — list-view rollup
// ---------------------------------------------------------------------------
// Used by the SKU Economics list page to surface Total D2C + Contribution
// Margin per SKU at a glance. The detail page does its own computation
// using freight-derived prefilled% from sku_prefill_stats; the list view
// can't do per-SKU freight queries economically, so it falls back to
// either the manual override (if active) or 0% prefilled (worst case for
// fillable SKUs — assumes full US labor path). Documented as approximate.
//
// Inputs:
//   - econ:               sku_economics row (or null = no economics yet)
//   - primaryUnitCost:    the primary supplier's unit_cost from
//                         sku_supplier_costs (or 0 if unset)
//   - retailPrice:        product_skus.retail_price
//   - category:           "fillable" | "non_fillable" — non-fillable SKUs
//                         skip the manufacturing bucket entirely
//
// Returns null when econ is missing — caller renders "—" to signal
// "no economics row exists yet."
export interface ListD2CResult {
  rawCost: number;
  importCost: number;
  mfgCost: number;
  packShipCost: number;
  totalD2C: number;
  contributionMargin: number;
}

export function computeListD2C(
  econ: SKUEconomics | null | undefined,
  primaryUnitCost: number,
  retailPrice: number,
  category: ProductSKU["category"],
): ListD2CResult | null {
  if (!econ) return null;

  const additionalRaw = econ.additional_raw_cost ?? 0;
  const rawCost = primaryUnitCost + additionalRaw;

  const seaPct = (econ.pct_sea ?? 0) / 100;
  const airPct = (econ.pct_air ?? 0) / 100;
  const importCost =
    seaPct * (econ.sea_freight_cost_per_unit ?? 0) +
    airPct * (econ.air_freight_cost_per_unit ?? 0) +
    (econ.breakage_issue_cost ?? 0);

  let mfgCost = 0;
  if (category !== "non_fillable") {
    // Use the saved manual override if active. Otherwise treat as 0%
    // prefilled — the conservative (highest-cost) assumption. The detail
    // page corrects this with real freight stats.
    const prefilledFrac =
      econ.mfg_override_active && econ.mfg_override_pct_prefilled !== null
        ? (econ.mfg_override_pct_prefilled ?? 0) / 100
        : 0;
    const unfilledFrac = 1 - prefilledFrac;
    mfgCost =
      unfilledFrac * ((econ.labor_cost_us ?? 0) + (econ.glycerin_cost_us ?? 0)) +
      prefilledFrac * (econ.manufacturing_cost_cn ?? 0);
  }

  // Credit card fees: prefer the stored per-SKU value when present
  // (`sku_economics.credit_card_fees`), fall back to the default rate
  // applied to retail. Avoids the previous hardcoded `retail × 0.03`
  // pattern that ignored stored overrides.
  const ccFees =
    econ.credit_card_fees != null && econ.credit_card_fees > 0
      ? econ.credit_card_fees
      : retailPrice * DEFAULT_CC_FEE_RATE;
  const packShipCost =
    (econ.packing_material_cost ?? 0) +
    (econ.packing_labor_cost ?? 0) +
    (econ.shipping_cost ?? 0) +
    ccFees;

  const totalD2C = rawCost + importCost + mfgCost + packShipCost;
  const contributionMargin =
    retailPrice > 0 ? (retailPrice - totalD2C) / retailPrice : 0;

  return { rawCost, importCost, mfgCost, packShipCost, totalD2C, contributionMargin };
}

export function computeSKUCosts(e: SKUEconomics, retailPrice = 0) {
  // Every numeric column on sku_economics is nullable in the schema,
  // so coalesce each to 0 before the math. Legacy callers (none today
  // — kept for future use) won't fall over on a half-populated row.
  const weightedRawCost =
    ((e.pct_from_nancy ?? 0) / 100) * (e.nancy_raw_cost ?? 0) +
    ((e.pct_from_yx ?? 0) / 100) * (e.yx_raw_cost ?? 0) +
    (e.additional_raw_cost ?? 0);
  const weightedImportingCost =
    ((e.pct_sea ?? 0) / 100) * (e.sea_freight_cost_per_unit ?? 0) +
    ((e.pct_air ?? 0) / 100) * (e.air_freight_cost_per_unit ?? 0) +
    (e.breakage_issue_cost ?? 0);
  const weightedManufacturingCost =
    ((e.pct_manufactured_us ?? 0) / 100) *
      ((e.labor_cost_us ?? 0) + (e.glycerin_cost_us ?? 0)) +
    ((e.pct_manufactured_cn ?? 0) / 100) * (e.manufacturing_cost_cn ?? 0);
  const packShipCost =
    (e.packing_material_cost ?? 0) +
    (e.packing_labor_cost ?? 0) +
    (e.shipping_cost ?? 0) +
    (e.credit_card_fees ?? 0);
  const totalCostPerUnit =
    weightedRawCost + weightedImportingCost + weightedManufacturingCost + packShipCost;
  const contributionMargin =
    retailPrice > 0 ? (retailPrice - totalCostPerUnit) / retailPrice : 0;
  return {
    weightedRawCost,
    weightedImportingCost,
    weightedManufacturingCost,
    packShipCost,
    totalCostPerUnit,
    contributionMargin,
  };
}
