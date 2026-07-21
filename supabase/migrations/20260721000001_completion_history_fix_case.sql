-- ============================================================================
-- Manufacturing completion history: fix first-match-wins CASE double-count
-- ============================================================================
-- The per-day delta used ONE CASE per side, so for a category_move where
-- BOTH endpoints sit on the same side, the to-branch matched first and the
-- from-branch never ran:
--   * prefilled_raw -> finished  (both "complete"): counted +qty, not 0
--   * raw -> in_production       (both "unfilled"): counted +qty, not 0
-- Result: history inflated by exactly the crew's prefilled-RTS and staging
-- volume — e.g. Jul 11-21 2026 rendered as a flat ~92% when true completion
-- climbed ~87% -> ~92% (ledger flows: +970 RTS vs −926 sales; the flat line
-- was ~947 phantom prefilled-RTS units). Also the true root cause of the
-- June 19-22 negative-bucket dip previously mitigated by the output clamp.
--
-- Fix: additive per-branch arithmetic (same pattern as
-- rpc_inventory_retail_value_history, whose comment explicitly warns
-- against the first-match CASE). Same-side moves now cancel to zero.
-- The GREATEST(0) output clamp stays as a belt for ledger-order lag.

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
      SUM(
          CASE WHEN it.movement_kind = 'net_change'
                AND it.field_affected IN ('warehouse_finished','warehouse_prefilled_raw') THEN it.quantity ELSE 0 END
        + CASE WHEN it.movement_kind = 'category_move'
                AND it.to_field   IN ('warehouse_finished','warehouse_prefilled_raw') THEN it.quantity ELSE 0 END
        - CASE WHEN it.movement_kind = 'category_move'
                AND it.from_field IN ('warehouse_finished','warehouse_prefilled_raw') THEN it.quantity ELSE 0 END
        - CASE WHEN it.movement_kind = 'write_off'
                AND it.from_field IN ('warehouse_finished','warehouse_prefilled_raw') THEN it.quantity ELSE 0 END
      ) AS dc,
      SUM(
          CASE WHEN it.movement_kind = 'net_change'
                AND it.field_affected IN ('warehouse_raw','warehouse_in_production') THEN it.quantity ELSE 0 END
        + CASE WHEN it.movement_kind = 'category_move'
                AND it.to_field   IN ('warehouse_raw','warehouse_in_production') THEN it.quantity ELSE 0 END
        - CASE WHEN it.movement_kind = 'category_move'
                AND it.from_field IN ('warehouse_raw','warehouse_in_production') THEN it.quantity ELSE 0 END
        - CASE WHEN it.movement_kind = 'write_off'
                AND it.from_field IN ('warehouse_raw','warehouse_in_production') THEN it.quantity ELSE 0 END
      ) AS du
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
