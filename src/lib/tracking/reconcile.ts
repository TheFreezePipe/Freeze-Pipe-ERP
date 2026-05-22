import type { FreightShipment } from "@/types/database";
import type { TrackingUpdate, ReconciledEta } from "./types";

// Narrow: the reconciler only ever outputs post-departure statuses. The
// generated FreightShipment["status"] widens to plain string so we define
// this explicitly rather than deriving it.
type ShipmentStatus =
  | "on_the_water"
  | "high_risk"
  | "cleared_customs"
  | "tracking"
  | "out_for_delivery"
  | "delivered";

/** How many days before arrival a carrier is expected to have the shipment in its system. */
const RECEIVE_WINDOW_DAYS: Record<"sea" | "air", number> = {
  sea: 7,
  air: 2,
};

function todayYmd(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDays(ymd: string, days: number): string {
  const d = new Date(ymd + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function diffDays(a: string, b: string): number {
  const ad = new Date(a + "T00:00:00Z").getTime();
  const bd = new Date(b + "T00:00:00Z").getTime();
  return Math.round((ad - bd) / 86_400_000);
}

/**
 * Reconcile a fresh tracking update against a shipment's current state.
 *
 * Rules:
 *   - Original ETA (eta_original) is captured on first check and never overwritten.
 *   - If carrier says "not_received" AND we're inside the receive window (7d sea /
 *     2d air from the original ETA), push ETA to today + window. This is the
 *     "the carrier should have it by now" correction.
 *   - If carrier says "in_transit" and provides a new ETA, use it (can move earlier
 *     or later than the previous ETA).
 *   - If carrier says "delivered", record the actual arrival.
 *   - Otherwise leave ETA alone.
 */
export function reconcileEta(shipment: FreightShipment, update: TrackingUpdate): ReconciledEta {
  const today = todayYmd();
  const etaOriginal = shipment.eta_original ?? shipment.eta ?? today;
  const currentEta = shipment.eta ?? etaOriginal;
  // Freight type and status both widen to string via the generated types
  // even though the DB CHECK narrows them. Cast to the narrow unions the
  // reconcile logic expects — value guarantees come from the DB, not TS.
  const freightType = shipment.freight_type as "air" | "sea";
  const receiveWindow = RECEIVE_WINDOW_DAYS[freightType];

  let newEta = currentEta;
  let actualArrival = shipment.actual_arrival_date ?? null;
  let newStatus: ShipmentStatus = shipment.status as ShipmentStatus;

  // Manual override: a human has explicitly set this status. Tracking polls
  // continue to refresh ETA + last-checked, but never auto-change the status
  // until the human clears the override.
  const isManuallyOverridden = !!shipment.status_overridden_at;

  switch (update.status) {
    case "delivered": {
      actualArrival = update.deliveredAt ?? today;
      if (!isManuallyOverridden) {
        // Delivered always wins (over auto-set statuses). Manual overrides still block this.
        newStatus = "delivered";
      }
      break;
    }
    case "out_for_delivery": {
      // Carrier has the package on a delivery vehicle. Distinct from
      // generic in_transit because the receiving team wants the "incoming
      // today" signal for dock prep. Won't regress an already-delivered
      // shipment; doesn't fire when a manual override is active.
      if (update.carrierEta) {
        newEta = update.carrierEta;
      }
      if (!isManuallyOverridden && shipment.status !== "delivered") {
        newStatus = "out_for_delivery";
      }
      break;
    }
    case "in_transit": {
      if (update.carrierEta) {
        newEta = update.carrierEta;
      }
      // Auto-advance to "tracking" when the carrier confirms receipt and is
      // actively moving the package. Manual overrides block this. Don't
      // regress out_for_delivery → tracking if a later in-transit scan
      // arrives — that would falsely demote a hot shipment.
      if (
        !isManuallyOverridden
        && shipment.status !== "delivered"
        && shipment.status !== "out_for_delivery"
      ) {
        newStatus = "tracking";
      }
      break;
    }
    case "not_received": {
      const daysUntilOriginal = diffDays(etaOriginal, today);
      if (daysUntilOriginal <= receiveWindow) {
        // We should have tracking by now — push ETA out to today + window.
        newEta = addDays(today, receiveWindow);
      }
      // Else: too early to expect tracking, leave ETA untouched.
      // Status is not changed — carrier has no info yet.
      break;
    }
  }

  return {
    eta: newEta,
    eta_original: etaOriginal,
    eta_last_checked_at: update.checkedAt,
    actual_arrival_date: actualArrival,
    status: newStatus,
  };
}

/** Helper: how many days did the ETA drift from the original? Positive = later. */
export function etaDriftDays(shipment: Pick<FreightShipment, "eta" | "eta_original">): number {
  if (!shipment.eta || !shipment.eta_original) return 0;
  return diffDays(shipment.eta, shipment.eta_original);
}
