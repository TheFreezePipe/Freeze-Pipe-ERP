#!/usr/bin/env node
/**
 * Re-backtest the forecast engine against the FRESH sales_daily series
 * (already SKU-resolved, gapless ~2yr) instead of the original CSV.
 * Reuses forecastAtCutoff + getActuals from backtest-forecast.cjs.
 *
 * Input TSV (no header):  sku \t display_category \t sale_date \t units
 * Usage: node scripts/backtest-salesdaily.cjs <sales_daily.tsv>
 */
const fs = require('fs');
const path = require('path');
const { forecastAtCutoff, getActuals } = require('./backtest-forecast.cjs');

const tsv = process.argv[2];
if (!tsv) { console.error('Usage: node backtest-salesdaily.cjs <sales_daily.tsv>'); process.exit(1); }

// Build dailyDemand[sku][date] = units and CATALOG = [{sku, category}]
const dailyDemand = {};
const catBySku = new Map();
for (const line of fs.readFileSync(tsv, 'utf8').split(/\r?\n/)) {
  if (!line.trim()) continue;
  const p = line.split('\t');
  if (p.length < 4) continue;
  const sku = p[0].trim();
  const category = (p[1] || '').trim() || 'Uncategorized';
  const date = p[2].trim();
  const units = parseInt(p[3], 10) || 0;
  if (!dailyDemand[sku]) dailyDemand[sku] = {};
  dailyDemand[sku][date] = (dailyDemand[sku][date] || 0) + units;
  catBySku.set(sku, category);
}
const CATALOG = [...catBySku.entries()].map(([sku, category]) => ({ sku, category }));

const overrides = JSON.parse(fs.readFileSync(path.join(__dirname, 'forecast-overrides.json'), 'utf8'));
const events = overrides.events || [];
const skuOverrides = overrides.overrides || {};

// Original 9 cutoffs + two recent ones to test the latest demand regime.
const testDates = [
  { date: '2025-03-15', label: 'Mid-March 2025 (pre-4/20)' },
  { date: '2025-05-15', label: 'Mid-May 2025 (post-4/20)' },
  { date: '2025-07-01', label: 'July 2025 (summer)' },
  { date: '2025-09-01', label: 'September 2025 (fall)' },
  { date: '2025-11-01', label: 'November 2025 (holiday ramp)' },
  { date: '2025-12-01', label: 'December 2025 (peak holiday)' },
  { date: '2026-01-15', label: 'Mid-January 2026 (post-holiday)' },
  { date: '2026-03-01', label: 'March 2026 (pre-4/20)' },
  { date: '2026-04-15', label: 'Mid-April 2026 (4/20 ramp) [NEW]' },
  { date: '2026-05-05', label: 'Early May 2026 (post-4/20) [NEW]' },
];

const focusSkus = [
  { sku: 'BW20', cat: 'Pipes' }, { sku: 'BW20DNA', cat: 'Pipes' },
  { sku: 'BW40SP', cat: 'Joint Chiller' }, { sku: 'NB4', cat: 'Bongs' },
  { sku: 'BW22', cat: 'Bongs' }, { sku: 'BW21P', cat: 'Bubblers' },
  { sku: 'BW20-Bowl', cat: 'Bowls' }, { sku: 'BW33-19P', cat: 'Ash Catchers' },
  { sku: 'Keychain-Debowler', cat: 'Accessories' }, { sku: 'Cleaning-Bottle', cat: 'Accessories' },
  { sku: 'FP-Koozie', cat: 'Accessories' }, { sku: 'HT-5', cat: 'Coils' },
  { sku: 'NB2-Base', cat: 'Bases' }, { sku: 'BW38', cat: 'Dab Rigs' },
  { sku: 'NB1M', cat: 'Bongs' },
];

const all = [];
for (const td of testDates) {
  const fc = forecastAtCutoff(dailyDemand, CATALOG, td.date, events, skuOverrides);
  const act = getActuals(dailyDemand, CATALOG, td.date);
  for (const f of focusSkus) {
    const forecast = fc[f.sku] || 0;
    const actual = act[f.sku] || 0;
    const pctError = actual > 0 ? Math.abs(forecast - actual) / actual : (forecast > 0 ? 1 : 0);
    all.push({ date: td.date, label: td.label, sku: f.sku, forecast, actual, pctError });
  }
}

const med = (arr) => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const testable = all.filter(r => r.actual > 5);
const mapes = testable.map(r => r.pctError);
const avg = mapes.reduce((a, b) => a + b, 0) / mapes.length;

console.log('\n=== RE-BACKTEST ON sales_daily ===');
console.log(`Testable forecasts (actual>5): ${testable.length}`);
console.log(`Average MAPE: ${(avg * 100).toFixed(1)}%   Median MAPE: ${(med(mapes) * 100).toFixed(1)}%`);
console.log(`Within 25%: ${mapes.filter(m => m <= .25).length}/${mapes.length} (${(mapes.filter(m => m <= .25).length / mapes.length * 100).toFixed(0)}%)`);
console.log(`Within 50%: ${mapes.filter(m => m <= .5).length}/${mapes.length} (${(mapes.filter(m => m <= .5).length / mapes.length * 100).toFixed(0)}%)\n`);

console.log('By period:');
for (const td of testDates) {
  const rows = testable.filter(r => r.date === td.date);
  if (!rows.length) { console.log(`  ${td.date}  ${td.label.padEnd(36)}  (no testable)`); continue; }
  const a = rows.reduce((s, r) => s + r.pctError, 0) / rows.length;
  console.log(`  ${td.date}  ${td.label.padEnd(36)}  avg ${(a * 100).toFixed(0).padStart(4)}%  med ${(med(rows.map(r => r.pctError)) * 100).toFixed(0).padStart(4)}%`);
}

console.log('\nBy SKU (avg across periods):');
for (const f of focusSkus) {
  const rows = testable.filter(r => r.sku === f.sku);
  if (!rows.length) { console.log(`  ${f.sku.padEnd(20)} (insufficient)`); continue; }
  const a = rows.reduce((s, r) => s + r.pctError, 0) / rows.length;
  console.log(`  ${f.sku.padEnd(20)} ${f.cat.padEnd(14)} avg ${(a * 100).toFixed(0).padStart(4)}%  med ${(med(rows.map(r => r.pctError)) * 100).toFixed(0).padStart(4)}%  (${rows.length} periods)`);
}

// Spotlight the two new recent periods, detailed
for (const nd of ['2026-04-15', '2026-05-05']) {
  console.log(`\n${nd} forecast vs actual:`);
  for (const r of all.filter(x => x.date === nd)) {
    console.log(`  ${r.sku.padEnd(20)} fcst ${String(r.forecast).padStart(6)}  actual ${String(r.actual).padStart(6)}  ${r.actual > 5 ? (r.pctError * 100).toFixed(0) + '%' : '-'}`);
  }
}
