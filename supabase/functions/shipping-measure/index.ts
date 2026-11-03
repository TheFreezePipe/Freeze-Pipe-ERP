// =============================================================
// Shipping measure (Supabase Edge Function) — weekly
// =============================================================
// Outbound shipping cost per SKU "as sold", from real data only:
//
//   1. Item weights and box tares are solved by least squares from the
//      team's scale-measured order totals (shipstation_shipments.weight_oz):
//        order_oz = tare[box] + Σ qty × item_oz[sku]
//      over the last 180 days of free-tier orders, two passes (orders more
//      than 1 lb off after the first pass are dropped as mis-weighs or
//      wrong-box entries and reported as exceptions).
//   2. Each order's real label cost is split across its lines by the solved
//      item weights; per SKU, as_sold_cost = Σ allocated $ / Σ units over
//      the last 90 days (180 for SKUs with too few orders in 90).
//   3. Results go through rpc_shipping_measure_apply, which shifts the
//      prior values, adds drift flags and records the run.
//
// Body params (all optional):
//   { "days_cost": 90, "days_weight": 180, "min_orders": 15, "dry_run": false }
//
// Service-role callers only (pg_cron / ops).
// =============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

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

interface Line { order_id: number; order_number: string; ship_date: string; weight_oz: number; box: string; cost: number; sku_id: string; sku: string; cat: string | null; qty: number; }
interface Order { id: number; number: string; date: string; w: number; box: string; cost: number; lines: Map<string, number>; bi: number; }

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const r2 = (x: number) => Math.round(x * 100) / 100;

/** Solve A x = b (dense, n ≤ ~300) by Gaussian elimination with partial pivoting. */
function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const pv = M[c][c] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c || M[r][c] === 0) continue;
      const f = M[r][c] / pv;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / (row[i] || 1e-12));
}

