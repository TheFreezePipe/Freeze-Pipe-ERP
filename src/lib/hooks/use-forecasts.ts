import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase as typedSupabase } from "@/lib/supabase";

// Generated DB types don't yet include sku_forecasts (added 20260605000003).
// Cast like the materials hooks until types are regenerated.
// deno-lint-ignore no-explicit-any
const supabase = typedSupabase as unknown as any;

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
 * sku_id -> forecast_30d, SCOPED to high-volume SKUs (>= threshold).
 *
 * The backtest showed the engine is accurate on high-volume SKUs (~20%
 * MAPE) but unreliable on the lumpy/low-volume tail. So we only let the
 * forecast drive planning above this threshold; below it, getEffectiveDemand
 * falls back to the trailing-30d monthly_demand baseline.
 */
export const FORECAST_HIGH_VOLUME_MONTHLY = 60;
export function useForecastDemandMap() {
  const { data } = useSkuForecasts();
  return useMemo(() => {
    const m = new Map<string, number>();
    for (const f of data ?? []) {
      if ((f.forecast_30d ?? 0) >= FORECAST_HIGH_VOLUME_MONTHLY) m.set(f.sku_id, f.forecast_30d);
    }
    return m;
  }, [data]);
}
