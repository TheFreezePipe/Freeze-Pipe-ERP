// =============================================================
// ShipStation nightly reconciliation (Supabase Edge Function)
// =============================================================
// Runs on a schedule (pg_cron -> SELECT net.http_post(...)). Pulls orders
// from the ShipStation API for the target window and reconciles them
// against our stored orders.
//
// Three jobs:
//
//   1. Replay any webhook events that failed to process. Walks
//      shipstation_webhook_events WHERE processed_at IS NULL; each event is
//      re-attempted up to a limit.
//   2. Pull the previous day's orders from ShipStation and ensure every
//      order we expect is in our DB. Logs drift to shipstation_sync_runs.
//   3. Apply inventory for any order where inventory_applied_at IS NULL
//      AND no unresolved SKU remains.
//
// Schedule via Supabase dashboard or:
//   SELECT cron.schedule(
//     'shipstation-reconcile-daily',
//     '15 3 * * *',  -- 3:15 UTC nightly
//     $$SELECT net.http_post(
//       url := 'https://<project>.supabase.co/functions/v1/shipstation-reconcile',
//       headers := jsonb_build_object('Authorization', 'Bearer <service_role_jwt>'),
//       body := '{}'::jsonb
//     )$$
//   );

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { resolveLineItems } from "../_shared/shipstation-resolve.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SHIPSTATION_API_KEY = Deno.env.get("SHIPSTATION_API_KEY")!;
const SHIPSTATION_API_SECRET = Deno.env.get("SHIPSTATION_API_SECRET")!;
const SHIPSTATION_API_BASE = "https://ssapi.shipstation.com";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

