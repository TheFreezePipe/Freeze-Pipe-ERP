/**
 * retail-value — single source of truth for the dollar value of inventory
 * across the three pipeline stages (In Warehouse / In Transit / On Order),
 * both at RETAIL (units × retail_price) and at CASH OUTLAY (real per-unit
 * cost committed by that stage).
 *
 * This logic used to live inline in RetailValueSummaryBar. It's extracted
 * here so the summary bar and the Retail Value drill-down report compute
 * identical numbers from one implementation — the bar shows the totals,
 * the report shows the same totals plus the per-SKU rows that roll up to
 * them. See RetailValueSummaryBar.tsx for the original derivation comments;
 * the stage-by-stage cash model is preserved verbatim below.
 */

import type {
  InventoryWithProduct,
} from "./hooks/use-inventory";
import type { FactoryOrderWithItems } from "./hooks/use-factory-orders";
import type { FreightLineItemWithProduct } from "./hooks/use-freight";
import type { FreightShipment, ProductSKU } from "@/types/database";
import type { SKUEconomics } from "@/types/database";
import {
  buildInTransitMap,
  buildOnOrderMap,
  inventoryTotalsReal,
} from "./inventory-aggregates";
import { computeListD2C } from "./inventory-math";

/** Per-SKU value row. Retail is always populated; cash is 0 when the SKU
 *  has no sku_economics row (hasCost=false). */
export interface RetailValueRow {
  skuId: string;
  sku: string;
  name: string;
  category: ProductSKU["category"];
  displayCategory: string;
  retailPrice: number;
  monthlyDemand: number;
  warehouseUnits: number;
  transitUnits: number;
  onOrderUnits: number;
  totalUnits: number;
  warehouseRetail: number;
  transitRetail: number;
  onOrderRetail: number;
  totalRetail: number;
  cashWarehouse: number;
  cashTransit: number;
  cashOnOrder: number;
  totalCash: number;
  /** false → no economics row; this SKU contributes 0 to all cash figures. */
  hasCost: boolean;
}

export interface RetailValueBreakdown {
  rows: RetailValueRow[];
  // Retail totals
  warehouse: number;
  transit: number;
  onOrder: number;
  total: number;
  // Cash totals
  cashWarehouse: number;
  cashTransit: number;
  cashOnOrder: number;
  totalCash: number;
  /** SKUs that hold inventory but have no economics row (cash excluded). */
  skusMissingCost: number;
}

type PrimaryCostMap = Map<string, { unit_cost: number }> | undefined;
type EconomicsMap = Map<string, SKUEconomics> | undefined;

/**
 * Build the full retail/cash breakdown from the live source tables. Stage
 * unit counts come from inventory-aggregates (the same maps the dashboard
 * uses); valuation is per the documented cost model.
 */
