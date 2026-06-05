-- =============================================================
-- sku_forecasts — live forecast output, keyed by real sku_id
-- =============================================================
-- Replaces the dead, static forecast-data.ts (keyed on legacy numeric
-- ids that never matched the app's UUIDs). The live engine writes here
-- weekly from the sales_daily series; getEffectiveDemand reads it by
-- sku_id so forecasts actually drive planning.
--
-- One row per SKU. Guardrail fields (lower/upper, method, data_points)
-- let the UI show confidence + let planning scope trust to high-volume
-- SKUs (the backtest shows ~20% MAPE there vs 75%+ on the lumpy tail).
-- =============================================================
CREATE TABLE IF NOT EXISTS public.sku_forecasts (
  sku_id            uuid PRIMARY KEY REFERENCES public.product_skus(id) ON DELETE CASCADE,
  forecast_30d      integer NOT NULL,
  lower_bound       integer,
  upper_bound       integer,
  ewma_daily        numeric(10,3),
  seasonal_index    numeric(6,3),
  trend_multiplier  numeric(6,3),
  data_points       integer,
  forecast_method   text,
  last_sale_date    date,
  computed_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.sku_forecasts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "sku_forecasts readable by authenticated" ON public.sku_forecasts;
CREATE POLICY "sku_forecasts readable by authenticated"
  ON public.sku_forecasts FOR SELECT TO authenticated USING (true);

COMMENT ON TABLE public.sku_forecasts IS
  'Live demand forecast per SKU (30-day), recomputed weekly from sales_daily by the forecast engine. Keyed by real sku_id (fixes the dead forecast-data.ts mismatch).';
