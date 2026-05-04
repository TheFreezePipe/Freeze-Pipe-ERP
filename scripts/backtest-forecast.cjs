#!/usr/bin/env node
/**
 * Forecast Backtest Engine
 *
 * Tests the v2 forecast algorithm across multiple cutoff dates and SKU types.
 * For each cutoff, it:
 *   1. Truncates data to that date (simulating "today")
 *   2. Runs the full forecast pipeline
 *   3. Compares the 30-day forecast to actual next-30-day sales
 *   4. Reports MAPE, bias, and per-SKU accuracy
 *
 * Usage: node scripts/backtest-forecast.cjs [csv_path]
 */

const fs = require('fs');
const path = require('path');

// Import the build-forecast module's functions by loading it
// We need to extract the functions without running main()
// So we'll duplicate the core algorithm here for isolation

// ---- Load shared data from build-forecast.cjs ----
// We'll re-require parts we need. Since build-forecast.cjs runs main() on load,
// we need to extract functions differently. Let's inline the needed pieces.

const DAY_MS = 86400000;

// ---- Minimal re-implementation of needed functions ----
// (These mirror build-forecast.cjs exactly)

function getISOWeek(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const dayOfYear = Math.floor((d - new Date(Date.UTC(d.getUTCFullYear(), 0, 1))) / DAY_MS) + 1;
  return Math.min(52, Math.ceil(dayOfYear / 7));
}

function linearRegression(ys) {
  const n = ys.length;
  if (n < 2) return { slope: 0, intercept: ys[0] || 0, rSquared: 0 };
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i; sumY += ys[i]; sumXY += i * ys[i]; sumX2 += i * i;
  }
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return { slope: 0, intercept: sumY / n, rSquared: 0 };
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  const yMean = sumY / n;
  let ssTot = 0, ssRes = 0;
  for (let i = 0; i < n; i++) {
    ssTot += (ys[i] - yMean) ** 2;
    ssRes += (ys[i] - (intercept + slope * i)) ** 2;
  }
  const rSquared = ssTot > 0 ? 1 - ssRes / ssTot : 0;
  return { slope, intercept, rSquared };
}

function buildEventMask(dateArray, events) {
  const mask = new Array(dateArray.length).fill(false);
  const maskableEvents = events.filter(evt => evt.mask === true);
  for (let i = 0; i < dateArray.length; i++) {
    const mmdd = dateArray[i].slice(5);
    for (const evt of maskableEvents) {
      if (evt.recurring) {
        if (mmdd >= evt.startMMDD && mmdd <= evt.endMMDD) { mask[i] = true; break; }
        if (evt.startMMDD > evt.endMMDD && (mmdd >= evt.startMMDD || mmdd <= evt.endMMDD)) { mask[i] = true; break; }
      }
    }
  }
  return mask;
}

function extractBaseline(dailyArray, dateArray, eventMask) {
  const n = dailyArray.length;
  const flags = new Array(n).fill(false);
  const baseline = [...dailyArray];
  for (let i = 0; i < n; i++) { if (eventMask[i]) flags[i] = true; }
  const WINDOW = 21;
  for (let i = WINDOW; i < n; i++) {
    if (flags[i]) continue;
    const windowVals = [];
    for (let j = Math.max(0, i - WINDOW); j < i; j++) {
      if (!flags[j]) windowVals.push(dailyArray[j]);
    }
    if (windowVals.length < 7) continue;
    windowVals.sort((a, b) => a - b);
    const q1 = windowVals[Math.floor(windowVals.length * 0.25)];
    const q3 = windowVals[Math.floor(windowVals.length * 0.75)];
    const iqr = q3 - q1;
    const upperFence = q3 + 2.0 * iqr;
    if (upperFence > 0 && dailyArray[i] > upperFence) flags[i] = true;
  }
  for (let i = 0; i < n; i++) {
    if (!flags[i]) continue;
    const neighbors = [];
    for (let j = Math.max(0, i - 14); j <= Math.min(n - 1, i + 14); j++) {
      if (!flags[j]) neighbors.push(dailyArray[j]);
    }
    baseline[i] = neighbors.length > 0 ? neighbors.sort((a, b) => a - b)[Math.floor(neighbors.length / 2)] : 0;
  }
  return { baseline, spikeFlags: flags };
}

