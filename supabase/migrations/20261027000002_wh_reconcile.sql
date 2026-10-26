-- =============================================================
-- Migration: Warehouse nightly reconciliation, count scheduler, cron,
--            daily report key (Phase 1, slice 4E)
-- =============================================================
-- Design: docs/design/WAREHOUSE_MODULE_PHASE0_1.md §4.3 (wh_reconcile_runs,
-- wh_reconcile_lines, reconcile and count_schedule settings), §6 (nightly
-- reconciliation), §8 (schedule), §11 (rollout).
--
-- Finding: with the ledger mirror and ship settlement in place
-- (20261027000001) the physical layer and the SKU books should agree by
-- one identity per SKU, and nothing checks it yet; counts are only ad hoc.
-- Decision:
--   * rpc_wh_reconcile_physical(p_create_counts DEFAULT true), admin or
--     service (service_role, the postgres session for cron and smoke):
--       1. While live, sweeps ship settlements first: admitted orders whose
--          target and settled units differ or whose last attempt failed
--          (cancelled orders stay deferred), plus shipped orders with no
--          settlement row and a ship_date after the go-live day (a missed
--          trigger).
--       2. Prunes zero balances (§4.3): on_hand and allocated 0, no
--          movement for 30 days, container empty, void or none.
--       3. Per SKU and bucket, from one snapshot:
--            P = on_hand of balances at every active location (IN-01,
--                MFG-LINE and UNLOCATED included);
--            O = net order_shipped + shipstation_ledger_rebase units of
--                orders neither shipped nor cancelled;
--            H = the same for cancelled orders (deducted, never credited);
--            S = Σ over admitted orders of (target − settled): units the
--                ledger took on shipped orders that settlement has not
--                moved (non-zero only after a failure), minus units settled
--                on orders that are no longer shipped;
--            L = inventory_levels.warehouse_<bucket>.
--          finished: R = P − O − H − S − L; other buckets: R = P − L
--          (O, H and S are finished-only). The settled identity is
--          P − O = L.
--       4. Writes one wh_reconcile_runs row: skus_checked (SKUs with any
--          physical, levels or order term), mismatched_skus (SKUs with a
--          non-zero R in any bucket), abs_residual_units (Σ|R|),
--          unlocated_units (Σ|on_hand| at UNLOCATED, absolute so +5 of one
--          SKU and −5 of another read as 10), rts_unplaced_cartons (green
--          cartons still at MFG-LINE whose finished_at is over two hours
--          old).
--       5. With reconcile.create_counts, p_create_counts and live: per SKU
--          with a finished R, `reconcile` counts on up to
--          reconcile.max_counts_per_sku active pickable locations that hold
--          or held the SKU (holding first, then pick_sequence). A location
--          with an open or counting task keeps it (its id is listed, no
--          duplicate); every listed location counts toward the cap.
--       6. One wh_reconcile_lines row per (SKU, bucket) with a non-zero R,
--          H or S, with the count task ids.
--     Before live_since the call still computes and records a run (the
--     practice floor can read one) but creates no counts and sweeps no
--     settlements.
--   * rpc_wh_schedule_counts(), admin or service (§8): a location is due
--     when last_counted_at is null or older than the shortest cadence of
--     the SKUs it holds (product_skus.abc_classification A → A_days,
--     B → B_days, anything else → C_days). Never counted is most overdue,
--     then by the date it fell due, then pick_sequence. Skips virtual and
--     station locations and the transit zones IN, OUT and MFG (proposed:
--     staging areas turn over daily and are not storage), and any location
--     with a task open, counting or submitted (no duplicates). daily_cap
--     bounds the `scheduled` tasks created per UTC day, so a second call
--     the same day adds only what the first left under the cap.
--   * pg_cron: 'wh-reconcile' 09:00 UTC and 'wh-schedule-counts' 09:10 UTC
--     as plain SQL (no HTTP, no project URL), each gated on _wh_live() so
--     nothing runs nightly before go-live. Existing jobs of those names are
--     unscheduled first, so the migration re-applies cleanly.
--   * rpc_daily_report: re-issued whole from the live staging body
--     (pg_get_functiondef, 2026-10-26) with one addition, the `warehouse`
--     key {mismatched_skus, abs_units, unlocated_units, rts_unplaced} from
--     the latest wh_reconcile_runs row (null before the first run) plus
--     run_at, and {putaway_over_24h, counts_due} live from the task tables
--     (counts due on or before the report's ET today). Every other key,
--     the security definer, search_path and the service_role-only ACL
--     (20260930000003) are unchanged; the function has no comment.
--   * rpc_wh_overview already returns the latest run as last_reconcile
--     (20261022000004); unchanged.
--
-- Smoke after deploy (each call inside a transaction that is rolled back,
-- since the first two write; a validation envelope passes, a relation
-- error fails):
--   SELECT public.rpc_wh_reconcile_physical(false);                           -- {ok:true, live:false, counts_enabled:false, ...}
--   SELECT public.rpc_wh_schedule_counts();                                   -- {ok:true, created:n, due:n, ...}
--   SELECT (public.rpc_daily_report())->'warehouse';                          -- {mismatched_skus, abs_units, unlocated_units, ...}
--   SELECT string_agg(jobname || ' ' || schedule || ' ' || command, ' | ' ORDER BY jobname) FROM cron.job WHERE jobname LIKE 'wh-%';  -- both jobs, plain SQL
-- =============================================================

BEGIN;

-- -------------------------------------------------------------
-- A. rpc_wh_reconcile_physical (§6)
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_wh_reconcile_physical(p_create_counts boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor    uuid;
  v_live     boolean := public._wh_live();
  v_since    timestamptz := public._wh_live_since();
  v_cfg      jsonb := COALESCE(public._wh_setting('reconcile'), '{}'::jsonb);
  v_counts   boolean;
  v_max      integer;
  v_unloc    uuid := public._wh_loc_id('UNLOCATED');
  v_mfg      uuid := public._wh_loc_id('MFG-LINE');
  v_oid      uuid;
  v_res      jsonb;
  v_swept    integer := 0;
  v_sw_units integer := 0;
  v_sw_short integer := 0;
  v_sw_err   integer := 0;
  v_pruned   integer := 0;
  v_run      public.wh_reconcile_runs%ROWTYPE;
  v_r        record;
  v_loc      record;
  v_ids      uuid[];
  v_cnt      jsonb;
  v_created  integer := 0;
  v_lines    integer := 0;
BEGIN
  IF public._wh_require_role(ARRAY['admin']) IS NULL THEN
    RETURN public._wh_err('forbidden', 'The physical reconciliation needs an admin.');
  END IF;
  v_actor := public._wh_actor(NULL);
  PERFORM pg_advisory_xact_lock(hashtextextended('wh_reconcile_physical', 0));
  v_counts := COALESCE(p_create_counts, true) AND COALESCE((v_cfg->>'create_counts')::boolean, true) AND v_live;
  v_max := GREATEST(COALESCE((v_cfg->>'max_counts_per_sku')::int, 3), 0);

  -- 1. sweep ship settlements (dormant before live_since)
  IF v_live THEN
    FOR v_oid IN
      SELECT p.order_id FROM public._wh_settlement_pairs() p
       WHERE p.order_status <> 'cancelled' AND p.target <> p.settled
      UNION
      SELECT s.shipstation_order_id
        FROM public.wh_order_settlements s
        JOIN public.shipstation_orders o ON o.id = s.shipstation_order_id
       WHERE s.method = 'ship_settle' AND s.last_error IS NOT NULL AND o.order_status <> 'cancelled'
      UNION
      SELECT o.id
        FROM public.shipstation_orders o
       WHERE o.order_status = 'shipped'
         AND o.ship_date >= (date_trunc('day', v_since AT TIME ZONE 'UTC') + interval '1 day') AT TIME ZONE 'UTC'
         AND NOT EXISTS (SELECT 1 FROM public.wh_order_settlements s WHERE s.shipstation_order_id = o.id)
    LOOP
      v_res := public._wh_settle_order_safe(v_oid);
      v_swept := v_swept + 1;
      IF COALESCE((v_res->>'ok')::boolean, false) THEN
        v_sw_units := v_sw_units + COALESCE((v_res->>'drawn')::int, 0) + COALESCE((v_res->>'shortfall')::int, 0);
        v_sw_short := v_sw_short + COALESCE((v_res->>'shortfall')::int, 0);
      ELSE
        v_sw_err := v_sw_err + 1;
      END IF;
    END LOOP;
  END IF;

  -- 2. prune zero balances (§4.3)
  DELETE FROM public.wh_inventory_balances b
   WHERE b.on_hand = 0 AND b.allocated = 0
     AND COALESCE(b.last_movement_at, b.created_at) < now() - interval '30 days'
     AND (b.container_id IS NULL
          OR EXISTS (SELECT 1 FROM public.wh_containers c WHERE c.id = b.container_id AND c.state IN ('empty', 'void')));
  GET DIAGNOSTICS v_pruned = ROW_COUNT;

  -- 3. P, O, H, S, L and R per SKU and bucket
  DROP TABLE IF EXISTS pg_temp._wh_rec;
  CREATE TEMP TABLE _wh_rec (
    sku_id      uuid,
    bucket      text,
    physical    integer,
    open_orders integer,
    held        integer,
    unsettled   integer,
    levels      integer,
    residual    integer,
    count_ids   uuid[]
  ) ON COMMIT DROP;

  INSERT INTO _wh_rec (sku_id, bucket, physical, open_orders, held, unsettled, levels, residual)
  WITH phys AS (
    SELECT b.sku_id, b.bucket, SUM(b.on_hand)::int AS p
      FROM public.wh_inventory_balances b
      JOIN public.wh_locations l ON l.id = b.location_id
     WHERE l.active
     GROUP BY 1, 2
  ),
  led AS (
    SELECT x.reference_id AS order_id, x.sku_id, SUM(-x.quantity)::int AS net
      FROM public.inventory_transactions x
     WHERE x.reference_type = 'shipstation_order' AND x.reference_id IS NOT NULL AND x.sku_id IS NOT NULL
       AND x.transaction_type IN ('order_shipped', 'shipstation_ledger_rebase')
     GROUP BY 1, 2
  ),
  ord AS (
    SELECT l.sku_id,
           COALESCE(SUM(l.net) FILTER (WHERE o.order_status NOT IN ('shipped', 'cancelled')), 0)::int AS o_units,
           COALESCE(SUM(l.net) FILTER (WHERE o.order_status = 'cancelled'), 0)::int AS h_units
      FROM led l
      JOIN public.shipstation_orders o ON o.id = l.order_id
     GROUP BY 1
  ),
  uns AS (
    SELECT p.sku_id, SUM(p.target - p.settled)::int AS s_units
      FROM public._wh_settlement_pairs() p
     GROUP BY 1
  ),
  lv AS (
    SELECT il.sku_id, v.bucket, SUM(v.qty)::int AS l
      FROM public.inventory_levels il
      CROSS JOIN LATERAL (VALUES ('raw', COALESCE(il.warehouse_raw, 0)),
                                 ('prefilled_raw', COALESCE(il.warehouse_prefilled_raw, 0)),
                                 ('in_production', COALESCE(il.warehouse_in_production, 0)),
                                 ('finished', COALESCE(il.warehouse_finished, 0)),
                                 ('other', COALESCE(il.warehouse_other, 0))) AS v(bucket, qty)
     WHERE il.sku_id IS NOT NULL
     GROUP BY 1, 2
  ),
  keys AS (
    SELECT phys.sku_id, phys.bucket FROM phys
    UNION SELECT lv.sku_id, lv.bucket FROM lv WHERE lv.l <> 0
    UNION SELECT ord.sku_id, 'finished' FROM ord WHERE ord.o_units <> 0 OR ord.h_units <> 0
    UNION SELECT uns.sku_id, 'finished' FROM uns WHERE uns.s_units <> 0
  )
  SELECT k.sku_id, k.bucket,
         COALESCE(p.p, 0),
         CASE WHEN k.bucket = 'finished' THEN COALESCE(o.o_units, 0) ELSE 0 END,
         CASE WHEN k.bucket = 'finished' THEN COALESCE(o.h_units, 0) ELSE 0 END,
         CASE WHEN k.bucket = 'finished' THEN COALESCE(u.s_units, 0) ELSE 0 END,
         COALESCE(lv.l, 0),
         COALESCE(p.p, 0) - COALESCE(lv.l, 0)
           - CASE WHEN k.bucket = 'finished'
                  THEN COALESCE(o.o_units, 0) + COALESCE(o.h_units, 0) + COALESCE(u.s_units, 0)
                  ELSE 0 END
    FROM keys k
    LEFT JOIN phys p ON p.sku_id = k.sku_id AND p.bucket = k.bucket
    LEFT JOIN lv ON lv.sku_id = k.sku_id AND lv.bucket = k.bucket
    LEFT JOIN ord o ON o.sku_id = k.sku_id
    LEFT JOIN uns u ON u.sku_id = k.sku_id;

  -- 4. the run
  INSERT INTO public.wh_reconcile_runs (run_at, actor_id, skus_checked, mismatched_skus, abs_residual_units,
                                        unlocated_units, rts_unplaced_cartons)
  SELECT now(), v_actor,
         (SELECT count(DISTINCT r.sku_id) FROM _wh_rec r)::int,
         (SELECT count(DISTINCT r.sku_id) FROM _wh_rec r WHERE r.residual <> 0)::int,
         (SELECT COALESCE(SUM(abs(r.residual)), 0) FROM _wh_rec r)::int,
         (SELECT COALESCE(SUM(abs(b.on_hand)), 0) FROM public.wh_inventory_balances b WHERE b.location_id = v_unloc)::int,
         (SELECT count(*) FROM public.wh_containers c
           WHERE c.label_stock = 'green' AND c.state IN ('sealed', 'open') AND c.location_id = v_mfg
             AND COALESCE(c.finished_at, c.created_at) < now() - interval '2 hours')::int
  RETURNING * INTO v_run;

  -- 5. reconcile counts on finished residuals
  IF v_counts AND v_max > 0 THEN
    FOR v_r IN
      SELECT r.sku_id, r.residual, ps.sku
        FROM _wh_rec r
        JOIN public.product_skus ps ON ps.id = r.sku_id
       WHERE r.bucket = 'finished' AND r.residual <> 0
       ORDER BY abs(r.residual) DESC, ps.sku
    LOOP
      v_ids := '{}';
      FOR v_loc IN
        SELECT l.id
          FROM public.wh_locations l
          JOIN LATERAL (SELECT bool_or(b.on_hand <> 0) AS holds
                          FROM public.wh_inventory_balances b
                         WHERE b.location_id = l.id AND b.sku_id = v_r.sku_id AND b.bucket = 'finished') h
            ON h.holds IS NOT NULL
         WHERE l.active AND l.pickable
         ORDER BY h.holds DESC, l.pick_sequence NULLS LAST, l.code
         LIMIT v_max
      LOOP
        v_cnt := public._wh_open_count(v_loc.id, 'reconcile', v_r.sku_id,
                   format('Reconcile %s: %s %s%s', to_char(current_date, 'YYYY-MM-DD'), v_r.sku,
                          CASE WHEN v_r.residual > 0 THEN '+' ELSE '' END, v_r.residual),
                   'wh_reconcile_run', v_run.id, v_actor);
        IF COALESCE((v_cnt->>'created')::boolean, false) THEN
          v_created := v_created + 1;
        END IF;
        IF (v_cnt->>'id') IS NOT NULL THEN
          v_ids := v_ids || (v_cnt->>'id')::uuid;
        END IF;
      END LOOP;
      UPDATE _wh_rec SET count_ids = v_ids WHERE sku_id = v_r.sku_id AND bucket = 'finished';
    END LOOP;
  END IF;

  -- 6. lines
  INSERT INTO public.wh_reconcile_lines (run_id, sku_id, bucket, physical, open_order_units, cancelled_held_units,
                                         unsettled_units, levels_value, residual, count_task_ids)
  SELECT v_run.id, r.sku_id, r.bucket, r.physical, r.open_orders, r.held, r.unsettled, r.levels, r.residual,
         NULLIF(r.count_ids, '{}'::uuid[])
    FROM _wh_rec r
   WHERE r.residual <> 0 OR r.held <> 0 OR r.unsettled <> 0;
  GET DIAGNOSTICS v_lines = ROW_COUNT;

  RETURN jsonb_build_object(
    'ok', true,
    'run_id', v_run.id,
    'run_at', v_run.run_at,
    'live', v_live,
    'skus_checked', v_run.skus_checked,
    'mismatched_skus', v_run.mismatched_skus,
    'abs_residual_units', v_run.abs_residual_units,
    'unlocated_units', v_run.unlocated_units,
    'rts_unplaced_cartons', v_run.rts_unplaced_cartons,
    'lines', v_lines,
    'counts_enabled', v_counts,
    'counts_created', v_created,
    'sweep', jsonb_build_object('orders', v_swept, 'units', v_sw_units, 'shortfall', v_sw_short, 'errors', v_sw_err),
    'pruned_balances', v_pruned);
END;
$$;

-- -------------------------------------------------------------
-- B. rpc_wh_schedule_counts (§8)
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_wh_schedule_counts()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor  uuid;
  v_cfg    jsonb := COALESCE(public._wh_setting('count_schedule'), '{}'::jsonb);
  v_a      integer := COALESCE((v_cfg->>'A_days')::int, 7);
  v_b      integer := COALESCE((v_cfg->>'B_days')::int, 30);
  v_c      integer := COALESCE((v_cfg->>'C_days')::int, 90);
  v_cap    integer := COALESCE((v_cfg->>'daily_cap')::int, 20);
  v_today  integer;
  v_room   integer;
  v_due    integer := 0;
  v_busy   integer := 0;
  v_ids    uuid[] := '{}';
  v_l      record;
  v_cnt    jsonb;
BEGIN
  IF public._wh_require_role(ARRAY['admin']) IS NULL THEN
    RETURN public._wh_err('forbidden', 'Scheduling counts needs an admin.');
  END IF;
  v_actor := public._wh_actor(NULL);
  PERFORM pg_advisory_xact_lock(hashtextextended('wh_schedule_counts', 0));
  SELECT count(*) INTO v_today FROM public.wh_count_tasks
   WHERE kind = 'scheduled' AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  v_room := GREATEST(v_cap - v_today, 0);

  FOR v_l IN
    WITH held AS (
      SELECT b.location_id, b.sku_id, ps.sku, upper(ps.abc_classification) AS cls,
             CASE upper(ps.abc_classification) WHEN 'A' THEN v_a WHEN 'B' THEN v_b ELSE v_c END AS days
        FROM public.wh_inventory_balances b
        JOIN public.product_skus ps ON ps.id = b.sku_id
       WHERE b.on_hand <> 0
    ),
    cad AS (
      SELECT DISTINCT ON (h.location_id) h.location_id, h.sku_id, h.sku, h.cls, h.days
        FROM held h
       ORDER BY h.location_id, h.days, h.sku
    )
    SELECT l.id, l.code, c.sku_id, c.sku, c.cls, c.days,
           EXISTS (SELECT 1 FROM public.wh_count_tasks t
                    WHERE t.location_id = l.id AND t.status IN ('open', 'counting', 'submitted')) AS busy
      FROM cad c
      JOIN public.wh_locations l ON l.id = c.location_id
     WHERE l.active AND l.kind NOT IN ('virtual', 'station') AND l.zone NOT IN ('IN', 'OUT', 'MFG')
       AND (l.last_counted_at IS NULL OR l.last_counted_at < now() - make_interval(days => c.days))
     ORDER BY l.last_counted_at + make_interval(days => c.days) ASC NULLS FIRST, l.pick_sequence NULLS LAST, l.code
  LOOP
    v_due := v_due + 1;
    IF v_l.busy THEN
      v_busy := v_busy + 1;
      CONTINUE;
    END IF;
    CONTINUE WHEN cardinality(v_ids) >= v_room;
    v_cnt := public._wh_open_count(v_l.id, 'scheduled', v_l.sku_id,
               format('Scheduled count: %s (%s, every %s days)', v_l.sku,
                      CASE WHEN v_l.cls IN ('A', 'B', 'C') THEN v_l.cls || '-class' ELSE 'unclassified' END, v_l.days),
               NULL, NULL, v_actor);
    IF COALESCE((v_cnt->>'created')::boolean, false) THEN
      v_ids := v_ids || (v_cnt->>'id')::uuid;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('ok', true,
                            'created', cardinality(v_ids),
                            'count_task_ids', to_jsonb(v_ids),
                            'due', v_due,
                            'already_open', v_busy,
                            'left_for_later', GREATEST(v_due - v_busy - cardinality(v_ids), 0),
                            'daily_cap', v_cap,
                            'scheduled_today', v_today + cardinality(v_ids));
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_wh_reconcile_physical(boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rpc_wh_schedule_counts() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_wh_reconcile_physical(boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_wh_schedule_counts() TO authenticated, service_role;

-- -------------------------------------------------------------
-- C. pg_cron: nightly, plain SQL, nothing before go-live
-- -------------------------------------------------------------
DO $$
DECLARE v_job bigint;
BEGIN
  FOR v_job IN SELECT jobid FROM cron.job WHERE jobname IN ('wh-reconcile', 'wh-schedule-counts') LOOP
    PERFORM cron.unschedule(v_job);
  END LOOP;
END $$;

SELECT cron.schedule('wh-reconcile', '0 9 * * *',
  $cron$SELECT public.rpc_wh_reconcile_physical() WHERE public._wh_live()$cron$);
SELECT cron.schedule('wh-schedule-counts', '10 9 * * *',
  $cron$SELECT public.rpc_wh_schedule_counts() WHERE public._wh_live()$cron$);

-- -------------------------------------------------------------
-- D. rpc_daily_report: the live body plus the `warehouse` key
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_daily_report()
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
WITH d AS (
  SELECT (now() AT TIME ZONE 'America/New_York')::date AS today,
         ((now() AT TIME ZONE 'America/New_York')::date - 1) AS yday
),
sold AS (
  SELECT sd.sku_id, SUM(sd.units)::int AS units
  FROM sales_daily sd, d
  WHERE sd.sale_date = d.yday
  GROUP BY sd.sku_id
),
avg30 AS (
  SELECT sd.sku_id, SUM(sd.units)::numeric / 30 AS avg_daily
  FROM sales_daily sd, d
  WHERE sd.sale_date >= d.yday - 30 AND sd.sale_date < d.yday
  GROUP BY sd.sku_id
),
sales_rows AS (
  SELECT ps.sku, ps.product_name, sold.units,
         ROUND(COALESCE(avg30.avg_daily, 0), 1) AS avg_daily,
         CASE
           WHEN COALESCE(avg30.avg_daily, 0) >= 1 AND sold.units >= 2 * avg30.avg_daily THEN 'above'
           WHEN COALESCE(avg30.avg_daily, 0) >= 1 AND sold.units <= 0.5 * avg30.avg_daily THEN 'below'
           ELSE NULL
         END AS flag
  FROM sold
  JOIN product_skus ps ON ps.id = sold.sku_id
  LEFT JOIN avg30 ON avg30.sku_id = sold.sku_id
  WHERE COALESCE(ps.display_category, '') NOT IN ('Bases', 'Coils')
),
incoming_rows AS (
  SELECT fs.shipment_number, fs.carrier_name, fs.freight_type, fs.eta,
         (fs.eta - (SELECT today FROM d)) AS days_out,
         COALESCE(
           jsonb_agg(jsonb_build_object('sku', COALESCE(ps.sku, fli.custom_description), 'name', ps.product_name,
                     'qty', GREATEST(fli.quantity - fli.quantity_received, 0))
                     ORDER BY ps.sku)
           FILTER (WHERE fli.id IS NOT NULL AND GREATEST(fli.quantity - fli.quantity_received, 0) > 0
                   AND COALESCE(ps.display_category, '') NOT IN ('Bases', 'Coils')),
           '[]'::jsonb
         ) AS items
  FROM freight_shipments fs
  LEFT JOIN freight_line_items fli ON fli.freight_shipment_id = fs.id
  LEFT JOIN product_skus ps ON ps.id = fli.sku_id
  WHERE fs.status = 'tracking'
  GROUP BY fs.id, fs.shipment_number, fs.carrier_name, fs.freight_type, fs.eta
  HAVING count(*) FILTER (WHERE fli.id IS NOT NULL AND GREATEST(fli.quantity - fli.quantity_received, 0) > 0
                          AND COALESCE(ps.display_category, '') NOT IN ('Bases', 'Coils')) > 0
),
eff AS (
  SELECT ps.id AS sku_id, ps.sku, ps.product_name,
         COALESCE(
           CASE ov.mode
             WHEN 'manual'   THEN ov.monthly_demand
             WHEN 'trailing' THEN COALESCE(ps.monthly_demand, 0)
             WHEN 'forecast' THEN COALESCE(f.forecast_30d, ps.monthly_demand, 0)
           END,
           CASE WHEN COALESCE(f.forecast_30d, 0) >= 60 THEN f.forecast_30d
                ELSE COALESCE(ps.monthly_demand, 0) END
         ) AS monthly_demand
  FROM product_skus ps
  LEFT JOIN sku_forecasts f ON f.sku_id = ps.id
  LEFT JOIN demand_overrides ov ON ov.sku_id = ps.id
  WHERE ps.is_active
    AND COALESCE(ps.display_category, '') NOT IN ('Bases', 'Coils')
),
wh AS (
  SELECT il.sku_id,
    (COALESCE(il.warehouse_raw, 0) + COALESCE(il.warehouse_prefilled_raw, 0)
     + COALESCE(il.warehouse_in_production, 0) + COALESCE(il.warehouse_finished, 0)
     + COALESCE(il.warehouse_other, 0)) AS wh_units
  FROM inventory_levels il
),
transit AS (
  -- Remaining units only, statusless: received units are already on-hand.
  SELECT fli.sku_id, SUM(GREATEST(fli.quantity - fli.quantity_received, 0))::int AS units,
         MIN(fs.eta) AS next_eta
  FROM freight_line_items fli
  JOIN freight_shipments fs ON fs.id = fli.freight_shipment_id
  WHERE fli.sku_id IS NOT NULL
    AND fli.quantity > fli.quantity_received
  GROUP BY fli.sku_id
),
recv_out AS (
  -- Shipments sitting partially received >= 7 days since first check-in.
  SELECT fs.shipment_number,
         ((SELECT today FROM d) - MIN((fr.received_at AT TIME ZONE 'America/New_York')::date))::int AS days_outstanding,
         (SELECT SUM(g.received_cartons)::int FROM freight_carton_groups g WHERE g.freight_shipment_id = fs.id) AS cartons_received,
         (SELECT SUM(g.carton_qty)::int FROM freight_carton_groups g WHERE g.freight_shipment_id = fs.id) AS cartons_total,
         SUM(fli.quantity_received)::int AS units_received,
         SUM(fli.quantity)::int AS units_total,
         fs.carrier_pieces_delivered AS carrier_delivered,
         fs.carrier_pieces_total AS carrier_total,
         fs.carrier_last_piece_event_at::date AS carrier_last_movement
  FROM freight_shipments fs
  JOIN freight_line_items fli ON fli.freight_shipment_id = fs.id AND fli.sku_id IS NOT NULL
  JOIN freight_receipts fr ON fr.freight_shipment_id = fs.id
  WHERE fs.receipt_confirmed_at IS NULL
  GROUP BY fs.id, fs.shipment_number
  HAVING SUM(fli.quantity_received) > 0
     AND ((SELECT today FROM d) - MIN((fr.received_at AT TIME ZONE 'America/New_York')::date)) >= 7
),
low_rows AS (
  SELECT eff.sku, eff.product_name,
         GREATEST(COALESCE(wh.wh_units, 0), 0) AS wh_units,
         eff.monthly_demand,
         ROUND(GREATEST(COALESCE(wh.wh_units, 0), 0) / (eff.monthly_demand / 30.0), 1) AS dos_days,
         COALESCE(transit.units, 0) AS in_transit, transit.next_eta
  FROM eff
  JOIN wh ON wh.sku_id = eff.sku_id
  LEFT JOIN transit ON transit.sku_id = eff.sku_id
  WHERE eff.monthly_demand > 0
    AND (COALESCE(wh.wh_units, 0) / (eff.monthly_demand / 30.0)) <= 7
)
SELECT jsonb_build_object(
  'report_date', (SELECT yday FROM d),
  'generated_at', now(),
  'recipients', COALESCE(
    (SELECT jsonb_agg(u.email ORDER BY u.email)
     FROM profiles p JOIN auth.users u ON u.id = p.id
     WHERE p.role = 'admin' AND p.is_active AND u.email IS NOT NULL),
    '[]'::jsonb),
  'sales', COALESCE((SELECT jsonb_agg(to_jsonb(sr) ORDER BY sr.units DESC) FROM sales_rows sr), '[]'::jsonb),
  'sales_totals', (SELECT jsonb_build_object(
     'units', COALESCE(SUM(units), 0),
     'sku_count', COUNT(*)) FROM sales_rows),
  'incoming', COALESCE((SELECT jsonb_agg(to_jsonb(ir) ORDER BY ir.eta NULLS LAST) FROM incoming_rows ir), '[]'::jsonb),
  'receiving_outstanding', COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.days_outstanding DESC) FROM recv_out r), '[]'::jsonb),
  'marketing', jsonb_build_object(
    'sales', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'name', ms.name, 'starts_at', ms.starts_at::date, 'ends_at', ms.ends_at::date,
        'early_access', ms.early_access_starts_at::date,
        'approval', ms.approval_status,
        'sku_count', (SELECT count(DISTINCT e.sku_id) FROM mkt_offer_sku_expansion e WHERE e.sale_id = ms.id)
      ) ORDER BY ms.starts_at)
      FROM mkt_sales ms
      WHERE COALESCE(ms.early_access_starts_at, ms.starts_at)::date <= (SELECT today FROM d) + 14 AND ms.ends_at::date >= (SELECT today FROM d)), '[]'::jsonb),
    'launches', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'name', ml.name, 'kind', ml.kind, 'launch_date', ml.launch_date,
        'early_access', ml.early_access_date, 'approval', ml.approval_status,
        -- one definition of "product": member rows minus rows whose card is halted
        'sku_count', (SELECT count(*)
                        FROM mkt_launch_skus k
                        LEFT JOIN mkt_pd_projects c ON c.id = k.pd_project_id
                       WHERE k.launch_id = ml.id
                         AND (c.id IS NULL OR c.stage <> 'halted'))
      ) ORDER BY ml.launch_date)
      FROM mkt_launches ml
      WHERE ml.launch_date >= (SELECT today FROM d)
        AND COALESCE(ml.early_access_date, ml.launch_date) <= (SELECT today FROM d) + 14), '[]'::jsonb),
    'broadcasts', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'name', mb.name, 'channel', mb.channel, 'scheduled_at', mb.scheduled_at::date
      ) ORDER BY mb.scheduled_at)
      FROM mkt_broadcasts mb
      WHERE mb.scheduled_at::date BETWEEN (SELECT today FROM d) AND (SELECT today FROM d) + 14), '[]'::jsonb),
    'awaiting_confirmation', COALESCE((
      SELECT jsonb_agg(t.x ORDER BY t.x->>'date') FROM (
        SELECT jsonb_build_object('type', 'sale', 'name', ms.name, 'date', ms.starts_at::date) AS x
          FROM mkt_sales ms WHERE ms.approval_status = 'proposed' AND ms.ends_at::date >= (SELECT today FROM d)
        UNION ALL
        SELECT jsonb_build_object('type', 'launch', 'name', ml.name, 'date', ml.launch_date)
          FROM mkt_launches ml WHERE ml.approval_status = 'proposed' AND ml.launch_date >= (SELECT today FROM d)
      ) t), '[]'::jsonb)
  ),
  'low_stock', COALESCE((SELECT jsonb_agg(to_jsonb(lr) ORDER BY lr.dos_days ASC) FROM low_rows lr), '[]'::jsonb),
  -- warehouse physical layer (20261027000002): the latest nightly reconcile plus live task counts
  'warehouse', (
    SELECT jsonb_build_object(
      'mismatched_skus', r.mismatched_skus,
      'abs_units', r.abs_residual_units,
      'unlocated_units', r.unlocated_units,
      'putaway_over_24h', (SELECT count(*) FROM wh_moves m
                            WHERE m.kind = 'putaway' AND m.status IN ('open', 'in_progress')
                              AND m.created_at < now() - interval '24 hours'),
      'rts_unplaced', r.rts_unplaced_cartons,
      'counts_due', (SELECT count(*) FROM wh_count_tasks t
                      WHERE t.status IN ('open', 'counting')
                        AND (t.due_date IS NULL OR t.due_date <= (SELECT today FROM d))),
      'run_at', r.run_at)
    FROM (SELECT 1) AS one
    LEFT JOIN LATERAL (SELECT * FROM wh_reconcile_runs ORDER BY run_at DESC LIMIT 1) r ON true)
);
$function$;

REVOKE EXECUTE ON FUNCTION public.rpc_daily_report() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_daily_report() TO service_role;

COMMIT;
