/**
 * Category-Level Demand Model
 *
 * Forecasts demand at the category level first, then allocates down to individual
 * SKUs based on their recent velocity share within the category.
 *
 * This handles:
 * - Demand cannibalization between sibling SKUs within a category
 * - New SKU launches (spike-then-settle curve)
 * - Discontinued SKUs (keeps forecasting until inventory hits 0, then hides)
 * - More stable forecasts since category totals are less noisy than individual SKUs
 *
 * Formula:
 *   category_forecast_30d = sum of all SKU EWMA × 30 × category_seasonal_index × category_trend
 *   sku_forecast_30d = category_forecast_30d × sku_share_pct
 *
 * SKU share is computed from trailing 60-day velocity (EWMA-weighted),
 * with new SKU launch curve adjustment.
 */

// The legacy static forecast engine (forecast-data.ts) was removed: it was
// keyed on numeric demo ids that never matched the app's real UUIDs, so
// these lookups always returned undefined in production. Replaced with an
// empty set so the (demo-based) fallback branches below behave exactly as
// they did in prod. NOTE: this entire module is demo-data-based and is
// effectively dead in production (it operates on demoProducts / numeric ids
// and never matches real SKUs). Slated for removal — see cleanup note.
type SKUForecast = {
  catalogSkuId: string;
  forecastedDemand30d: number;
  lowerBound: number;
  upperBound: number;
  seasonalIndex: number;
  categorySeasonalIndex?: number;
  trendMultiplier: number;
  forecastMethod?: string;
  velocityShare?: number;
  dataPoints?: number;
};
const skuForecasts: SKUForecast[] = [];

// ============================================================
// Category groupings — matches Retail Value by Category chart
// ============================================================

import { demoProducts } from "./demo-data";

function buildCategoryGroups() {
  const groups: Record<string, string[]> = {};
  for (const p of demoProducts) {
    const cat = p.display_category;
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(p.id);
  }
  return groups;
}

// ============================================================
// Category Forecast
// ============================================================

export interface CategoryForecast {
  category: string;
  forecast30d: number;        // Total category demand in units for next 30 days
  forecastRetailValue: number; // Total retail value of forecasted demand
  // Bands are NULL when the category has no per-SKU forecast data and we
  // can't honestly compute a confidence interval. Previously these were
  // synthesized as `staticTotal × 0.65 / × 1.45` — fabricated numbers
  // that the UI rendered as if they were real prediction intervals.
  // Callers MUST handle null (display "no forecast data" or hide the
  // range) rather than reading these as numbers.
  lowerBound: number | null;
  upperBound: number | null;
  lowerBoundRetail: number | null;
  upperBoundRetail: number | null;
  avgSeasonalIndex: number;   // Weighted average of SKU seasonal indices
  avgTrendMultiplier: number; // Weighted average of SKU trend multipliers
  skuCount: number;           // Active SKUs with forecast data
  totalSkuCount: number;      // All SKUs in category
}

export interface SKUCategoryAllocation {
  productId: string;
  sku: string;
  category: string;
  // Per-SKU forecast (raw, before category adjustment)
  rawForecast30d: number;
  // Category-adjusted forecast
  categoryAdjustedForecast30d: number;
  // Share of category demand
  sharePct: number;
  // Launch curve info
  isNewLaunch: boolean;
  launchDaysActive: number;
  // Status
  isDiscontinued: boolean;
  shouldHide: boolean; // true when discontinued AND zero inventory
}

/**
 * Compute category-level forecasts by aggregating per-SKU build output.
 * The build script (v2) already computes category-level seasonal indices and trends,
 * so this is a thin aggregation layer — no redundant recomputation.
 */
