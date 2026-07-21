-- ============================================================================
-- Manufacturing completion history: clamp reconstructed buckets at zero
-- ============================================================================
-- The history replays each day as (today's snapshot − all later ledger
-- deltas). When a freight receipt is RECORDED days after the crew already
-- RTSed those units (paper lag — e.g. the June 19-22 2026 window, where the
-- receipt landed in the ledger on June 23), the replayed raw bucket dips
-- negative for those days and the dashboard showed >100% completion.
-- Physical floor: a bucket can't hold negative units — clamp at 0 on OUTPUT
-- only (per-day values derive independently from the anchor, so clamping
-- one day distorts no other day). 100% on those days = "everything the
-- ledger knew about was complete", which is the truthful display.

CREATE OR REPLACE FUNCTION public.rpc_manufacturing_completion_history(p_days integer DEFAULT 30)
RETURNS TABLE(day date, complete_units integer, unfilled_units integer)
LANGUAGE sql
STABLE SECURITY DEFINER
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
  cum AS (
    SELECT d,
      COALESCE(SUM(dc) OVER (ORDER BY d DESC ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS dc_after,
      COALESCE(SUM(du) OVER (ORDER BY d DESC ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS du_after
    FROM joined
  )
  SELECT
    c.d AS day,
    GREATEST(a.complete_now - c.dc_after, 0)::int AS complete_units,
    GREATEST(a.unfilled_now - c.du_after, 0)::int AS unfilled_units
  FROM cum c CROSS JOIN anchor a
  ORDER BY c.d;
$function$;
