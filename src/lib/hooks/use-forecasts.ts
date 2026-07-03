import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useDemandOverrides, type DemandOverride } from "./use-demand-overrides";

export interface SkuForecast {
  sku_id: string;
  forecast_30d: number;
  lower_bound: number | null;
  upper_bound: number | null;
  ewma_daily: number | null;
  seasonal_index: number | null;
  trend_multiplier: number | null;
  data_points: number | null;
  last_sale_date: string | null;
  forecast_method: string | null;
  computed_at: string;
}

/** All live SKU forecasts (recomputed weekly by the forecast engine). */
export function useSkuForecasts() {
  return useQuery({
    queryKey: ["sku-forecasts"],
    queryFn: async () => {
      const { data, error } = await supabase.from("sku_forecasts").select("*");
      if (error) throw error;
      return (data ?? []) as SkuForecast[];
    },
    staleTime: 30 * 60 * 1000,
  });
}

/** sku_id -> full forecast row (for detail/UI display). */
export function useSkuForecastMap() {
  const { data } = useSkuForecasts();
  return useMemo(() => {
    const m = new Map<string, SkuForecast>();
    for (const f of data ?? []) m.set(f.sku_id, f);
    return m;
  }, [data]);
}

/**
 * sku_id -> effective demand map consumed by getEffectiveDemand.
 *
 * Two layers, in ascending precedence:
 *   1. Engine forecast (sku_forecasts.forecast_30d), SCOPED to high-volume
 *      SKUs (>= threshold). The backtest showed the engine is accurate on
 *      high-volume SKUs (~20% MAPE) but unreliable on the lumpy/low-volume
 *      tail; below the threshold getEffectiveDemand falls back to the
 *      trailing-30d monthly_demand baseline.
 *   2. Manual demand_overrides — the operator's number ALWAYS wins (new
 *      launches, discontinuations, known promo bumps). Because
 *      getEffectiveDemand consults this map before monthly_demand, folding
 *      overrides in here makes every consumer (Stock Levels DOS, order
 *      builder, auto-allocator, alerts, pipeline priority, retail charts)
 *      override-aware at once. Before 2026-07-03 overrides were only
 *      honored inside the SKU detail modal — the audit fix routes them
 *      through this single point instead.
 */
export const FORECAST_HIGH_VOLUME_MONTHLY = 60;

/** Pure builder so the layering is unit-testable without React Query. */
export function buildEffectiveDemandMap(
  forecasts: readonly Pick<SkuForecast, "sku_id" | "forecast_30d">[] | undefined,
  overrides: readonly Pick<DemandOverride, "sku_id" | "monthly_demand">[] | undefined,
): Map<string, number> {
  const m = new Map<string, number>();
  for (const f of forecasts ?? []) {
    if ((f.forecast_30d ?? 0) >= FORECAST_HIGH_VOLUME_MONTHLY) m.set(f.sku_id, f.forecast_30d);
  }
  for (const o of overrides ?? []) m.set(o.sku_id, o.monthly_demand);
  return m;
}

export function useForecastDemandMap() {
  const { data: forecasts } = useSkuForecasts();
  const { data: overrides } = useDemandOverrides();
  return useMemo(
    () => buildEffectiveDemandMap(forecasts, overrides),
    [forecasts, overrides],
  );
}
