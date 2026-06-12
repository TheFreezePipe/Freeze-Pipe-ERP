-- =============================================================
-- Migration: sales pulse — warehouse-day alignment + queue context
-- =============================================================
-- Two fixes to rpc_sales_pulse after observing real shipping patterns:
--
-- 1. Day boundary: label runs cluster 3-10 PM ET and a meaningful share
--    lands AFTER 8 PM ET — which is past midnight UTC, so the UTC
--    current_date boundary pushed late-evening ships into "tomorrow".
--    Day windows now key off America/New_York (the warehouse day,
--    matching how ShipStation stamps ship_date in the account TZ).
--
-- 2. Context: the warehouse ships in end-of-day batches, so "today" is
--    structurally near-zero before mid-afternoon. Return yesterday's
--    totals + the current awaiting_shipment queue so the dashboard can
--    show "92 in queue" instead of looking broken every morning.
-- =============================================================

DROP FUNCTION IF EXISTS public.rpc_sales_pulse();

CREATE OR REPLACE FUNCTION public.rpc_sales_pulse()
 RETURNS TABLE(
   orders_today integer,
   units_today integer,
   orders_yesterday integer,
   units_yesterday integer,
   awaiting_orders integer,
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
    (SELECT count(*) FROM o WHERE d = (SELECT today FROM tz))::int                       AS orders_today,
    COALESCE((SELECT units FROM iu WHERE d = (SELECT today FROM tz)), 0)                 AS units_today,
    (SELECT count(*) FROM o WHERE d = (SELECT today FROM tz) - 1)::int                   AS orders_yesterday,
    COALESCE((SELECT units FROM iu WHERE d = (SELECT today FROM tz) - 1), 0)             AS units_yesterday,
    (SELECT count(*) FROM public.shipstation_orders WHERE order_status = 'awaiting_shipment')::int AS awaiting_orders,
    COALESCE((SELECT SUM(units) FROM iu WHERE d > (SELECT today FROM tz) - 7), 0)::int   AS units_7d,
    COALESCE((SELECT SUM(units) FROM iu
              WHERE d <= (SELECT today FROM tz) - 7
                AND d > (SELECT today FROM tz) - 14), 0)::int                            AS units_prior_7d;
$function$;

REVOKE ALL ON FUNCTION public.rpc_sales_pulse() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_sales_pulse() TO authenticated;
