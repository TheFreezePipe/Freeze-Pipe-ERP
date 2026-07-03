// =============================================================
// Daily report email (Supabase Edge Function)
// =============================================================
// Pulls the morning report payload from rpc_daily_report() and emails it to
// all active admins via Resend. Fired by pg_cron (public.fire_daily_report)
// at 8am ET; can also be invoked manually for testing.
//
// Body params (all optional):
//   { "dry_run": true }        -> render + return the HTML, DON'T send
//   { "test_to": "x@y.com" }   -> send only to this address (string or array)
//
// Styled to the Freeze Pipe brand: dark (Ink #0C0C0C / graphite), Freeze
// Blue #28A4F8 as the single accent, Lato type with uppercase tracked
// eyebrows, mono for SKU/price data, sharp corners, no emoji.
//
// Secrets used: RESEND_API_KEY (required), REPORT_FROM (optional), SITE_URL.
// =============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const REPORT_FROM = Deno.env.get("REPORT_FROM") ?? "Freeze Pipe ERP <reports@freezepipeinventory.com>";
const SITE_URL = Deno.env.get("SITE_URL") ?? "https://freezepipeinventory.com";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// ---- formatting helpers ----
const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const num = (n: unknown) => (Number(n) || 0).toLocaleString("en-US");
function fmtDate(d: string | null, opts: Intl.DateTimeFormatOptions): string {
  if (!d) return "—";
  return new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: "America/New_York", ...opts });
}

// ---- brand tokens (from Freeze Pipe design system) ----
const FONT = "'Lato',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
const MONO = "'JetBrains Mono',ui-monospace,'SF Mono',Menlo,Consolas,monospace";
const SERIF = "'Minion Pro','Minion Pro Bold','Adobe Garamond Pro',Georgia,'Times New Roman',serif";
const INK = "#0C0C0C", CARD = "#161616", SURF = "#1E1E1E", BORD = "#2A2A2A", DIV = "#232323";
const WHITE = "#FFFFFF", SEC = "#C9C9C9", TER = "#8C8C8C";
const BLUE = "#28A4F8", GREEN = "#36C88D", AMBER = "#F4B740", RED = "#F05252";

const EYEBROW = `font-family:${FONT};font-size:12px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:${BLUE};`;
const TH = `font-family:${FONT};font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${TER};padding:8px 10px;border-bottom:1px solid ${BORD};`;
const TD = `font-family:${FONT};font-size:13px;color:${SEC};padding:8px 10px;border-bottom:1px solid ${DIV};`;
const skuCell = (sku: string, name?: string) =>
  `<span style="font-family:${MONO};font-size:13px;font-weight:500;color:${WHITE};">${esc(sku)}</span>` +
  (name ? `<div style="font-family:${FONT};font-size:11px;color:${TER};margin-top:1px;">${esc(name)}</div>` : "");

interface SalesRow { sku: string; product_name: string; units: number; avg_daily: number; flag: string | null; }
interface IncomingRow { shipment_number: string; carrier_name: string | null; freight_type: string; eta: string | null; days_out: number | null; items: { sku: string; name: string | null; qty: number }[]; }
interface LowRow { sku: string; product_name: string; wh_units: number; monthly_demand: number; dos_days: number; in_transit: number; next_eta: string | null; }
interface MktSale { name: string; starts_at: string; ends_at: string; approval: string; sku_count: number; }
interface MktLaunch { name: string; kind: string; launch_date: string; approval: string; sku_count: number; }
interface MktBroadcast { name: string; channel: string; scheduled_at: string; }
interface MktAwaiting { type: string; name: string; date: string; }
interface MarketingData { sales: MktSale[]; launches: MktLaunch[]; broadcasts: MktBroadcast[]; awaiting_confirmation: MktAwaiting[]; }

interface ReportData {
  report_date: string; recipients: string[];
  sales: SalesRow[]; sales_totals: { units: number; sku_count: number };
  incoming: IncomingRow[]; low_stock: LowRow[];
  marketing: MarketingData;
}

function sectionLabel(text: string): string {
  return `<div style="${EYEBROW}margin:30px 0 12px;">${text}</div>`;
}