function computeCategoryWeeklySeasonal(catDailyArray, catDateArray) {
  const n = catDailyArray.length;
  if (n < 90) { const r = {}; for (let w = 1; w <= 52; w++) r[w] = 1.0; return r; }
  const trend = new Array(n).fill(0);
  const halfWin = 45;
  for (let i = 0; i < n; i++) {
    let sum = 0, count = 0;
    for (let j = Math.max(0, i - halfWin); j <= Math.min(n - 1, i + halfWin); j++) { sum += catDailyArray[j]; count++; }
    trend[i] = count > 0 ? sum / count : 1;
  }
  const detrended = new Array(n).fill(1.0);
  for (let i = 0; i < n; i++) detrended[i] = trend[i] > 0.1 ? catDailyArray[i] / trend[i] : 1.0;
  const weekBuckets = {};
  for (let i = 0; i < n; i++) {
    const week = getISOWeek(catDateArray[i]);
    const year = catDateArray[i].slice(0, 4);
    if (!weekBuckets[week]) weekBuckets[week] = { sum: 0, count: 0, years: new Set() };
    weekBuckets[week].sum += detrended[i]; weekBuckets[week].count++; weekBuckets[week].years.add(year);
  }
  const rawSeasonal = {};
  for (let w = 1; w <= 52; w++) {
    rawSeasonal[w] = (weekBuckets[w] && weekBuckets[w].count >= 7 && weekBuckets[w].years.size >= 1)
      ? weekBuckets[w].sum / weekBuckets[w].count : 1.0;
  }
  let rawSum = 0; for (let w = 1; w <= 52; w++) rawSum += rawSeasonal[w];
  const rawMean = rawSum / 52;
  const seasonal = {};
  for (let w = 1; w <= 52; w++) seasonal[w] = rawMean > 0 ? rawSeasonal[w] / rawMean : 1.0;
  const smoothed = {};
  for (let w = 1; w <= 52; w++) {
    const prev = w === 1 ? 52 : w - 1;
    const next = w === 52 ? 1 : w + 1;
    smoothed[w] = (seasonal[prev] + seasonal[w] + seasonal[next]) / 3;
  }
  return smoothed;
}

function computeCategoryTrend(catDailyBaseline, catDateArray) {
  const n = catDailyBaseline.length;
  const cutoffIdx = Math.max(0, n - 180);
  const monthTotals = {};
  for (let i = cutoffIdx; i < n; i++) {
    const ym = catDateArray[i].slice(0, 7);
    monthTotals[ym] = (monthTotals[ym] || 0) + catDailyBaseline[i];
  }
  const keys = Object.keys(monthTotals).sort();
  if (keys.length > 1) {
    const lastMonth = keys[keys.length - 1];
    const lastMonthDays = catDateArray.filter(d => d.startsWith(lastMonth)).length;
    if (lastMonthDays < 20) keys.pop();
  }
  if (keys.length < 3) return { trend: 1.0, rSquared: 0 };
  const ys = keys.map(k => monthTotals[k]);
  const { slope, rSquared } = linearRegression(ys);
  const yMean = ys.reduce((a, b) => a + b, 0) / ys.length;
  if (yMean <= 0) return { trend: 1.0, rSquared: 0 };
  const monthlyPctChange = slope / yMean;
  let dampedTrend = 1 + monthlyPctChange * 0.85;
  if (rSquared < 0.3) dampedTrend = 1 + (dampedTrend - 1) * 0.5;
  dampedTrend = Math.max(0.50, Math.min(1.60, dampedTrend));
  return { trend: dampedTrend, rSquared };
}

function computeAdaptiveEWMA(baseline, dateArray, seasonalIndices) {
  const n = baseline.length;
  const last90Start = Math.max(0, n - 90);
  // Deseasonalize before EWMA: divide each day by its weekly seasonal index
  // This prevents double-counting when seasonal is applied to the forecast
  const window = [];
  for (let i = last90Start; i < n; i++) {
    const wk = dateArray ? getISOWeek(dateArray[i]) : 0;
    const si = (seasonalIndices && seasonalIndices[wk]) || 1.0;
    window.push(si > 0.1 ? baseline[i] / si : baseline[i]);
  }
  const wLen = window.length;
  if (wLen === 0) return { ewma: 0, alpha: 0.15, cv: 0 };
  const mean = window.reduce((a, b) => a + b, 0) / wLen;
  let variance = 0;
  for (let i = 0; i < wLen; i++) variance += (window[i] - mean) ** 2;
  variance /= wLen;
  const cv = mean > 0 ? Math.sqrt(variance) / mean : 1.0;
  const alpha = Math.max(0.05, Math.min(0.40, 0.05 + 0.15 * cv));
  let ewma = window[0];
  for (let i = 1; i < wLen; i++) ewma = alpha * window[i] + (1 - alpha) * ewma;
  return { ewma: Math.max(0, ewma), alpha, cv };
}

