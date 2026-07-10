-- =============================================================
-- Marketing fix batch (2026-07-10 integration audit)
-- =============================================================
-- 1) rpc_save_launch — ATOMIC launch create/update + member reconciliation
--    that PRESERVES the Phase B outcome columns (sold_out_at,
--    actual_first_30d_units, factory_order_id). Replaces the non-atomic
--    delete-then-reinsert in useUpdate/CreateLaunch, which stranded rows on
--    failure and wiped outcomes on every edit. SECURITY INVOKER so the
--    existing admin/manager RLS write gate (jwt_is_internal) still applies
--    and created_by's auth.uid() default resolves to the caller.
-- 2) rpc_compute_marketing_outcomes — skip sales with a NULL start date so
--    one bad row can't crash the whole nightly job (days = NULL violated a
--    NOT NULL). The SaleFormDialog now also requires both dates.
-- 3) Record the marketing-outcomes-nightly cron in a migration (it was
--    scheduled live but never captured in version control).

-- ---- 1. Atomic launch save --------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_save_launch(
  p_id uuid,
  p_launch jsonb,
  p_members jsonb
) RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_id IS NULL THEN
    -- created_by omitted → column default auth.uid() fills it.
    INSERT INTO mkt_launches (kind, name, launch_date, inventory_ready_by, preorder, notes)
    VALUES (
      COALESCE(p_launch->>'kind', 'launch'),
      p_launch->>'name',
      (p_launch->>'launch_date')::date,
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
$$;

GRANT EXECUTE ON FUNCTION public.rpc_save_launch(uuid, jsonb, jsonb) TO authenticated;

-- ---- 2. Outcomes RPC: skip NULL-dated sales ---------------------------------
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

-- ---- 3. Record the nightly cron (idempotent) --------------------------------
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'marketing-outcomes-nightly';
SELECT cron.schedule('marketing-outcomes-nightly', '20 5 * * *',
                     $$SELECT public.rpc_compute_marketing_outcomes();$$);