function renderSales(d: ReportData): string {
  const t = d.sales_totals;
  // Top 15 sellers by units PLUS any flagged movers (faster/slower vs their
  // 30-day average) outside the top 15 — so notable movers are never cut.
  const top = d.sales.slice(0, 15);
  const topSkus = new Set(top.map((r) => r.sku));
  const extra = d.sales.filter((r) => r.flag && !topSkus.has(r.sku));
  const shown = [...top, ...extra];
  const rows = shown.map((r) => {
    const bg = r.flag === "above" ? "background:#101f18;" : r.flag === "below" ? "background:#221c10;" : "";
    const badge = r.flag === "above"
      ? `<span style="color:${GREEN};font-weight:700;">▲</span>`
      : r.flag === "below" ? `<span style="color:${AMBER};font-weight:700;">▼</span>` : "";
    return `<tr style="${bg}">
      <td style="${TD}">${skuCell(r.sku, r.product_name)}</td>
      <td style="${TD}text-align:right;font-family:${MONO};color:${WHITE};font-weight:500;">${num(r.units)}</td>
      <td style="${TD}text-align:right;font-family:${MONO};color:${TER};">${num(r.avg_daily)}</td>
      <td style="${TD}text-align:center;">${badge}</td>
    </tr>`;
  }).join("");
  const remaining = d.sales.length - shown.length;
  const more = remaining > 0
    ? `<tr><td colspan="4" style="${TD}color:${TER};font-size:12px;border-bottom:none;">+${remaining} more SKUs</td></tr>`
    : "";
  return `
    ${sectionLabel("Yesterday's sales")}
    <div style="font-family:${FONT};color:${SEC};font-size:14px;margin:0 0 6px;">
      <span style="font-family:${MONO};color:${WHITE};font-weight:500;">${num(t.units)}</span> units across
      <span style="font-family:${MONO};color:${WHITE};font-weight:500;">${num(t.sku_count)}</span> SKUs
    </div>
    <div style="font-family:${FONT};color:${TER};font-size:12px;margin:0 0 10px;">Top 15 sellers plus flagged movers — ≥2× (<span style="color:${GREEN};">▲</span>) or ≤½ (<span style="color:${AMBER};">▼</span>) the 30-day daily average.</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
      <tr>
        <th style="${TH}text-align:left;">SKU</th>
        <th style="${TH}text-align:right;">Units</th>
        <th style="${TH}text-align:right;">30d avg</th>
        <th style="${TH}text-align:center;">vs avg</th>
      </tr>
      ${rows}${more}
    </table>`;
}

