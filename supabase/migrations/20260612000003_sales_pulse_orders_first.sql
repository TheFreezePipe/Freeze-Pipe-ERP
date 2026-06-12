-- =============================================================
-- Migration: sales pulse — add 7d order counts (orders-first cards)
-- =============================================================
-- The dashboard pulse cards now lead with ORDERS shipped (units demoted
-- to the subtitle), so the 7-day card needs order counts for its
-- week-over-week trend, not just unit sums.
-- =============================================================

DROP FUNCTION IF EXISTS public.rpc_sales_pulse();

CREATE OR REPLACE FUNCTION public.rpc_sales_pulse()
 RETURNS TABLE(
   orders_today integer,
   units_today integer,
   orders_yesterday integer,
   units_yesterday integer,
   awaiting_orders integer,
   orders_7d integer,
   orders_prior_7d integer,
   units_7d integer,
   units_prior_7d integer
 )
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH tz AS (
    SELECT (now() AT TIME ZONE 'America/New_York')::date AS today
  ),
  o AS (
    SELECT id, ship_date::date AS d
    FROM public.shipstation_orders
    WHERE order_status = 'shipped'
      AND ship_date >= (SELECT today FROM tz) - 14
  ),
  iu AS (
    SELECT o.d, SUM(i.quantity)::int AS units
    FROM o
    JOIN public.shipstation_order_items i ON i.shipstation_order_id = o.id
    WHERE i.sku_id IS NOT NULL
    GROUP BY o.d
  )
  SELECT
    (SELECT count(*) FROM o WHERE d = (SELECT today FROM tz))::int                        AS orders_today,
    COALESCE((SELECT units FROM iu WHERE d = (SELECT today FROM tz)), 0)                  AS units_today,
    (SELECT count(*) FROM o WHERE d = (SELECT today FROM tz) - 1)::int                    AS orders_yesterday,
    COALESCE((SELECT units FROM iu WHERE d = (SELECT today FROM tz) - 1), 0)              AS units_yesterday,
    (SELECT count(*) FROM public.shipstation_orders WHERE order_status = 'awaiting_shipment')::int AS awaiting_orders,
    (SELECT count(*) FROM o WHERE d > (SELECT today FROM tz) - 7)::int                    AS orders_7d,
    (SELECT count(*) FROM o
      WHERE d <= (SELECT today FROM tz) - 7
        AND d > (SELECT today FROM tz) - 14)::int                                         AS orders_prior_7d,
    COALESCE((SELECT SUM(units) FROM iu WHERE d > (SELECT today FROM tz) - 7), 0)::int    AS units_7d,
    COALESCE((SELECT SUM(units) FROM iu
              WHERE d <= (SELECT today FROM tz) - 7
                AND d > (SELECT today FROM tz) - 14), 0)::int                             AS units_prior_7d;
$function$;

REVOKE ALL ON FUNCTION public.rpc_sales_pulse() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_sales_pulse() TO authenticated;