function getLaunchCurveFactor(daysActive) {
  if (daysActive <= 7) return 0.50;
  if (daysActive <= 14) return 0.65;
  if (daysActive <= 30) return 0.80;
  if (daysActive <= 60) return 0.90;
  return 1.0;
}

function crostonForecast(dailyArray) {
  const n = dailyArray.length;
  if (n < 30) return null;
  const last90 = dailyArray.slice(Math.max(0, n - 90));
  const zeroPct = last90.filter(v => v === 0).length / last90.length;
  if (zeroPct <= 0.40) return null;
  const demands = [], intervals = [];
  let daysSinceLast = 0;
  for (let i = 0; i < last90.length; i++) {
    daysSinceLast++;
    if (last90[i] > 0) { demands.push(last90[i]); if (demands.length > 1) intervals.push(daysSinceLast); daysSinceLast = 0; }
  }
  if (demands.length < 5) return null;
  const a = 0.15;
  let smoothedSize = demands[0];
  for (let i = 1; i < demands.length; i++) smoothedSize = a * demands[i] + (1 - a) * smoothedSize;
  let smoothedInterval = intervals[0] || 7;
  for (let i = 1; i < intervals.length; i++) smoothedInterval = a * intervals[i] + (1 - a) * smoothedInterval;
  return { dailyRate: Math.max(0, smoothedSize / smoothedInterval), zeroPct };
}

// ============================================================
// CATEGORY MAP (same as build-forecast.cjs)
// ============================================================
const CATEGORY_MAP = {
  "1": "Pipes", "2": "Pipes", "3": "Pipes", "4": "Pipes", "5": "Pipes", "6": "Pipes",
  "7": "Bubblers", "8": "Bubblers",
  "9": "Joint Chiller", "10": "Joint Chiller", "11": "Joint Chiller", "12": "Joint Chiller",
  "13": "Bongs", "14": "Bongs", "15": "Bongs", "16": "Bongs", "17": "Bongs", "18": "Bongs",
  "19": "Bongs", "20": "Bongs", "21": "Bongs", "22": "Bongs", "23": "Bongs", "24": "Bongs",
  "25": "Bongs", "26": "Bongs",
  "27": "Studio", "28": "Studio", "29": "Studio", "30": "Studio",
  "31": "Dab Rigs", "32": "Dab Rigs", "33": "Dab Rigs", "34": "Dab Rigs", "35": "Dab Rigs",
  "36": "Accessories", "37": "Accessories", "38": "Accessories",
  "39": "Ash Catchers", "40": "Ash Catchers", "41": "Ash Catchers",
  "42": "Ash Catchers", "43": "Ash Catchers", "44": "Ash Catchers",
  "45": "Bowls", "46": "Bowls", "47": "Bowls", "48": "Bowls", "49": "Bowls",
  "50": "Bowls", "51": "Bowls", "52": "Bowls", "53": "Bowls", "54": "Bowls",
  "55": "Bowls", "56": "Bowls", "57": "Bowls", "58": "Bowls", "59": "Bowls",
  "60": "Bowls", "61": "Bowls",
  "62": "Accessories", "63": "Accessories", "64": "Accessories", "65": "Accessories",
  "66": "Accessories", "67": "Accessories", "68": "Accessories", "69": "Accessories",
  "70": "Accessories", "71": "Accessories", "72": "Accessories", "73": "Accessories",
  "74": "Accessories", "75": "Accessories", "76": "Accessories", "77": "Accessories",
  "78": "Accessories", "79": "Accessories", "80": "Accessories", "81": "Accessories",
  "82": "Accessories", "83": "Accessories", "84": "Accessories", "85": "Accessories",
  "86": "Accessories", "87": "Accessories", "88": "Accessories", "89": "Accessories",
  "90": "Accessories", "91": "Accessories", "92": "Accessories", "93": "Accessories",
  "94": "Coils", "95": "Coils", "96": "Coils", "97": "Coils", "98": "Coils",
  "99": "Coils", "100": "Coils", "101": "Coils", "102": "Coils", "103": "Coils",
  "104": "Coils", "105": "Coils", "106": "Coils", "107": "Coils", "108": "Coils",
  "109": "Coils", "110": "Coils", "111": "Coils", "112": "Coils",
  "113": "Bases", "114": "Bases", "115": "Bases", "116": "Bases", "117": "Bases",
  "118": "Bases", "119": "Bases", "120": "Bases", "121": "Bases", "122": "Bases",
  "123": "Bases", "124": "Bases", "125": "Bases", "126": "Bases", "127": "Bases", "128": "Bases",
};

