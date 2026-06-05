-- =============================================================
-- rpc_recompute_demand — refresh monthly_demand from actual sales
-- =============================================================
-- product_skus.monthly_demand is the planning baseline behind DOS,
-- manufacturing priority, reorder, and materials runway. It was seeded
-- from a stale (Apr 3) forecast and has drifted badly — top movers
-- overstated ~2x, several real sellers recorded as 0.
--
-- This recomputes it from a clean trailing-30-day window of actual
-- ShipStation sales (bootstrap was 2026-05-05, so a full clean month is
-- available). Pure in-database aggregation — no edge function needed.
--
-- Window:   the 30 COMPLETE days before today (excludes the partial
--           current day so a mid-day cron run doesn't undercount).
-- Counted:  shipped + awaiting_shipment orders only (excludes cancelled,
--           on_hold, awaiting_payment).
-- Scope:    active, non-archived SKUs. Zero-sellers go to 0 (honest
--           rolling demand; known exceptions use demand_overrides).
-- Untouched: demand_overrides (separate table) — manual overrides still
--           win in DOS calcs.
--
-- p_dry_run = true returns the would-be changes WITHOUT writing, so the
-- diff can be reviewed before applying or before the cron is enabled.
--
-- Returns one row per SKU whose demand changes: sku, old, new, delta
-- (largest swings first).
-- =============================================================
CREATE OR REPLACE FUNCTION public.rpc_recompute_demand(p_dry_run boolean DEFAULT false)
RETURNS TABLE (sku text, old_demand integer, new_demand integer, delta integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_role text;
BEGIN
  -- When invoked with a user JWT (PostgREST), require admin/manager.
  -- Cron/psql have no auth context (auth.uid() IS NULL) and are allowed.
  IF auth.uid() IS NOT NULL THEN
    SELECT role INTO v_role FROM public.profiles WHERE id = auth.uid();
    IF v_role IS DISTINCT FROM 'admin' AND v_role IS DISTINCT FROM 'manager' THEN
      RAISE EXCEPTION 'admin or manager role required to recompute demand';
    END IF;
  END IF;

  RETURN QUERY
  WITH sales AS (
    SELECT i.sku_id, SUM(i.quantity)::int AS units
      FROM public.shipstation_order_items i
      JOIN public.shipstation_orders o ON o.id = i.shipstation_order_id
     WHERE i.sku_id IS NOT NULL
       AND o.order_status IN ('shipped', 'awaiting_shipment')
       AND o.order_date >= current_date - INTERVAL '30 days'
       AND o.order_date <  current_date
     GROUP BY i.sku_id
  ),
  computed AS (
    SELECT ps.id,
           ps.sku AS sku,
           COALESCE(ps.monthly_demand, 0) AS old_demand,
           COALESCE(s.units, 0)           AS new_demand
      FROM public.product_skus ps
      LEFT JOIN sales s ON s.sku_id = ps.id
     WHERE ps.archived_at IS NULL
       AND ps.is_active
  ),
  -- Data-modifying CTE: always executes (Postgres runs it even when the
  -- outer query doesn't reference it). Skips writes entirely on dry-run.
  upd AS (
    UPDATE public.product_skus p
       SET monthly_demand = c.new_demand
      FROM computed c
     WHERE p.id = c.id
       AND c.new_demand IS DISTINCT FROM c.old_demand
       AND NOT p_dry_run
    RETURNING p.id
  )
  SELECT c.sku, c.old_demand, c.new_demand, (c.new_demand - c.old_demand) AS delta
    FROM computed c
   WHERE c.new_demand IS DISTINCT FROM c.old_demand
   ORDER BY abs(c.new_demand - c.old_demand) DESC;
END;
$$;

COMMENT ON FUNCTION public.rpc_recompute_demand IS
  'Recomputes product_skus.monthly_demand from trailing-30-complete-days ShipStation sales (shipped+awaiting_shipment). Leaves demand_overrides untouched. p_dry_run=true returns the diff without writing. Returns changed SKUs (sku, old, new, delta).';