/** Least squares: one tare per box column, one weight per SKU; light ridge for identifiability. */
function fitWeights(orders: Order[], nBox: number, idx: Map<string, number>): number[] {
  const n = nBox + idx.size;
  const A = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const b = new Array<number>(n).fill(0);
  for (const o of orders) {
    const cols: [number, number][] = [[o.bi, 1]];
    for (const [s, q] of o.lines) cols.push([idx.get(s)!, q]);
    for (const [i, xi] of cols) {
      b[i] += xi * o.w;
      for (const [j, xj] of cols) A[i][j] += xi * xj;
    }
  }
  for (let i = 0; i < n; i++) A[i][i] += 1e-3;
  return solve(A, b);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  if (jwtRole(req.headers.get("Authorization")) !== "service_role") {
    return json({ error: "forbidden - service role required" }, 403);
  }
  let opts: { days_cost?: number; days_weight?: number; min_orders?: number; dry_run?: boolean } = {};
  try { opts = await req.json(); } catch { /* empty body ok */ }
  const DAYS_COST = Math.max(30, Math.min(opts.days_cost ?? 90, 365));
  const DAYS_WEIGHT = Math.max(DAYS_COST, Math.min(opts.days_weight ?? 180, 365));
  const MIN_ORDERS = Math.max(3, opts.min_orders ?? 15);
  const LOW_ORDERS = 5;
  const RESID_LIMIT = 16; // oz
  const startedAt = new Date().toISOString();

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const today = new Date();
  const to = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 1));
  const fromW = new Date(to.getTime() - DAYS_WEIGHT * 86_400_000);
  const fromC = new Date(to.getTime() - DAYS_COST * 86_400_000);
  const iso = (d: Date) => d.toISOString().slice(0, 10);

  // Pull the input in 30-day chunks: each RPC call stays well inside the
  // PostgREST statement timeout (the whole window in one call does not).
  const lines: Line[] = [];
  for (let a = new Date(fromW); a < to; a = new Date(a.getTime() + 30 * 86_400_000)) {
    const b = new Date(Math.min(a.getTime() + 30 * 86_400_000, to.getTime()));
    const { data, error } = await admin.rpc("rpc_shipping_measure_input", { p_from: iso(a), p_to: iso(b) });
    if (error) return json({ ok: false, stage: "input", range: [iso(a), iso(b)], error: error.message }, 500);
    lines.push(...((data ?? []) as Line[]));
  }

  // ---- orders ----
  const orders = new Map<number, Order>();
  const catOf = new Map<string, string>();
  const skuIdOf = new Map<string, string>();
  for (const l of lines) {
    let o = orders.get(l.order_id);
    if (!o) {
      o = { id: l.order_id, number: l.order_number, date: l.ship_date, w: Number(l.weight_oz), box: l.box ?? "?", cost: Number(l.cost), lines: new Map(), bi: 0 };
      orders.set(l.order_id, o);
    }
    o.lines.set(l.sku, (o.lines.get(l.sku) ?? 0) + Number(l.qty));
    catOf.set(l.sku, l.cat ?? "");
    skuIdOf.set(l.sku, l.sku_id);
  }
  const all = [...orders.values()];
  if (all.length < 200) return json({ ok: false, error: `only ${all.length} usable orders in window` }, 500);

  // ---- weight solve on the long window ----
  const appear = new Map<string, number>();
  for (const o of all) for (const s of o.lines.keys()) appear.set(s, (appear.get(s) ?? 0) + 1);
  const fitSkus = [...appear].filter(([, n]) => n >= MIN_ORDERS).map(([s]) => s).sort();
  const boxN = new Map<string, number>();
  for (const o of all) boxN.set(o.box, (boxN.get(o.box) ?? 0) + 1);
  const boxes = [...boxN].filter(([, n]) => n >= 30).map(([b]) => b).sort();
  const bidx = new Map(boxes.map((b, i) => [b, i]));
  const NB = boxes.length + 1; // last column = other/unknown box
  const idx = new Map(fitSkus.map((s, i) => [s, NB + i]));
  const usable = all.filter((o) => [...o.lines.keys()].every((s) => idx.has(s)));
  for (const o of usable) o.bi = bidx.get(o.box) ?? NB - 1;

  const resid = (o: Order, x: number[]) => o.w - (x[o.bi] + [...o.lines].reduce((t, [s, q]) => t + q * x[idx.get(s)!], 0));
  let x = fitWeights(usable, NB, idx);
  const kept = usable.filter((o) => Math.abs(resid(o, x)) <= RESID_LIMIT);
  x = fitWeights(kept, NB, idx);
  const res = kept.map((o) => resid(o, x));
  const ssRes = res.reduce((t, e) => t + e * e, 0);
  const mean = kept.reduce((t, o) => t + o.w, 0) / kept.length;
  const ssTot = kept.reduce((t, o) => t + (o.w - mean) ** 2, 0);
  const R2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;
  const medResid = median(res.map(Math.abs)) ?? 0;

  // Exceptions: recent orders more than 1 lb off the fit.
  const exceptions = usable
    .map((o) => ({ o, e: resid(o, x) }))
    .filter(({ e }) => Math.abs(e) > RESID_LIMIT)
    .sort((a, b) => Math.abs(b.e) - Math.abs(a.e))
    .slice(0, 50)
    .map(({ o, e }) => ({
      order_number: o.number, ship_date: o.date, box: o.box, measured_oz: r2(o.w), fitted_oz: r2(o.w - e),
      skus: [...o.lines].map(([s, q]) => (q > 1 ? `${q}× ${s}` : s)).join(", "),
    }));

  // Joint SKUs: a SKU that never ships alone and appears in every one of its
  // orders beside the same other SKU has no separable weight of its own.
  const co = new Map<string, Map<string, number>>();
  const soloN = new Map<string, number>();
  for (const o of all) {
    const ks = [...o.lines.keys()].filter((s) => idx.has(s));
    if (ks.length === 1) soloN.set(ks[0], (soloN.get(ks[0]) ?? 0) + 1);
    for (const a of ks) for (const b of ks) if (a !== b) {
      const m = co.get(a) ?? new Map<string, number>();
      m.set(b, (m.get(b) ?? 0) + 1); co.set(a, m);
    }
  }
  const jointWith = new Map<string, string>();
  for (const [a, m] of co) for (const [b, n] of m) {
    if (n >= 10 && n === appear.get(a) && (soloN.get(a) ?? 0) === 0) jointWith.set(a, b);
  }

  // Item weight per SKU: solved, else category median of solved; floor 0.3 oz.
  const itemOz = new Map<string, number>();
  for (const s of fitSkus) itemOz.set(s, Math.max(x[idx.get(s)!], 0.3));
  const catMed = new Map<string, number>();
  for (const cat of new Set(catOf.values())) {
    const ws = fitSkus.filter((s) => catOf.get(s) === cat).map((s) => itemOz.get(s)!);
    const m = median(ws); if (m != null) catMed.set(cat, m);
  }
  const ozFor = (s: string) => itemOz.get(s) ?? catMed.get(catOf.get(s) ?? "") ?? 8;

  // ---- allocation ----
  type Acc = { units: number; alloc: number; orders: number; solo: number[] };
  const allocate = (subset: Order[]) => {
    const acc = new Map<string, Acc>();
    for (const o of subset) {
      let tot = 0;
      for (const [s, q] of o.lines) tot += q * ozFor(s);
      const units = [...o.lines.values()].reduce((t, q) => t + q, 0);
      const share = new Map<string, number>();
      for (const [s, q] of o.lines) share.set(s, tot > 0 ? (o.cost * q * ozFor(s)) / tot : (o.cost * q) / units);
      // A joint SKU's weight is not separable from its partner's, so the
      // pair's share is pooled and re-split per unit between them.
      for (const [s] of o.lines) {
        const b = jointWith.get(s);
        if (!b || !o.lines.has(b)) continue;
        const pooled = share.get(s)! + share.get(b)!;
        const n = o.lines.get(s)! + o.lines.get(b)!;
        share.set(s, (pooled * o.lines.get(s)!) / n);
        share.set(b, (pooled * o.lines.get(b)!) / n);
      }
      for (const [s, q] of o.lines) {
        const a = acc.get(s) ?? { units: 0, alloc: 0, orders: 0, solo: [] };
        a.units += q; a.orders += 1;
        a.alloc += share.get(s)!;
        if (o.lines.size === 1 && q === 1) a.solo.push(o.cost);
        acc.set(s, a);
      }
    }
    return acc;
  };
  const recent = all.filter((o) => o.date >= iso(fromC));
  const acc90 = allocate(recent);
  const acc180 = allocate(all);

  const skus: Record<string, unknown>[] = [];
  for (const [s, a180] of acc180) {
    const a90 = acc90.get(s);
    const use90 = (a90?.orders ?? 0) >= MIN_ORDERS;
    const a = use90 ? a90! : a180;
    const windowDays = use90 ? DAYS_COST : DAYS_WEIGHT;
    const joint = jointWith.get(s) ?? null;
    const flags: string[] = [];
    let confidence: "high" | "low" | "none" = a.orders >= MIN_ORDERS ? "high" : a.orders >= LOW_ORDERS ? "low" : "none";
    if (joint) flags.push("joint"); // pooled with its partner; still usable
    if (confidence !== "high") flags.push("low_confidence");
    if (!idx.has(s)) flags.push("no_fit");
    skus.push({
      sku_id: skuIdOf.get(s), sku: s, window_days: windowDays, orders: a.orders, solo_orders: a.solo.length,
      item_oz: idx.has(s) ? r2(itemOz.get(s)!) : null,
      as_sold_cost: a.units > 0 ? r2(a.alloc / a.units) : null,
      solo_median_cost: a.solo.length ? r2(median(a.solo)!) : null,
      confidence, flags, joint_with: joint,
    });
  }
  const tares = boxes.map((b) => ({ box: b, tare_oz: r2(x[bidx.get(b)!]), orders: boxN.get(b) }));

  const result = {
    run: {
      started_at: startedAt, window_from: iso(fromW), window_to: iso(to), days_cost: DAYS_COST, days_weight: DAYS_WEIGHT,
      orders_used: usable.length, orders_kept: kept.length, orders_total: all.length, r2: Math.round(R2 * 10000) / 10000,
      median_resid_oz: r2(medResid), boxes: boxes.length, skus_fit: fitSkus.length,
      flagged: skus.filter((k) => (k.flags as string[]).length > 0).length, exceptions: exceptions.length,
    },
    tares, skus, exceptions,
  };
  if (opts.dry_run) return json({ ok: true, dry_run: true, ...result });

  const { data: applied, error: applyErr } = await admin.rpc("rpc_shipping_measure_apply", { p_result: result });
  if (applyErr) return json({ ok: false, stage: "apply", error: applyErr.message, run: result.run }, 500);
  return json({ ok: true, applied, run: result.run });
});
