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
const money = (n: number) => "$" + Math.round(Number(n) || 0).toLocaleString("en-US");
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

interface SalesRow { sku: string; product_name: string; units: number; avg_daily: number; revenue: number; flag: string | null; }
interface IncomingRow { shipment_number: string; carrier_name: string | null; freight_type: string; eta: string | null; days_out: number | null; items: { sku: string; qty: number }[]; }
interface LowRow { sku: string; product_name: string; wh_units: number; monthly_demand: number; dos_days: number; in_transit: number; next_eta: string | null; }
interface ReportData {
  report_date: string; recipients: string[];
  sales: SalesRow[]; sales_totals: { units: number; revenue: number; sku_count: number };
  incoming: IncomingRow[]; low_stock: LowRow[];
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
      <td style="${TD}text-align:right;font-family:${MONO};">${money(r.revenue)}</td>
      <td style="${TD}text-align:center;">${badge}</td>
    </tr>`;
  }).join("");
  const remaining = d.sales.length - shown.length;
  const more = remaining > 0
    ? `<tr><td colspan="5" style="${TD}color:${TER};font-size:12px;border-bottom:none;">+${remaining} more SKUs</td></tr>`
    : "";
  return `
    ${sectionLabel("Yesterday's sales")}
    <div style="font-family:${FONT};color:${SEC};font-size:14px;margin:0 0 6px;">
      <span style="font-family:${MONO};color:${WHITE};font-weight:500;">${num(t.units)}</span> units ·
      <span style="font-family:${MONO};color:${WHITE};font-weight:500;">${money(t.revenue)}</span> ·
      <span style="font-family:${MONO};color:${WHITE};font-weight:500;">${num(t.sku_count)}</span> SKUs
    </div>
    <div style="font-family:${FONT};color:${TER};font-size:12px;margin:0 0 10px;">Top 15 sellers plus flagged movers — ≥2× (<span style="color:${GREEN};">▲</span>) or ≤½ (<span style="color:${AMBER};">▼</span>) the 30-day daily average.</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
      <tr>
        <th style="${TH}text-align:left;">SKU</th>
        <th style="${TH}text-align:right;">Units</th>
        <th style="${TH}text-align:right;">30d avg</th>
        <th style="${TH}text-align:right;">Revenue</th>
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
      ? s.items.map((it) => `<span style="font-family:${MONO};color:${WHITE};font-weight:500;">${num(it.qty)}×</span> <span style="font-family:${MONO};color:${SEC};">${esc(it.sku)}</span>`).join('<span style="color:'+TER+';">   ·   </span>')
      : `<span style="color:${TER};">no SKU lines</span>`;
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:8px;background:${SURF};border:1px solid ${BORD};border-radius:6px;">
      <tr><td style="padding:11px 13px;">
        <div style="font-family:${FONT};font-size:13px;color:${WHITE};">
          <span style="font-family:${MONO};font-weight:500;">${esc(s.shipment_number)}</span>
          <span style="color:${TER};">·</span> ${esc(s.carrier_name ?? s.freight_type)}
          <span style="color:${TER};">·</span> <span style="color:${BLUE};">ETA ${when}</span><span style="color:${TER};">${dLbl}</span>
        </div>
        <div style="font-family:${FONT};font-size:13px;color:${SEC};margin-top:5px;">${items}</div>
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
            <div style="font-family:${SERIF};font-size:30px;font-weight:700;color:${WHITE};letter-spacing:0.005em;margin-top:8px;">Freeze Pipe</div>
            <div style="font-family:${FONT};font-size:13px;color:${TER};margin-top:5px;">${dateLong}</div>
          </td></tr>
        </table>
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

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

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