// ============================================================
// LOAD RAW DAILY DATA
// ============================================================

/**
 * Parse the CSV and return raw daily demand per SKU.
 * Reuses the SKU resolution logic from build-forecast.cjs.
 */
function loadDailyDemand(csvPath) {
  // We'll shell out to the build-forecast module's parsing.
  // For simplicity, load the CSV ourselves and aggregate by date+SKU.
  // We use the CATALOG + resolveShipStationSku from build-forecast.

  // Load build-forecast.cjs source to extract CATALOG + resolution
  const bfSource = fs.readFileSync(path.join(__dirname, 'build-forecast.cjs'), 'utf-8');

  // Extract up to the main() call, then evaluate to get access to functions
  const mainIdx = bfSource.lastIndexOf('\nmain();');
  let moduleCode = bfSource.slice(0, mainIdx);
  // Strip shebang if present
  if (moduleCode.startsWith('#!')) {
    moduleCode = moduleCode.slice(moduleCode.indexOf('\n') + 1);
  }

  // Create a module sandbox
  const sandbox = {};
  const wrappedCode = `
    ${moduleCode}
    module.exports = { CATALOG, parseCSV, aggregateDemand };
  `;

  const tmpPath = path.join(__dirname, '_backtest_tmp.cjs');
  fs.writeFileSync(tmpPath, wrappedCode, 'utf-8');
  const mod = require(tmpPath);
  fs.unlinkSync(tmpPath);

  const rows = mod.parseCSV(csvPath);
  const { dailyDemand, matched, unmatched } = mod.aggregateDemand(rows);

  console.log(`Loaded ${rows.length} rows, matched ${matched} units, unmatched ${unmatched}`);
  return { dailyDemand, CATALOG: mod.CATALOG };
}

// ============================================================
// FORECAST AT A GIVEN CUTOFF DATE
// ============================================================

/**
 * Run the full v2 forecast pipeline, but truncate all data to cutoffDate.
 * Returns { sku -> forecast30d } map.
 */
