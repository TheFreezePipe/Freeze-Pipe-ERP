import type { FactoryOrderWithItems } from "@/lib/hooks/use-factory-orders";
import type { ProductBomRow } from "@/lib/hooks/use-factory-orders";

/**
 * Planned allocation for linked factory orders (owner-approved 2026-07-27,
 * terminology: "allocated").
 *
 * A child order (typically YX spare parts) linked to a parent order
 * (typically Nancy compound SKUs) will have some of its component units
 * packed INTO the parent's products at the factory — those units never
 * arrive as loose stock. The existing `quantity_consumed_by_parent` only
 * realizes that at parent-SHIP time, ~60-75 days after linking; planning
 * surfaces need the number from day one:
 *
 *   planned = min(child item qty,
 *                 Σ over parent lines with a BOM to this component:
 *                   units_per_parent × parent line qty ordered)
 *
 * Consumers reserve GREATEST(planned, realized consumption) — the plan
 * moves the effect to link day; the ship-time true-up wins once larger,
 * and if the factory packs fewer than planned the difference flows back
 * to free automatically.
 */
export interface PlannedAllocation {
  /** Units of this child item expected to be consumed by its parent order. */
  planned: number;
  parentOrderId: string;
  parentOrderNumber: string | null;
}

/** child factory_order_item.id → planned allocation. Items on unlinked
 *  orders, or with no BOM relation to any parent line ("ride-alongs"),
 *  are absent from the map (planned 0). */
export function buildPlannedAllocationMap(
  orders: readonly FactoryOrderWithItems[],
  boms: readonly ProductBomRow[],
): Map<string, PlannedAllocation> {
  const out = new Map<string, PlannedAllocation>();
  if (boms.length === 0) return out;

  const ordersById = new Map(orders.map((o) => [o.id, o]));
  // component sku → its BOM rows (a component can serve several parents)
  const bomsByComponent = new Map<string, ProductBomRow[]>();
  for (const b of boms) {
    const list = bomsByComponent.get(b.component_sku_id) ?? [];
    list.push(b);
    bomsByComponent.set(b.component_sku_id, list);
  }

  for (const child of orders) {
    if (!child.parent_factory_order_id) continue;
    const parent = ordersById.get(child.parent_factory_order_id);
    if (!parent) continue;

    for (const item of child.items ?? []) {
      if (!item.sku_id) continue;
      const rows = bomsByComponent.get(item.sku_id);
      if (!rows || rows.length === 0) continue;

      let need = 0;
      for (const parentItem of parent.items ?? []) {
        if (!parentItem.sku_id) continue;
        for (const b of rows) {
          if (b.parent_sku_id === parentItem.sku_id) {
            need += b.units_per_parent * (parentItem.quantity_ordered ?? 0);
          }
        }
      }
      if (need <= 0) continue;

      out.set(item.id, {
        planned: Math.min(item.quantity_ordered ?? 0, need),
        parentOrderId: parent.id,
        parentOrderNumber: parent.order_number ?? null,
      });
    }
  }
  return out;
}

/** The reserve an on-order computation should subtract for a child item:
 *  the larger of the day-one plan and the ship-time realized consumption. */
export function allocatedReserve(
  item: { id: string; quantity_consumed_by_parent?: number | null },
  plannedMap: Map<string, PlannedAllocation> | undefined,
): number {
  const consumed = item.quantity_consumed_by_parent ?? 0;
  const planned = plannedMap?.get(item.id)?.planned ?? 0;
  return Math.max(consumed, planned);
}