export function computeCategoryForecasts(): CategoryForecast[] {
  const groups = buildCategoryGroups();
  const results: CategoryForecast[] = [];

  for (const [category, productIds] of Object.entries(groups)) {
    const skuFcs: SKUForecast[] = [];
    for (const pid of productIds) {
      const fc = skuForecasts.find(f => f.catalogSkuId === pid);
      if (fc && fc.forecastedDemand30d > 0) skuFcs.push(fc);
    }

    if (skuFcs.length === 0) {
      // No per-SKU forecast data for any SKU in this category. We can
      // still surface the static `monthly_demand` total as a point
      // estimate, but we cannot honestly produce confidence bands from
      // it — there's no variance signal to derive a range from. Return
      // null bands; the chart hides the "Range:" line when null. (The
      // previous code multiplied the static total by 0.65/1.45 and
      // rendered those as if they were real prediction intervals, which
      // operators reading the chart had no way to distinguish from
      // genuinely-derived bands.)
      let staticTotal = 0;
      let staticRetail = 0;
      for (const pid of productIds) {
        const p = demoProducts.find(pr => pr.id === pid);
        if (!p) continue;
        staticTotal += p.monthly_demand;
        staticRetail += p.monthly_demand * p.retail_price;
      }
      results.push({
        category,
        forecast30d: staticTotal,
        forecastRetailValue: Math.round(staticRetail),
        lowerBound: null,
        upperBound: null,
        lowerBoundRetail: null,
        upperBoundRetail: null,
        avgSeasonalIndex: 1.0,
        avgTrendMultiplier: 1.0,
        skuCount: 0,
        totalSkuCount: productIds.length,
      });
      continue;
    }

    // Sum pre-computed per-SKU forecasts (already category-adjusted by build script)
    const forecast30d = skuFcs.reduce((sum, fc) => sum + fc.forecastedDemand30d, 0);
    const lowerBound = skuFcs.reduce((sum, fc) => sum + fc.lowerBound, 0);
    const upperBound = skuFcs.reduce((sum, fc) => sum + fc.upperBound, 0);

    // Retail value from per-SKU forecasts × retail price
    let forecastRetailValue = 0;
    let lowerBoundRetail = 0;
    let upperBoundRetail = 0;
    for (const fc of skuFcs) {
      const product = demoProducts.find(p => p.id === fc.catalogSkuId);
      const price = product?.retail_price ?? 0;
      forecastRetailValue += fc.forecastedDemand30d * price;
      lowerBoundRetail += fc.lowerBound * price;
      upperBoundRetail += fc.upperBound * price;
    }
    // Include static fallback for SKUs without forecast
    for (const pid of productIds) {
      if (skuFcs.some(fc => fc.catalogSkuId === pid)) continue;
      const p = demoProducts.find(pr => pr.id === pid);
      if (p) forecastRetailValue += p.monthly_demand * p.retail_price;
    }

    // Use category-level seasonal/trend from the first SKU with data (they share it)
    const refFc = skuFcs[0];
    const avgSeasonal = refFc.categorySeasonalIndex ?? refFc.seasonalIndex;
    const avgTrend = refFc.trendMultiplier;

    results.push({
      category,
      forecast30d,
      forecastRetailValue: Math.round(forecastRetailValue),
      lowerBound,
      upperBound,
      lowerBoundRetail: Math.round(lowerBoundRetail),
      upperBoundRetail: Math.round(upperBoundRetail),
      avgSeasonalIndex: Math.round(avgSeasonal * 1000) / 1000,
      avgTrendMultiplier: Math.round(avgTrend * 1000) / 1000,
      skuCount: skuFcs.length,
      totalSkuCount: productIds.length,
    });
  }

  return results.sort((a, b) => b.forecastRetailValue - a.forecastRetailValue);
}

/**
 * Allocate category demand down to individual SKUs.
 * The build script (v2) already computes velocity shares, launch dampening,
 * and cold-start blending — this reads those values directly.
 */
export function computeSKUAllocations(): SKUCategoryAllocation[] {
  const groups = buildCategoryGroups();
  const allocations: SKUCategoryAllocation[] = [];

  for (const [category, productIds] of Object.entries(groups)) {
    for (const pid of productIds) {
      const product = demoProducts.find(p => p.id === pid)!;
      const fc = skuForecasts.find(f => f.catalogSkuId === pid);

      const isDiscontinued = !product.is_active;
      const isNewLaunch = fc ? (fc.forecastMethod === 'cold_start') : false;
      const sharePct = fc?.velocityShare ?? 0;

      allocations.push({
        productId: pid,
        sku: product.sku,
        category,
        rawForecast30d: fc?.forecastedDemand30d ?? product.monthly_demand,
        categoryAdjustedForecast30d: fc?.forecastedDemand30d ?? product.monthly_demand,
        sharePct,
        isNewLaunch,
        launchDaysActive: fc?.dataPoints ?? 0,
        isDiscontinued,
        shouldHide: isDiscontinued,
      });
    }
  }

  return allocations;
}

// ============================================================
// Public API — main entry points for the ERP
// ============================================================

let _categoryForecasts: CategoryForecast[] | null = null;
let _skuAllocations: SKUCategoryAllocation[] | null = null;

/** Get all category forecasts (cached). */
export function getCategoryForecasts(): CategoryForecast[] {
  if (!_categoryForecasts) _categoryForecasts = computeCategoryForecasts();
  return _categoryForecasts;
}

/** Get all SKU allocations (cached). */
export function getSKUAllocations(): SKUCategoryAllocation[] {
  if (!_skuAllocations) _skuAllocations = computeSKUAllocations();
  return _skuAllocations;
}

/** Get category forecast for a specific category. */
export function getCategoryForecast(category: string): CategoryForecast | undefined {
  return getCategoryForecasts().find(cf => cf.category === category);
}

/** Get the category-adjusted allocation for a specific product. */
export function getSKUAllocation(productId: string): SKUCategoryAllocation | undefined {
  return getSKUAllocations().find(a => a.productId === productId);
}

/**
 * Get the best demand estimate for a product, incorporating category context.
 *
 * Priority:
 * 1. Category-adjusted forecast (if category has enough data)
 * 2. Raw per-SKU forecast
 * 3. Static monthly_demand fallback
 */
export function getCategoryAdjustedDemand(productId: string): number {
  const allocation = getSKUAllocation(productId);
  if (allocation && allocation.categoryAdjustedForecast30d > 0) {
    return allocation.categoryAdjustedForecast30d;
  }
  // Fallback to raw forecast or static
  const fc = skuForecasts.find(f => f.catalogSkuId === productId);
  if (fc) return fc.forecastedDemand30d;
  const product = demoProducts.find(p => p.id === productId);
  return product?.monthly_demand ?? 0;
}

/**
 * Check if a SKU should be hidden from views.
 * Returns true only if the product has been manually marked as inactive (is_active = false).
 */
export function shouldHideSKU(productId: string): boolean {
  const product = demoProducts.find(p => p.id === productId);
  return product ? !product.is_active : false;
}
