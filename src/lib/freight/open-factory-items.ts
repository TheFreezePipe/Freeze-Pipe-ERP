/**
 * Helpers for the FreightNew "Pull from factory order" picker.
 *
 * Given a SKU id + the current set of factory orders + freight line
 * items, returns the list of factory_order_items that still have
 * room to ship more units. "Room" = quantity_ordered − already_shipped
 * − allocated, where already_shipped is the sum of freight_line_items
 * pointed at the FO item via source_factory_order_item_id and allocated
 * is the reserve claimed by a linked parent order (units packed into the
 * parent's products at the factory — they never ride this order's own
 * freight).
 *
 * Used to populate the per-row FO picker so an operator creating a
 * shipment can attribute units to a specific factory order. The
 * picker always includes a "(No factory order link)" option for
 * spot purchases or shipments that don't trace to a specific FO.
 */

import type { FactoryOrderWithItems } from "@/lib/hooks";
import type { FreightLineItem } from "@/types/database";
import { allocatedReserve, type PlannedAllocation } from "@/lib/allocation";

export interface OpenFactoryOrderItem {
  factory_order_id: string;
  factory_order_number: string | null;
  factory_order_item_id: string;
  expected_completion: string | null;
  status: string;
  quantity_ordered: number;
  quantity_already_shipped: number;
  /** Units reserved for a linked parent order — max(consumed, planned).
   *  These are packed into the parent's products at the factory and never
   *  ship on this order's own freight. */
  quantity_allocated: number;
  remaining: number;
}

/**
 * Compute open factory-order items for a given SKU.
 *
 * Active = parent FO status is not 'shipped' and not 'canceled'.
 * Returns items where remaining > 0, sorted by oldest order_date
 * first (FIFO — ship from the longest-waiting order first).
 *
 * remaining = ordered − already_shipped − allocated, where allocated =
 * max(quantity_consumed_by_parent, planned allocation) when `plannedMap`
 * (buildPlannedAllocationMap) is provided. Allocated units go to the
 * parent's factory and never board the child's own freight, so they must
 * not be offered to the FO picker as shippable.
 */
export function getOpenFactoryItemsForSku(
  skuId: string,
  factoryOrders: FactoryOrderWithItems[],
  freightLineItems: Pick<FreightLineItem, "source_factory_order_item_id" | "quantity">[],
  plannedMap?: Map<string, PlannedAllocation>,
): OpenFactoryOrderItem[] {
  // Build a (factory_order_item_id → already_shipped) map in one pass.
  const shippedByItem = new Map<string, number>();
  for (const line of freightLineItems) {
    const foItemId = line.source_factory_order_item_id;
    if (!foItemId) continue;
    shippedByItem.set(foItemId, (shippedByItem.get(foItemId) ?? 0) + (line.quantity ?? 0));
  }

  const out: OpenFactoryOrderItem[] = [];
  for (const order of factoryOrders) {
    if (order.status === "shipped" || order.status === "canceled") continue;
    for (const item of order.items ?? []) {
      if (item.sku_id !== skuId) continue;
      const ordered = item.quantity_ordered ?? 0;
      const alreadyShipped = shippedByItem.get(item.id) ?? 0;
      const allocated = allocatedReserve(item, plannedMap);
      const remaining = ordered - alreadyShipped - allocated;
      if (remaining <= 0) continue;
      out.push({
        factory_order_id: order.id,
        factory_order_number: order.order_number,
        factory_order_item_id: item.id,
        expected_completion: order.expected_completion,
        status: order.status,
        quantity_ordered: ordered,
        quantity_already_shipped: alreadyShipped,
        quantity_allocated: allocated,
        remaining,
      });
    }
  }

  // FIFO: ship from the oldest order first. Sort by order_date asc;
  // null order_date sinks to the bottom.
  out.sort((a, b) => {
    const aOrder = factoryOrders.find((o) => o.id === a.factory_order_id);
    const bOrder = factoryOrders.find((o) => o.id === b.factory_order_id);
    const aDate = aOrder?.order_date ?? "9999-99-99";
    const bDate = bOrder?.order_date ?? "9999-99-99";
    return aDate.localeCompare(bDate);
  });

  return out;
}