function renderIncoming(d: ReportData): string {
  if (!d.incoming.length) {
    return sectionLabel("Incoming shipments") + `<div style="font-family:${FONT};color:${TER};font-size:13px;">No shipments currently in tracking.</div>`;
  }
  const cards = d.incoming.map((s) => {
    const when = s.eta ? fmtDate(s.eta, { month: "short", day: "numeric" }) : "ETA —";
    const dLbl = s.days_out == null ? "" : s.days_out <= 0 ? " · due" : ` · in ${s.days_out}d`;
    const items = s.items.length
      ? s.items.map((it) => `<div style="margin-top:3px;">
          <span style="font-family:${MONO};color:${WHITE};font-weight:500;">${num(it.qty)}×</span>
          <span style="font-family:${MONO};color:${SEC};">${esc(it.sku)}</span>${it.name ? `<span style="font-family:${FONT};color:${TER};"> — ${esc(it.name)}</span>` : ""}
        </div>`).join("")
      : `<div style="margin-top:5px;color:${TER};font-family:${FONT};">no SKU lines</div>`;
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:8px;background:${SURF};border:1px solid ${BORD};border-radius:6px;">
      <tr><td style="padding:11px 13px;">
        <div style="font-family:${FONT};font-size:13px;color:${WHITE};">
          <span style="font-family:${MONO};font-weight:500;">${esc(s.shipment_number)}</span>
          <span style="color:${TER};">·</span> ${esc(s.carrier_name ?? s.freight_type)}
          <span style="color:${TER};">·</span> <span style="color:${BLUE};">ETA ${when}</span><span style="color:${TER};">${dLbl}</span>
        </div>
        <div style="font-size:13px;margin-top:4px;">${items}</div>
      </td></tr>
    </table>`;
  }).join("");
  return sectionLabel("Incoming shipments") + cards;
}

function renderLowStock(d: ReportData): string {
  if (!d.low_stock.length) {
    return sectionLabel("Running low") + `<div style="font-family:${FONT};color:${TER};font-size:13px;">Nothing within 7 days of stockout.</div>`;
  }
  const rows = d.low_stock.map((r) => {
    const days = r.dos_days <= 0
      ? `<span style="color:${RED};font-weight:700;">OUT</span>`
      : `<span style="color:${RED};font-weight:700;font-family:${MONO};">${num(r.dos_days)}d</span>`;
    const relief = r.in_transit > 0
      ? `<span style="font-family:${MONO};color:${SEC};">${num(r.in_transit)}</span> <span style="color:${TER};">→ ${r.next_eta ? fmtDate(r.next_eta, { month: "short", day: "numeric" }) : "—"}</span>`
      : `<span style="color:${TER};">—</span>`;
    return `<tr>
      <td style="${TD}">${skuCell(r.sku, r.product_name)}</td>
      <td style="${TD}text-align:right;font-family:${MONO};color:${WHITE};">${num(r.wh_units)}</td>
      <td style="${TD}text-align:right;font-family:${MONO};color:${TER};">${num(r.monthly_demand)}/mo</td>
      <td style="${TD}text-align:right;">${days}</td>
      <td style="${TD}text-align:right;">${relief}</td>
    </tr>`;
  }).join("");
  return `
    ${sectionLabel("Running low · ≤7 days of warehouse stock")}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
      <tr>
        <th style="${TH}text-align:left;">SKU</th>
        <th style="${TH}text-align:right;">On hand</th>
        <th style="${TH}text-align:right;">Demand</th>
        <th style="${TH}text-align:right;">Days left</th>
        <th style="${TH}text-align:right;">In transit</th>
      </tr>
      ${rows}
    </table>`;
}

function renderMarketing(d: ReportData): string {
  const m = d.marketing;
  if (!m) return "";
  const empty = !m.sales.length && !m.launches.length && !m.broadcasts.length && !m.awaiting_confirmation.length;
  if (empty) {
    return sectionLabel("Marketing · next 14 days") +
      `<div style="font-family:${FONT};color:${TER};font-size:13px;">No sales, launches, or broadcasts scheduled.</div>`;
  }
  const approvalChip = (approval: string) =>
    approval === "confirmed"
      ? ""
      : ` <span style="color:${AMBER};font-size:11px;">· ${esc(approval)} — not ops-confirmed</span>`;
  const line = (body: string) =>
    `<div style="font-family:${FONT};font-size:13px;color:${SEC};margin-top:5px;">${body}</div>`;
  let out = sectionLabel("Marketing · next 14 days");
  for (const s of m.sales) {
    out += line(`<span style="color:${WHITE};font-weight:700;">SALE</span> ${esc(s.name)} <span style="color:${TER};">· ${fmtDate(s.starts_at, { month: "short", day: "numeric" })}–${fmtDate(s.ends_at, { month: "short", day: "numeric" })} · ${num(s.sku_count)} SKUs</span>${approvalChip(s.approval)}`);
  }
  for (const l of m.launches) {
    out += line(`<span style="color:${BLUE};font-weight:700;">LAUNCH</span> ${esc(l.name)} <span style="color:${TER};">· ${fmtDate(l.launch_date, { month: "short", day: "numeric" })} · ${num(l.sku_count)} SKU${l.sku_count === 1 ? "" : "s"}</span>${approvalChip(l.approval)}`);
  }
  for (const b of m.broadcasts) {
    out += line(`<span style="color:${GREEN};font-weight:700;">${esc(b.channel).toUpperCase()}</span> ${esc(b.name)} <span style="color:${TER};">· ${fmtDate(b.scheduled_at, { month: "short", day: "numeric" })}</span>`);
  }
  if (m.awaiting_confirmation.length) {
    out += `<div style="margin-top:10px;padding:8px 12px;background:#2C2413;border-radius:6px;font-family:${FONT};font-size:12px;color:${AMBER};">
      Awaiting ops confirmation: ${m.awaiting_confirmation.map((a) => `${esc(a.name)} (${esc(a.type)}, ${fmtDate(a.date, { month: "short", day: "numeric" })})`).join(" · ")}
    </div>`;
  }
  return out;
}

function renderHtml(d: ReportData): string {
  const dateLong = fmtDate(d.report_date, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link href="https://fonts.googleapis.com/css2?family=Lato:wght@400;700;900&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet"></head>
<body style="margin:0;padding:0;background:${INK};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${INK};">
  <tr><td align="center" style="padding:24px 12px;">
    <table role="presentation" width="640" cellpadding="0" cellspacing="0" style="width:640px;max-width:640px;background:${CARD};border:1px solid ${BORD};border-radius:10px;">
      <tr><td style="padding:26px 28px 30px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-bottom:1px solid ${BORD};">
          <tr><td style="padding-bottom:16px;">
            <div style="${EYEBROW}">Daily Operations Report</div>
            <div style="font-family:${SERIF};font-size:30px;font-weight:700;color:${WHITE};letter-spacing:0.05em;text-transform:uppercase;margin-top:8px;">Freeze Pipe</div>
            <div style="font-family:${FONT};font-size:13px;color:${TER};margin-top:5px;">${dateLong}</div>
          </td></tr>
        </table>
        ${renderMarketing(d)}
        ${renderSales(d)}
        ${renderIncoming(d)}
        ${renderLowStock(d)}
        <div style="border-top:1px solid ${BORD};margin-top:28px;padding-top:14px;font-family:${FONT};font-size:12px;color:${TER};">
          <a href="${SITE_URL}/inventory" style="color:${BLUE};text-decoration:none;">Open the ERP</a>
          <span style="color:${BORD};">&nbsp;|&nbsp;</span> Automated 8:00 AM ET report.
        </div>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

/** Extract the `role` claim from a JWT without verifying the signature —
 *  the Supabase gateway (verify_jwt) has already done that. Payload is
 *  base64url, which atob can't digest directly. */
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

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  // Defense-in-depth: only the service-role JWT (pg_cron / ops) may trigger
  // sends. The gateway already rejects unsigned callers; pinning the role
  // claim additionally locks out anon/user JWTs regardless of gateway config.
  if (jwtRole(req.headers.get("Authorization")) !== "service_role") {
    return json({ error: "forbidden - service role required" }, 403);
  }

  let opts: { dry_run?: boolean; test_to?: string | string[] } = {};
  try { opts = await req.json(); } catch { /* empty body ok */ }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  const { data, error } = await admin.rpc("rpc_daily_report");
  if (error) return json({ ok: false, stage: "rpc", error: error.message }, 500);
  const report = data as ReportData;

  const html = renderHtml(report);
  const subject = `Freeze Pipe Daily Report — ${fmtDate(report.report_date, { month: "short", day: "numeric" })}`;

  const recipients = opts.test_to
    ? (Array.isArray(opts.test_to) ? opts.test_to : [opts.test_to])
    : (report.recipients ?? []);

  if (opts.dry_run) {
    return json({ ok: true, dry_run: true, subject, recipients, counts: {
      sales: report.sales.length, incoming: report.incoming.length, low_stock: report.low_stock.length,
    }, html });
  }

  if (!recipients.length) return json({ ok: false, error: "no recipients (no active admins with email)" });
  if (!RESEND_API_KEY) return json({ ok: false, error: "RESEND_API_KEY is not set — cannot send" });

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: REPORT_FROM, to: recipients, subject, html }),
  });
  const result = await resp.json().catch(() => ({}));
  if (!resp.ok) return json({ ok: false, stage: "resend", status: resp.status, error: result }, 502);
  return json({ ok: true, sent_to: recipients, resend_id: result.id ?? null, subject });
});
