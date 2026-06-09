-- =============================================================
-- Migration: per-material observed usage rates
-- =============================================================
-- Boxes aren't recipe-driven — their consumption is the ShipStation box
-- decrements (material_transactions.transaction_type = 'shipstation_box').
-- This RPC returns each material's trailing daily usage from real
-- consumption transactions so the runway/reorder math can use observed
-- reality instead of the recipe estimate.
--
-- daily_usage = units consumed in the window ÷ days of data we actually
-- have (elapsed since first consumption, capped at the window, min 1).
-- That keeps the estimate fair while history ramps up rather than dividing
-- a few days of data across the whole window.
--
-- Consumption types are whitelisted (only negative, usage-style rows count;
-- cycle counts and receipts are excluded). Extend the IN-list when
-- auto-deduction for other materials lands.
-- =============================================================

CREATE OR REPLACE FUNCTION public.rpc_material_usage_rates(p_days integer DEFAULT 30)
 RETURNS TABLE(
   material_id uuid,
   units_consumed numeric,
   daily_usage numeric,
   data_points integer
 )
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH params AS (
    SELECT GREATEST(LEAST(COALESCE(p_days, 30), 365), 1) AS n
  ),
  consumption AS (
    SELECT
      mt.material_id,
      SUM(-mt.quantity_change) AS units,
      COUNT(*)                 AS pts,
      MIN(mt.created_at)       AS first_at
    FROM public.material_transactions mt
    CROSS JOIN params
    WHERE mt.transaction_type IN ('shipstation_box')
      AND mt.quantity_change < 0
      AND mt.created_at >= now() - make_interval(days => (SELECT n FROM params))
    GROUP BY mt.material_id
  )
  SELECT
    c.material_id,
    c.units AS units_consumed,
    ROUND(
      c.units / GREATEST(
        1,
        LEAST(
          (SELECT n FROM params),
          CEIL(EXTRACT(EPOCH FROM (now() - c.first_at)) / 86400.0)::int
        )
      )::numeric,
      4
    ) AS daily_usage,
    c.pts::int AS data_points
  FROM consumption c
  WHERE c.units > 0;
$function$;

REVOKE ALL ON FUNCTION public.rpc_material_usage_rates(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_material_usage_rates(integer) TO authenticated;
