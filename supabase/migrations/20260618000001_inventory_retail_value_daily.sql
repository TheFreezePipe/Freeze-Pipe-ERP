-- =============================================================
-- Migration: inventory retail value over time (snapshot + history)
-- =============================================================
-- Powers the "Total Retail Value" drill-down report. The centerpiece is
-- a retail-value-over-time chart split into the three pipeline stages
-- (In Warehouse / In Transit / On Order). We don't store daily inventory
-- snapshots, so this provides BOTH:
--
--   1. rpc_inventory_retail_value_history(p_days) — RECONSTRUCTS the daily
--      series back to go-live from existing records (immediate history),
--      valuing units at TODAY's retail price (price history isn't stored;
--      this is a documented approximation). It transparently prefers an
--      exact snapshot row when one exists for a given day.
--
--   2. inventory_retail_value_daily + rpc_snapshot_inventory_retail_value()
--      run nightly by pg_cron — captures the EXACT three-stage retail value
--      each day going forward. As snapshots accrue, the chart becomes exact
--      for recent days while older days stay reconstructed.
--
-- All three stage definitions match the live UI (inventory-aggregates.ts):
--   * Warehouse  = Σ over all warehouse_* buckets × retail_price
--   * In Transit = freight_line_items on non-delivered shipments × price
--   * On Order   = factory_order_items remaining (ordered − breakage −
--                  freight-shipped − manual-shipped − consumed-by-parent),
--                  active orders only, × price
-- =============================================================

