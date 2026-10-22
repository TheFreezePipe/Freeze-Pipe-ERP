// =============================================================
// One of One markdown (Supabase Edge Function)
// =============================================================
// Every variant of the Shopify product "One of One Drops" is a unique,
// single-unit piece. This job walks the product daily and steps each
// UNSOLD variant's price down $10 for every full week it has sat since its
// clock started, stopping at a floor of 50% of its original price. When a
// piece first reaches the floor, it emails the owners (slow-moving alert).
// Fired daily by pg_cron (public.fire_one_of_one_markdown). The rule itself
// lives in ./pricing.ts (pure, unit-tested).
//
// State lives ON THE VARIANT, as metafields in namespace `one_of_one`
// (pinned on the variant page in Shopify admin so the owners can see and
// edit them without touching this code):
//   original_price     number_decimal  the price the clock started at;
//                                      written on first sighting = live price
//   clock_start        date_time       anniversary anchor; first sighting =
//                                      the later of the variant's createdAt
//                                      and OOO_CLOCK_NOT_BEFORE. Edit it in
//                                      admin to restart a piece's clock.
//   floor_notified_at  date_time       set once the floor email went out
//                                      (clear it to re-arm the alert)
//
// Invariants:
//   - Idempotent and time-based: price = f(original, weeks since clock_start).
//     Running twice a day changes nothing; a missed day catches up next run.
//   - Prices only ever go DOWN. A price someone lowered by hand below the
//     target is left alone (the clock keeps ticking; it catches up later).
//   - Sold variants (inventory 0) are untouched and never emailed.
//   - compare-at price is set to the original on first markdown (configurable)
//     so the storefront shows the strikethrough.
//   - Email-then-mark: floor_notified_at is written only after Resend accepts.
//     A failed mark means a repeat email next day (duplicate beats silence).
//
// Body params (all optional):
//   { }                   -> normal daily run (writes prices, sends alerts)
//   { "dry_run": true }   -> compute + return the plan; NO Shopify writes,
//                            no email, no log rows
//   { "test_to": "x@y.com" } -> like a normal run for prices, but the floor
//                            alert goes only to test_to and floor_notified_at
//                            is NOT written (so the real alert still fires)
//
// Secrets / config (Supabase edge secrets):
//   SHOPIFY_ADMIN_TOKEN   required  custom-app Admin API token
//                                   (scopes: read_products, write_products)
//   RESEND_API_KEY        required  for the floor alert
//   SHOPIFY_SHOP_DOMAIN   optional  default fet-innovations.myshopify.com
//   SHOPIFY_API_VERSION   optional  default 2026-07
//   OOO_PRODUCT_HANDLE    optional  default one-off-drops
//   OOO_NOTIFY_TO         optional  comma list; default adam@ + chase@freshetech.com
//   OOO_CLOCK_NOT_BEFORE  optional  ISO date; a variant's clock never starts
//                                   before this (set to go-live day to avoid
//                                   back-dated catch-up markdowns)
//   OOO_SET_COMPARE_AT    optional  "false" to leave compare-at alone
//   REPORT_FROM           optional  sender; shared with the daily report
// =============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { decide, floorPrice, round2, weeksToFloor, STEP_DOLLARS } from "./pricing.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const REPORT_FROM = Deno.env.get("REPORT_FROM") ?? "Freeze Pipe ERP <reports@freezepipeinventory.com>";

const SHOPIFY_ADMIN_TOKEN = Deno.env.get("SHOPIFY_ADMIN_TOKEN") ?? "";
const SHOP_DOMAIN = Deno.env.get("SHOPIFY_SHOP_DOMAIN") ?? "fet-innovations.myshopify.com";
const API_VERSION = Deno.env.get("SHOPIFY_API_VERSION") ?? "2026-07";
const PRODUCT_HANDLE = Deno.env.get("OOO_PRODUCT_HANDLE") ?? "one-off-drops";
const NOTIFY_TO = (Deno.env.get("OOO_NOTIFY_TO") ?? "adam@freshetech.com,chase@freshetech.com")
  .split(",").map((s) => s.trim()).filter(Boolean);
const CLOCK_NOT_BEFORE = Deno.env.get("OOO_CLOCK_NOT_BEFORE") ?? "";
const SET_COMPARE_AT = (Deno.env.get("OOO_SET_COMPARE_AT") ?? "true").toLowerCase() !== "false";

const NS = "one_of_one";
const STORE_SLUG = SHOP_DOMAIN.replace(/\.myshopify\.com$/, "");

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

