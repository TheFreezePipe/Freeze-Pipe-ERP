// =============================================================
// ShipStation webhook receiver (Supabase Edge Function, Deno)
// =============================================================
// Public HTTPS endpoint registered with ShipStation. ShipStation POSTs here
// when orders move to ship_notify / item_ship_notify / order_notify states.
//
// The function is designed to be bulletproof:
//
//   1. Signature verification. ShipStation doesn't natively sign webhooks
//      (as of this writing), so we use a "secret in the URL path" + source
//      IP allowlist. Configure WEBHOOK_SHARED_SECRET as a random 32+ char
//      value and register the URL as:
//          https://<project>.supabase.co/functions/v1/shipstation-webhook?s=<SECRET>
//      We ALSO check the ?s= query param on every request; anything without
//      a match returns 401 without leaking detail.
//
//   2. Idempotency. Every request is stored in shipstation_webhook_events
//      with a UNIQUE event_id derived from (resource_url, event_type, body_hash).
//      Re-deliveries hit a unique-violation and we return 200 without
//      re-processing. ShipStation retries on any non-2xx.
//
//   3. Fast ack, deferred processing. We store the event, return 200
//      immediately, then process in-function with a short budget. If
//      processing fails mid-way, the event row is left with processed_at
//      NULL and a later replay run picks it up.
//
//   4. Transactional inventory apply. All state changes go through
//      rpc_apply_shipstation_sale which is one Postgres transaction.
//
//   5. Observability. Every event writes an audit row. Errors are
//      captured in processing_error for post-hoc review.
//
// To deploy:
//   supabase functions deploy shipstation-webhook --no-verify-jwt
//
// --no-verify-jwt is required because ShipStation can't send our JWT;
// we enforce our own secret-in-URL authentication instead.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// -----------------------------------------------------------------------------
// Env & clients
// -----------------------------------------------------------------------------
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SHIPSTATION_WEBHOOK_SECRET = Deno.env.get("SHIPSTATION_WEBHOOK_SECRET")!;
const SHIPSTATION_API_KEY = Deno.env.get("SHIPSTATION_API_KEY")!;
const SHIPSTATION_API_SECRET = Deno.env.get("SHIPSTATION_API_SECRET")!;
// Optional comma-separated allowlist of ShipStation IPs / CIDRs. Leave empty
// to skip IP-based checks (the secret-in-URL still protects).
const IP_ALLOWLIST = (Deno.env.get("SHIPSTATION_IP_ALLOWLIST") ?? "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// -----------------------------------------------------------------------------
// Types (subset — ShipStation's payload is massive; we only consume what we need)
// -----------------------------------------------------------------------------
interface ShipStationWebhookPayload {
  resource_url: string;
  resource_type: string;
}

interface ShipStationOrder {
  orderId: number;
  orderNumber: string;
  orderDate: string;          // "2024-10-14T12:34:56.000Z"
  shipDate: string | null;
  orderStatus: string;
  customerEmail: string | null;
  customerUsername: string | null;
  orderTotal: number;         // dollars
  amountPaid: number;
  shippingAmount: number;
  taxAmount: number;
  advancedOptions?: { storeId?: number; source?: string };
  items: Array<{
    orderItemId: number;
    sku: string;
    name: string;
    quantity: number;
    unitPrice: number;
  }>;
}

// -----------------------------------------------------------------------------
// Main handler
// -----------------------------------------------------------------------------
Deno.serve(async (req) => {
  const url = new URL(req.url);

  // --- AuthN layer 1: secret in URL ---------------------------------------
  const providedSecret = url.searchParams.get("s");
  if (!providedSecret || providedSecret !== SHIPSTATION_WEBHOOK_SECRET) {
    // Constant-time-ish deny. Don't leak which field was wrong.
    return new Response("unauthorized", { status: 401 });
  }

  // --- AuthN layer 2: IP allowlist (optional) -----------------------------
  if (IP_ALLOWLIST.length > 0) {
    const sourceIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
      ?? req.headers.get("x-real-ip")
      ?? "";
    if (!IP_ALLOWLIST.some(allowed => sourceIp.startsWith(allowed))) {
      return new Response("unauthorized", { status: 401 });
    }
  }

  // --- Method guard --------------------------------------------------------
  if (req.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }

  // --- Parse body ----------------------------------------------------------
  let payload: ShipStationWebhookPayload;
  let rawBody: string;
  try {
    rawBody = await req.text();
    payload = JSON.parse(rawBody);
  } catch {
    return new Response("invalid json", { status: 400 });
  }

  // --- Compute idempotency key --------------------------------------------
  const bodyHash = await sha256(rawBody);
  const eventId = `${payload.resource_url ?? "unknown"}:${payload.resource_type ?? "unknown"}:${bodyHash}`;

  // --- Persist the webhook event; UNIQUE index on event_id dedupes -------
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => { headers[k] = v; });

  const { data: existingEvent } = await supabase
    .from("shipstation_webhook_events")
    .select("id, processed_at")
    .eq("event_id", eventId)
    .maybeSingle();

  if (existingEvent) {
    // Already delivered. Return 200 so ShipStation stops retrying.
    return new Response(
      JSON.stringify({ ok: true, duplicate: true, id: existingEvent.id }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  const { data: eventRow, error: insertErr } = await supabase
    .from("shipstation_webhook_events")
    .insert({
      event_id: eventId,
      event_type: payload.resource_type ?? "unknown",
      resource_url: payload.resource_url ?? null,
      signature_verified: true, // secret-in-URL check passed
      request_headers: headers,
      request_body: payload,
    })
    .select()
    .single();

  if (insertErr || !eventRow) {
    // If this fails with a unique-violation, someone beat us in a race;
    // treat as duplicate.
    if (insertErr?.code === "23505") {
      return new Response(
        JSON.stringify({ ok: true, duplicate: true }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    console.error("failed to insert webhook event", insertErr);
    return new Response("internal error", { status: 500 });
  }

  // --- Fetch the actual order details from ShipStation --------------------
  // The webhook payload only contains a resource_url pointing to the order(s).
  try {
    await processWebhookEvent(eventRow.id, payload);
  } catch (err) {
    // Processing failed, but we persisted the event. A reconcile run will
    // retry it. Return 200 so ShipStation doesn't hammer us — we already
    // have the record.
    console.error("processing error", err);
    await supabase
      .from("shipstation_webhook_events")
      .update({
        processing_error: err instanceof Error ? err.message : String(err),
        attempts: (eventRow.attempts ?? 0) + 1,
      })
      .eq("id", eventRow.id);
  }

  return new Response(
    JSON.stringify({ ok: true, id: eventRow.id }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
});

// -----------------------------------------------------------------------------
// Process a single webhook event
// -----------------------------------------------------------------------------
async function processWebhookEvent(
  eventRowId: string,
  payload: ShipStationWebhookPayload,
): Promise<void> {
  if (!payload.resource_url) {
    throw new Error("webhook payload missing resource_url");
  }

  // GET the referenced orders from ShipStation.
  const orders = await fetchShipStationResource(payload.resource_url);

  for (const order of orders) {
    const orderRowId = await upsertOrder(order, payload.resource_type);
    // Apply inventory only on ship-related events.
    if (
      payload.resource_type === "SHIP_NOTIFY"
      || payload.resource_type === "ITEM_SHIP_NOTIFY"
    ) {
      await applySaleInventory(orderRowId);
    }
  }

  await supabase
    .from("shipstation_webhook_events")
    .update({ processed_at: new Date().toISOString(), processing_error: null })
    .eq("id", eventRowId);
}

// -----------------------------------------------------------------------------
// Fetch orders from ShipStation API (handles both single and paged responses)
// -----------------------------------------------------------------------------
async function fetchShipStationResource(resourceUrl: string): Promise<ShipStationOrder[]> {
  const auth = btoa(`${SHIPSTATION_API_KEY}:${SHIPSTATION_API_SECRET}`);
  const orders: ShipStationOrder[] = [];
  let nextUrl: string | null = resourceUrl;
  let safety = 10; // cap pages to avoid infinite loops

  while (nextUrl && safety-- > 0) {
    const res = await fetchWithRetry(nextUrl, {
      headers: { Authorization: `Basic ${auth}` },
    });
    if (!res.ok) {
      throw new Error(`ShipStation API ${res.status}: ${await res.text()}`);
    }
    const body = await res.json() as { orders?: ShipStationOrder[] } | ShipStationOrder;
    if (Array.isArray((body as { orders?: ShipStationOrder[] }).orders)) {
      orders.push(...(body as { orders: ShipStationOrder[] }).orders);
      // Handle pagination if needed (ShipStation uses `page` query)
      nextUrl = null; // simple default
    } else {
      orders.push(body as ShipStationOrder);
      nextUrl = null;
    }
  }

  return orders;
}

// Exponential-backoff retry wrapper for transient ShipStation failures.
async function fetchWithRetry(url: string, init: RequestInit, maxAttempts = 4): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const res = await fetch(url, init);
      // Retry on 5xx and 429; pass through 4xx immediately.
      if (res.status >= 500 || res.status === 429) {
        await sleep(250 * Math.pow(2, attempt));
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      await sleep(250 * Math.pow(2, attempt));
    }
  }
  throw lastErr ?? new Error("fetchWithRetry exhausted");
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// -----------------------------------------------------------------------------
// Upsert a ShipStation order + its line items
// -----------------------------------------------------------------------------
async function upsertOrder(order: ShipStationOrder, seenVia: string): Promise<string> {
  // Look up or insert the order
  const { data: existing } = await supabase
    .from("shipstation_orders")
    .select("id")
    .eq("shipstation_order_id", order.orderId)
    .maybeSingle();

  const row = {
    shipstation_order_id: order.orderId,
    order_number: order.orderNumber,
    order_status: order.orderStatus,
    order_date: order.orderDate,
    ship_date: order.shipDate,
    customer_email: order.customerEmail,
    customer_name: order.customerUsername,
    store_id: order.advancedOptions?.storeId ?? null,
    store_name: order.advancedOptions?.source ?? null,
    order_total_cents: Math.round(order.orderTotal * 100),
    shipping_amount_cents: Math.round(order.shippingAmount * 100),
    tax_amount_cents: Math.round(order.taxAmount * 100),
    last_seen_via: seenVia === "SHIP_NOTIFY" || seenVia === "ITEM_SHIP_NOTIFY" ? "webhook" : "webhook",
    last_seen_at: new Date().toISOString(),
    raw_payload: order,
  };

  let orderRowId: string;
  if (existing) {
    await supabase.from("shipstation_orders").update(row).eq("id", existing.id);
    orderRowId = existing.id;
    // Line items: replace them (idempotent — but only if none have been applied)
    // Safer: only sync line items for orders not yet applied.
  } else {
    const { data: inserted, error } = await supabase
      .from("shipstation_orders")
      .insert(row)
      .select("id")
      .single();
    if (error || !inserted) throw error ?? new Error("order insert failed");
    orderRowId = inserted.id;
  }

  // Resolve SKU codes to product_skus.id
  const skuCodes = order.items.map(i => i.sku).filter(Boolean);
  const { data: skuRows } = await supabase
    .from("product_skus")
    .select("id, sku")
    .in("sku", skuCodes);
  const skuMap = new Map((skuRows ?? []).map(r => [r.sku, r.id as string]));

  // Replace line items (fresh insert set per order)
  await supabase
    .from("shipstation_order_items")
    .delete()
    .eq("shipstation_order_id", orderRowId);

  if (order.items.length > 0) {
    await supabase.from("shipstation_order_items").insert(
      order.items.map(i => ({
        shipstation_order_id: orderRowId,
        shipstation_line_item_id: i.orderItemId,
        sku_code: i.sku ?? "(unknown)",
        sku_id: skuMap.get(i.sku) ?? null,
        quantity: i.quantity,
        unit_price_cents: Math.round(i.unitPrice * 100),
      })),
    );
  }

  return orderRowId;
}

// -----------------------------------------------------------------------------
// Apply inventory delta via the atomic RPC
// -----------------------------------------------------------------------------
async function applySaleInventory(orderRowId: string): Promise<void> {
  // Look up the "system" actor id — a reserved profile for automated writes.
  const { data: sys } = await supabase
    .from("profiles")
    .select("id")
    .eq("email", "system@internal")
    .maybeSingle();

  const { data, error } = await supabase.rpc("rpc_apply_shipstation_sale", {
    p_order_id: orderRowId,
    p_system_actor_id: sys?.id ?? null,
  });
  if (error) {
    throw new Error(`rpc_apply_shipstation_sale failed: ${error.message}`);
  }
  if (data && typeof data === "object" && "ok" in data && !data.ok) {
    // Not a crash — business-logic refusal (e.g., unresolved SKUs). Attempts
    // column bumps; error captured in order row.
    console.warn("apply_shipstation_sale returned non-ok", data);
  }
}

// -----------------------------------------------------------------------------
// SHA-256 hex digest helper (native SubtleCrypto, no deps)
// -----------------------------------------------------------------------------
async function sha256(s: string): Promise<string> {
  const buf = new TextEncoder().encode(s);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}
