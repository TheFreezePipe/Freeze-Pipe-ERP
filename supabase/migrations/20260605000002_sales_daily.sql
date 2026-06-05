-- =============================================================
-- sales_daily — single source of truth for demand history
-- =============================================================
-- A compact daily-units-per-SKU series, decoupled from the operational
-- order tables (shipstation_orders/_items drive inventory; this is pure
-- demand signal). It feeds the demand recompute, the Analytics module,
-- and the forthcoming forecast engine — build once, three consumers.
--
-- Grain: one row per (sku_id, sale_date). At ~128 SKUs × 730 days the
-- whole 2-year series is well under 100k rows (~10 MB w/ index) — trivial
-- for Postgres; no partitioning/rollups needed.
--
-- Populated two ways:
--   * recent: rpc_refresh_sales_daily() re-aggregates the trailing window
--     from shipstation_order_items (already SKU-resolved in-DB). Nightly.
--   * historical (pre-DB): a one-time 2-year backfill (separate step) that
--     resolves legacy ShipStation codes and upserts older dates.
-- Idempotent on the PK so both paths and re-runs are safe.
-- =============================================================

CREATE TABLE IF NOT EXISTS public.sales_daily (
  sku_id      uuid        NOT NULL REFERENCES public.product_skus(id) ON DELETE CASCADE,
  sale_date   date        NOT NULL,
  units       integer     NOT NULL DEFAULT 0,
  source      text        NOT NULL DEFAULT 'shipstation',
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sku_id, sale_date)
);

-- Cross-SKU / date-range scans (Analytics, coverage checks).
CREATE INDEX IF NOT EXISTS idx_sales_daily_date ON public.sales_daily (sale_date);

-- Demand units are not sensitive financials — readable by the team;
-- writes go through the SECURITY DEFINER refresh RPC / backfill.
ALTER TABLE public.sales_daily ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "sales_daily readable by authenticated" ON public.sales_daily;
CREATE POLICY "sales_daily readable by authenticated"
  ON public.sales_daily FOR SELECT TO authenticated USING (true);

-- -------------------------------------------------------------
-- Refresh recent days from the (already-resolved) order items.
-- p_days = how many trailing days to re-aggregate (default 35, enough to
-- catch late order-status changes). Returns rows upserted.
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_refresh_sales_daily(p_days integer DEFAULT 35)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_role  text;
  v_count integer;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    SELECT role INTO v_role FROM public.profiles WHERE id = auth.uid();
    IF v_role IS DISTINCT FROM 'admin' AND v_role IS DISTINCT FROM 'manager' THEN
      RAISE EXCEPTION 'admin or manager role required';
    END IF;
  END IF;

  WITH agg AS (
    SELECT i.sku_id,
           o.order_date::date AS sale_date,
           SUM(i.quantity)::int AS units
      FROM public.shipstation_order_items i
      JOIN public.shipstation_orders o ON o.id = i.shipstation_order_id
     WHERE i.sku_id IS NOT NULL
       AND o.order_status IN ('shipped', 'awaiting_shipment')
       AND o.order_date >= current_date - make_interval(days => p_days)
       AND o.order_date <  current_date + 1
     GROUP BY i.sku_id, o.order_date::date
  ), up AS (
    INSERT INTO public.sales_daily (sku_id, sale_date, units, source)
    SELECT sku_id, sale_date, units, 'shipstation' FROM agg
    ON CONFLICT (sku_id, sale_date) DO UPDATE
      SET units = EXCLUDED.units, source = EXCLUDED.source, updated_at = now()
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM up;
  RETURN v_count;
END;
$$;

COMMENT ON TABLE public.sales_daily IS
  'Daily units sold per SKU — single source of truth for demand history. Recent days refreshed nightly from shipstation_order_items; historical filled by one-time backfill. Feeds demand recompute, Analytics, and the forecast engine.';