// ---- Shopify Admin GraphQL ----
async function shopify<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const resp = await fetch(`https://${SHOP_DOMAIN}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`Shopify HTTP ${resp.status}: ${JSON.stringify(body).slice(0, 300)}`);
  if (body.errors?.length) throw new Error(`Shopify GraphQL: ${JSON.stringify(body.errors).slice(0, 300)}`);
  return body.data as T;
}

interface RawVariant {
  id: string; title: string; sku: string | null; price: string; compareAtPrice: string | null;
  inventoryQuantity: number; createdAt: string;
  selectedOptions: { name: string; value: string }[];
  metafields: { edges: { node: { key: string; value: string } }[] };
}
interface ProductData {
  products: { edges: { node: { id: string; title: string; handle: string; variants: { edges: { node: RawVariant }[] } } }[] };
}

const PRODUCT_QUERY = `
query($q: String!) {
  products(first: 1, query: $q) {
    edges { node { id title handle
      variants(first: 100) { edges { node {
        id title sku price compareAtPrice inventoryQuantity createdAt
        selectedOptions { name value }
        metafields(first: 10, namespace: "${NS}") { edges { node { key value } } }
      } } }
    } }
  }
}`;

const BULK_UPDATE = `
mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) {
    productVariants { id price compareAtPrice }
    userErrors { field message }
  }
}`;

const METAFIELDS_SET = `
mutation($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) {
    metafields { id }
    userErrors { field message code }
  }
}`;

const DEFINITION_CREATE = `
mutation($definition: MetafieldDefinitionInput!) {
  metafieldDefinitionCreate(definition: $definition) {
    createdDefinition { id }
    userErrors { field message code }
  }
}`;

// Definitions make the metafields show up (pinned) on the variant page in
// admin. Creating one that already exists returns a TAKEN user error, which
// is the normal steady state — ignored.
async function ensureDefinitions(): Promise<void> {
  const defs = [
    { key: "original_price", name: "One of One · Original price", type: "number_decimal",
      description: "Price the markdown clock started at. The floor is half of this." },
    { key: "clock_start", name: "One of One · Clock start", type: "date_time",
      description: "Markdowns of $10 apply per full week since this moment. Edit to restart the clock." },
    { key: "floor_notified_at", name: "One of One · Floor alert sent", type: "date_time",
      description: "When the 50%-floor email went out. Clear to re-arm the alert." },
  ];
  for (const d of defs) {
    const r = await shopify<{ metafieldDefinitionCreate: { userErrors: { code: string; message: string }[] } }>(
      DEFINITION_CREATE,
      { definition: { namespace: NS, ownerType: "PRODUCTVARIANT", pin: true, ...d } },
    );
    const errs = r.metafieldDefinitionCreate.userErrors.filter((e) => e.code !== "TAKEN");
    if (errs.length) throw new Error(`metafieldDefinitionCreate ${d.key}: ${errs.map((e) => e.message).join("; ")}`);
  }
}

// ---- plan ----
interface Plan {
  variantId: string; sku: string; piece: string; theme: string;
  inventory: number; current: number; original: number; clockStart: string;
  weeks: number; target: number; floor: number; weeksToFloor: number;
  newPrice: number | null; atFloor: boolean; notify: boolean;
  compareAt: number | null; setCompareAt: number | null;
  writeOriginal: boolean; writeClockStart: boolean;
  action: "markdown" | "hold" | "sold";
}

function buildPlan(v: RawVariant, now: Date): Plan {
  const mf = Object.fromEntries(v.metafields.edges.map((e) => [e.node.key, e.node.value]));
  const current = Number(v.price);
  const hasOriginal = mf.original_price != null && Number.isFinite(Number(mf.original_price));
  const original = hasOriginal ? round2(Number(mf.original_price)) : current;
  let clockStart = mf.clock_start ? new Date(mf.clock_start) : new Date(v.createdAt);
  if (!mf.clock_start && CLOCK_NOT_BEFORE) {
    const nb = new Date(CLOCK_NOT_BEFORE);
    if (!Number.isNaN(nb.getTime()) && nb > clockStart) clockStart = nb;
  }
  const opt = (name: string) => v.selectedOptions.find((o) => o.name === name)?.value ?? "";
  const piece = opt("Piece") || v.title;
  const theme = opt("Theme");
  const compareAt = v.compareAtPrice == null ? null : Number(v.compareAtPrice);

  const base: Omit<Plan, "weeks" | "target" | "newPrice" | "atFloor" | "notify" | "setCompareAt" | "action"> = {
    variantId: v.id, sku: v.sku ?? "", piece, theme, inventory: v.inventoryQuantity,
    current, original, clockStart: clockStart.toISOString(), floor: floorPrice(original),
    weeksToFloor: weeksToFloor(original), compareAt,
    writeOriginal: !hasOriginal, writeClockStart: !mf.clock_start,
  };
  if (v.inventoryQuantity <= 0) {
    return { ...base, weeks: 0, target: current, newPrice: null, atFloor: false, notify: false, setCompareAt: null, action: "sold" };
  }
  const d = decide(original, current, clockStart, now);
  const notify = d.atFloor && !mf.floor_notified_at;
  // Show the strikethrough once a markdown has happened (or already applies).
  const marked = (d.newPrice ?? current) < original;
  const setCompareAt = SET_COMPARE_AT && marked && compareAt !== original ? original : null;
  return {
    ...base, weeks: d.weeks, target: d.target, newPrice: d.newPrice, atFloor: d.atFloor, notify, setCompareAt,
    action: d.newPrice != null ? "markdown" : "hold",
  };
}

// ---- email ----
const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const money = (n: number) => `$${n.toFixed(2)}`;
const FONT = "'Lato',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
const MONO = "'JetBrains Mono',ui-monospace,'SF Mono',Menlo,Consolas,monospace";
const SERIF = "'Minion Pro','Minion Pro Bold','Adobe Garamond Pro',Georgia,'Times New Roman',serif";
const INK = "#0C0C0C", CARD = "#161616", BORD = "#2A2A2A", DIV = "#232323";
const WHITE = "#FFFFFF", SEC = "#C9C9C9", TER = "#8C8C8C";
const BLUE = "#28A4F8", AMBER = "#F4B740";
const EYEBROW = `font-family:${FONT};font-size:12px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:${BLUE};`;
const TH = `font-family:${FONT};font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${TER};padding:8px 10px;border-bottom:1px solid ${BORD};`;
const TD = `font-family:${FONT};font-size:13px;color:${SEC};padding:8px 10px;border-bottom:1px solid ${DIV};vertical-align:top;`;

function variantUrl(productId: string, variantId: string): string {
  const pid = productId.split("/").pop(), vid = variantId.split("/").pop();
  return `https://admin.shopify.com/store/${STORE_SLUG}/products/${pid}/variants/${vid}`;
}

