/**
 * inventory-aggregates — single source of truth for "In Transit" and
 * "On Order" unit counts per SKU.
 *
 * Background: the ERP's dashboard + inventory pages historically read
 * per-supplier + in-transit unit counts from denormalized columns on
 * `inventory_levels` (nancy_ordered, nancy_finished, yx_ordered, yx_finished,
 * in_transit_air, in_transit_sea, in_transit_high_risk). After the supplier
 * portal shipped (migrations 020+), those columns stopped getting updated —
 * the portal writes to `factory_orders` + `factory_order_items` for orders
 * and `freight_shipments` + `freight_line_items` for shipments, never
 * touching the legacy columns.
 *
 * This module derives the same conceptual buckets from the current tables:
 *
 *   - **On Order** per SKU:
 *       Sum(factory_order_item.quantity_ordered
 *           - factory_order_item.quantity_breakage
 *           - total_shipped_via_freight_line_items)
 *       across factory_orders with status in {ordered, in_production, finished}.
 *     Once units enter a freight shipment (any status), they stop counting
 *     here — they move to In Transit until the shipment is delivered.
 *
 *   - **In Transit** per SKU:
 *       Sum(freight_line_item.quantity) across freight_shipments with
 *       status in {pending, on_the_water, high_risk, cleared_customs, tracking}.
 *     Delivered shipments are excluded because their units have landed in
 *     warehouse_raw already.
 *
 * Callers should prefer `inventoryTotalsReal` over the legacy
 * `computeInventoryTotals` from demo-data — the legacy helper still sums
 * the stale columns and will read 0 for anything supplier-portal-created.
 */

import type { FactoryOrderWithItems } from "./hooks/use-factory-orders";
import type { FreightLineItemWithProduct } from "./hooks/use-freight";
import type { FreightShipment, InventoryLevel } from "@/types/database";

/** Statuses counted as "still coming from the factory, not yet shipped." */
const ON_ORDER_STATUSES = new Set<FactoryOrderWithItems["status"]>([
  "ordered",
  "in_production",
  "finished",
]);

/** Statuses counted as "in a shipment that hasn't been received into the warehouse yet." */
const IN_TRANSIT_STATUSES = new Set<FreightShipment["status"]>([
  "pending",
  "on_the_water",
  "high_risk",
  "cleared_customs",
  "tracking",
]);

/**
 * Per-SKU in-transit unit count derived from real freight data.
 * Key: `sku_id`. Value: sum of `freight_line_items.quantity` across all
 * non-delivered shipments containing that SKU.
 */
export function buildInTransitMap(
  shipments: readonly FreightShipment[],
  freightLines: readonly FreightLineItemWithProduct[],
): Map<string, number> {
  const liveShipmentIds = new Set<string>();
  for (const s of shipments) {
    if (IN_TRANSIT_STATUSES.has(s.status)) liveShipmentIds.add(s.id);
  }
  const out = new Map<string, number>();
  for (const line of freightLines) {
    if (!liveShipmentIds.has(line.freight_shipment_id)) continue;
    const prior = out.get(line.sku_id) ?? 0;
    out.set(line.sku_id, prior + (line.quantity ?? 0));
  }
  return out;
}

/**
 * Per-SKU on-order unit count derived from factory_orders + factory_order_items,
 * net of any quantity already shipped via freight_line_items.
 *
 * Math per line item (only in active orders):
 *   remaining = max(0, quantity_ordered - quantity_breakage - shipped_qty)
 *
 * where shipped_qty = sum of freight_line_items.quantity whose
 * `source_factory_order_item_id` matches this line item. Any freight line
 * counts toward shipped_qty regardless of shipment status — once the units
 * are in a shipment, they've left the "on order" bucket (they're now in
 * either In Transit or Warehouse, depending on delivery state).
 */
export function buildOnOrderMap(
  factoryOrders: readonly FactoryOrderWithItems[],
  freightLines: readonly FreightLineItemWithProduct[],
): Map<string, number> {
  // Aggregate freight qty by source_factory_order_item_id first — a single
  // line item can be split across multiple shipments, and we need the total
  // shipped so far to subtract from the order quantity.
  const shippedByFoi = new Map<string, number>();
  for (const line of freightLines) {
    const foi = line.source_factory_order_item_id;
    if (!foi) continue;
    shippedByFoi.set(foi, (shippedByFoi.get(foi) ?? 0) + (line.quantity ?? 0));
  }

  const out = new Map<string, number>();
  for (const order of factoryOrders) {
    if (!ON_ORDER_STATUSES.has(order.status)) continue;
    for (const item of order.items ?? []) {
      const shipped = shippedByFoi.get(item.id) ?? 0;
      const breakage = item.quantity_breakage ?? 0;
      const remaining = Math.max(0, (item.quantity_ordered ?? 0) - breakage - shipped);
      if (remaining === 0) continue;
      out.set(item.sku_id, (out.get(item.sku_id) ?? 0) + remaining);
    }
  }
  return out;
}

/**
 * Replacement for `computeInventoryTotals` from demo-data that derives the
 * transit + on-order buckets from real tables instead of the stale
 * `inventory_levels.in_transit_* / nancy_* / yx_*` columns.
 *
 * Warehouse numbers (raw / in_production / finished / other) still come
 * from inventory_levels — those columns ARE kept live by the task-log RPC
 * and the receive flow. Only the stale buckets get replaced.
 */
export function inventoryTotalsReal(
  inv: InventoryLevel,
  inTransitMap: Map<string, number>,
  onOrderMap: Map<string, number>,
): {
  warehouseTotal: number;
  transitTotal: number;
  onOrderTotal: number;
  totalUnits: number;
} {
  const warehouseTotal =
    (inv.warehouse_raw ?? 0) +
    (inv.warehouse_in_production ?? 0) +
    (inv.warehouse_finished ?? 0) +
    (inv.warehouse_other ?? 0);
  const transitTotal = inTransitMap.get(inv.sku_id) ?? 0;
  const onOrderTotal = onOrderMap.get(inv.sku_id) ?? 0;
  return {
    warehouseTotal,
    transitTotal,
    onOrderTotal,
    totalUnits: warehouseTotal + transitTotal + onOrderTotal,
  };
}
