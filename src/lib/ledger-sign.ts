/**
 * Sign conventions for inventory_transactions rows.
 *
 * Most ledger rows store `quantity` already signed for the field they touch
 * (order_shipped is negative, freight_delivered positive, cycle_count either).
 * The exception is movement_kind='write_off' (breakage, close-shorts): the
 * writing RPCs validate p_quantity > 0 and store it positive, with the
 * "units removed" meaning carried by the movement_kind. Every reader that
 * treats quantity as a delta must flip write-offs or it will count a
 * breakage as an INCREASE — which is exactly how the Change Log showed
 * "breakage of 1 units · +1" and convinced the crew the deduction never
 * happened (2026-08-05, BW56-Base).
 */

export interface LedgerRow {
  quantity: number;
  movement_kind: string;
  field_affected: string;
  from_field: string | null;
  to_field: string | null;
}

export const isWarehouseField = (f: string | null): boolean =>
  !!f && f.startsWith("warehouse_");

/**
 * Quantity as a human-readable signed delta for the field the row is
 * displayed against. Only write-offs need flipping; everything else is
 * already signed. abs() guards against a hypothetical negatively-stored
 * write-off flipping back into a phantom increase.
 */
export function signedLedgerQuantity(
  tx: Pick<LedgerRow, "quantity" | "movement_kind">,
): number {
  return tx.movement_kind === "write_off"
    ? -Math.abs(tx.quantity)
    : tx.quantity;
}

/**
 * How much a ledger row changed the TOTAL across all warehouse_* buckets.
 * Powers the history half of the SKU inventory projection chart:
 *
 *   - 'metadata' (oversell warnings, audit-only)         → 0
 *   - 'category_move' warehouse → warehouse              → 0 (total unchanged)
 *   - 'category_move' warehouse → elsewhere              → -quantity
 *   - 'category_move' elsewhere → warehouse              → +quantity
 *   - 'write_off' from a warehouse bucket (breakage)     → -|quantity|
 *   - 'net_change' on a warehouse bucket                 → quantity (already signed)
 *   - anything touching non-inventory fields (eta, role) → 0
 */
export function deltaToWarehouseTotal(tx: LedgerRow): number {
  if (tx.movement_kind === "metadata") return 0;
  if (tx.movement_kind === "category_move") {
    const fromIsWh = isWarehouseField(tx.from_field);
    const toIsWh = isWarehouseField(tx.to_field);
    if (fromIsWh && toIsWh) return 0;
    if (fromIsWh && !toIsWh) return -tx.quantity;
    if (!fromIsWh && toIsWh) return tx.quantity;
    return 0;
  }
  if (tx.movement_kind === "write_off") {
    return isWarehouseField(tx.from_field ?? tx.field_affected)
      ? -Math.abs(tx.quantity)
      : 0;
  }
  // net_change — only counts when the field is one of our warehouse buckets.
  return isWarehouseField(tx.field_affected) ? tx.quantity : 0;
}
