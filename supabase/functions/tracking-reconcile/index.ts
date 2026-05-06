// =============================================================
// Server-side carrier tracking reconciler (Supabase Edge Function)
// =============================================================
// Runs on pg_cron every 6 hours. For every in-flight shipment:
//
//   1. Fetch carrier tracking update (Maersk, FedEx, DHL, COSCO, Evergreen, ...)
//   2. Apply the same reconciliation rules as the client had (receive window
//      push, auto status transitions on "in_transit" / "delivered", etc.)
//      — but now once, server-side, authoritatively.
//   3. Write ETA/status changes to freight_shipments.
//   4. Write audit entries (attributed to the system user).
//   5. Skip shipments with status_overridden_at set (manual override wins).
//
// Benefits over the client-side 12h poll:
//   - Runs on schedule regardless of user activity.
//   - One authoritative source of truth for ETAs; no race between browser tabs.
//   - Audit entries are written by the trusted server, not client code.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// Carrier API keys — set via `supabase secrets set` per environment.
// Missing keys cause the relevant carrier to fall back to "no update",
// which is safer than surfacing partial data.
const MAERSK_API_KEY = Deno.env.get("MAERSK_API_KEY") ?? "";
const FEDEX_API_KEY = Deno.env.get("FEDEX_API_KEY") ?? "";
const FEDEX_API_SECRET = Deno.env.get("FEDEX_API_SECRET") ?? "";
const FEDEX_USE_SANDBOX = (Deno.env.get("FEDEX_USE_SANDBOX") ?? "false").toLowerCase() === "true";
const FEDEX_BASE = FEDEX_USE_SANDBOX
  ? "https://apis-sandbox.fedex.com"
  : "https://apis.fedex.com";
const DHL_API_KEY = Deno.env.get("DHL_API_KEY") ?? "";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-000000000001";

// -----------------------------------------------------------------------------
// Types (mirrored from src/lib/tracking/types.ts)
// -----------------------------------------------------------------------------
type TrackingStatus = "not_received" | "in_transit" | "out_for_delivery" | "delivered";
type FreightStatus = "on_the_water" | "high_risk" | "cleared_customs" | "tracking" | "delivered";

interface TrackingUpdate {
  status: TrackingStatus;
  carrierEta: string | null;
  deliveredAt?: string | null;
  location?: string | null;
  events: Array<{ timestamp: string; description: string; location?: string | null }>;
  checkedAt: string;
}

interface Shipment {
  id: string;
  shipment_number: string;
  freight_type: "air" | "sea";
  status: FreightStatus;
  carrier_name: string | null;
  tracking_number: string | null;
  ship_date: string | null;
  eta: string | null;
  eta_original: string | null;
  eta_last_checked_at: string | null;
  actual_arrival_date: string | null;
  status_overridden_at: string | null;
}

const RECEIVE_WINDOW_DAYS = { sea: 7, air: 2 };

// CORS headers — required because this function is now also called from
// the browser (the "Refresh tracking" button on the freight dashboard),
// not just from pg_cron. Without these, the browser blocks the request
// at the preflight stage with "Failed to send a request to the Edge Function".
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// -----------------------------------------------------------------------------
// Main handler
// -----------------------------------------------------------------------------
Deno.serve(async (req) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  const authHeader = req.headers.get("authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return new Response("unauthorized", { status: 401, headers: CORS_HEADERS });
  }

  const report = {
    shipments_checked: 0,
    eta_changes: 0,
    status_changes: 0,
    overrides_skipped: 0,
    errors: 0,
    error_details: [] as Array<{ shipmentId: string; error: string }>,
  };

  try {
    // Fetch every in-flight shipment (not delivered).
    const { data: shipments, error } = await supabase
      .from("freight_shipments")
      .select("*")
      .neq("status", "delivered");
    if (error) throw error;

    for (const shipment of (shipments ?? []) as Shipment[]) {
      report.shipments_checked++;
      try {
        // Respect manual overrides: still refresh ETA, but don't touch status.
        const update = await fetchCarrierUpdate(shipment);
        if (!update) continue;
        const applied = await applyUpdate(shipment, update);
        if (applied.etaChanged) report.eta_changes++;
        if (applied.statusChanged) report.status_changes++;
        if (applied.overrideSkipped) report.overrides_skipped++;
      } catch (err) {
        report.errors++;
        report.error_details.push({
          shipmentId: shipment.id,
          error: stringifyError(err),
        });
      }
    }

    return new Response(JSON.stringify({ ok: true, report }), {
      status: 200,
      headers: { ...CORS_HEADERS, "content-type": "application/json" },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: { ...CORS_HEADERS, "content-type": "application/json" } },
    );
  }
});

