/**
 * Shared receiving-state predicate for the freight detail page.
 *
 * Lives in lib (not the component file) so both FreightDetail and
 * ShipmentManifest can import it without tripping react-refresh's
 * only-export-components rule.
 */

import type { FreightLineItemWithProduct } from "@/lib/hooks";
import type { FreightShipment } from "@/types/database";

// RECEIVING-ACTIVE RULE. The receiving UI (dock banner, Received column with
// steppers, check-in-all, close-short) shows when receipt_confirmed_at IS
// NULL AND any of:
//   status IN ('cleared_customs','tracking','out_for_delivery','delivered')
//                                              -- past the water: cartons can
//                                                 land any day, and the crew on
//                                                 the dock is the real sensor
//   OR eta <= today                            -- due, whatever the feed says
//   OR (carrier_pieces_delivered ?? 0) > 0     -- carrier already dropped pieces
//   OR any line quantity_received > 0          -- a straggler check-in exists
//
// Why the status/ETA clauses (2026-09-14, sea 466): UPS tracked by the lead
// number answered with fewer packages than cartons, so the trust guard nulled
// the piece counts, and the master never flipped to delivered while the first
// cartons were already on the dock. The carrier feed is informational only;
// it must never be the thing that blocks a physical check-in.
//
// Once receipt_confirmed_at is set the header shows the green completed chip
// and the Received column stays visible but read-only (no steppers);
// closed_short_at additionally shows the amber closed-short note above the
// manifest.

const LANDED_STATUSES = new Set(["cleared_customs", "tracking", "out_for_delivery", "delivered"]);

/** Local calendar day as YYYY-MM-DD (freight ETAs are dates, not instants). */
function localDayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function isReceivingActive(
  shipment: FreightShipment,
  lineItems: FreightLineItemWithProduct[],
  todayKey: string = localDayKey(new Date()),
): boolean {
  if (shipment.receipt_confirmed_at) return false;
  if (shipment.status === "pending") return false;
  return (
    LANDED_STATUSES.has(shipment.status) ||
    (!!shipment.eta && shipment.eta.slice(0, 10) <= todayKey) ||
    (shipment.carrier_pieces_delivered ?? 0) > 0 ||
    lineItems.some((l) => l.sku_id && (l.quantity_received ?? 0) > 0)
  );
}
