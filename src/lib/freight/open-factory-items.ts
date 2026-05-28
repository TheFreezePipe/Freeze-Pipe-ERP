/**
 * Helpers for the FreightNew "Pull from factory order" picker.
 *
 * Given a SKU id + the current set of factory orders + freight line
 * items, returns the list of factory_order_items that still have
 * room to ship more units. "Room" = quantity_ordered − already_shipped,
 * where already_shipped is the sum of freight_line_items pointed at
 * the FO item via source_factory_order_item_id.
 *
 * Used to populate the per-row FO picker so an operator creating a
 * shipment can attribute units to a specific factory order. The
 * picker always includes a "(No factory order link)" option for
 * spot purchases or shipments that don't trace to a specific FO.
 */

import type { FactoryOrderWithItems } from "@/lib/hooks";
import type { FreightLineItem } from "@/types/database";

export interface OpenFactoryOrderItem {
  factory_order_id: string;
  factory_order_number: string | null;
  factory_order_item_id: string;
  expected_completion: string | null;
  status: string;
  quantity_ordered: number;
  quantity_already_shipped: number;
  remaining: number;
}

/**
 * Compute open factory-order items for a given SKU.
 *
 * Active = parent FO status is not 'shipped' and not 'canceled'.
 * Returns items where remaining > 0, sorted by oldest order_date
 * first (FIFO — ship from the longest-waiting order first).
 */
export function getOpenFactoryItemsForSku(
  skuId: string,
  factoryOrders: FactoryOrderWithItems[],
  freightLineItems: Pick<FreightLineItem, "source_factory_order_item_id" | "quantity">[],
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
      const remaining = ordered - alreadyShipped;
      if (remaining <= 0) continue;
      out.push({
        factory_order_id: order.id,
        factory_order_number: order.order_number,
        factory_order_item_id: item.id,
        expected_completion: order.expected_completion,
        status: order.status,
        quantity_ordered: ordered,
        quantity_already_shipped: alreadyShipped,
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