Deno.serve(async (req) => {
  // Only allow service-role callers (pg_cron sends the service_role JWT).
  const authHeader = req.headers.get("authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return new Response("unauthorized", { status: 401 });
  }

  // Create a sync run record to report back to
  const { data: run } = await supabase
    .from("shipstation_sync_runs")
    .insert({ run_type: "nightly_reconcile" })
    .select()
    .single();

  if (!run) {
    return new Response("failed to create sync run", { status: 500 });
  }

  const report = {
    events_replayed: 0,
    events_still_failed: 0,
    orders_pulled: 0,
    orders_new: 0,
    orders_updated: 0,
    orders_drift_detected: 0,
    inventory_apply_succeeded: 0,
    inventory_apply_skipped: 0,
    error: null as string | null,
  };

  try {
    // -------- Stage 1: replay failed webhook events -----------------------
    const { data: pendingEvents } = await supabase
      .from("shipstation_webhook_events")
      .select("id, event_id, event_type, resource_url, request_body, attempts")
      .is("processed_at", null)
      .lt("attempts", 6)   // give up after 6 attempts
      .limit(200);

    for (const evt of pendingEvents ?? []) {
      try {
        await processEvent(evt);
        report.events_replayed++;
      } catch (err) {
        report.events_still_failed++;
        await supabase
          .from("shipstation_webhook_events")
          .update({
            attempts: (evt.attempts ?? 0) + 1,
            processing_error: err instanceof Error ? err.message : String(err),
          })
          .eq("id", evt.id);
      }
    }

    // -------- Stage 2: pull recent orders ---------------------------------
    // Rolling last-26h window ending NOW. The old version floored `end` to
    // midnight UTC ("pull yesterday") — correct for its original life as a
    // nightly 03:15 job, but the intraday */30 schedule was then re-pulling
    // yesterday all day, so today's ships only landed after midnight UTC.
    // Rolling window + idempotent upserts = today's orders land within
    // ~30 min; the 2h overlap absorbs clock skew and slow label batches.
    const end = new Date();
    const start = new Date(end.getTime() - 26 * 60 * 60 * 1000);

    await supabase
      .from("shipstation_sync_runs")
      .update({ from_date: start.toISOString(), to_date: end.toISOString() })
      .eq("id", run.id);

    const pulled = await pullOrders(start, end);
    report.orders_pulled = pulled.length;

    for (const order of pulled) {
      const { isNew, hadDrift } = await upsertAndReconcile(order);
      if (isNew) report.orders_new++;
      else report.orders_updated++;
      if (hadDrift) report.orders_drift_detected++;
    }

    // -------- Stage 3: apply inventory for orders still pending ----------
    // Mirrors the webhook's status-based gate (see shipstation-webhook
    // for the full rationale): we deduct for shipped + awaiting_shipment
    // only. Skipping on_hold / cancelled / awaiting_payment avoids
    // false deductions for orders that may never ship.
    const { data: unappliedOrders } = await supabase
      .from("shipstation_orders")
      .select("id")
      .is("inventory_applied_at", null)
      .lt("inventory_apply_attempts", 6)
      .in("order_status", ["shipped", "awaiting_shipment"])
      .limit(500);

    for (const o of unappliedOrders ?? []) {
      const { data } = await supabase.rpc("rpc_apply_shipstation_sale", {
        p_order_id: o.id,
        // System actor (deterministic UUID, see migration 20260505000001
        // memory note). Required because inventory_transactions.performed_by
        // is NOT NULL FK to profiles — passing null silently swallows the
        // insert in the RPC's protected section and returns ok:false,
        // making every cron call appear to "skip" when it's actually
        // failing on a constraint violation.
        p_system_actor_id: "00000000-0000-0000-0000-000000000001",
      });
      if (data && typeof data === "object" && "ok" in data && data.ok) {
        report.inventory_apply_succeeded++;
      } else {
        report.inventory_apply_skipped++;
      }
    }

    // -------- Done --------------------------------------------------------
    await supabase
      .from("shipstation_sync_runs")
      .update({
        completed_at: new Date().toISOString(),
        status: "succeeded",
        orders_pulled: report.orders_pulled,
        orders_new: report.orders_new,
        orders_updated: report.orders_updated,
        orders_drift_detected: report.orders_drift_detected,
        notes: JSON.stringify(report),
      })
      .eq("id", run.id);

    return new Response(JSON.stringify({ ok: true, report }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    report.error = err instanceof Error ? err.message : String(err);
    await supabase
      .from("shipstation_sync_runs")
      .update({
        completed_at: new Date().toISOString(),
        status: "failed",
        error_message: report.error,
        notes: JSON.stringify(report),
      })
      .eq("id", run.id);

    return new Response(JSON.stringify({ ok: false, report }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
});

// -----------------------------------------------------------------------------
// Pull orders from ShipStation for a date range
// -----------------------------------------------------------------------------
async function pullOrders(from: Date, to: Date): Promise<ShipStationOrder[]> {
  const auth = btoa(`${SHIPSTATION_API_KEY}:${SHIPSTATION_API_SECRET}`);
  const out: ShipStationOrder[] = [];
  let page = 1;
  let safety = 100; // cap at 100 pages (~5000 orders)

  while (safety-- > 0) {
    const url = new URL(`${SHIPSTATION_API_BASE}/orders`);
    url.searchParams.set("modifyDateStart", from.toISOString());
    url.searchParams.set("modifyDateEnd", to.toISOString());
    url.searchParams.set("pageSize", "50");
    url.searchParams.set("page", String(page));

    const res = await fetchWithRetry(url.toString(), {
      headers: { Authorization: `Basic ${auth}` },
    });
    if (!res.ok) {
      throw new Error(`ShipStation /orders ${res.status}: ${await res.text()}`);
    }
    const body = await res.json() as { orders: ShipStationOrder[]; pages: number };
    out.push(...body.orders);
    if (page >= body.pages) break;
    page++;
  }

  return out;
}

async function upsertAndReconcile(order: ShipStationOrder): Promise<{ isNew: boolean; hadDrift: boolean }> {
  const { data: existing } = await supabase
    .from("shipstation_orders")
    .select("id, order_status, order_total_cents, inventory_applied_at")
    .eq("shipstation_order_id", order.orderId)
    .maybeSingle();

  const totalCents = Math.round(order.orderTotal * 100);
  const hadDrift = !!existing && (
    existing.order_status !== order.orderStatus
    || existing.order_total_cents !== totalCents
  );

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
    order_total_cents: totalCents,
    shipping_amount_cents: Math.round(order.shippingAmount * 100),
    tax_amount_cents: Math.round(order.taxAmount * 100),
    last_seen_via: "api_pull",
    last_seen_at: new Date().toISOString(),
    raw_payload: order,
  };

  let orderRowId: string;
  let isNew = false;
  if (existing) {
    await supabase.from("shipstation_orders").update(row).eq("id", existing.id);
    orderRowId = existing.id;
  } else {
    const { data: inserted, error } = await supabase
      .from("shipstation_orders")
      .insert(row)
      .select("id")
      .single();
    if (error || !inserted) throw error ?? new Error("order insert failed");
    orderRowId = inserted.id;
    isNew = true;
  }

  // Only (re)populate items for orders not yet inventory-applied. Once applied,
  // items are immutable to keep audit trail consistent.
  if (!existing?.inventory_applied_at) {
    await supabase
      .from("shipstation_order_items")
      .delete()
      .eq("shipstation_order_id", orderRowId);

    const rowsToInsert = await resolveLineItems(supabase, orderRowId, order.items);
    if (rowsToInsert.length > 0) {
      await supabase.from("shipstation_order_items").insert(rowsToInsert);
    }
  }

  return { isNew, hadDrift };
}

// Line-item resolution (alias table → exact catalog match → prefix rule)
// lives in _shared/shipstation-resolve.ts — one implementation for both
// this function and shipstation-webhook.

async function processEvent(evt: {
  id: string;
  event_type: string;
  resource_url: string | null;
  request_body: ShipStationWebhookPayload;
}): Promise<void> {
  // Re-fetch the referenced order(s) and upsert.
  if (!evt.resource_url) return;
  const orders = await fetchResource(evt.resource_url);
  for (const order of orders) {
    await upsertAndReconcile(order);
  }
  await supabase
    .from("shipstation_webhook_events")
    .update({ processed_at: new Date().toISOString(), processing_error: null })
    .eq("id", evt.id);
}

async function fetchResource(url: string): Promise<ShipStationOrder[]> {
  const auth = btoa(`${SHIPSTATION_API_KEY}:${SHIPSTATION_API_SECRET}`);
  const res = await fetchWithRetry(url, { headers: { Authorization: `Basic ${auth}` } });
  if (!res.ok) throw new Error(`ShipStation ${res.status}`);
  const body = await res.json() as { orders?: ShipStationOrder[] } | ShipStationOrder;
  return Array.isArray((body as { orders?: ShipStationOrder[] }).orders)
    ? (body as { orders: ShipStationOrder[] }).orders
    : [body as ShipStationOrder];
}

async function fetchWithRetry(url: string, init: RequestInit, maxAttempts = 4): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.status >= 500 || res.status === 429) {
        await sleep(500 * Math.pow(2, attempt));
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      await sleep(500 * Math.pow(2, attempt));
    }
  }
  throw lastErr ?? new Error("fetchWithRetry exhausted");
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

interface ShipStationOrder {
  orderId: number;
  orderNumber: string;
  orderDate: string;
  shipDate: string | null;
  orderStatus: string;
  customerEmail: string | null;
  customerUsername: string | null;
  orderTotal: number;
  amountPaid: number;
  shippingAmount: number;
  taxAmount: number;
  advancedOptions?: { storeId?: number; source?: string };
  items: Array<{ orderItemId: number; sku: string; name: string; quantity: number; unitPrice: number }>;
}

interface ShipStationWebhookPayload {
  resource_url: string;
  resource_type: string;
}
