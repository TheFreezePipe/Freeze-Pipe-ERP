-- =============================================================
-- Migration: manufacturing "days to clear" estimate inputs
-- =============================================================
-- Replaces the dashboard drill-down's old net-trend days-to-clear with a
-- throughput-based queue-drain model:
--
--   days_to_clear = total fillable work to make ready
--                 ÷ combined make-ready throughput (trailing window)
--
--   work = (raw + in_production + pre-filled, in the warehouse now)
--        + (raw + pre-filled fillable units inbound on non-delivered freight)
--   rate = (rtsing + prefilled_rtsing units/day, trailing p_days)
--
-- rtsing (in_production -> finished) and prefilled_rtsing (pre-filled ->
-- finished) are the two "make a unit ready to ship" steps; summing their
-- recent volume gives the team's combined ready-making rate. Including
-- inbound freight means scheduled arrivals extend the estimate instead of
-- being invisible until they land.
--
-- Returns the raw components (one row); the client composes the figure so
-- presentation stays flexible.
-- =============================================================

CREATE OR REPLACE FUNCTION public.rpc_manufacturing_clear_estimate(p_days integer DEFAULT 30)
 RETURNS TABLE(
   unfilled_now integer,
   prefilled_now integer,
   incoming_raw integer,
   incoming_prefilled integer,
   rtsing_per_day numeric,
   prefilled_rtsing_per_day numeric
 )
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH params AS (
    SELECT LEAST(GREATEST(COALESCE(p_days, 30), 1), 365) AS n
  ),
  fillable AS (
    SELECT id FROM product_skus WHERE category = 'fillable'
  ),
  inv AS (
    SELECT
      COALESCE(SUM(il.warehouse_raw + il.warehouse_in_production), 0) AS unfilled_now,
      COALESCE(SUM(il.warehouse_prefilled_raw), 0)                    AS prefilled_now
    FROM inventory_levels il
    JOIN fillable f ON f.id = il.sku_id
  ),
  freight AS (
    -- Clamp pre-filled to [0, quantity] per line (same rule the receipt
    -- RPC uses), so incoming raw/pre-filled can't go negative or exceed qty.
    SELECT
      COALESCE(SUM(GREATEST(fli.quantity - LEAST(GREATEST(COALESCE(fli.quantity_prefilled, 0), 0), fli.quantity), 0)), 0) AS incoming_raw,
      COALESCE(SUM(LEAST(GREATEST(COALESCE(fli.quantity_prefilled, 0), 0), fli.quantity)), 0)                              AS incoming_prefilled
    FROM freight_line_items fli
    JOIN freight_shipments fs ON fs.id = fli.freight_shipment_id
    JOIN fillable f ON f.id = fli.sku_id
    WHERE fs.status <> 'delivered'
  ),
  thru AS (
    SELECT
      COALESCE(SUM(tl.quantity_processed) FILTER (WHERE tl.task_type = 'rtsing'), 0)::numeric          AS rtsing_units,
      COALESCE(SUM(tl.quantity_processed) FILTER (WHERE tl.task_type = 'prefilled_rtsing'), 0)::numeric AS prefilled_rtsing_units
    FROM task_logs tl
    JOIN fillable f ON f.id = tl.sku_id
    WHERE COALESCE(tl.time_completed, tl.created_at) >= now() - make_interval(days => (SELECT n FROM params))
  )
  SELECT
    inv.unfilled_now::int,
    inv.prefilled_now::int,
    freight.incoming_raw::int,
    freight.incoming_prefilled::int,
    ROUND(thru.rtsing_units / (SELECT n FROM params), 2)          AS rtsing_per_day,
    ROUND(thru.prefilled_rtsing_units / (SELECT n FROM params), 2) AS prefilled_rtsing_per_day
  FROM inv, freight, thru;
$function$;

REVOKE ALL ON FUNCTION public.rpc_manufacturing_clear_estimate(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_manufacturing_clear_estimate(integer) TO authenticated;
