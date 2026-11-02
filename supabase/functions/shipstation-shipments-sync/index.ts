// =============================================================
// ShipStation shipments sync (Supabase Edge Function)
// =============================================================
// Pulls labels from GET /shipments (the only ShipStation resource that
// carries shipmentCost, the carrier cost actually paid) and upserts them
// into public.shipstation_shipments keyed by shipment_id.
//
// Body params (all optional):
//   { "days": 2 }                       -> shipDate window ending today (default 2)
//   { "start": "YYYY-MM-DD", "end": "YYYY-MM-DD" } -> explicit window (end exclusive)
//
// Keep windows to ~30 days per call: ShipStation allows 40 requests/min
// and the function has a wall-clock limit. Idempotent — re-running a
// window replaces its rows.
//
// Service-role callers only (pg_cron / ops), same gate as daily-report.
// =============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const KEY = Deno.env.get("SHIPSTATION_API_KEY") ?? "";
const SECRET = Deno.env.get("SHIPSTATION_API_SECRET") ?? "";
const BASE = "https://ssapi.shipstation.com";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function jwtRole(authHeader: string | null): string | null {
  const token = (authHeader ?? "").replace(/^Bearer\s+/i, "");
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    return (JSON.parse(atob(b64)) as { role?: string }).role ?? null;
  } catch {
    return null;
  }
}

interface SsShipment {
  shipmentId: number; orderId: number | null; orderKey: string | null; orderNumber: string | null;
  shipDate: string | null; shipmentCost: number | null; insuranceCost: number | null;
  carrierCode: string | null; serviceCode: string | null; packageCode: string | null;
  weight: { value: number; units: string } | null;
  dimensions: { length: number; width: number; height: number; units: string } | null;
  voided: boolean | null;
  shipTo: { country?: string | null; state?: string | null; postalCode?: string | null } | null;
  shipmentItems: { sku: string | null; quantity: number | null }[] | null;
}

const toOz = (w: SsShipment["weight"]) => {
  if (!w || w.value == null) return null;
  const u = (w.units ?? "ounces").toLowerCase();
  return u.startsWith("pound") ? w.value * 16 : u.startsWith("gram") ? w.value / 28.3495 : w.value;
};
const toIn = (v: number | null | undefined, units: string | null | undefined) =>
  v == null ? null : (units ?? "inches").toLowerCase().startsWith("cent") ? v / 2.54 : v;

function mapRow(s: SsShipment) {
  const d = s.dimensions;
  return {
    shipment_id: s.shipmentId,
    order_id: s.orderId,
    order_key: s.orderKey,
    order_number: s.orderNumber,
    ship_date: s.shipDate ? s.shipDate.slice(0, 10) : null,
    shipment_cost: s.shipmentCost,
    insurance_cost: s.insuranceCost,
    carrier_code: s.carrierCode,
    service_code: s.serviceCode,
    package_code: s.packageCode,
    weight_oz: toOz(s.weight),
    length_in: toIn(d?.length, d?.units),
    width_in: toIn(d?.width, d?.units),
    height_in: toIn(d?.height, d?.units),
    voided: s.voided ?? false,
    ship_to_country: s.shipTo?.country ?? null,
    ship_to_state: s.shipTo?.state ?? null,
    ship_to_zip3: s.shipTo?.postalCode ? String(s.shipTo.postalCode).slice(0, 3) : null,
    items: (s.shipmentItems ?? []).map((it) => ({ sku: it.sku ?? null, quantity: it.quantity ?? 0 })),
    synced_at: new Date().toISOString(),
  };
}

async function fetchPage(url: string, auth: string): Promise<Response> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, { headers: { Authorization: auth } });
    if (res.status === 429 || res.status >= 500) {
      const reset = Number(res.headers.get("X-Rate-Limit-Reset") ?? "30");
      await res.text();
      await sleep((Number.isFinite(reset) ? reset : 30) * 1000 + 500);
      continue;
    }
    return res;
  }
  throw new Error("ShipStation /shipments: retries exhausted");
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  if (jwtRole(req.headers.get("Authorization")) !== "service_role") {
    return json({ error: "forbidden - service role required" }, 403);
  }
  if (!KEY || !SECRET) return json({ ok: false, error: "ShipStation creds not set" }, 500);

  let opts: { days?: number; start?: string; end?: string } = {};
  try { opts = await req.json(); } catch { /* empty body ok */ }
  const today = new Date();
  const endD = opts.end ? new Date(opts.end + "T00:00:00Z") : new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 1));
  const startD = opts.start
    ? new Date(opts.start + "T00:00:00Z")
    : new Date(endD.getTime() - Math.max(1, Math.min(opts.days ?? 2, 60)) * 86_400_000);
  const start = startD.toISOString().slice(0, 10);
  const end = endD.toISOString().slice(0, 10);

  const auth = "Basic " + btoa(`${KEY}:${SECRET}`);
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  let page = 1, pages = 1, pulled = 0, upserted = 0;
  const t0 = Date.now();
  try {
    do {
      const url = new URL(`${BASE}/shipments`);
      url.searchParams.set("shipDateStart", start);
      url.searchParams.set("shipDateEnd", end);
      url.searchParams.set("includeShipmentItems", "true");
      url.searchParams.set("pageSize", "500");
      url.searchParams.set("page", String(page));
      const res = await fetchPage(url.toString(), auth);
      if (!res.ok) throw new Error(`ShipStation /shipments ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const body = await res.json() as { shipments: SsShipment[]; pages: number };
      pages = body.pages ?? 1;
      const rows = (body.shipments ?? []).map(mapRow);
      pulled += rows.length;
      for (let i = 0; i < rows.length; i += 500) {
        const chunk = rows.slice(i, i + 500);
        const { error } = await admin.from("shipstation_shipments").upsert(chunk, { onConflict: "shipment_id" });
        if (error) throw new Error(`upsert: ${error.message}`);
        upserted += chunk.length;
      }
      const remaining = Number(res.headers.get("X-Rate-Limit-Remaining") ?? "10");
      if (remaining < 3 && page < pages) {
        await sleep((Number(res.headers.get("X-Rate-Limit-Reset") ?? "30") + 1) * 1000);
      }
      page++;
    } while (page <= pages);
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message ?? e), range: { start, end }, pulled, upserted, page, pages }, 500);
  }
  return json({ ok: true, range: { start, end }, pulled, upserted, pages, ms: Date.now() - t0 });
});
