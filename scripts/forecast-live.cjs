#!/usr/bin/env node
/**
 * Live forecast run: reads the current sales_daily series, runs the
 * validated forecastAtCutoff (as of today), applies a catastrophe cap,
 * and emits sku_forecasts rows for upsert.
 *
 * Reuses the exact backtested math (forecastAtCutoff) — no re-implementation.
 *
 * Input TSV (no header):  sku \t display_category \t sale_date \t units
 * Output TSV (no header): sku \t forecast_30d \t lower \t upper \t data_points \t last_sale_date \t method
 * Usage: node scripts/forecast-live.cjs <sales_daily.tsv> <out.tsv> [asOfDate]
 */
const fs = require('fs');
const path = require('path');
const { forecastAtCutoff } = require('./backtest-forecast.cjs');

const DAY_MS = 86400000;
const [, , tsv, outPath, asOfArg] = process.argv;
if (!tsv || !outPath) { console.error('Usage: node forecast-live.cjs <sales_daily.tsv> <out.tsv> [asOfDate]'); process.exit(1); }
const asOf = asOfArg || new Date().toISOString().slice(0, 10);

const dailyDemand = {};
const catBySku = new Map();
for (const line of fs.readFileSync(tsv, 'utf8').split(/\r?\n/)) {
  if (!line.trim()) continue;
  const p = line.split('\t'); if (p.length < 4) continue;
  const sku = p[0].trim(), category = (p[1] || '').trim() || 'Uncategorized', date = p[2].trim(), units = parseInt(p[3], 10) || 0;
  (dailyDemand[sku] ||= {})[date] = (dailyDemand[sku][date] || 0) + units;
  catBySku.set(sku, category);
}
const CATALOG = [...catBySku.entries()].map(([sku, category]) => ({ sku, category }));
const ov = JSON.parse(fs.readFileSync(path.join(__dirname, 'forecast-overrides.json'), 'utf8'));

const forecasts = forecastAtCutoff(dailyDemand, CATALOG, asOf, ov.events || [], ov.overrides || {});

// Sum of units in a 30-day window starting `offsetDays` before asOf-as-anchor.
// Used for the same-window-last-year catastrophe cap.
function windowSum(sku, startMs, endMs) {
  const s = dailyDemand[sku]; if (!s) return 0;
  let t = 0;
  for (const [d, v] of Object.entries(s)) {
    const ms = new Date(d + 'T00:00:00Z').getTime();
    if (ms >= startMs && ms < endMs) t += v;
  }
  return t;
}

const asOfMs = new Date(asOf + 'T00:00:00Z').getTime();
const out = [];
for (const sku of Object.keys(forecasts)) {
  let f = Math.round(forecasts[sku] || 0);
  if (f <= 0) continue;
  const series = dailyDemand[sku] || {};
  const dates = Object.keys(series).sort();
  if (!dates.length) continue;
  const lastSale = dates[dates.length - 1];
  const dataPoints = dates.length;

  // Catastrophe cap: never forecast > 2x the same 30-day window last year
  // (guards against rare un-planned anomalies; planned promos/giveaways are
  // handled via demand_overrides upstream).
  //
  // The year-ago window is only a valid ceiling when last year was
  // representative. For a SKU that was new or out of stock then, 2x a
  // near-zero number is a bogus ceiling that crushes a healthy product
  // (e.g. bw64: 2 units in the year-ago window -> capped to 4 despite selling
  // ~130/mo now). So we floor the ceiling at the recent trailing-30d run-rate:
  // the cap can still catch a genuine over-forecast, but can never drag the
  // number below what the SKU is actually selling right now.
  const lyStart = asOfMs - 365 * DAY_MS;
  const lyActual = windowSum(sku, lyStart, lyStart + 30 * DAY_MS);
  const recent30 = windowSum(sku, asOfMs - 30 * DAY_MS, asOfMs);
  if (lyActual > 0) f = Math.min(f, Math.max(Math.round(2 * lyActual), recent30));

  // Rough confidence band (A-tier MAPE ~20-25%, wider upside).
  const lower = Math.round(f * 0.7);
  const upper = Math.round(f * 1.5);
  out.push(`${sku}\t${f}\t${lower}\t${upper}\t${dataPoints}\t${lastSale}\tengine_v2`);
}

fs.writeFileSync(outPath, out.join('\n') + '\n');
console.log(JSON.stringify({ as_of: asOf, skus_forecast: out.length }, null, 2));
