/**
 * order-preview — shared "what does ordering N units do?" math.
 *
 * Single source of truth for the per-SKU cost + days-of-stock preview used by
 * BOTH the New Factory Order dialog and the Stock Levels "order builder" mode.
 * Keeping it here guarantees the two surfaces always show identical numbers
 * (cost, current/projected DOS, margin) instead of drifting apart.
 *
 * Build one with `buildOrderPreview(deps)` from the page's already-loaded
 * sources (products, inventory, the in-transit / on-order maps, primary
 * supplier costs, forecast map), then call the returned helpers.
 */
import { computeDOS } from "@/lib/inventory-math";
import { getEffectiveDemand } from "@/lib/demand";
import { inventoryTotalsReal } from "@/lib/inventory-aggregates";
import type { ProductSKU, InventoryLevel } from "@/types/database";
import type { SkuSupplierCostRow } from "@/lib/hooks/use-sku-economics";

export interface OrderPreviewLine {
  sku_id: string;
  quantity: number;
}

export interface OrderTotals {
  units: number;
  rawCost: number;
  retail: number;
  margin: number;
}

export interface OrderPreviewDeps {
  products: ProductSKU[];
  inventory: InventoryLevel[];
  inTransitMap: Map<string, number>;
  onOrderMap: Map<string, number>;
  primaryCostBySkuId?: Map<string, SkuSupplierCostRow>;
  forecastMap?: Map<string, number>;
}

export interface OrderPreview {
  /** Real primary supplier unit cost, or null when none on file (never a guess). */
  rawCostFor(skuId: string): number | null;
  retailFor(skuId: string): number;
  /** Primary supplier id for the SKU, or null when no cost row exists. */
  supplierIdFor(skuId: string): string | null;
  /** Total units across warehouse + in-transit + on-order (matches the page). */
  currentUnits(skuId: string): number;
  /** Days of stock at current effective demand, optionally with extra units added. */
  dosFor(skuId: string, extraUnits?: number): number;
  /** Roll up units / raw cost / retail / margin across a set of lines. */
  lineTotals(lines: OrderPreviewLine[]): OrderTotals;
}

export function buildOrderPreview(deps: OrderPreviewDeps): OrderPreview {
  const { products, inventory, inTransitMap, onOrderMap, primaryCostBySkuId, forecastMap } = deps;
  const productById = new Map(products.map((p) => [p.id, p]));
  const invBySku = new Map(inventory.map((i) => [i.sku_id, i]));

  function rawCostFor(skuId: string): number | null {
    const primary = primaryCostBySkuId?.get(skuId);
    return primary && primary.unit_cost > 0 ? primary.unit_cost : null;
  }
  function retailFor(skuId: string): number {
    return productById.get(skuId)?.retail_price ?? 0;
  }
  function supplierIdFor(skuId: string): string | null {
    return primaryCostBySkuId?.get(skuId)?.supplier_id ?? null;
  }
  function currentUnits(skuId: string): number {
    const inv = invBySku.get(skuId);
    if (!inv) return 0;
    return inventoryTotalsReal(inv, inTransitMap, onOrderMap).totalUnits;
  }
  function dosFor(skuId: string, extraUnits = 0): number {
    const product = productById.get(skuId);
    const demand = getEffectiveDemand(skuId, product?.monthly_demand, forecastMap);
    return computeDOS(currentUnits(skuId) + extraUnits, demand);
  }
  function lineTotals(lines: OrderPreviewLine[]): OrderTotals {
    let units = 0;
    let rawCost = 0;
    let retail = 0;
    for (const l of lines) {
      units += l.quantity;
      rawCost += (rawCostFor(l.sku_id) ?? 0) * l.quantity;
      retail += retailFor(l.sku_id) * l.quantity;
    }
    return { units, rawCost, retail, margin: retail - rawCost };
  }

  return { rawCostFor, retailFor, supplierIdFor, currentUnits, dosFor, lineTotals };
}
