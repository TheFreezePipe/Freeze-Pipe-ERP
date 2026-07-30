/**
 * History-based pre-fill default for shipment entry.
 *
 * The pre-filled checkbox kept getting missed for SKUs that ALWAYS ship
 * pre-filled (owner hand-fixed shipments 447/458/459 in one week — bowls,
 * ash catchers, "(with G)" items). Instead of relying on memory, the form
 * defaults the checkbox from the SKU's own shipment history: if the clear
 * majority of its ever-shipped units were pre-filled across at least two
 * shipments, a newly selected SKU starts CHECKED (with a "from history"
 * hint). The operator's explicit toggle always wins.
 */
import type { FreightLineItemWithProduct } from "@/lib/hooks/use-freight";

export interface PrefillHistory {
  prefilledUnits: number;
  totalUnits: number;
  shipmentCount: number;
}

/** Aggregate per-SKU prefill history from all existing freight lines. */
export function buildPrefillRateBySku(
  lines: readonly Pick<FreightLineItemWithProduct, "sku_id" | "quantity" | "quantity_prefilled" | "freight_shipment_id">[],
): Map<string, PrefillHistory> {
  const out = new Map<string, PrefillHistory & { shipments: Set<string> }>();
  for (const line of lines) {
    if (!line.sku_id || (line.quantity ?? 0) <= 0) continue;
    const qty = line.quantity ?? 0;
    const pref = Math.min(Math.max(line.quantity_prefilled ?? 0, 0), qty);
    let e = out.get(line.sku_id);
    if (!e) {
      e = { prefilledUnits: 0, totalUnits: 0, shipmentCount: 0, shipments: new Set() };
      out.set(line.sku_id, e);
    }
    e.prefilledUnits += pref;
    e.totalUnits += qty;
    e.shipments.add(line.freight_shipment_id);
  }
  const result = new Map<string, PrefillHistory>();
  for (const [sku, e] of out) {
    result.set(sku, {
      prefilledUnits: e.prefilledUnits,
      totalUnits: e.totalUnits,
      shipmentCount: e.shipments.size,
    });
  }
  return result;
}

/** True when history is decisive enough to default the checkbox on:
 *  >= 70% of ever-shipped units pre-filled, across >= 2 shipments. */
export function suggestPrefilled(history: PrefillHistory | undefined): boolean {
  if (!history) return false;
  return (
    history.shipmentCount >= 2 &&
    history.totalUnits > 0 &&
    history.prefilledUnits / history.totalUnits >= 0.7
  );
}
