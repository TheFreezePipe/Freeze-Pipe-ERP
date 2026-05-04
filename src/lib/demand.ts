/**
 * demand — effective monthly demand + forecast lookup helpers.
 *
 * Centralizes the precedence rule for "what demand should this SKU be
 * planned against today":
 *
 *     forecast (forecast-data.ts)  >  product.monthly_demand  >  0
 *
 * Real-data flow: pages pass `product.monthly_demand` from Supabase into
 * `getEffectiveDemand`. If a forecast row exists for the SKU it wins; if
 * not, the monthly_demand baseline is used.
 *
 * The historical-snapshots generator (used by the per-SKU projection
 * chart) also lives here — it's a UI utility that synthesizes a
 * plausible 30-day finished-goods burn-down trace for the chart.
 *
 * Was previously embedded in `src/lib/demo-data.ts` alongside demo seed
 * fixtures, which made it look like the helpers were demo-only.
 */

import { getForecast, type SKUForecast } from "@/lib/forecast-data";

/**
 * Returns the effective monthly demand for a product. Forecast wins if
 * present; otherwise the caller's `monthlyDemand` baseline.
 *
 * Pass `product.monthly_demand` as the second argument when the product
 * comes from Supabase. The `productId` we accept is the real `sku_id`
 * (UUID) — the forecast table is keyed on the same id.
 */
export function getEffectiveDemand(productId: string, monthlyDemand?: number): number {
  const forecast = getForecast(productId);
  if (forecast) return forecast.forecastedDemand30d;
  if (monthlyDemand !== undefined) return monthlyDemand;
  return 0;
}

/** Forecast row for a SKU, or undefined. Thin pass-through to forecast-data. */
export function getProductForecast(productId: string): SKUForecast | undefined {
  return getForecast(productId);
}

// `generateHistoricalSnapshots` was a synthesizer that fabricated a
// 30-day finished-goods trace using a daily-burn approximation plus
// random noise. The chart that consumed it has been switched to a
// projection-only view (InventoryProjectionChart) since presenting
// fabricated history as if it were real misled operators. Re-introduce
// here once an `inventory_levels_history` table (or similar) starts
// landing real daily snapshots.
