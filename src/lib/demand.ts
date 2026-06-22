/**
 * demand — effective monthly demand resolver.
 *
 * Precedence:
 *     live forecast (sku_forecasts, when the SKU is in the scoped
 *     forecastMap)  >  product.monthly_demand (trailing-30d baseline)  >  0
 *
 * The forecastMap is built by useForecastDemandMap() (see
 * src/lib/hooks/use-forecasts.ts) and is intentionally scoped to
 * high-volume SKUs: the backtest shows the engine is accurate there
 * (~20% MAPE) but unreliable on the lumpy/low-volume tail, which keeps
 * using the trailing-30d monthly_demand baseline.
 *
 * Pass `product.monthly_demand` as the second argument and the map from
 * useForecastDemandMap() as the third. Callers that omit the map fall back
 * to the monthly_demand baseline — safe, just without the forecast.
 *
 * (The old static forecast-data.ts engine was removed: it was keyed on
 * legacy numeric ids that never matched the app's UUIDs, so it never
 * applied. The live sku_forecasts table replaces it.)
 */
export function getEffectiveDemand(
  productId: string,
  monthlyDemand?: number | null,
  forecastMap?: Map<string, number>,
): number {
  const forecast = forecastMap?.get(productId);
  if (forecast != null) return forecast;
  // `monthly_demand` is nullable in the DB (e.g. brand-new SKUs, most Bases)
  // even though the generated type says `number`. Treat null the same as
  // missing — fall through to 0 — so callers never receive a null they then
  // call .toString()/arithmetic on.
  if (monthlyDemand != null) return monthlyDemand;
  return 0;
}