function pieceCell(p: Plan, productId: string): string {
  return `<a href="${variantUrl(productId, p.variantId)}" style="font-family:${FONT};font-size:13px;font-weight:700;color:${WHITE};text-decoration:none;">${esc(p.piece)}</a>` +
    `<div style="font-family:${MONO};font-size:11px;color:${TER};margin-top:2px;">${esc(p.sku)}${p.theme ? ` &middot; ${esc(p.theme)}` : ""}</div>`;
}

function renderHtml(floored: Plan[], others: Plan[], productId: string, now: Date): string {
  const when = now.toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "long", month: "long", day: "numeric" });
  const rowsFloor = floored.map((p) => `
    <tr>
      <td style="${TD}">${pieceCell(p, productId)}</td>
      <td style="${TD}text-align:right;font-family:${MONO};color:${TER};text-decoration:line-through;">${money(p.original)}</td>
      <td style="${TD}text-align:right;font-family:${MONO};color:${AMBER};font-weight:700;">${money(p.newPrice ?? p.current)}</td>
      <td style="${TD}text-align:right;font-family:${MONO};color:${WHITE};">${p.weeks}</td>
    </tr>`).join("");
  const rowsOther = others.map((p) => `
    <tr>
      <td style="${TD}">${pieceCell(p, productId)}</td>
      <td style="${TD}text-align:right;font-family:${MONO};color:${WHITE};">${money(p.newPrice ?? p.current)}</td>
      <td style="${TD}text-align:right;font-family:${MONO};color:${TER};">${money(p.floor)}</td>
      <td style="${TD}text-align:right;font-family:${MONO};color:${WHITE};">${p.weeks}</td>
    </tr>`).join("");
  const n = floored.length;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link href="https://fonts.googleapis.com/css2?family=Lato:wght@400;700;900&display=swap" rel="stylesheet"></head>