-- -------------------------------------------------------------
-- Daily snapshot table — one row per warehouse day (America/New_York),
-- aggregate (not per-SKU) since the over-time chart only needs the three
-- stage totals. Exact values captured nightly; never approximated.
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.inventory_retail_value_daily (
  snapshot_date    date        NOT NULL PRIMARY KEY,
  warehouse_retail numeric(14,2) NOT NULL DEFAULT 0,
  transit_retail   numeric(14,2) NOT NULL DEFAULT 0,
  onorder_retail   numeric(14,2) NOT NULL DEFAULT 0,
  source           text        NOT NULL DEFAULT 'snapshot',
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Retail value totals are management-level financials, not row-level
-- sensitive; readable by the team. Writes go only through the SECURITY
-- DEFINER snapshot RPC (and the nightly cron that calls it).
ALTER TABLE public.inventory_retail_value_daily ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "retail_value_daily readable by authenticated" ON public.inventory_retail_value_daily;
CREATE POLICY "retail_value_daily readable by authenticated"
  ON public.inventory_retail_value_daily FOR SELECT TO authenticated USING (true);

COMMENT ON TABLE public.inventory_retail_value_daily IS
  'Daily exact three-stage retail value of inventory (warehouse/transit/on-order). Captured nightly by rpc_snapshot_inventory_retail_value via pg_cron. History before the first row is reconstructed on read by rpc_inventory_retail_value_history.';

-- -------------------------------------------------------------
-- Snapshot TODAY's exact three-stage retail value. Idempotent on the PK
-- so re-runs (and the migration's immediate call) just overwrite the day.
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_snapshot_inventory_retail_value()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_day       date := (now() AT TIME ZONE 'America/New_York')::date;
  v_warehouse numeric(14,2);
  v_transit   numeric(14,2);
  v_onorder   numeric(14,2);
BEGIN
  -- Warehouse: all warehouse buckets × retail price.
  SELECT COALESCE(SUM(
           ( COALESCE(il.warehouse_raw,0)
           + COALESCE(il.warehouse_prefilled_raw,0)
           + COALESCE(il.warehouse_in_production,0)
           + COALESCE(il.warehouse_finished,0)
           + COALESCE(il.warehouse_other,0) ) * COALESCE(ps.retail_price,0)
         ), 0)
    INTO v_warehouse
    FROM public.inventory_levels il
    JOIN public.product_skus ps ON ps.id = il.sku_id;

  -- In transit: units on shipments not yet delivered (matches
  -- inventory-aggregates IN_TRANSIT_STATUSES).
  SELECT COALESCE(SUM(fl.quantity * COALESCE(ps.retail_price,0)), 0)
    INTO v_transit
    FROM public.freight_line_items fl
    JOIN public.freight_shipments s ON s.id = fl.freight_shipment_id
    JOIN public.product_skus ps ON ps.id = fl.sku_id
   WHERE fl.sku_id IS NOT NULL
     AND s.status IN ('pending','on_the_water','high_risk','cleared_customs','tracking');

  -- On order: remaining factory units, active orders only.
  WITH foiship AS (
    SELECT source_factory_order_item_id AS foi_id, SUM(quantity) AS q
      FROM public.freight_line_items
     WHERE source_factory_order_item_id IS NOT NULL
     GROUP BY source_factory_order_item_id
  )
  SELECT COALESCE(SUM(
           GREATEST(
             COALESCE(foi.quantity_ordered,0)
             - COALESCE(foi.quantity_breakage,0)
             - COALESCE(foi.quantity_shipped_manual,0)
             - COALESCE(foi.quantity_consumed_by_parent,0)
             - COALESCE(fsh.q,0)
           , 0) * COALESCE(ps.retail_price,0)
         ), 0)
    INTO v_onorder
    FROM public.factory_order_items foi
    JOIN public.factory_orders o ON o.id = foi.factory_order_id
    JOIN public.product_skus ps ON ps.id = foi.sku_id
    LEFT JOIN foiship fsh ON fsh.foi_id = foi.id
   WHERE o.status IN ('ordered','in_production','finished');

  INSERT INTO public.inventory_retail_value_daily
    (snapshot_date, warehouse_retail, transit_retail, onorder_retail, source, updated_at)
  VALUES (v_day, v_warehouse, v_transit, v_onorder, 'snapshot', now())
  ON CONFLICT (snapshot_date) DO UPDATE
    SET warehouse_retail = EXCLUDED.warehouse_retail,
        transit_retail   = EXCLUDED.transit_retail,
        onorder_retail   = EXCLUDED.onorder_retail,
        source           = 'snapshot',
        updated_at       = now();
END;
$function$;

-- -------------------------------------------------------------
-- Reconstruct the daily three-stage retail series for the trailing
-- p_days days. Snapshot rows (exact) override the reconstruction for any
-- day they exist. Reconstruction values everything at CURRENT retail
-- price (documented approximation — price history isn't stored).
--
-- Warehouse: anchor at current inventory_levels value, walk the
--   inventory_transactions ledger backward (same technique as
--   rpc_manufacturing_completion_history), weighting each unit delta by
--   the SKU's retail price. Intra-warehouse category moves net to zero.
-- Transit:   for each day D, sum line value on shipments whose
--   [ship_date, received) interval covers D.
-- On order:  for each day D, sum remaining order units (net of freight
--   shipped on/before D). Manual-shipped / consumed-by-parent / breakage
--   carry no event timestamp, so they're applied across the order's whole
--   life — a small understatement of early-history on-order for the few
--   SKUs that use them (99% of fulfillment is freight, which IS dated).
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_inventory_retail_value_history(p_days integer DEFAULT 90)
 RETURNS TABLE(
   day              date,
   warehouse_retail numeric,
   transit_retail   numeric,
   onorder_retail   numeric,
   is_snapshot      boolean
 )
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH params AS (
    SELECT LEAST(GREATEST(COALESCE(p_days, 90), 1), 730) AS n
  ),
  cal AS (
    SELECT generate_series(
      current_date - ((SELECT n FROM params) - 1),
      current_date,
      '1 day'
    )::date AS d
  ),
  price AS (
    SELECT id AS sku_id, COALESCE(retail_price, 0) AS p FROM product_skus
  ),

  -- ---------- WAREHOUSE: anchor + ledger walk ----------
  wh_anchor AS (
    SELECT COALESCE(SUM(
             ( COALESCE(il.warehouse_raw,0)
             + COALESCE(il.warehouse_prefilled_raw,0)
             + COALESCE(il.warehouse_in_production,0)
             + COALESCE(il.warehouse_finished,0)
             + COALESCE(il.warehouse_other,0) ) * pr.p
           ), 0) AS now_val
    FROM inventory_levels il
    JOIN price pr ON pr.sku_id = il.sku_id
  ),
  -- All warehouse buckets are in-scope, so EVERY category_move is
  -- intra-warehouse and must net to zero — computed as additive
  -- arithmetic (not a first-match CASE, which would double-count moves).
  wh_tx AS (
    SELECT it.created_at::date AS d,
      SUM( pr.p * (
          CASE WHEN it.movement_kind = 'net_change'
                AND it.field_affected IN ('warehouse_raw','warehouse_prefilled_raw','warehouse_in_production','warehouse_finished','warehouse_other')
               THEN it.quantity ELSE 0 END
        + CASE WHEN it.movement_kind = 'category_move'
                AND it.to_field IN ('warehouse_raw','warehouse_prefilled_raw','warehouse_in_production','warehouse_finished','warehouse_other')
               THEN it.quantity ELSE 0 END
        - CASE WHEN it.movement_kind = 'category_move'
                AND it.from_field IN ('warehouse_raw','warehouse_prefilled_raw','warehouse_in_production','warehouse_finished','warehouse_other')
               THEN it.quantity ELSE 0 END
        - CASE WHEN it.movement_kind = 'write_off'
                AND it.from_field IN ('warehouse_raw','warehouse_prefilled_raw','warehouse_in_production','warehouse_finished','warehouse_other')
               THEN it.quantity ELSE 0 END
      )) AS dv
    FROM inventory_transactions it
    JOIN price pr ON pr.sku_id = it.sku_id
    WHERE it.created_at >= (current_date - ((SELECT n FROM params) - 1))
    GROUP BY it.created_at::date
  ),
  wh_joined AS (
    SELECT c.d, COALESCE(t.dv, 0) AS dv
    FROM cal c LEFT JOIN wh_tx t ON t.d = c.d
  ),
  wh_cum AS (
    SELECT d,
      COALESCE(SUM(dv) OVER (ORDER BY d DESC ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS dv_after
    FROM wh_joined
  ),
  wh AS (
    SELECT c.d, (a.now_val - c.dv_after) AS val
    FROM wh_cum c CROSS JOIN wh_anchor a
  ),

  -- ---------- IN TRANSIT: active shipment intervals ----------
  ship AS (
    SELECT fl.quantity, pr.p,
           s.ship_date AS start_d,
           COALESCE(
             s.actual_arrival_date,
             s.receipt_confirmed_at::date,
             CASE WHEN s.status = 'delivered' THEN s.ship_date END
           ) AS recv_d
    FROM freight_line_items fl
    JOIN freight_shipments s ON s.id = fl.freight_shipment_id
    JOIN price pr ON pr.sku_id = fl.sku_id
    WHERE fl.sku_id IS NOT NULL AND s.ship_date IS NOT NULL
  ),
  transit AS (
    SELECT c.d, COALESCE(SUM(sh.quantity * sh.p), 0) AS val
    FROM cal c
    LEFT JOIN ship sh
      ON sh.start_d <= c.d
     AND (sh.recv_d IS NULL OR c.d < sh.recv_d)
    GROUP BY c.d
  ),

  -- ---------- ON ORDER: remaining factory units over time ----------
  fo AS (
    SELECT foi.id AS foi_id, pr.p, o.order_date,
           GREATEST(
             COALESCE(foi.quantity_ordered,0)
             - COALESCE(foi.quantity_breakage,0)
             - COALESCE(foi.quantity_shipped_manual,0)
             - COALESCE(foi.quantity_consumed_by_parent,0)
           , 0) AS base_remaining
    FROM factory_order_items foi
    JOIN factory_orders o ON o.id = foi.factory_order_id
    JOIN price pr ON pr.sku_id = foi.sku_id
    WHERE o.status <> 'canceled' AND o.order_date IS NOT NULL
  ),
  fo_ship AS (
    SELECT fl.source_factory_order_item_id AS foi_id, s.ship_date, SUM(fl.quantity) AS qty
    FROM freight_line_items fl
    JOIN freight_shipments s ON s.id = fl.freight_shipment_id
    WHERE fl.source_factory_order_item_id IS NOT NULL AND s.ship_date IS NOT NULL
    GROUP BY fl.source_factory_order_item_id, s.ship_date
  ),
  onorder AS (
    SELECT c.d, COALESCE(SUM(
             GREATEST(
               fo.base_remaining
               - COALESCE((SELECT SUM(fs.qty) FROM fo_ship fs
                            WHERE fs.foi_id = fo.foi_id AND fs.ship_date <= c.d), 0)
             , 0) * fo.p
           ), 0) AS val
    FROM cal c
    JOIN fo ON fo.order_date <= c.d
    GROUP BY c.d
  )

  SELECT
    c.d AS day,
    COALESCE(s.warehouse_retail, wh.val)::numeric      AS warehouse_retail,
    COALESCE(s.transit_retail,   transit.val)::numeric AS transit_retail,
    COALESCE(s.onorder_retail,   onorder.val)::numeric AS onorder_retail,
    (s.snapshot_date IS NOT NULL)                      AS is_snapshot
  FROM cal c
  JOIN wh                              ON wh.d = c.d
  LEFT JOIN transit                    ON transit.d = c.d
  LEFT JOIN onorder                    ON onorder.d = c.d
  LEFT JOIN inventory_retail_value_daily s ON s.snapshot_date = c.d
  ORDER BY c.d;
$function$;

GRANT EXECUTE ON FUNCTION public.rpc_snapshot_inventory_retail_value() TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_inventory_retail_value_history(integer) TO authenticated;
GRANT SELECT ON public.inventory_retail_value_daily TO authenticated;

-- -------------------------------------------------------------
-- Nightly snapshot at 05:10 UTC (~01:10 ET) — captures the close of the
-- warehouse day after the box-apply (03:35) and intraday reconciles settle.
-- -------------------------------------------------------------
DO $cron$
BEGIN
  PERFORM cron.unschedule('inventory-retail-value-snapshot');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $cron$;

SELECT cron.schedule(
  'inventory-retail-value-snapshot',
  '10 5 * * *',
  $$SELECT public.rpc_snapshot_inventory_retail_value();$$
);

-- Seed today's exact point immediately so the chart has a live anchor.
SELECT public.rpc_snapshot_inventory_retail_value();

-- Record into the migration ledger (this project applies via psql and
-- records the version explicitly).
INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES
  ('20260618000001', 'inventory_retail_value_daily')
ON CONFLICT (version) DO NOTHING;