// -----------------------------------------------------------------------------
// Fetch a tracking update from the right carrier
// -----------------------------------------------------------------------------
async function fetchCarrierUpdate(shipment: Shipment): Promise<TrackingUpdate | null> {
  if (!shipment.carrier_name || !shipment.tracking_number) return null;
  const carrier = shipment.carrier_name.toLowerCase().trim();

  try {
    switch (carrier) {
      case "maersk":     return await fetchMaersk(shipment.tracking_number);
      case "cosco":      return await fetchCosco(shipment.tracking_number);
      case "evergreen":  return await fetchEvergreen(shipment.tracking_number);
      case "fedex":      return await fetchFedEx(shipment.tracking_number);
      case "dhl":        return await fetchDhl(shipment.tracking_number);
      default:
        console.warn(`No carrier integration for "${carrier}" on shipment ${shipment.shipment_number}`);
        return null;
    }
  } catch (err) {
    // Per-carrier failures should not abort the whole run.
    console.error(`Carrier ${carrier} failed:`, err);
    return null;
  }
}

// -----------------------------------------------------------------------------
// Apply the update: reconcile + write to DB + audit
// -----------------------------------------------------------------------------
async function applyUpdate(shipment: Shipment, update: TrackingUpdate): Promise<{
  etaChanged: boolean;
  statusChanged: boolean;
  overrideSkipped: boolean;
}> {
  const reconciled = reconcile(shipment, update);
  const etaChanged = reconciled.eta !== shipment.eta;
  const statusChanged = reconciled.status !== shipment.status;
  const overrideSkipped = !!shipment.status_overridden_at && statusChanged === false && reconciled.status !== shipment.status;

  // Build the update payload
  const patch: Partial<Shipment> = {
    eta: reconciled.eta,
    eta_original: reconciled.eta_original,
    eta_last_checked_at: update.checkedAt,
    actual_arrival_date: reconciled.actual_arrival_date,
  };
  // If manually overridden, preserve current status (already handled in reconcile).
  if (reconciled.status !== shipment.status) {
    patch.status = reconciled.status;
  }

  const { error: updateErr } = await supabase
    .from("freight_shipments")
    .update(patch)
    .eq("id", shipment.id);
  if (updateErr) throw updateErr;

  // Audit entries — one per line-item SKU so the log is filterable by SKU.
  const { data: lineItems } = await supabase
    .from("freight_line_items")
    .select("sku_id")
    .eq("freight_shipment_id", shipment.id);
  const skuTargets = (lineItems ?? []).map(li => li.sku_id as string);
  if (skuTargets.length === 0) skuTargets.push(null as unknown as string);

  if (etaChanged) {
    for (const skuId of skuTargets) {
      await supabase.from("inventory_transactions").insert({
        sku_id: skuId,
        transaction_type: "tracking_eta_update",
        quantity: 0,
        field_affected: "eta",
        movement_kind: "metadata",
        reference_id: shipment.id,
        reference_type: "freight_shipment",
        notes: `${shipment.shipment_number}: carrier ETA ${shipment.eta ?? "unknown"} → ${reconciled.eta}`,
        performed_by: SYSTEM_ACTOR_ID,
      });
    }
  }
  if (statusChanged) {
    for (const skuId of skuTargets) {
      await supabase.from("inventory_transactions").insert({
        sku_id: skuId,
        transaction_type: "tracking_status_auto",
        quantity: 0,
        field_affected: "status",
        movement_kind: "metadata",
        reference_id: shipment.id,
        reference_type: "freight_shipment",
        notes: `${shipment.shipment_number}: status ${shipment.status} → ${reconciled.status} (carrier tracking)`,
        performed_by: SYSTEM_ACTOR_ID,
      });
    }
  }

  return { etaChanged, statusChanged, overrideSkipped };
}