<body style="margin:0;padding:0;background:${INK};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${INK};">
  <tr><td align="center" style="padding:24px 12px;">
    <table role="presentation" width="640" cellpadding="0" cellspacing="0" style="width:640px;max-width:640px;background:${CARD};border:1px solid ${BORD};border-radius:10px;">
      <tr><td style="padding:26px 28px 30px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-bottom:1px solid ${BORD};">
          <tr><td style="padding-bottom:16px;">
            <div style="${EYEBROW}">One of One &middot; Slow mover alert</div>
            <div style="font-family:${SERIF};font-size:24px;font-weight:700;color:${WHITE};line-height:1.3;margin-top:8px;">${n === 1 ? "1 piece" : `${n} pieces`} hit the 50% floor</div>
            <div style="font-family:${FONT};font-size:13px;color:${TER};margin-top:6px;">${esc(when)}</div>
          </td></tr>
        </table>
        <p style="font-family:${FONT};font-size:14px;color:${SEC};line-height:1.6;margin:20px 0 0;">
          These pieces have been marked down $${STEP_DOLLARS} a week since listing and are now at half their original price. The automation stops here; what happens next is up to you.
        </p>
        <div style="${EYEBROW}margin:26px 0 10px;">At the floor</div>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr><th align="left" style="${TH}">Piece</th><th align="right" style="${TH}">Original</th><th align="right" style="${TH}">Now</th><th align="right" style="${TH}">Weeks</th></tr>
          ${rowsFloor}
        </table>
        ${others.length ? `
        <div style="${EYEBROW}margin:30px 0 10px;">Still marking down</div>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr><th align="left" style="${TH}">Piece</th><th align="right" style="${TH}">Now</th><th align="right" style="${TH}">Floor</th><th align="right" style="${TH}">Weeks</th></tr>
          ${rowsOther}
        </table>` : ""}
        <div style="border-top:1px solid ${BORD};margin-top:28px;padding-top:14px;font-family:${FONT};font-size:12px;color:${TER};">
          Automated by the Freeze Pipe ERP. Each piece's clock and original price are metafields on its variant in Shopify; edit them there to restart a piece.
        </div>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

async function sendEmail(to: string[], subject: string, html: string, idempotencyKey: string): Promise<string | null> {
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({ from: REPORT_FROM, to, subject, html }),
    signal: AbortSignal.timeout(30_000),
  });
  const result = await resp.json().catch(() => ({} as { id?: string; name?: string }));
  // Same key, different payload = this alert already went out. Not an error.
  if (resp.status === 409 && (result as { name?: string }).name === "invalid_idempotent_request") return null;
  if (!resp.ok) throw new Error(`Resend HTTP ${resp.status}: ${JSON.stringify(result).slice(0, 300)}`);
  return (result as { id?: string }).id ?? null;
}

