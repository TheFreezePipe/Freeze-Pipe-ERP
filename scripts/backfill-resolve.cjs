#!/usr/bin/env node
/**
 * One-time backfill resolver: maps staged historical ShipStation rows
 * (sale_date, sku_code, units) to real product_sku UUIDs using the
 * forecast engine's tested resolver, aggregates to daily units per SKU,
 * and emits a load file for sales_daily plus an unresolved-codes report.
 *
 * Reuses resolveShipStationSku from build-forecast.cjs (legacy aliases,
 * bundles, kits, base mapping) — no reimplementation.
 *
 * Inputs (tab-delimited, no header):
 *   stagingPath  : sale_date \t sku_code \t units   (from sales_backfill_raw)
 *   skuMapPath   : sku       \t id                  (from product_skus)
 *   handlingPath : lower(code) \t resolved_id \t is_non_inventory  (from shipstation_sku_handling)
 * Outputs:
 *   outResolved   : sku_id \t sale_date \t units    (load into sales_daily)
 *   outUnresolved : units  \t code                  (triage report)
 *
 * Resolution chain per code: engine resolver (legacy aliases/bundles) ->
 * direct match against current product_skus (catches SKUs newer than the
 * engine's April catalog) -> shipstation_sku_handling (current triaged
 * aliases + non-inventory). Maximizes coverage across 2 years.
 *
 * Usage: node scripts/backfill-resolve.cjs <staging.tsv> <skumap.tsv> <handling.tsv> <out.tsv> <unresolved.tsv>
 */
const fs = require('fs');
const { resolveShipStationSku } = require('./build-forecast.cjs');

const [, , stagingPath, skuMapPath, handlingPath, outResolved, outUnresolved] = process.argv;
if (!stagingPath || !skuMapPath || !handlingPath || !outResolved || !outUnresolved) {
  console.error('Usage: node backfill-resolve.cjs <staging.tsv> <skumap.tsv> <handling.tsv> <out.tsv> <unresolved.tsv>');
  process.exit(1);
}

// product_skus: lower(sku) -> uuid
const skuToId = new Map();
for (const line of fs.readFileSync(skuMapPath, 'utf8').split(/\r?\n/)) {
  if (!line.trim()) continue;
  const tab = line.indexOf('\t');
  if (tab < 0) continue;
  skuToId.set(line.slice(0, tab).trim().toLowerCase(), line.slice(tab + 1).trim());
}

// shipstation_sku_handling: lower(code) -> { id, nonInv }
const handling = new Map();
for (const line of fs.readFileSync(handlingPath, 'utf8').split(/\r?\n/)) {
  if (!line.trim()) continue;
  const p = line.split('\t');
  handling.set(p[0].trim().toLowerCase(), { id: (p[1] || '').trim(), nonInv: (p[2] || '').trim() === 't' });
}

// Resolve one code+units to [{id, qty}], 'skip' (non-inventory), or null.
function resolveCode(code, units) {
  const eng = resolveShipStationSku(code, units);
  if (eng) {
    const out = [];
    for (const { catalogSku, qty } of eng) {
      const id = skuToId.get(String(catalogSku).toLowerCase());
      if (id) out.push({ id, qty });
    }
    if (out.length) return out;
  }
  // Direct match against the live catalog (newer SKUs the engine lacks)
  const direct = skuToId.get(code.trim().toLowerCase());
  if (direct) return [{ id: direct, qty: units }];
  // Current triaged aliases / non-inventory
  const h = handling.get(code.trim().toLowerCase());
  if (h) {
    if (h.nonInv) return 'skip';
    if (h.id) return [{ id: h.id, qty: units }];
  }
  return null;
}

const daily = new Map();       // sku_id|date -> units
const unresolved = new Map();  // code -> units
let resolvedUnits = 0, unresolvedUnits = 0, skippedUnits = 0;

for (const line of fs.readFileSync(stagingPath, 'utf8').split(/\r?\n/)) {
  if (!line.trim()) continue;
  const parts = line.split('\t');
  if (parts.length < 3) continue;
  const date = parts[0].trim();
  const code = parts[1];
  const units = parseInt(parts[2], 10) || 0;
  if (units <= 0) continue;

  const res = resolveCode(code, units);
  if (res === 'skip') { skippedUnits += units; continue; }
  if (!res) {
    unresolved.set(code, (unresolved.get(code) || 0) + units);
    unresolvedUnits += units;
    continue;
  }
  for (const { id, qty } of res) {
    const k = `${id}|${date}`;
    daily.set(k, (daily.get(k) || 0) + qty);
    resolvedUnits += qty;
  }
}

const resolvedLines = [];
for (const [k, units] of daily) {
  const [id, date] = k.split('|');
  resolvedLines.push(`${id}\t${date}\t${units}`);
}
fs.writeFileSync(outResolved, resolvedLines.join('\n') + '\n');

const unLines = [...unresolved.entries()].sort((a, b) => b[1] - a[1]).map(([c, u]) => `${u}\t${c}`);
fs.writeFileSync(outUnresolved, unLines.join('\n') + '\n');

const total = resolvedUnits + unresolvedUnits;
console.log(JSON.stringify({
  resolved_units: resolvedUnits,
  skipped_non_inventory_units: skippedUnits,
  unresolved_units: unresolvedUnits,
  resolution_rate: total ? (resolvedUnits / total * 100).toFixed(1) + '%' : 'n/a',
  sales_daily_rows: daily.size,
  distinct_unresolved_codes: unresolved.size,
}, null, 2));
