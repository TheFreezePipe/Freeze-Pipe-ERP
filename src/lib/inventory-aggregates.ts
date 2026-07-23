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
 *       Sum(max(0, freight_line_item.quantity - freight_line_item.quantity_received))
 *       across ALL shipments, regardless of shipment status. Fully received
 *       lines contribute 0 automatically, so no status whitelist is needed
 *       (see buildInTransitMap for the invariant).
 *
 * `inventoryTotalsReal` below is the only totals helper — the legacy
 * `computeInventoryTotals` (demo-data) that read the stale columns was
 * deleted in the 2026-07 audit cleanup along with demo-data itself.
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

/**
 * Per-SKU in-transit unit count derived from real freight data.
 * Key: `sku_id`. Value: sum of per-line REMAINING units across ALL shipments.
 *
 * INVARIANT (partial receiving, 2026-07):
 *   - `freight_line_items.quantity` = units that left the factory. Receiving
 *     NEVER mutates it; only closing a shipment short reduces it.
 *   - `freight_line_items.quantity_received` = units physically checked into
 *     the warehouse so far (default 0).
 *   - In transit per line is therefore simply the remainder:
 *         max(0, quantity - quantity_received)
 *     summed for EVERY shipment REGARDLESS of status. No status whitelist:
 *     fully received/closed shipments have quantity_received == quantity on
 *     every catalog line (historical delivered shipments were backfilled this
 *     way), so their lines contribute 0 automatically.
 *
 * Dropping the old status gate also fixes the "delivered by carrier but
 * awaiting receipt confirmation" limbo, where units were excluded from the
 * transit sum yet had not been moved into warehouse_raw — they vanished from
 * both buckets. Now they stay in transit until physically checked in.
 *
 * `_shipments` is unused by the math but retained so the many existing call
 * sites (dashboard, SKU modal, retail-value, order dialogs) keep compiling
 * unchanged.
 */
export function buildInTransitMap(
  _shipments: readonly FreightShipment[],
  freightLines: readonly FreightLineItemWithProduct[],
): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of freightLines) {
    // Non-catalog (sample) lines have no SKU — nothing to count in transit.
    if (!line.sku_id) continue;
    const remaining = Math.max(0, (line.quantity ?? 0) - (line.quantity_received ?? 0));
    if (remaining === 0) continue;
    out.set(line.sku_id, (out.get(line.sku_id) ?? 0) + remaining);
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
 *
 * PARTIAL RECEIVING NOTE: this function must keep reading the FULL
 * `freight_line_items.quantity`, NOT `quantity - quantity_received`.
 * `quantity` means "units that left the factory" — receiving progress does
 * not change how many units have shipped, so partially received shipments
 * must stay fully netted out of On Order. Closing a shipment short mutates
 * `quantity` itself (reduces it to what actually arrived), which restores
 * the undelivered remainder to On Order automatically — no
 * quantity_received handling is needed here.
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
      // Units recorded as shipped outside the system (e.g. pre-go-live)
      // have also left the factory — net them out like freight-shipped.
      const manualShipped = item.quantity_shipped_manual ?? 0;
      // Component units absorbed into shipped parent (assembled) orders are
      // no longer separately on order.
      const consumedByParent = item.quantity_consumed_by_parent ?? 0;
      const remaining = Math.max(0, (item.quantity_ordered ?? 0) - breakage - shipped - manualShipped - consumedByParent);
      if (remaining === 0) continue;
      out.set(item.sku_id, (out.get(item.sku_id) ?? 0) + remaining);
    }
  }
  return out;
}

/**
 * Per-SKU totals with transit + on-order derived from the real tables
 * (freight_shipments / factory_orders) rather than any denormalized
 * inventory_levels columns.
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
    (inv.warehouse_prefilled_raw ?? 0) +
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