function forecastAtCutoff(dailyDemand, CATALOG, cutoffDate, events, skuOverrides) {
  const cutoffMs = new Date(cutoffDate + 'T00:00:00Z').getTime();
  const forecastWeek = getISOWeek(cutoffDate);

  // Build per-SKU truncated daily arrays
  const skuData = {};
  for (const catItem of CATALOG) {
    const series = dailyDemand[catItem.sku];
    if (!series) continue;
    const dates = Object.keys(series).filter(d => d <= cutoffDate).sort();
    if (dates.length === 0) continue;

    const firstDate = dates[0];
    const lastDate = dates[dates.length - 1];
    const startMs = new Date(firstDate + 'T00:00:00Z').getTime();
    const endMs = new Date(lastDate + 'T00:00:00Z').getTime();
    const totalDays = Math.round((endMs - startMs) / DAY_MS) + 1;
    const dailyArray = new Array(totalDays).fill(0);
    const dateArray = [];
    for (let i = 0; i < totalDays; i++) {
      const d = new Date(startMs + i * DAY_MS).toISOString().slice(0, 10);
      dateArray.push(d);
      dailyArray[i] = series[d] || 0;
    }

    const eventMask = buildEventMask(dateArray, events);
    const { baseline } = extractBaseline(dailyArray, dateArray, eventMask);
    skuData[catItem.sku] = {
      dailyArray, dateArray, baseline, lastDate, firstDate,
      dataPoints: totalDays,
      catalogId: catItem.id,
      category: CATEGORY_MAP[catItem.id] || 'Unknown',
    };
  }

  // Group by category
  const categorySkus = {};
  for (const [sku, sd] of Object.entries(skuData)) {
    if (!categorySkus[sd.category]) categorySkus[sd.category] = [];
    categorySkus[sd.category].push(sku);
  }

  // Category seasonal indices
  const categorySeasonals = {};
  const categoryDailyPooled = {};
  for (const [cat, skus] of Object.entries(categorySkus)) {
    let minDate = '9999-12-31', maxDate = '0000-01-01';
    for (const sku of skus) {
      if (skuData[sku].firstDate < minDate) minDate = skuData[sku].firstDate;
      if (skuData[sku].lastDate > maxDate) maxDate = skuData[sku].lastDate;
    }
    const startMs = new Date(minDate + 'T00:00:00Z').getTime();
    const endMs = new Date(maxDate + 'T00:00:00Z').getTime();
    const totalDays = Math.round((endMs - startMs) / DAY_MS) + 1;
    const catDaily = new Array(totalDays).fill(0);
    const catDates = [];
    for (let i = 0; i < totalDays; i++) {
      catDates.push(new Date(startMs + i * DAY_MS).toISOString().slice(0, 10));
    }
    for (const sku of skus) {
      const sd = skuData[sku];
      const offset = Math.round((new Date(sd.firstDate + 'T00:00:00Z').getTime() - startMs) / DAY_MS);
      for (let i = 0; i < sd.baseline.length; i++) catDaily[offset + i] += sd.baseline[i];
    }
    categoryDailyPooled[cat] = { dailyArray: catDaily, dateArray: catDates };
    categorySeasonals[cat] = computeCategoryWeeklySeasonal(catDaily, catDates);
  }

  // Category trends
  const categoryTrends = {};
  for (const [cat, pooled] of Object.entries(categoryDailyPooled)) {
    categoryTrends[cat] = computeCategoryTrend(pooled.dailyArray, pooled.dateArray);
  }

  // Per-SKU EWMA (deseasonalized using category seasonal indices)
  const skuEwmaResults = {};
  for (const [sku, sd] of Object.entries(skuData)) {
    skuEwmaResults[sku] = computeAdaptiveEWMA(sd.baseline, sd.dateArray, categorySeasonals[sd.category]);
  }

  // Category forecast → SKU allocation
  const results = {};
  for (const [cat, skus] of Object.entries(categorySkus)) {
    // Average seasonal index across the next 4 weeks (30-day forecast horizon)
    const si = categorySeasonals[cat];
    let catSeasonal = 0;
    for (let w = 0; w < 4; w++) {
      const wk = ((forecastWeek - 1 + w) % 52) + 1;
      catSeasonal += (si[wk] || 1.0);
    }
    catSeasonal /= 4;
    const catTrend = (categoryTrends[cat] || { trend: 1.0 }).trend;
    let catEwmaTotal = 0;
    for (const sku of skus) catEwmaTotal += skuEwmaResults[sku].ewma;
    const catForecast30d = Math.max(0, catEwmaTotal * 30 * catSeasonal * catTrend);

    for (const sku of skus) {
      const sd = skuData[sku];
      const ewmaDaily = skuEwmaResults[sku].ewma;
      const velocityShare = catEwmaTotal > 0 ? ewmaDaily / catEwmaTotal : 0;
      const crostonResult = crostonForecast(sd.dailyArray);
      const daysOfData = sd.dataPoints;
      let forecast30d;

      if (crostonResult && daysOfData >= 90) {
        forecast30d = Math.round(crostonResult.dailyRate * 30 * catSeasonal * catTrend);
      } else if (daysOfData < 90) {
        const skuWeight = Math.min(daysOfData / 90, 0.7);
        const catAvgDaily = skus.length > 0 ? catEwmaTotal / skus.length : 0;
        const blendedDaily = skuWeight * ewmaDaily + (1 - skuWeight) * catAvgDaily;
        const launchFactor = getLaunchCurveFactor(daysOfData);
        forecast30d = Math.round(blendedDaily * 30 * catSeasonal * catTrend * launchFactor);
      } else {
        forecast30d = Math.round(catForecast30d * velocityShare);
      }

      // SKU-level trend blending
      if (daysOfData >= 180) {
        const skuTrend = computeCategoryTrend(sd.baseline, sd.dateArray).trend;
        const blendedTrend = catTrend * 0.6 + skuTrend * 0.4;
        if (catTrend > 0) forecast30d = Math.round(forecast30d * (blendedTrend / catTrend));
      }

      forecast30d = Math.max(0, forecast30d);

      // Apply overrides
      const override = skuOverrides[sku];
      if (override && override.type === 'seasonal_neutralize' && catSeasonal !== 0) {
        forecast30d = Math.round(forecast30d / catSeasonal);
      }

      results[sku] = forecast30d;
    }
  }

  return results;
}

