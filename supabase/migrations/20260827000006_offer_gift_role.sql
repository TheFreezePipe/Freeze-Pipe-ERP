-- =============================================================
-- Gift-aware offers: "buy any N of these SKUs → get X free"
-- =============================================================
-- The schema always held the fields (scope=sku_set + buy_qty/get_qty +
-- free_item_sku_id); what was missing is semantics. Research 2026-08-27:
-- the expansion view never emitted the FREE ITEM, so the one SKU with a
-- guaranteed unit drain was invisible to ops badges, the daily report,
-- and lift measurement — and if forced into the qualifier set it would
-- corrupt all three. Fix: rows now carry a ROLE.
--
--   member — a qualifier / discounted SKU (all previous behavior)
--   gift   — the offer's free_item_sku_id, regardless of scope; carries
--            NO discount depth (it isn't price-cut, it's given away) and
--            never gets a lift row (giveaway units are not organic lift).
--
-- mkt_offers.expected_orders (planner input): how many qualifying orders
-- the sale is expected to produce → giveaway units ≈ expected_orders ×
-- get_qty, surfaced on the ordering screens for the gift SKU.

-- ---- 1. Planner input -------------------------------------------------

ALTER TABLE public.mkt_offers
  ADD COLUMN IF NOT EXISTS expected_orders integer;
ALTER TABLE public.mkt_offers DROP CONSTRAINT IF EXISTS mkt_offers_expected_orders_check;
ALTER TABLE public.mkt_offers
  ADD CONSTRAINT mkt_offers_expected_orders_check
  CHECK (expected_orders IS NULL OR expected_orders > 0);
COMMENT ON COLUMN public.mkt_offers.expected_orders IS
  'Planner estimate: qualifying orders during the sale window. Gift offers: giveaway units = expected_orders × get_qty.';

-- ---- 2. Expansion view learns roles ----------------------------------

DROP VIEW IF EXISTS public.mkt_offer_sku_expansion;
CREATE VIEW public.mkt_offer_sku_expansion
WITH (security_invoker = true) AS
SELECT o.id AS offer_id,
       s.id AS sale_id,
       s.name AS sale_name,
       s.starts_at,
       s.ends_at,
       s.annual_recurring,
       s.approval_status,
       o.scope,
       x.sku_id,
       CASE WHEN x.role = 'gift' THEN NULL ELSE COALESCE(x.percent_off, o.percent_off) END AS percent_off,
       CASE WHEN x.role = 'gift' THEN NULL ELSE COALESCE(x.dollar_off, o.dollar_off) END AS dollar_off,
       CASE WHEN x.role = 'gift' THEN NULL ELSE COALESCE(x.planner_uplift_pct, o.expected_uplift_pct) END AS uplift_pct,
       CASE WHEN x.role = 'gift' THEN NULL ELSE COALESCE(o.effective_discount_pct, x.percent_off, o.percent_off) END AS effective_discount_pct,
       x.role,
       o.get_qty,
       o.expected_orders
FROM public.mkt_offers o
JOIN public.mkt_sales s ON s.id = o.sale_id
JOIN LATERAL (
  SELECT ps.id AS sku_id, NULL::numeric AS percent_off, NULL::numeric AS dollar_off, NULL::numeric AS planner_uplift_pct, 'member'::text AS role
    FROM public.product_skus ps
   WHERE o.scope = 'sitewide' AND ps.is_active
  UNION ALL
  SELECT ps.id, NULL::numeric, NULL::numeric, NULL::numeric, 'member'
    FROM public.product_skus ps
   WHERE o.scope = 'category' AND ps.is_active AND ps.display_category = o.category
  UNION ALL
  SELECT os.sku_id, os.percent_off, os.dollar_off, os.planner_uplift_pct, 'member'
    FROM public.mkt_offer_skus os
   WHERE o.scope = 'sku_set' AND os.offer_id = o.id
  UNION ALL
  -- the gift: one row whatever the qualifier scope is (fixes the doubly
  -- invisible "sitewide free X over $75" pattern too)
  SELECT o.free_item_sku_id, NULL::numeric, NULL::numeric, NULL::numeric, 'gift'
   WHERE o.free_item_sku_id IS NOT NULL
) x ON true;

COMMENT ON VIEW public.mkt_offer_sku_expansion IS
  'Resolves every offer to concrete SKUs. role=member: qualifier/discounted SKU by scope (sitewide→active catalog, category→display_category, sku_set→mkt_offer_skus). role=gift: the offer''s free_item_sku_id (any scope; no discount depth — giveaway drain, not a price cut; excluded from lift). The single source for "which SKUs does a sale touch" — ops badges, digest, lift, forecast overlay key on this.';

-- ---- 3. Lift never attributes giveaway units --------------------------

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
  WITH pairs AS (
    SELECT DISTINCT e.sale_id, e.sku_id, e.starts_at::date AS d1, e.ends_at::date AS d2
    FROM mkt_offer_sku_expansion e
    WHERE e.sku_id IS NOT NULL
      AND e.role <> 'gift'                  -- giveaways are not organic lift
      AND e.starts_at IS NOT NULL           -- guard: NULL start crashed days=NOT NULL
      AND e.ends_at IS NOT NULL
      AND e.ends_at::date < current_date
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

  WITH calc AS (
    SELECT k.id AS member_id, COALESCE(SUM(sd.units), 0)::int AS units
    FROM mkt_launch_skus k
    JOIN mkt_launches l ON l.id = k.launch_id
    LEFT JOIN sales_daily sd ON sd.sku_id = k.sku_id
      AND sd.sale_date >= l.launch_date AND sd.sale_date < l.launch_date + 30
    WHERE k.sku_id IS NOT NULL AND l.launch_date IS NOT NULL AND l.launch_date + 30 <= current_date
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

  WITH so AS (
    UPDATE mkt_launch_skus k
       SET sold_out_at = current_date
      FROM mkt_launches l, inventory_levels il
     WHERE l.id = k.launch_id AND k.sku_id IS NOT NULL AND k.sold_out_at IS NULL
       AND l.launch_date IS NOT NULL AND l.launch_date <= current_date
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
