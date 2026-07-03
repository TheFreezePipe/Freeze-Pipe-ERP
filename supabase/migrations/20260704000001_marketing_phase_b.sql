-- =============================================================
-- Marketing Phase B: close the loop (outcomes) — plan v0.3.1 §0
-- =============================================================
-- 1) mkt_sale_sku_lift — computed post-event outcomes ledger: for every
--    (ended sale, affected SKU) pair, units sold during the window vs a
--    trailing-28d pre-sale baseline, and the % lift. Written ONLY by the
--    nightly outcomes job; read by SalesDetail's performance block and
--    (Phase C) the measured-lift pre-fill.
--    Baseline v1 = simple trailing 28 days before the sale start. Known
--    caveat: overlapping prior promos inflate the baseline; Phase C's
--    promo-labeled history refines this.
-- 2) mkt_launch_skus outcomes: actual_first_30d_units (vs the planner's
--    expected_first_30d_units), sold_out_at (freezes the demand-censoring
--    fact the live derivation loses on restock), factory_order_id (optional
--    explicit PO pin; the UI also derives matches by SKU).
-- 3) mkt_broadcasts typed results columns (recipients/opens/clicks/revenue)
--    replacing ad-hoc jsonb entry (legacy `metrics` blob kept read-only).
-- 4) rpc_compute_marketing_outcomes() + nightly cron (05:20 UTC, after the
--    04:50 sales-daily refresh).

-- ---- 1. Sale lift ledger ---------------------------------------------------
CREATE TABLE IF NOT EXISTS public.mkt_sale_sku_lift (
  sale_id uuid NOT NULL REFERENCES public.mkt_sales(id) ON DELETE CASCADE,
  sku_id uuid NOT NULL REFERENCES public.product_skus(id) ON DELETE CASCADE,
  days integer NOT NULL,
  units_during integer NOT NULL DEFAULT 0,
  baseline_daily numeric NOT NULL DEFAULT 0,
  lift_pct numeric,
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sale_id, sku_id)
);
ALTER TABLE public.mkt_sale_sku_lift ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "mkt_sale_sku_lift readable" ON public.mkt_sale_sku_lift;
CREATE POLICY "mkt_sale_sku_lift readable"
  ON public.mkt_sale_sku_lift FOR SELECT TO authenticated USING (true);
-- no insert/update policies: written only by the SECURITY DEFINER job.

-- ---- 2. Launch outcome fields ----------------------------------------------
ALTER TABLE public.mkt_launch_skus
  ADD COLUMN IF NOT EXISTS actual_first_30d_units integer,
  ADD COLUMN IF NOT EXISTS sold_out_at date,
  ADD COLUMN IF NOT EXISTS factory_order_id uuid REFERENCES public.factory_orders(id);

-- ---- 3. Typed broadcast results ----------------------------------------------
ALTER TABLE public.mkt_broadcasts
  ADD COLUMN IF NOT EXISTS recipients integer,
  ADD COLUMN IF NOT EXISTS opens integer,
  ADD COLUMN IF NOT EXISTS clicks integer,
  ADD COLUMN IF NOT EXISTS revenue numeric;

-- ---- 4. Nightly outcomes job ---------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_compute_marketing_outcomes()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lift_rows int := 0;
  v_launch_rows int := 0;
  v_soldout_rows int := 0;
BEGIN
  -- (a) Sale lift: every ended sale's affected SKUs (via the expansion
  -- view). Recomputed idempotently; cheap at this scale.
  WITH pairs AS (
    SELECT DISTINCT e.sale_id, e.sku_id, e.starts_at::date AS d1, e.ends_at::date AS d2
    FROM mkt_offer_sku_expansion e
    WHERE e.sku_id IS NOT NULL AND e.ends_at::date < current_date
  ),
  ins AS (
    INSERT INTO mkt_sale_sku_lift (sale_id, sku_id, days, units_during, baseline_daily, lift_pct, computed_at)
    SELECT p.sale_id, p.sku_id,
           (p.d2 - p.d1 + 1),
           COALESCE(du.units, 0),
           ROUND(COALESCE(bl.daily, 0), 3),
           CASE WHEN COALESCE(bl.daily, 0) > 0
                THEN ROUND(((COALESCE(du.units, 0)::numeric / (p.d2 - p.d1 + 1)) / bl.daily - 1) * 100, 1)
           END,
           now()
    FROM pairs p
    LEFT JOIN LATERAL (
      SELECT SUM(sd.units)::int AS units FROM sales_daily sd
      WHERE sd.sku_id = p.sku_id AND sd.sale_date BETWEEN p.d1 AND p.d2
    ) du ON true
    LEFT JOIN LATERAL (
      SELECT SUM(sd.units)::numeric / 28 AS daily FROM sales_daily sd
      WHERE sd.sku_id = p.sku_id AND sd.sale_date >= p.d1 - 28 AND sd.sale_date < p.d1
    ) bl ON true
    ON CONFLICT (sale_id, sku_id) DO UPDATE
      SET days = EXCLUDED.days,
          units_during = EXCLUDED.units_during,
          baseline_daily = EXCLUDED.baseline_daily,
          lift_pct = EXCLUDED.lift_pct,
          computed_at = now()
    RETURNING 1
  )
  SELECT count(*) INTO v_lift_rows FROM ins;

  -- (b) Launch first-30d actuals, once the window has fully elapsed.
  -- (Aggregated first: an UPDATE target can't be referenced from a LATERAL
  -- in its own FROM clause.)
  WITH calc AS (
    SELECT k.id AS member_id, COALESCE(SUM(sd.units), 0)::int AS units
    FROM mkt_launch_skus k
    JOIN mkt_launches l ON l.id = k.launch_id
    LEFT JOIN sales_daily sd ON sd.sku_id = k.sku_id
      AND sd.sale_date >= l.launch_date AND sd.sale_date < l.launch_date + 30
    WHERE k.sku_id IS NOT NULL AND l.launch_date + 30 <= current_date
    GROUP BY k.id
  ),
  upd AS (
    UPDATE mkt_launch_skus k
       SET actual_first_30d_units = c.units
      FROM calc c
     WHERE c.member_id = k.id
       AND k.actual_first_30d_units IS DISTINCT FROM c.units
    RETURNING 1
  )
  SELECT count(*) INTO v_launch_rows FROM upd;

  -- (c) Freeze first sold-out date (nightly granularity) for launched
  -- members that hit zero total on-hand. Never un-set on restock.
  WITH so AS (
    UPDATE mkt_launch_skus k
       SET sold_out_at = current_date
      FROM mkt_launches l, inventory_levels il
     WHERE l.id = k.launch_id AND k.sku_id IS NOT NULL AND k.sold_out_at IS NULL
       AND l.launch_date <= current_date
       AND il.sku_id = k.sku_id
       AND (COALESCE(il.warehouse_raw, 0) + COALESCE(il.warehouse_prefilled_raw, 0)
            + COALESCE(il.warehouse_in_production, 0) + COALESCE(il.warehouse_finished, 0)
            + COALESCE(il.warehouse_other, 0)) <= 0
    RETURNING 1
  )
  SELECT count(*) INTO v_soldout_rows FROM so;

  RETURN jsonb_build_object('ok', true, 'lift_rows', v_lift_rows,
                            'launch_actuals', v_launch_rows, 'sold_out_marked', v_soldout_rows);
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_compute_marketing_outcomes() FROM public;
GRANT EXECUTE ON FUNCTION public.rpc_compute_marketing_outcomes() TO service_role;