export function buildRetailValueBreakdown(
  inventory: readonly InventoryWithProduct[],
  shipments: readonly FreightShipment[],
  freightLines: readonly FreightLineItemWithProduct[],
  factoryOrders: readonly FactoryOrderWithItems[],
  economicsById: EconomicsMap,
  primaryCostBySkuId: PrimaryCostMap,
): RetailValueBreakdown {
  const inTransitMap = buildInTransitMap(shipments, freightLines);
  const onOrderMap = buildOnOrderMap(factoryOrders, freightLines);

  const rows: RetailValueRow[] = [];
  let warehouse = 0;
  let transit = 0;
  let onOrder = 0;
  let cashWarehouse = 0;
  let cashTransit = 0;
  let cashOnOrder = 0;
  let skusMissingCost = 0;

  for (const inv of inventory) {
    const product = inv.product;
    if (!product) continue;
    const price = product.retail_price;
    if (price <= 0) continue;

    const totals = inventoryTotalsReal(inv, inTransitMap, onOrderMap);

    // Retail value (display-only, doesn't depend on cost data).
    const whRetail = totals.warehouseTotal * price;
    const trRetail = totals.transitTotal * price;
    const ooRetail = totals.onOrderTotal * price;
    warehouse += whRetail;
    transit += trRetail;
    onOrder += ooRetail;

    const econ = economicsById?.get(product.id) ?? null;
    const primaryUnitCost = primaryCostBySkuId?.get(product.id)?.unit_cost ?? 0;
    const d2c = computeListD2C(econ, primaryUnitCost, price, product.category);

    let rowCashWh = 0;
    let rowCashTr = 0;
    let rowCashOo = 0;
    let hasCost = true;

    if (!d2c) {
      hasCost = false;
      if (totals.warehouseTotal + totals.transitTotal + totals.onOrderTotal > 0) {
        skusMissingCost += 1;
      }
    } else {
      // Stage-by-stage cash model (see RetailValueSummaryBar for the full
      // rationale): On Order commits raw only; In Transit adds import +
      // the CN-fill share of pre-filled units; Warehouse charges each
      // sub-bucket the mfg it has actually absorbed.
      const prefilledFrac =
        econ?.mfg_override_active && econ.mfg_override_pct_prefilled !== null
          ? (econ.mfg_override_pct_prefilled ?? 0) / 100
          : 0;
      const isFillable = product.category !== "non_fillable";
      const mfgCn = isFillable ? (econ?.manufacturing_cost_cn ?? 0) : 0;
      const usMfg = isFillable
        ? (econ?.labor_cost_us ?? 0) + (econ?.glycerin_cost_us ?? 0)
        : 0;
      const effectiveMfg = prefilledFrac * mfgCn + (1 - prefilledFrac) * usMfg;

      const baseCost = d2c.rawCost + d2c.importCost; // raw + import
      const onOrderPerUnit = d2c.rawCost; // raw only
      const inTransitPerUnit = baseCost + prefilledFrac * mfgCn;

      rowCashOo = totals.onOrderTotal * onOrderPerUnit;
      rowCashTr = totals.transitTotal * inTransitPerUnit;

      const wRaw = inv.warehouse_raw ?? 0;
      const wPrefilled = inv.warehouse_prefilled_raw ?? 0;
      const wInProd = inv.warehouse_in_production ?? 0;
      const wFinished = inv.warehouse_finished ?? 0;
      const wOther = inv.warehouse_other ?? 0;

      rowCashWh =
        wRaw * baseCost +
        wPrefilled * (baseCost + effectiveMfg) +
        wInProd * (baseCost + 0.5 * usMfg) +
        wFinished * (baseCost + effectiveMfg) +
        wOther * (baseCost + effectiveMfg);
    }

    cashWarehouse += rowCashWh;
    cashTransit += rowCashTr;
    cashOnOrder += rowCashOo;

    rows.push({
      skuId: product.id,
      sku: product.sku,
      name: product.product_name,
      category: product.category,
      displayCategory: product.display_category,
      retailPrice: price,
      monthlyDemand: product.monthly_demand ?? 0,
      warehouseUnits: totals.warehouseTotal,
      transitUnits: totals.transitTotal,
      onOrderUnits: totals.onOrderTotal,
      totalUnits: totals.totalUnits,
      warehouseRetail: whRetail,
      transitRetail: trRetail,
      onOrderRetail: ooRetail,
      totalRetail: whRetail + trRetail + ooRetail,
      cashWarehouse: rowCashWh,
      cashTransit: rowCashTr,
      cashOnOrder: rowCashOo,
      totalCash: rowCashWh + rowCashTr + rowCashOo,
      hasCost,
    });
  }

  return {
    rows,
    warehouse,
    transit,
    onOrder,
    total: warehouse + transit + onOrder,
    cashWarehouse,
    cashTransit,
    cashOnOrder,
    totalCash: cashWarehouse + cashTransit + cashOnOrder,
    skusMissingCost,
  };
}
