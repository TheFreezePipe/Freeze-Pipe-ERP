/**
 * Deterministic mock tracking provider. Used by all carrier stubs in demo mode
 * so the UI has realistic-looking data without hitting any real carrier API.
 *
 * The mock is seeded by `trackingNumber + YYYYMMDD`, so a given shipment gets
 * the same answer all day, but its status + ETA can drift between days — which
 * is what the 12-hour polling loop is supposed to react to.
 */
import type { TrackingUpdate, TrackingStatus, TrackingEvent } from "../types";

/** Tiny deterministic PRNG (mulberry32) so results are repeatable. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

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
 * Context supplied by the carrier stub — lets the mock tailor the response
 * to the shipment's ship date / baseline ETA without hard-coding anything.
 */
export interface MockContext {
  carrierType: "sea" | "air";
  carrierName: string;
  /** Original (pre-drift) ETA, so the mock knows the "true" arrival window. */
  baselineEta: string | null;
  /** When it left the supplier. */
  shipDate: string | null;
}

export async function mockFetchTracking(
  trackingNumber: string,
  ctx: MockContext
): Promise<TrackingUpdate> {
  const today = todayYmd();
  const rand = seededRandom(hashString(trackingNumber + ":" + today));

  // Receive window: how many days before arrival the carrier starts reporting.
  const receiveWindow = ctx.carrierType === "sea" ? 7 : 2;

  // If we don't have a baseline ETA, we can't simulate anything sensible.
  if (!ctx.baselineEta) {
    return {
      status: "not_received",
      carrierEta: null,
      events: [],
      checkedAt: new Date().toISOString(),
    };
  }

  const daysUntilBaseline = diffDays(ctx.baselineEta, today);

  // --- Already past the baseline ETA -----------------------------------------
  if (daysUntilBaseline < -1) {
    // Shipment is overdue. 50/50: either still in transit (further delay) or delivered.
    if (rand() < 0.5) {
      return deliveredUpdate(ctx, addDays(today, -1));
    }
    // Further delay — push ETA by 2–4 more days from today
    const delayDays = 2 + Math.floor(rand() * 3);
    const newEta = addDays(today, delayDays);
    return {
      status: "in_transit",
      carrierEta: newEta,
      location: ctx.carrierType === "sea" ? "Port of Long Beach" : "Regional hub",
      events: [
        event(today, "In transit — delay reported", ctx.carrierType),
        event(addDays(today, -2), "Departed origin port", ctx.carrierType),
      ],
      checkedAt: new Date().toISOString(),
    };
  }

  // --- Outside the receive window -> "not_received" -------------------------
  if (daysUntilBaseline > receiveWindow) {
    return {
      status: "not_received",
      carrierEta: null,
      events: [],
      checkedAt: new Date().toISOString(),
    };
  }

  // --- Inside the receive window -> carrier has it, provides an ETA ---------
  // Drift: −2 to +3 days from baseline (slight bias toward late).
  const drift = Math.floor(rand() * 6) - 2;
  const carrierEta = addDays(ctx.baselineEta, drift);

  // If the drifted ETA is today or yesterday and rand is low -> mark delivered.
  if (diffDays(carrierEta, today) <= 0 && rand() < 0.4) {
    return deliveredUpdate(ctx, today);
  }

  return {
    status: "in_transit",
    carrierEta,
    location: ctx.carrierType === "sea" ? "Approaching destination port" : "Out for delivery",
    events: [
      event(today, `ETA updated to ${carrierEta}`, ctx.carrierType),
      event(addDays(today, -3), "Arrived at transit hub", ctx.carrierType),
      ctx.shipDate ? event(ctx.shipDate, "Departed origin", ctx.carrierType) : null,
    ].filter((e): e is TrackingEvent => e !== null),
    checkedAt: new Date().toISOString(),
  };
}

function deliveredUpdate(ctx: MockContext, deliveredDate: string): TrackingUpdate {
  return {
    status: "delivered",
    carrierEta: deliveredDate,
    deliveredAt: deliveredDate,
    location: ctx.carrierType === "sea" ? "Destination port" : "Delivered",
    events: [
      event(deliveredDate, "Delivered", ctx.carrierType),
      event(addDays(deliveredDate, -1), "Out for delivery", ctx.carrierType),
    ],
    checkedAt: new Date().toISOString(),
  };
}

function event(date: string, description: string, carrierType: "sea" | "air"): TrackingEvent {
  return {
    timestamp: date.length === 10 ? `${date}T12:00:00Z` : date,
    description,
    location: carrierType === "sea" ? "Port" : "Hub",
  };
}

// --- Status -> human-readable helpers ---------------------------------------
export const trackingStatusLabel: Record<TrackingStatus, string> = {
  not_received: "Not yet received by carrier",
  in_transit: "In transit",
  out_for_delivery: "Out for delivery",
  delivered: "Delivered",
};
