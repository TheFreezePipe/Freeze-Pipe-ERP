-- =============================================================
-- Migration: manufacturing completion % history RPC
-- =============================================================
-- Powers the "Completion % over time" graph in the dashboard's
-- Manufacturing Completion drill-down. We don't store daily snapshots, so
-- the series is reconstructed from the inventory_transactions ledger:
-- anchor at today's live complete/unfilled totals (across fillable SKUs)
-- and walk backward, subtracting each day's net bucket deltas.
--
--   complete  = warehouse_finished + warehouse_prefilled_raw
--   unfilled  = warehouse_raw      + warehouse_in_production
--
-- Doing the reconstruction in SQL (vs shipping tens of thousands of tx
-- rows to the browser) keeps even a 90-day view to ~90 returned rows.
--
-- Returns one row per calendar day (oldest..today) with the end-of-day
-- complete/unfilled unit totals; the client derives the percentage.
-- p_days is clamped to [1, 730].
-- =============================================================

CREATE OR REPLACE FUNCTION public.rpc_manufacturing_completion_history(p_days integer DEFAULT 30)
 RETURNS TABLE(day date, complete_units integer, unfilled_units integer)
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH params AS (
    SELECT LEAST(GREATEST(COALESCE(p_days, 30), 1), 730) AS n
  ),
  fillable AS (
    SELECT id FROM product_skus WHERE category = 'fillable'
  ),
  anchor AS (
    SELECT
      COALESCE(SUM(il.warehouse_finished + il.warehouse_prefilled_raw), 0) AS complete_now,
      COALESCE(SUM(il.warehouse_raw + il.warehouse_in_production), 0)      AS unfilled_now
    FROM inventory_levels il
    JOIN fillable f ON f.id = il.sku_id
  ),
  -- Net per-day delta to each side, fillable SKUs only. category_move
  -- between two same-side buckets nets to zero (e.g. raw -> in_production
  -- is unfilled -> unfilled); metadata rows never move inventory.
  tx AS (
    SELECT
      it.created_at::date AS d,
      SUM(CASE
        WHEN it.movement_kind = 'net_change'    AND it.field_affected IN ('warehouse_finished','warehouse_prefilled_raw') THEN it.quantity
        WHEN it.movement_kind = 'category_move' AND it.to_field      IN ('warehouse_finished','warehouse_prefilled_raw') THEN it.quantity
        WHEN it.movement_kind = 'category_move' AND it.from_field    IN ('warehouse_finished','warehouse_prefilled_raw') THEN -it.quantity
        WHEN it.movement_kind = 'write_off'     AND it.from_field    IN ('warehouse_finished','warehouse_prefilled_raw') THEN -it.quantity
        ELSE 0 END) AS dc,
      SUM(CASE
        WHEN it.movement_kind = 'net_change'    AND it.field_affected IN ('warehouse_raw','warehouse_in_production') THEN it.quantity
        WHEN it.movement_kind = 'category_move' AND it.to_field      IN ('warehouse_raw','warehouse_in_production') THEN it.quantity
        WHEN it.movement_kind = 'category_move' AND it.from_field    IN ('warehouse_raw','warehouse_in_production') THEN -it.quantity
        WHEN it.movement_kind = 'write_off'     AND it.from_field    IN ('warehouse_raw','warehouse_in_production') THEN -it.quantity
        ELSE 0 END) AS du
    FROM inventory_transactions it
    JOIN fillable f ON f.id = it.sku_id
    WHERE it.created_at >= (current_date - ((SELECT n FROM params) - 1))
    GROUP BY it.created_at::date
  ),
  cal AS (
    SELECT generate_series(
      current_date - ((SELECT n FROM params) - 1),
      current_date,
      '1 day'
    )::date AS d
  ),
  joined AS (
    SELECT c.d, COALESCE(t.dc, 0) AS dc, COALESCE(t.du, 0) AS du
    FROM cal c LEFT JOIN tx t ON t.d = c.d
  ),
  -- For day D, end-of-day balance = anchor_now - (sum of deltas on days > D).
  -- ORDER BY d DESC with "1 PRECEDING" sums only the strictly-later days.
  cum AS (
    SELECT d,
      COALESCE(SUM(dc) OVER (ORDER BY d DESC ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS dc_after,
      COALESCE(SUM(du) OVER (ORDER BY d DESC ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS du_after
    FROM joined
  )
  SELECT
    c.d AS day,
    (a.complete_now - c.dc_after)::int AS complete_units,
    (a.unfilled_now - c.du_after)::int AS unfilled_units
  FROM cum c CROSS JOIN anchor a
  ORDER BY c.d;
$function$;

REVOKE ALL ON FUNCTION public.rpc_manufacturing_completion_history(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_manufacturing_completion_history(integer) TO authenticated;