// ---- main ----
Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  if (jwtRole(req.headers.get("Authorization")) !== "service_role") {
    return json({ error: "forbidden - service role required" }, 403);
  }
  let opts: { dry_run?: boolean; test_to?: string | string[] } = {};
  try { opts = await req.json(); } catch { /* empty body ok */ }
  const dryRun = opts.dry_run === true;
  const testTo = opts.test_to ? (Array.isArray(opts.test_to) ? opts.test_to : [opts.test_to]) : null;
  if (!SHOPIFY_ADMIN_TOKEN) return json({ ok: false, error: "SHOPIFY_ADMIN_TOKEN is not set" }, 500);

  const now = new Date();
  const runId = crypto.randomUUID();

  // 1. Read the product.
  let data: ProductData;
  try {
    data = await shopify<ProductData>(PRODUCT_QUERY, { q: `handle:${PRODUCT_HANDLE}` });
  } catch (e) {
    return json({ ok: false, stage: "read", error: String(e) }, 500);
  }
  const product = data.products.edges[0]?.node;
  if (!product || product.handle !== PRODUCT_HANDLE) {
    return json({ ok: false, stage: "read", error: `product with handle "${PRODUCT_HANDLE}" not found` }, 500);
  }

  // 2. Decide.
  const plans = product.variants.edges.map((e) => buildPlan(e.node, now));
  const unsold = plans.filter((p) => p.action !== "sold");
  const markdowns = unsold.filter((p) => p.newPrice != null);
  const toNotify = unsold.filter((p) => p.notify);
  const summary = {
    product: { id: product.id, title: product.title },
    counts: { variants: plans.length, unsold: unsold.length, markdowns: markdowns.length, at_floor: unsold.filter((p) => p.atFloor).length, new_floor_alerts: toNotify.length },
  };

  if (dryRun) {
    return json({ ok: true, dry_run: true, run_id: runId, as_of: now.toISOString(), config: { clock_not_before: CLOCK_NOT_BEFORE || null, set_compare_at: SET_COMPARE_AT, notify_to: NOTIFY_TO }, ...summary, plans });
  }

  // 3. Write prices + state to Shopify. One mutation covers every unsold
  //    variant that needs anything written (price, compare-at, or a
  //    first-sighting metafield). Sold variants are never touched.
  const writes = unsold.filter((p) => p.newPrice != null || p.setCompareAt != null || p.writeOriginal || p.writeClockStart);
  const errors: string[] = [];
  if (writes.length) {
    try {
      await ensureDefinitions();
      const variants = writes.map((p) => ({
        id: p.variantId,
        ...(p.newPrice != null ? { price: p.newPrice.toFixed(2) } : {}),
        ...(p.setCompareAt != null ? { compareAtPrice: p.setCompareAt.toFixed(2) } : {}),
        metafields: [
          ...(p.writeOriginal ? [{ namespace: NS, key: "original_price", type: "number_decimal", value: p.original.toFixed(2) }] : []),
          ...(p.writeClockStart ? [{ namespace: NS, key: "clock_start", type: "date_time", value: p.clockStart }] : []),
        ],
      }));
      const r = await shopify<{ productVariantsBulkUpdate: { userErrors: { field: string[]; message: string }[] } }>(
        BULK_UPDATE, { productId: product.id, variants },
      );
      if (r.productVariantsBulkUpdate.userErrors.length) {
        throw new Error(`productVariantsBulkUpdate: ${JSON.stringify(r.productVariantsBulkUpdate.userErrors).slice(0, 400)}`);
      }
    } catch (e) {
      // Nothing is logged as applied if the write failed; the next run
      // recomputes from Shopify and tries again.
      return json({ ok: false, stage: "write", error: String(e), ...summary }, 500);
    }
  }

  // 4. Floor alert (email first, then mark — a duplicate beats silence).
  let resendId: string | null = null;
  let notified: string[] = [];
  if (toNotify.length) {
    const others = unsold.filter((p) => !p.notify).sort((a, b) => b.weeks - a.weeks);
    const html = renderHtml(toNotify, others, product.id, now);
    const subject = toNotify.length === 1
      ? `One of One at 50% floor: ${toNotify[0].piece}`
      : `${toNotify.length} One of One pieces at the 50% floor`;
    const to = testTo ?? NOTIFY_TO;
    const ids = toNotify.map((p) => p.variantId.split("/").pop()).sort().join("+");
    const key = testTo ? `ooo-floor-test/${ids}/${Date.now()}` : `ooo-floor/${ids}`;
    if (!RESEND_API_KEY) {
      errors.push("RESEND_API_KEY is not set — floor alert not sent");
    } else {
      try {
        resendId = await sendEmail(to, subject, html, key);
        notified = to;
        if (!testTo) {
          const r = await shopify<{ metafieldsSet: { userErrors: { message: string }[] } }>(METAFIELDS_SET, {
            metafields: toNotify.map((p) => ({ ownerId: p.variantId, namespace: NS, key: "floor_notified_at", type: "date_time", value: now.toISOString() })),
          });
          if (r.metafieldsSet.userErrors.length) errors.push(`floor_notified_at: ${JSON.stringify(r.metafieldsSet.userErrors).slice(0, 300)}`);
        }
      } catch (e) {
        errors.push(`floor alert: ${String(e).slice(0, 300)}`);
      }
    }
  }

  // 5. Log what was applied (audit trail in the ERP).
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const rows = unsold.map((p) => ({
    run_id: runId, run_at: now.toISOString(),
    variant_id: p.variantId, sku: p.sku, piece: p.piece, theme: p.theme,
    weeks: p.weeks, original_price: p.original, old_price: p.current, new_price: p.newPrice ?? p.current,
    floor_price: p.floor, at_floor: p.atFloor, action: p.action,
    floor_alert_sent: p.notify && notified.length > 0 && !testTo,
  }));
  const { error: logErr } = await admin.from("one_of_one_markdown_log").insert(rows);
  if (logErr) errors.push(`log insert: ${logErr.message}`);

  return json({
    ok: errors.length === 0, run_id: runId, as_of: now.toISOString(), ...summary,
    applied: markdowns.map((p) => ({ sku: p.sku, piece: p.piece, weeks: p.weeks, from: p.current, to: p.newPrice })),
    floor_alert: toNotify.length ? { sent_to: notified, resend_id: resendId, pieces: toNotify.map((p) => p.piece) } : null,
    errors,
  });
});
