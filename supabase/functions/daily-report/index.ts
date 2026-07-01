// =============================================================
// Daily report email (Supabase Edge Function)
// =============================================================
// Pulls the morning report payload from rpc_daily_report() and emails it to
// all active admins via Resend. Fired by pg_cron (public.fire_daily_report)
// at 8am ET; can also be invoked manually for testing.
//
// Body params (all optional):
//   { "dry_run": true }        -> render + return the HTML, DON'T send
//   { "test_to": "x@y.com" }   -> send only to this address (string or array),
//                                 ignoring the admin recipient list
//
// Secrets used:
//   RESEND_API_KEY   (required to send)  -- set by the user in the dashboard
//   REPORT_FROM      (optional)          -- "Name <addr@verified-domain>"
//   SITE_URL         (optional)          -- app URL for the footer link
// =============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const REPORT_FROM = Deno.env.get("REPORT_FROM") ?? "Freeze Pipe ERP <reports@thefreezepipe.com>";
const SITE_URL = Deno.env.get("SITE_URL") ?? "https://freeze-pipe-erp.vercel.app";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---- formatting helpers ----
const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!),
  );
const money = (n: number) => "$" + Math.round(Number(n) || 0).toLocaleString("en-US");
const num = (n: unknown) => (Number(n) || 0).toLocaleString("en-US");

function fmtDate(d: string | null, opts: Intl.DateTimeFormatOptions): string {
  if (!d) return "—";
  const dt = new Date(d + "T12:00:00Z");
  return dt.toLocaleDateString("en-US", { timeZone: "America/New_York", ...opts });
}

interface SalesRow { sku: string; product_name: string; units: number; avg_daily: number; revenue: number; flag: string | null; }
interface IncomingRow { shipment_number: string; carrier_name: string | null; freight_type: string; eta: string | null; days_out: number | null; items: { sku: string; qty: number }[]; }
interface LowRow { sku: string; product_name: string; wh_units: number; monthly_demand: number; dos_days: number; in_transit: number; next_eta: string | null; }
interface ReportData {
  report_date: string;
  recipients: string[];
  sales: SalesRow[];
  sales_totals: { units: number; revenue: number; sku_count: number };
  incoming: IncomingRow[];
  low_stock: LowRow[];
}

const CELL = 'style="padding:6px 10px;border-bottom:1px solid #ececec;"';
const TH = 'style="padding:6px 10px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.03em;color:#8a8a8a;border-bottom:1px solid #ddd;"';
const SECTION_H = 'style="margin:26px 0 8px;font-size:16px;font-weight:600;color:#111;"';

function renderSales(d: ReportData): string {
  const t = d.sales_totals;
  // Flagged movers rendered as chips FIRST — the "▼ slow" ones sold little
  // yesterday so they'd sort to the bottom and get cut by the table cap,
  // yet they're the most important signal (a strong seller that cratered).
  const flagged = d.sales.filter((r) => r.flag);
  const chips = flagged.length
    ? `<div style="margin:6px 0 14px;line-height:1.9;">` +
      flagged.map((r) => {
        const up = r.flag === "above";
        const style = up ? "background:#eafaf0;color:#1d7a46;" : "background:#fdf3e7;color:#b26a00;";
        return `<span style="display:inline-block;margin:0 6px 4px 0;padding:3px 8px;border-radius:6px;font-size:12px;${style}">${up ? "▲" : "▼"} <b>${esc(r.sku)}</b> ${num(r.units)} vs ${num(r.avg_daily)}/day</span>`;
      }).join("") +
      `</div>`
    : "";
  const SALES_CAP = 40;
  const rows = d.sales.slice(0, SALES_CAP);
  const body = rows.map((r) => {
    const bg = r.flag === "above" ? "background:#eafaf0;" : r.flag === "below" ? "background:#fdf3e7;" : "";
    const badge = r.flag === "above"
      ? '<span style="color:#1d7a46;font-weight:600;">▲ hot</span>'
      : r.flag === "below"
      ? '<span style="color:#b26a00;font-weight:600;">▼ slow</span>'
      : "";
    return `<tr style="${bg}">
      <td ${CELL}><b>${esc(r.sku)}</b><div style="color:#999;font-size:11px;">${esc(r.product_name)}</div></td>
      <td ${CELL} align="right"><b>${num(r.units)}</b></td>
      <td ${CELL} align="right" style="padding:6px 10px;border-bottom:1px solid #ececec;color:#777;">${num(r.avg_daily)}/day</td>
      <td ${CELL} align="right">${money(r.revenue)}</td>
      <td ${CELL}>${badge}</td>
    </tr>`;
  }).join("");
  const more = d.sales.length > SALES_CAP ? `<tr><td colspan="5" style="padding:6px 10px;color:#999;font-size:12px;">+${d.sales.length - SALES_CAP} more SKUs…</td></tr>` : "";
  return `
    <h2 ${SECTION_H}>Yesterday's sales</h2>
    <p style="margin:0 0 8px;color:#444;">${num(t.units)} units · ${money(t.revenue)} across ${num(t.sku_count)} SKUs. Flagged movers are ≥2× (<b style="color:#1d7a46;">▲ hot</b>) or ≤½ (<b style="color:#b26a00;">▼ slow</b>) their 30-day daily average.</p>
    ${chips}
    <table cellspacing="0" cellpadding="0" width="100%" style="border-collapse:collapse;font-size:13px;">
      <tr><th ${TH}>SKU</th><th ${TH} style="text-align:right;padding:6px 10px;color:#8a8a8a;">Units</th><th ${TH} style="text-align:right;padding:6px 10px;color:#8a8a8a;">30d avg</th><th ${TH} style="text-align:right;padding:6px 10px;color:#8a8a8a;">Revenue</th><th ${TH}>vs avg</th></tr>
      ${body}${more}
    </table>`;
}