// ============================================================
// COMPUTE ACTUALS FOR NEXT 30 DAYS AFTER CUTOFF
// ============================================================

function getActuals(dailyDemand, CATALOG, cutoffDate) {
  const cutoffMs = new Date(cutoffDate + 'T00:00:00Z').getTime();
  const endMs = cutoffMs + 30 * DAY_MS;
  const results = {};
  for (const catItem of CATALOG) {
    const series = dailyDemand[catItem.sku];
    if (!series) continue;
    let total = 0;
    for (const [d, v] of Object.entries(series)) {
      const dMs = new Date(d + 'T00:00:00Z').getTime();
      if (dMs > cutoffMs && dMs <= endMs) total += v;
    }
    results[catItem.sku] = total;
  }
  return results;
}

// ============================================================
// MAIN BACKTEST
// ============================================================

function main() {
  const csvPath = process.argv[2] || String.raw`C:\Users\chase\Downloads\3079b3bd-4922-44f7-be08-9f13fe7a3c32.csv`;

  console.log('Loading data...');
  const { dailyDemand, CATALOG } = loadDailyDemand(csvPath);

  const overridesConfig = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'forecast-overrides.json'), 'utf-8')
  );
  const events = overridesConfig.events || [];
  const skuOverrides = overridesConfig.overrides || {};

  // ---- Define test cutoff dates ----
  // Each represents a different seasonal context
  const testDates = [
    { date: '2025-03-15', label: 'Mid-March 2025 (pre-4/20 ramp)' },
    { date: '2025-04-10', label: 'Early April 2025 (4/20 ramp peak)' },
    { date: '2025-05-15', label: 'Mid-May 2025 (post-4/20 normal)' },
    { date: '2025-07-01', label: 'July 2025 (summer baseline)' },
    { date: '2025-09-01', label: 'September 2025 (early fall)' },
    { date: '2025-11-01', label: 'November 2025 (holiday ramp start)' },
    { date: '2025-12-01', label: 'December 2025 (peak holiday)' },
    { date: '2026-01-15', label: 'Mid-January 2026 (post-holiday)' },
    { date: '2026-03-01', label: 'March 2026 (recent, pre-4/20)' },
  ];

  // ---- Focus SKUs: mix of volume levels, categories, and behaviors ----
  const focusSkus = [
    { sku: 'BW20', name: 'Freeze Pipe (flagship)', cat: 'Pipes' },
    { sku: 'BW20DNA', name: 'DNA Pipe (top seller)', cat: 'Pipes' },
    { sku: 'BW40SP', name: 'GBT Spiral', cat: 'Joint Chiller' },
    { sku: 'NB4', name: 'Straight Tube Bong', cat: 'Bongs' },
    { sku: 'BW22', name: 'Beaker Bong', cat: 'Bongs' },
    { sku: 'BW21P', name: 'Bubbler Pro', cat: 'Bubblers' },
    { sku: 'BW20-Bowl', name: 'FP Bowl (high vol)', cat: 'Bowls' },
    { sku: 'BW33-19P', name: '18mm AC Pro', cat: 'Ash Catchers' },
    { sku: 'Keychain-Debowler', name: 'Debowler (giveaway)', cat: 'Accessories' },
    { sku: 'Cleaning-Bottle', name: 'Cleaning Bottle', cat: 'Accessories' },
    { sku: 'FP-Koozie', name: 'FP Koozie', cat: 'Accessories' },
    { sku: 'HT-5', name: 'HT-5 Coil', cat: 'Coils' },
    { sku: 'NB2-Base', name: 'NB2 Base', cat: 'Bases' },
    { sku: 'BW38', name: 'Mini Dab Rig', cat: 'Dab Rigs' },
    { sku: 'NB1M', name: 'Mini Bong', cat: 'Bongs' },
  ];

  console.log(`\nRunning backtest across ${testDates.length} dates × ${focusSkus.length} SKUs...\n`);

  // ---- Store all results ----
  const allResults = []; // { date, label, sku, forecast, actual, error, pctError }

  for (const td of testDates) {
    process.stdout.write(`  ${td.date} (${td.label})...`);
    const forecasts = forecastAtCutoff(dailyDemand, CATALOG, td.date, events, skuOverrides);
    const actuals = getActuals(dailyDemand, CATALOG, td.date);

    for (const fs of focusSkus) {
      const forecast = forecasts[fs.sku] || 0;
      const actual = actuals[fs.sku] || 0;
      const error = forecast - actual;
      const pctError = actual > 0 ? Math.abs(error) / actual : (forecast > 0 ? 1.0 : 0);
      allResults.push({
        date: td.date, label: td.label,
        sku: fs.sku, skuName: fs.name, category: fs.cat,
        forecast, actual, error, pctError,
      });
    }
    console.log(' done');
  }

  // ============================================================
  // REPORT
  // ============================================================

  let report = '';
  report += '='.repeat(110) + '\n';
  report += 'FREEZE PIPE FORECAST BACKTEST REPORT — Enterprise Engine v2\n';
  report += `Generated: ${new Date().toISOString().slice(0, 10)}\n`;
  report += `Test periods: ${testDates.length}  |  Focus SKUs: ${focusSkus.length}  |  Total tests: ${allResults.length}\n`;
  report += '='.repeat(110) + '\n\n';

  // ---- Per-date summary ----
  report += '═══ ACCURACY BY TEST PERIOD ═══\n\n';
  report += 'Cutoff Date         Period Description                   Avg MAPE   Med MAPE   Bias     Tested\n';
  report += '-'.repeat(100) + '\n';

  for (const td of testDates) {
    const rows = allResults.filter(r => r.date === td.date && r.actual > 5); // exclude near-zero
    if (rows.length === 0) { report += `${td.date}  ${td.label.padEnd(40)}  (no testable SKUs)\n`; continue; }
    const mapes = rows.map(r => r.pctError);
    const avgMape = mapes.reduce((a, b) => a + b, 0) / mapes.length;
    const sorted = [...mapes].sort((a, b) => a - b);
    const medMape = sorted[Math.floor(sorted.length / 2)];
    const avgBias = rows.reduce((s, r) => s + r.error, 0) / rows.length;
    report += `${td.date}    ${td.label.padEnd(40)}${(avgMape * 100).toFixed(1).padStart(7)}%${(medMape * 100).toFixed(1).padStart(9)}%${(avgBias > 0 ? '+' : '') + avgBias.toFixed(0).padStart(7)}${String(rows.length).padStart(8)}\n`;
  }

  // ---- Per-SKU summary (averaged across all dates) ----
  report += '\n\n═══ ACCURACY BY SKU (across all test periods) ═══\n\n';
  report += 'SKU                  Category        Avg MAPE   Med MAPE   Avg Bias   Tests   Best Period              Worst Period\n';
  report += '-'.repeat(120) + '\n';

  for (const fs of focusSkus) {
    const rows = allResults.filter(r => r.sku === fs.sku && r.actual > 5);
    if (rows.length === 0) {
      report += `${fs.sku.padEnd(21)}${fs.cat.padEnd(16)}(insufficient data across test periods)\n`;
      continue;
    }
    const mapes = rows.map(r => r.pctError);
    const avgMape = mapes.reduce((a, b) => a + b, 0) / mapes.length;
    const sorted = [...mapes].sort((a, b) => a - b);
    const medMape = sorted[Math.floor(sorted.length / 2)];
    const avgBias = rows.reduce((s, r) => s + r.error, 0) / rows.length;
    const bestRow = rows.reduce((best, r) => r.pctError < best.pctError ? r : best, rows[0]);
    const worstRow = rows.reduce((worst, r) => r.pctError > worst.pctError ? r : worst, rows[0]);

    report += `${fs.sku.padEnd(21)}${fs.cat.padEnd(16)}${(avgMape * 100).toFixed(1).padStart(7)}%${(medMape * 100).toFixed(1).padStart(9)}%${(avgBias > 0 ? '+' : '') + avgBias.toFixed(0).padStart(9)}${String(rows.length).padStart(7)}   ${bestRow.date} (${(bestRow.pctError * 100).toFixed(0)}%)`.padEnd(100) + `  ${worstRow.date} (${(worstRow.pctError * 100).toFixed(0)}%)\n`;
  }

  // ---- Detailed per-date × per-SKU grid ----
  report += '\n\n═══ DETAILED FORECAST vs ACTUAL GRID ═══\n';

  for (const td of testDates) {
    report += `\n--- ${td.date}: ${td.label} ---\n`;
    report += 'SKU                  Category         Forecast   Actual   Error    MAPE\n';
    report += '-'.repeat(80) + '\n';

    const rows = allResults.filter(r => r.date === td.date);
    for (const r of rows) {
      const mapeStr = r.actual > 5 ? `${(r.pctError * 100).toFixed(0)}%` : (r.actual === 0 ? 'n/a' : `~${(r.pctError * 100).toFixed(0)}%`);
      const errorSign = r.error >= 0 ? '+' : '';
      report += `${r.sku.padEnd(21)}${r.category.padEnd(17)}${String(r.forecast).padStart(8)}${String(r.actual).padStart(9)}${(errorSign + r.error).padStart(8)}${mapeStr.padStart(8)}\n`;
    }
  }

  // ---- Overall summary ----
  const testable = allResults.filter(r => r.actual > 5);
  const overallMapes = testable.map(r => r.pctError);
  const overallAvg = overallMapes.reduce((a, b) => a + b, 0) / overallMapes.length;
  const overallSorted = [...overallMapes].sort((a, b) => a - b);
  const overallMedian = overallSorted[Math.floor(overallSorted.length / 2)];
  const within25 = overallMapes.filter(m => m <= 0.25).length;
  const within50 = overallMapes.filter(m => m <= 0.50).length;

  report += `\n\n═══ OVERALL SUMMARY ═══\n`;
  report += `Total testable forecasts (actual > 5 units): ${testable.length}\n`;
  report += `Average MAPE:    ${(overallAvg * 100).toFixed(1)}%\n`;
  report += `Median MAPE:     ${(overallMedian * 100).toFixed(1)}%\n`;
  report += `Within 25% error: ${within25}/${testable.length} (${(within25 / testable.length * 100).toFixed(0)}%)\n`;
  report += `Within 50% error: ${within50}/${testable.length} (${(within50 / testable.length * 100).toFixed(0)}%)\n`;
  report += `\nInterpretation:\n`;
  report += `  < 20% MAPE: Excellent (enterprise-grade)\n`;
  report += `  20-35% MAPE: Good (typical for ecommerce with promos)\n`;
  report += `  35-50% MAPE: Acceptable (volatile or low-volume SKUs)\n`;
  report += `  > 50% MAPE: Needs attention (model weakness or data issue)\n`;

  const reportPath = path.join(__dirname, 'backtest-report.txt');
  fs.writeFileSync(reportPath, report, 'utf-8');
  console.log(`\nWrote: ${reportPath}`);

  // Print summary to console
  console.log('\n' + '='.repeat(60));
  console.log('BACKTEST SUMMARY');
  console.log('='.repeat(60));
  console.log(`Testable forecasts: ${testable.length}`);
  console.log(`Average MAPE:       ${(overallAvg * 100).toFixed(1)}%`);
  console.log(`Median MAPE:        ${(overallMedian * 100).toFixed(1)}%`);
  console.log(`Within 25%:         ${within25}/${testable.length} (${(within25 / testable.length * 100).toFixed(0)}%)`);
  console.log(`Within 50%:         ${within50}/${testable.length} (${(within50 / testable.length * 100).toFixed(0)}%)`);
  console.log('');

  // Per-date quick summary
  for (const td of testDates) {
    const rows = allResults.filter(r => r.date === td.date && r.actual > 5);
    if (rows.length === 0) continue;
    const avg = rows.reduce((s, r) => s + r.pctError, 0) / rows.length;
    console.log(`  ${td.date}  ${td.label.padEnd(40)}  MAPE: ${(avg * 100).toFixed(1)}%`);
  }
}

main();
