/**
 * Carrier-agnostic shape returned by a tracking provider.
 *
 * Status semantics:
 *   - "not_received": carrier has no record yet (common for sea freight until
 *     ~5–7 days before arrival, i.e. ~23–25 days after supplier ship date).
 *   - "in_transit":   carrier has the shipment and is moving it. `carrierEta`
 *     should be populated with the carrier-provided ETA.
 *   - "out_for_delivery": final-mile (mostly air freight).
 *   - "delivered":    shipment arrived; `deliveredAt` populated.
 */
export type TrackingStatus =
  | "not_received"
  | "in_transit"
  | "out_for_delivery"
  | "delivered";

export interface TrackingEvent {
  timestamp: string; // ISO
  description: string;
  location?: string | null;
}

export interface TrackingUpdate {
  status: TrackingStatus;
  /** Carrier-provided ETA. Null when status === "not_received". */
  carrierEta: string | null; // YYYY-MM-DD
  /** If delivered, the ISO timestamp. */
  deliveredAt?: string | null;
  /** Most recent known location (optional). */
  location?: string | null;
  /** Recent tracking events (newest first). */
  events: TrackingEvent[];
  /** When this update was fetched. */
  checkedAt: string; // ISO
}

/** What the reconciler outputs after comparing an update against the shipment. */
export interface ReconciledEta {
  eta: string; // YYYY-MM-DD
  eta_original: string; // YYYY-MM-DD
  eta_last_checked_at: string; // ISO
  actual_arrival_date: string | null; // YYYY-MM-DD
  /** May be null when no status transition is warranted (leave the shipment as-is). */
  status:
    | "on_the_water"
    | "high_risk"
    | "cleared_customs"
    | "tracking"
    | "delivered";
}

export interface TrackingProvider {
  /** Display name. */
  name: string;
  /** What kind of freight this provider handles. */
  carrierType: "sea" | "air";
  /**
   * Fetch a tracking update for the given tracking number.
   * Providers should be resilient: throw only on hard failure (network, auth).
   * A valid "no data yet" response is {status: "not_received", ...}.
   */
  fetchTracking(trackingNumber: string): Promise<TrackingUpdate>;
}
