// =============================================================
// One-time historical backfill: pull a single month of ShipStation
// orders, aggregate to (sale_date, sku_code, units), upsert into the
// transient public.sales_backfill_raw staging table.
//
// Chunked deliberately — ONE month per invocation — so each call stays
// well under the edge-function time limit. The caller loops 24 months.
// Idempotent: re-running a month replaces that month's rows.
//
// Resolution of legacy sku_code -> real sku_id happens in a separate
// Node step (reusing the forecast engine's tested resolver), not here.
// SAFE TO DELETE after the backfill + resolve are done.
// =============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const KEY = Deno.env.get("SHIPSTATION_API_KEY") ?? "";
const SECRET = Deno.env.get("SHIPSTATION_API_SECRET") ?? "";
const BASE = "https://ssapi.shipstation.com";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (!(req.headers.get("authorization") ?? "").startsWith("Bearer ")) {
    return new Response("unauthorized", { status: 401, headers: CORS });
  }
  if (!KEY || !SECRET) {
    return new Response(JSON.stringify({ ok: false, error: "ShipStation creds not set" }),
      { status: 500, headers: { ...CORS, "content-type": "application/json" } });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const month: string = body?.month; // "YYYY-MM"
    if (!/^\d{4}-\d{2}$/.test(month ?? "")) {
      return new Response(JSON.stringify({ ok: false, error: "pass { month: 'YYYY-MM' }" }),
        { status: 400, headers: { ...CORS, "content-type": "application/json" } });
    }
    const [y, m] = month.split("-").map(Number);
    const start = `${month}-01`;
    const endD = new Date(Date.UTC(y, m, 1)); // first of next month
    const end = endD.toISOString().slice(0, 10);

    const auth = "Basic " + btoa(`${KEY}:${SECRET}`);
    // Aggregate (date \t sku) -> units across all pages of the month.
    const agg = new Map<string, number>();
    let ordersPulled = 0;
    let page = 1;
    let pages = 1;
    do {
      const url = new URL(`${BASE}/orders`);
      url.searchParams.set("orderDateStart", start);
      url.searchParams.set("orderDateEnd", end);
      url.searchParams.set("pageSize", "500");
      url.searchParams.set("page", String(page));
      const res = await fetch(url, { headers: { Authorization: auth } });
      if (res.status === 429) { await sleep(2000); continue; } // backoff, retry same page
      if (!res.ok) throw new Error(`/orders ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const json = await res.json();
      pages = json?.pages ?? 1;
      for (const o of json?.orders ?? []) {
        // Demand signal: count shipped + awaiting_shipment, drop cancelled/on_hold.
        const st = o?.orderStatus;
        if (st !== "shipped" && st !== "awaiting_shipment") continue;
        const date = String(o?.orderDate ?? "").slice(0, 10);
        if (!date) continue;
        ordersPulled++;
        for (const it of o?.items ?? []) {
          const sku = it?.sku ? String(it.sku).trim() : "";
          const qty = Number(it?.quantity ?? 0);
          if (!sku || qty <= 0) continue;
          const k = `${date}\t${sku}`;
          agg.set(k, (agg.get(k) ?? 0) + qty);
        }
      }
      page++;
      await sleep(200); // be gentle on the 40 req/min limit
    } while (page <= pages);

    const rows = [...agg.entries()].map(([k, units]) => {
      const [sale_date, sku_code] = k.split("\t");
      return { sale_date, sku_code, units };
    });

    const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
    // Idempotent: clear the month, then insert fresh.
    await sb.from("sales_backfill_raw").delete().gte("sale_date", start).lt("sale_date", end);
    for (let i = 0; i < rows.length; i += 1000) {
      const { error } = await sb.from("sales_backfill_raw").upsert(rows.slice(i, i + 1000), { onConflict: "sale_date,sku_code" });
      if (error) throw new Error(`insert: ${error.message}`);
    }

    return new Response(JSON.stringify({
      ok: true, month, orders_pulled: ordersPulled, pages,
      rows_inserted: rows.length,
      total_units: rows.reduce((s, r) => s + r.units, 0),
    }), { status: 200, headers: { ...CORS, "content-type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: { ...CORS, "content-type": "application/json" } });
  }
});