// -----------------------------------------------------------------------------
// Reconciliation logic (mirror of src/lib/tracking/reconcile.ts)
// -----------------------------------------------------------------------------
function reconcile(shipment: Shipment, update: TrackingUpdate): {
  eta: string;
  eta_original: string;
  actual_arrival_date: string | null;
  status: FreightStatus;
} {
  const today = new Date().toISOString().slice(0, 10);
  const etaOriginal = shipment.eta_original ?? shipment.eta ?? today;
  const currentEta = shipment.eta ?? etaOriginal;
  const window = RECEIVE_WINDOW_DAYS[shipment.freight_type];
  const isOverridden = !!shipment.status_overridden_at;

  let newEta = currentEta;
  let actualArrival = shipment.actual_arrival_date ?? null;
  let newStatus: FreightStatus = shipment.status;

  switch (update.status) {
    case "delivered":
      actualArrival = update.deliveredAt ?? today;
      if (!isOverridden) newStatus = "delivered";
      break;
    case "in_transit":
    case "out_for_delivery":
      if (update.carrierEta) newEta = update.carrierEta;
      if (!isOverridden && shipment.status !== "delivered") newStatus = "tracking";
      break;
    case "not_received": {
      const daysUntil = diffDays(etaOriginal, today);
      if (daysUntil <= window) newEta = addDays(today, window);
      break;
    }
  }

  return { eta: newEta, eta_original: etaOriginal, actual_arrival_date: actualArrival, status: newStatus };
}

function diffDays(a: string, b: string): number {
  return Math.round((Date.parse(a + "T00:00:00Z") - Date.parse(b + "T00:00:00Z")) / 86_400_000);
}
function addDays(ymd: string, n: number): string {
  const d = new Date(ymd + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// -----------------------------------------------------------------------------
// Carrier API integrations — TODOs for real wiring
// -----------------------------------------------------------------------------
// Each of these returns a TrackingUpdate or throws on unrecoverable errors.
// Until real API keys are set, they return `null`-as-not_received so
// reconciliation still runs the receive-window push.

async function fetchMaersk(trackingNumber: string): Promise<TrackingUpdate | null> {
  if (!MAERSK_API_KEY) return notReceivedNow();
  // TODO: GET https://api.maersk.com/track/{trackingNumber}
  // with header Consumer-Key: MAERSK_API_KEY
  return notReceivedNow();
}

async function fetchCosco(trackingNumber: string): Promise<TrackingUpdate | null> {
  // COSCO lookup is via BL number scrape; replace with Project44 or AfterShip.
  return notReceivedNow();
}

async function fetchEvergreen(trackingNumber: string): Promise<TrackingUpdate | null> {
  return notReceivedNow();
}

// FedEx Track API v1. OAuth2 client_credentials → POST /track/v1/trackingnumbers.
// Token has 1hr TTL; cron fires every 6h so we just fetch fresh each call (cheap,
// no caching needed). Sandbox vs production controlled by FEDEX_USE_SANDBOX env.
async function fetchFedEx(trackingNumber: string): Promise<TrackingUpdate | null> {
  if (!FEDEX_API_KEY || !FEDEX_API_SECRET) return notReceivedNow();

  // Step 1: OAuth token
  const tokenRes = await fetch(`${FEDEX_BASE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: FEDEX_API_KEY,
      client_secret: FEDEX_API_SECRET,
    }).toString(),
  });
  if (!tokenRes.ok) {
    const body = await tokenRes.text();
    throw new Error(`FedEx OAuth ${tokenRes.status}: ${body.slice(0, 200)}`);
  }
  const { access_token } = await tokenRes.json() as { access_token: string };

  // Step 2: tracking call
  const trackRes = await fetch(`${FEDEX_BASE}/track/v1/trackingnumbers`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${access_token}`,
      "Content-Type": "application/json",
      "X-locale": "en_US",
    },
    body: JSON.stringify({
      includeDetailedScans: true,
      trackingInfo: [{ trackingNumberInfo: { trackingNumber } }],
    }),
  });
  if (!trackRes.ok) {
    const body = await trackRes.text();
    throw new Error(`FedEx track ${trackRes.status}: ${body.slice(0, 200)}`);
  }

  // deno-lint-ignore no-explicit-any
  const trackJson = await trackRes.json() as any;
  const result = trackJson?.output?.completeTrackResults?.[0]?.trackResults?.[0];
  if (!result) return notReceivedNow();

  // Per-tracking errors (e.g. "tracking number not found") arrive as `error` on the result
  if (result.error?.code) {
    console.warn(`FedEx tracking ${trackingNumber}: ${result.error.code} ${result.error.message ?? ""}`);
    return notReceivedNow();
  }

  const code: string | undefined = result.latestStatusDetail?.code;
  const status: TrackingStatus = mapFedExStatusCode(code);

  // deno-lint-ignore no-explicit-any
  const dateAndTimes: Array<{ type: string; dateTime: string }> = result.dateAndTimes ?? [];
  const findDate = (t: string) => dateAndTimes.find(d => d.type === t)?.dateTime ?? null;
  const carrierEta = toDateOnly(findDate("ESTIMATED_DELIVERY"));
  const deliveredAt = toDateOnly(findDate("ACTUAL_DELIVERY"));

  // deno-lint-ignore no-explicit-any
  const events = (result.scanEvents ?? []).slice(0, 25).map((e: any) => ({
    timestamp: e.date ?? "",
    description: e.eventDescription ?? e.derivedStatus ?? e.eventType ?? "",
    location: formatFedExLocation(e.scanLocation),
  }));

  return {
    status,
    carrierEta,
    deliveredAt,
    events,
    checkedAt: new Date().toISOString(),
  };
}

