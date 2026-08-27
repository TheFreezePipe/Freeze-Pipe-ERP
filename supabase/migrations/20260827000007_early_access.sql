-- =============================================================
-- Early Access dates on sales + launches
-- =============================================================
-- Owner 2026-08-27: sales/launches frequently open early to top-spending
-- email subscribers, and that window is operationally real — demand starts
-- at EA, not at the public date. One optional date on each event:
--
--   mkt_sales.early_access_starts_at  (EA runs from here to starts_at)
--   mkt_launches.early_access_date    (EA runs from here to launch_date)
--
-- The expansion view exposes the sale EA date, and the lift job's sale
-- window now begins at EA — early-access sales are sale-driven demand.

ALTER TABLE public.mkt_sales ADD COLUMN IF NOT EXISTS early_access_starts_at timestamptz;
ALTER TABLE public.mkt_sales DROP CONSTRAINT IF EXISTS mkt_sales_early_access_check;
ALTER TABLE public.mkt_sales ADD CONSTRAINT mkt_sales_early_access_check
  CHECK (early_access_starts_at IS NULL OR starts_at IS NULL OR early_access_starts_at <= starts_at);
COMMENT ON COLUMN public.mkt_sales.early_access_starts_at IS
  'Optional: top-subscriber early access opens here; public start is starts_at.';

ALTER TABLE public.mkt_launches ADD COLUMN IF NOT EXISTS early_access_date date;
ALTER TABLE public.mkt_launches DROP CONSTRAINT IF EXISTS mkt_launches_early_access_check;
ALTER TABLE public.mkt_launches ADD CONSTRAINT mkt_launches_early_access_check
  CHECK (early_access_date IS NULL OR launch_date IS NULL OR early_access_date <= launch_date);
COMMENT ON COLUMN public.mkt_launches.early_access_date IS
  'Optional: top-subscriber early access opens here; public launch is launch_date.';

-- ---- rpc_save_launch learns the field --------------------------------

CREATE OR REPLACE FUNCTION public.rpc_save_launch(p_id uuid, p_launch jsonb, p_members jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_id uuid;
BEGIN
  IF p_id IS NULL THEN
    -- created_by omitted → column default auth.uid() fills it.
    INSERT INTO mkt_launches (kind, name, launch_date, early_access_date, inventory_ready_by, preorder, notes)
    VALUES (
      COALESCE(p_launch->>'kind', 'launch'),
      p_launch->>'name',
      (p_launch->>'launch_date')::date,
      (p_launch->>'early_access_date')::date,
      (p_launch->>'inventory_ready_by')::date,
      COALESCE((p_launch->>'preorder')::boolean, false),
      p_launch->>'notes'
    )
    RETURNING id INTO v_id;
  ELSE
    v_id := p_id;
    UPDATE mkt_launches SET
      kind               = COALESCE(p_launch->>'kind', kind),
      name               = COALESCE(p_launch->>'name', name),
      launch_date        = CASE WHEN p_launch ? 'launch_date'        THEN (p_launch->>'launch_date')::date        ELSE launch_date END,
      early_access_date  = CASE WHEN p_launch ? 'early_access_date'  THEN (p_launch->>'early_access_date')::date  ELSE early_access_date END,
      inventory_ready_by = CASE WHEN p_launch ? 'inventory_ready_by' THEN (p_launch->>'inventory_ready_by')::date ELSE inventory_ready_by END,
      preorder           = CASE WHEN p_launch ? 'preorder'           THEN (p_launch->>'preorder')::boolean        ELSE preorder END,
      notes              = CASE WHEN p_launch ? 'notes'              THEN p_launch->>'notes'                      ELSE notes END,
      updated_at         = now()
    WHERE id = v_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'launch % not found', v_id;
    END IF;
  END IF;

  -- p_members NULL → members untouched (e.g. a calendar drag that only
  -- shifts dates). A provided array (even empty) reconciles membership.
  IF p_members IS NOT NULL THEN
    -- (a) Upsert real-SKU members; ON CONFLICT preserves the outcome columns
    -- (they are simply not in the SET list). sort_order uses the member's
    -- global position in the array so real + planned rows stay in order.
    INSERT INTO mkt_launch_skus (
      launch_id, sku_id, planned_name, expected_first_30d_units,
      limited_qty, planner_confidence, sort_order
    )
    SELECT v_id,
           (m->>'sku_id')::uuid,
           m->>'planned_name',
           (m->>'expected_first_30d_units')::int,
           (m->>'limited_qty')::int,
           (m->>'planner_confidence')::int,
           (ord - 1)::int
    FROM jsonb_array_elements(p_members) WITH ORDINALITY AS t(m, ord)
    WHERE (m->>'sku_id') IS NOT NULL
    ON CONFLICT (launch_id, sku_id) WHERE sku_id IS NOT NULL
    DO UPDATE SET
      planned_name             = EXCLUDED.planned_name,
      expected_first_30d_units = EXCLUDED.expected_first_30d_units,
      limited_qty              = EXCLUDED.limited_qty,
      planner_confidence       = EXCLUDED.planner_confidence,
      sort_order               = EXCLUDED.sort_order,
      updated_at               = now();

    -- (b) Drop real-SKU members no longer in the incoming set (NOT IN over a
    -- NULL-free subquery; empty array → removes all real-SKU members).
    DELETE FROM mkt_launch_skus k
    WHERE k.launch_id = v_id
      AND k.sku_id IS NOT NULL
      AND k.sku_id NOT IN (
        SELECT (m->>'sku_id')::uuid
        FROM jsonb_array_elements(p_members) AS m
        WHERE (m->>'sku_id') IS NOT NULL
      );

    -- (c) Planned-name-only rows carry no outcomes → replace wholesale.
    DELETE FROM mkt_launch_skus WHERE launch_id = v_id AND sku_id IS NULL;
    INSERT INTO mkt_launch_skus (
      launch_id, sku_id, planned_name, expected_first_30d_units,
      limited_qty, planner_confidence, sort_order
    )
    SELECT v_id, NULL, m->>'planned_name',
           (m->>'expected_first_30d_units')::int,
           (m->>'limited_qty')::int,
           (m->>'planner_confidence')::int,
           (ord - 1)::int
    FROM jsonb_array_elements(p_members) WITH ORDINALITY AS t(m, ord)
    WHERE (m->>'sku_id') IS NULL;
  END IF;

  RETURN v_id;
END;
$function$;

-- ---- Expansion view exposes the sale's EA date ------------------------

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
       o.expected_orders,
       s.early_access_starts_at
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
  -- the gift: one row whatever the qualifier scope is
  SELECT o.free_item_sku_id, NULL::numeric, NULL::numeric, NULL::numeric, 'gift'
   WHERE o.free_item_sku_id IS NOT NULL
) x ON true;

COMMENT ON VIEW public.mkt_offer_sku_expansion IS
  'Resolves every offer to concrete SKUs. role=member: qualifier/discounted SKU by scope (sitewide→active catalog, category→display_category, sku_set→mkt_offer_skus). role=gift: the offer''s free_item_sku_id (any scope; no discount depth — giveaway drain, not a price cut; excluded from lift). early_access_starts_at: the sale''s EA open, when set. The single source for "which SKUs does a sale touch".';

-- ---- Lift window starts at Early Access -------------------------------

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
    SELECT DISTINCT e.sale_id, e.sku_id,
           COALESCE(e.early_access_starts_at, e.starts_at)::date AS d1,  -- EA sales are sale demand
           e.ends_at::date AS d2
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
