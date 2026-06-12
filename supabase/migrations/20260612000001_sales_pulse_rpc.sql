-- =============================================================
-- Migration: dashboard sales pulse RPC
-- =============================================================
-- The dashboard's stat row gains a sales pulse: units/orders shipped
-- today and trailing-7d vs prior-7d units. Sourced from
-- shipstation_orders/_items directly (fresh within ~30 min thanks to the
-- intraday reconcile) rather than sales_daily (refreshed only nightly at
-- 04:50, so "today" would always read zero there).
--
-- Only resolved catalog items count (sku_id IS NOT NULL) — service
-- charges / non-inventory codes don't inflate the unit numbers, matching
-- how demand math treats them. Days are UTC dates, consistent with
-- sales_daily.
-- =============================================================

CREATE OR REPLACE FUNCTION public.rpc_sales_pulse()
 RETURNS TABLE(
   orders_today integer,
   units_today integer,
   units_7d integer,
   units_prior_7d integer
 )
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH o AS (
    SELECT id, ship_date::date AS d
    FROM public.shipstation_orders
    WHERE order_status = 'shipped'
      AND ship_date >= current_date - 14
  ),
  iu AS (
    SELECT o.d, SUM(i.quantity)::int AS units
    FROM o
    JOIN public.shipstation_order_items i ON i.shipstation_order_id = o.id
    WHERE i.sku_id IS NOT NULL
    GROUP BY o.d
  )
  SELECT
    (SELECT count(*) FROM o WHERE d = current_date)::int                                        AS orders_today,
    COALESCE((SELECT units FROM iu WHERE d = current_date), 0)                                  AS units_today,
    COALESCE((SELECT SUM(units) FROM iu WHERE d > current_date - 7), 0)::int                    AS units_7d,
    COALESCE((SELECT SUM(units) FROM iu WHERE d <= current_date - 7 AND d > current_date - 14), 0)::int AS units_prior_7d;
$function$;

REVOKE ALL ON FUNCTION public.rpc_sales_pulse() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_sales_pulse() TO authenticated;