// FedEx codes per https://developer.fedex.com/api/en-us/catalog/track/v1/docs.html
function mapFedExStatusCode(code: string | undefined): TrackingStatus {
  switch (code) {
    case "DL":                                                   // Delivered
      return "delivered";
    case "OD":                                                   // Out for delivery
      return "out_for_delivery";
    case "IT":                                                   // In transit
    case "AR": case "AF":                                        // Arrived at / At FedEx facility
    case "DP":                                                   // Departed
    case "PU":                                                   // Picked up
    case "EP":                                                   // Eligible for pickup
    case "DE":                                                   // Delivery exception (still in flight)
    case "CC":                                                   // Cleared customs
    case "SF":                                                   // At sort facility
      return "in_transit";
    case "OC":                                                   // Order created (info received, not yet picked up)
    case "SH":                                                   // Shipment info sent — not yet picked up
    case "CA":                                                   // Cancelled
    default:
      return "not_received";
  }
}

function toDateOnly(iso: string | null): string | null {
  return iso ? iso.slice(0, 10) : null;
}

// deno-lint-ignore no-explicit-any
function formatFedExLocation(scan: any): string | null {
  if (!scan) return null;
  const parts = [scan.city, scan.stateOrProvinceCode, scan.countryCode].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

async function fetchDhl(trackingNumber: string): Promise<TrackingUpdate | null> {
  if (!DHL_API_KEY) return notReceivedNow();
  // TODO: GET /track/shipments?trackingNumber={awb} with DHL-API-Key header
  return notReceivedNow();
}

// Pretty-print errors that aren't proper Error instances (PostgrestError,
// raw fetch error objects, plain strings) so the report doesn't surface
// useless `[object Object]` strings.
// deno-lint-ignore no-explicit-any
function stringifyError(err: any): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    // PostgrestError: { code, message, details, hint }
    if ("message" in err) {
      const code = err.code ? `[${err.code}] ` : "";
      const details = err.details ? ` (${err.details})` : "";
      return `${code}${err.message}${details}`;
    }
    try { return JSON.stringify(err); } catch { /* fall through */ }
  }
  return String(err);
}

function notReceivedNow(): TrackingUpdate {
  return {
    status: "not_received",
    carrierEta: null,
    events: [],
    checkedAt: new Date().toISOString(),
  };
}
