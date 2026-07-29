// reporting-api — read-only JSON API for external dashboards (the CEO's
// custom app). Design (owner-approved 2026-07-28):
//   * Auth: `x-api-key` header, SHA-256-hashed and matched against the
//     active row in api_keys (rotated/revoked from the admin Settings
//     page — plaintext keys are never stored).
//   * Data: every section proxies rpc_reporting(), which reuses the exact
//     SQL the ERP itself displays (remaining-based transit, allocation-
//     aware on-order, override-aware demand) — the external dashboard can
//     never disagree with the app.
//   * Scope: operational counts + aggregate valuations only. NO per-SKU
//     costs, margins, or supplier pricing — the key may live in a
//     client-side dashboard.
//   * Root (/) needs no key: it returns the self-describing catalog so an
//     AI coding agent can be handed one URL + one key and build from it.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "x-api-key, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};
const JSON_HEADERS = {
  ...CORS,
  "content-type": "application/json",
  // Dashboards poll; five minutes of caching is plenty fresh for KPIs.
  "cache-control": "public, max-age=300",
};

const ENDPOINTS = [
  {
    path: "/kpis",
    description: "Headline numbers: yesterday's units sold, warehouse/in-transit/on-order-free unit totals, latest retail-value snapshot, low-stock count.",
    params: {},
  },
  {
    path: "/sales-daily",
    description: "Per-day, per-SKU units sold. One row per (date, sku) with product_name and category.",
    params: { days: "lookback window, default 90, max 365" },
  },
  {
    path: "/stock-levels",
    description: "Per active SKU: warehouse_units, in_transit_units, on_order_free_units, on_order_allocated_units (reserved for linked production), monthly_demand, dos_days (days of stock).",
    params: {},
  },
  {
    path: "/incoming-shipments",
    description: "Open freight shipments with units_total / units_received / units_remaining, carton progress, carrier, ETA.",
    params: {},
  },
  {
    path: "/low-stock",
    description: "SKUs at or below the days-of-stock threshold, with in-transit relief and next ETA. Same list as the 8am admin email.",
    params: { threshold: "days of stock, default 7" },
  },
] as const;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "GET") return json({ error: "GET only" }, 405);

  const url = new URL(req.url);
  // Path after the function name: "/reporting-api/kpis" -> "/kpis"
  const path = url.pathname.replace(/^\/reporting-api/, "") || "/";

  if (path === "/" || path === "") {
    return json({
      name: "Freeze Pipe ERP — reporting API",
      version: 1,
      auth: "Send the API key in an `x-api-key` header. Keys are issued on the ERP's Settings page (admin only).",
      data_freshness: "Live queries with 5-minute HTTP caching. All math matches the ERP's own displays.",
      endpoints: ENDPOINTS,
    });
  }

  // ---- key check ------------------------------------------------------------
  const key = req.headers.get("x-api-key")?.trim();
  if (!key) return json({ error: "missing x-api-key header" }, 401);
  const hash = await sha256Hex(key);
  const { data: keyRow, error: keyErr } = await supabase
    .from("api_keys")
    .select("id")
    .eq("key_hash", hash)
    .is("revoked_at", null)
    .maybeSingle();
  if (keyErr) return json({ error: "auth lookup failed" }, 500);
  if (!keyRow) return json({ error: "invalid or revoked API key" }, 401);
  // Fire-and-forget usage stamp — never blocks the response.
  void supabase.from("api_keys").update({ last_used_at: new Date().toISOString() }).eq("id", keyRow.id);

  // ---- sections ---------------------------------------------------------------
  const num = (name: string, fallback: number) => {
    const raw = url.searchParams.get(name);
    const n = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(n) ? n : fallback;
  };

  let section: string;
  let days: number;
  switch (path) {
    case "/kpis":               section = "kpis";         days = 7; break;
    case "/sales-daily":        section = "sales_daily";  days = num("days", 90); break;
    case "/stock-levels":       section = "stock_levels"; days = 90; break;
    case "/incoming-shipments": section = "incoming";     days = 90; break;
    case "/low-stock":          section = "low_stock";    days = num("threshold", 7); break;
    default:
      return json({ error: `unknown endpoint ${path}`, endpoints: ENDPOINTS.map((e) => e.path) }, 404);
  }

  const { data, error } = await supabase.rpc("rpc_reporting", { p_section: section, p_days: days });
  if (error) return json({ error: "query failed", detail: error.message }, 500);
  return json(data);
});
