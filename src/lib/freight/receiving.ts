/**
 * Shared receiving-state predicate for the freight detail page.
 *
 * Lives in lib (not the component file) so both FreightDetail and
 * ShipmentManifest can import it without tripping react-refresh's
 * only-export-components rule.
 */

import type { FreightLineItemWithProduct } from "@/lib/hooks";
import type { FreightShipment } from "@/types/database";

// RECEIVING-ACTIVE RULE (owner decision + agreed straggler interpretation):
// the receiving UI (dock banner, Received column with steppers, close-short
// button) shows when receipt_confirmed_at IS NULL AND (
//   status IN ('delivered','out_for_delivery')
//   OR (carrier_pieces_delivered ?? 0) > 0     -- carrier already dropped pieces
//   OR any line quantity_received > 0          -- a straggler check-in exists
// ).
// Once receipt_confirmed_at is set the header shows the green completed chip
// and the Received column stays visible but read-only (no steppers);
// closed_short_at additionally shows the amber closed-short note above the
// manifest.
export function isReceivingActive(
  shipment: FreightShipment,
  lineItems: FreightLineItemWithProduct[],
): boolean {
  if (shipment.receipt_confirmed_at) return false;
  return (
    shipment.status === "delivered" ||
    shipment.status === "out_for_delivery" ||
    (shipment.carrier_pieces_delivered ?? 0) > 0 ||
    lineItems.some((l) => l.sku_id && (l.quantity_received ?? 0) > 0)
  );
}
