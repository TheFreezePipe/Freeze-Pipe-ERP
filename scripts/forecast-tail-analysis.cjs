#!/usr/bin/env node
/**
 * Tail-quality analysis: is the engine "good enough", and does a guardrail
 * clamp fix the bad-tail blowups? Reuses the validated forecast harness.
 *
 * For each (cutoff, SKU): forecast, actual, trailing baseline (90d/3), and
 * a CLAMPED forecast = clamp(forecast, baseline*LOW, baseline*HIGH).
 * Reports equal-weighted MAPE vs VOLUME-WEIGHTED error (WAPE) — the metric
 * that reflects real units mis-planned — before and after the clamp.
 *
 * Usage: node scripts/forecast-tail-analysis.cjs <sales_daily.tsv>
 */
const fs = require('fs');
const path = require('path');
const { forecastAtCutoff, getActuals } = require('./backtest-forecast.cjs');

const DAY_MS = 86400000;
const LOW = 0.33, HIGH = 2.5; // clamp band around trailing baseline

const tsv = process.argv[2];
if (!tsv) { console.error('Usage: node forecast-tail-analysis.cjs <sales_daily.tsv>'); process.exit(1); }

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
const events = ov.events || [], skuOverrides = ov.overrides || {};

const testDates = ['2025-03-15','2025-05-15','2025-07-01','2025-09-01','2025-11-01','2025-12-01','2026-01-15','2026-03-01','2026-04-15','2026-05-05'];
const focusSkus = ['BW20','BW20DNA','BW40SP','NB4','BW22','BW21P','BW20-Bowl','BW33-19P','Keychain-Debowler','Cleaning-Bottle','FP-Koozie','HT-5','NB2-Base','BW38','NB1M'];

// trailing 30d-equivalent baseline = sum(last 90 days before cutoff)/3
function baselineAt(sku, cutoff) {
  const series = dailyDemand[sku]; if (!series) return 0;
  const cMs = new Date(cutoff + 'T00:00:00Z').getTime();
  let s = 0;
  for (const [d, v] of Object.entries(series)) {
    const dMs = new Date(d + 'T00:00:00Z').getTime();
    if (dMs > cMs - 90 * DAY_MS && dMs <= cMs) s += v;
  }
  return s / 3;
}

const rows = [];
for (const cutoff of testDates) {
  const fc = forecastAtCutoff(dailyDemand, CATALOG, cutoff, events, skuOverrides);
  const act = getActuals(dailyDemand, CATALOG, cutoff);
  for (const sku of focusSkus) {
    const forecast = fc[sku] || 0, actual = act[sku] || 0;
    const base = baselineAt(sku, cutoff);
    const clamped = base > 0 ? Math.max(Math.round(base * LOW), Math.min(forecast, Math.round(base * HIGH))) : forecast;
    rows.push({ cutoff, sku, forecast, actual, clamped, base });
  }
}

const testable = rows.filter(r => r.actual > 5);
const mape = (f, a) => a > 0 ? Math.abs(f - a) / a : (f > 0 ? 1 : 0);
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };

function metrics(getF) {
  const m = testable.map(r => mape(getF(r), r.actual));
  const sumErr = testable.reduce((s, r) => s + Math.abs(getF(r) - r.actual), 0);
  const sumAct = testable.reduce((s, r) => s + r.actual, 0);
  return {
    avgMape: (m.reduce((a, b) => a + b, 0) / m.length * 100).toFixed(1) + '%',
    medMape: (med(m) * 100).toFixed(1) + '%',
    wape: (sumErr / sumAct * 100).toFixed(1) + '%',
    blowups: m.filter(x => x > 1).length,
  };
}

console.log('\n=== TAIL ANALYSIS (' + testable.length + ' testable forecasts) ===');
console.log('Metric                     UNCLAMPED      CLAMPED');
const u = metrics(r => r.forecast), c = metrics(r => r.clamped);
console.log(`Avg MAPE (equal-weight)    ${u.avgMape.padStart(8)}   ${c.avgMape.padStart(8)}`);
console.log(`Median MAPE                ${u.medMape.padStart(8)}   ${c.medMape.padStart(8)}`);
console.log(`WAPE (volume-weighted) **  ${u.wape.padStart(8)}   ${c.wape.padStart(8)}`);
console.log(`Blowups (>100% error)      ${String(u.blowups).padStart(8)}   ${String(c.blowups).padStart(8)}`);

console.log('\n** WAPE = total units mis-forecast / total units sold — the metric the business actually feels.\n');

console.log('Worst 8 unclamped misses (and what the clamp does):');
const worst = [...testable].sort((a, b) => mape(b.forecast, b.actual) - mape(a.forecast, a.actual)).slice(0, 8);
for (const r of worst) {
  console.log(`  ${r.cutoff} ${r.sku.padEnd(18)} fcst ${String(r.forecast).padStart(5)} -> clamp ${String(r.clamped).padStart(5)} | actual ${String(r.actual).padStart(5)} | ${(mape(r.forecast, r.actual) * 100).toFixed(0)}% -> ${(mape(r.clamped, r.actual) * 100).toFixed(0)}% (base ${r.base.toFixed(0)})`);
}

// High-volume vs low-volume split (median monthly actual as the cut)
const volBySku = {};
for (const sku of focusSkus) { const a = testable.filter(r => r.sku === sku).map(r => r.actual); volBySku[sku] = a.length ? med(a) : 0; }
const hi = testable.filter(r => volBySku[r.sku] >= 100), lo = testable.filter(r => volBySku[r.sku] < 100);
const wape = (rs, getF) => (rs.reduce((s, r) => s + Math.abs(getF(r) - r.actual), 0) / rs.reduce((s, r) => s + r.actual, 0) * 100).toFixed(1) + '%';
console.log(`\nBy volume tier (WAPE, clamped):`);
console.log(`  High-volume SKUs (>=100/mo): ${wape(hi, r => r.clamped)}  (${new Set(hi.map(r => r.sku)).size} SKUs)`);
console.log(`  Low-volume SKUs  (<100/mo):  ${wape(lo, r => r.clamped)}  (${new Set(lo.map(r => r.sku)).size} SKUs)`);