function renderIncoming(d: ReportData): string {
  if (!d.incoming.length) {
    return `<h2 ${SECTION_H}>Incoming shipments (tracking)</h2><p style="color:#777;margin:0;">No shipments currently in tracking.</p>`;
  }
  const cards = d.incoming.map((s) => {
    const when = s.eta ? fmtDate(s.eta, { month: "short", day: "numeric" }) : "ETA —";
    const dLbl = s.days_out == null ? "" : s.days_out <= 0 ? " · due" : ` · in ${s.days_out}d`;
    const items = s.items.length
      ? s.items.map((it) => `${num(it.qty)}× <b>${esc(it.sku)}</b>`).join(", ")
      : '<span style="color:#999;">no SKU lines</span>';
    return `<div style="border:1px solid #e6e6e6;border-radius:8px;padding:10px 12px;margin-bottom:8px;">
      <div style="font-size:13px;"><b>${esc(s.shipment_number)}</b> · ${esc(s.carrier_name ?? s.freight_type)} · ETA ${when}${dLbl}</div>
      <div style="font-size:13px;color:#444;margin-top:4px;">${items}</div>
    </div>`;
  }).join("");
  return `<h2 ${SECTION_H}>Incoming shipments (tracking)</h2>${cards}`;
}

function renderLowStock(d: ReportData): string {
  if (!d.low_stock.length) {
    return `<h2 ${SECTION_H}>Running low (≤7 days)</h2><p style="color:#777;margin:0;">Nothing within 7 days of stockout. 🎉</p>`;
  }
  const body = d.low_stock.map((r) => {
    const daysCell = r.dos_days <= 0
      ? '<span style="color:#c0392b;font-weight:600;">OUT</span>'
      : `<span style="color:#c0392b;font-weight:600;">${num(r.dos_days)}d</span>`;
    const relief = r.in_transit > 0
      ? `${num(r.in_transit)} → ${r.next_eta ? fmtDate(r.next_eta, { month: "short", day: "numeric" }) : "—"}`
      : '<span style="color:#bbb;">—</span>';
    return `<tr>
      <td ${CELL}><b>${esc(r.sku)}</b><div style="color:#999;font-size:11px;">${esc(r.product_name)}</div></td>
      <td ${CELL} align="right">${num(r.wh_units)}</td>
      <td ${CELL} align="right" style="padding:6px 10px;border-bottom:1px solid #ececec;color:#777;">${num(r.monthly_demand)}/mo</td>
      <td ${CELL} align="right">${daysCell}</td>
      <td ${CELL} align="right">${relief}</td>
    </tr>`;
  }).join("");
  return `
    <h2 ${SECTION_H}>Running low (≤7 days of warehouse stock)</h2>
    <table cellspacing="0" cellpadding="0" width="100%" style="border-collapse:collapse;font-size:13px;">
      <tr><th ${TH}>SKU</th><th ${TH} style="text-align:right;padding:6px 10px;color:#8a8a8a;">On hand</th><th ${TH} style="text-align:right;padding:6px 10px;color:#8a8a8a;">Demand</th><th ${TH} style="text-align:right;padding:6px 10px;color:#8a8a8a;">Days left</th><th ${TH} style="text-align:right;padding:6px 10px;color:#8a8a8a;">In transit</th></tr>
      ${body}
    </table>`;
}

function renderHtml(d: ReportData): string {
  const dateLong = fmtDate(d.report_date, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  return `<!doctype html><html><body style="margin:0;background:#f4f4f5;padding:24px 0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#222;">
  <div style="max-width:640px;margin:0 auto;background:#fff;border-radius:12px;padding:24px 28px;">
    <div style="border-bottom:2px solid #111;padding-bottom:12px;margin-bottom:4px;">
      <div style="font-size:20px;font-weight:700;color:#111;">Freeze Pipe — Daily Report</div>
      <div style="color:#777;font-size:13px;">${dateLong}</div>
    </div>
    ${renderSales(d)}
    ${renderIncoming(d)}
    ${renderLowStock(d)}
    <div style="margin-top:26px;border-top:1px solid #eee;padding-top:12px;font-size:12px;color:#999;">
      <a href="${SITE_URL}/inventory" style="color:#2563eb;text-decoration:none;">Open the ERP →</a>
      &nbsp;·&nbsp; Automated 8am ET report.
    </div>
  </div></body></html>`;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  let opts: { dry_run?: boolean; test_to?: string | string[] } = {};
  try { opts = await req.json(); } catch { /* empty body is fine */ }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

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
  if (!resp.ok) {
    return json({ ok: false, stage: "resend", status: resp.status, error: result }, 502);
  }
  return json({ ok: true, sent_to: recipients, resend_id: result.id ?? null, subject });
});
