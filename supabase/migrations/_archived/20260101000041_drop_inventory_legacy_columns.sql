-- =============================================================
-- Migration 041: drop inventory_levels legacy columns
-- =============================================================
-- Final step in the supplier-portal-era cleanup. Migrations 039 + 040
-- already decommissioned the RPCs, triggers, views, and the
-- supplier_inventory mirror that wrote to / read from these columns.
-- This migration removes the columns themselves.
--
-- Columns dropped from `inventory_levels`:
--   - in_transit_air
--   - in_transit_sea
--   - in_transit_high_risk
--   - nancy_finished
--   - nancy_ordered
--   - yx_finished
--   - yx_ordered
--
-- In Transit and On Order are now exclusively derived from the live
-- sources:
--   In Transit per SKU  = Σ freight_line_items.quantity across
--                         freight_shipments with status in
--                         (pending, on_the_water, high_risk,
--                          cleared_customs, tracking)
--   On Order per SKU    = Σ max(0, factory_order_items.quantity_ordered
--                               - quantity_breakage
--                               - shipped_via_freight)
--                         across factory_orders with status in
--                         (ordered, in_production, finished)
-- (see src/lib/inventory-aggregates.ts for the canonical derivation).
--
-- Dependent objects that must be rebuilt (these reference the columns
-- either via SELECT * or an explicit column list):
--   * VIEW  inventory_levels_default        (migration 014)
--   * VIEW  inventory_totals_by_sku         (migration 014)
--   * FUNCTION archive_sku(...)             (migration 008) — the safety
--                                            check sum included the legacy
--                                            columns; simplified to
--                                            warehouse-only totals.
--
-- Dependent objects already handled:
--   * rpc_apply_freight_delivery            modernized in migration 039
--   * rpc_advance_factory_order_stage       dropped in migration 039
--   * supplier_inventory + sync triggers    dropped in migration 040
--   * supplier_inventory_* views            dropped in migration 040
--
-- The migration is structured so a failed middle step rolls back the
-- entire transaction (the deploy BEGIN/COMMIT envelope covers this).
-- =============================================================

-- -------------------------------------------------------------
-- 1. Drop the two convenience views that reference legacy columns.
--    They'll be recreated at the bottom of the migration with the
--    reduced column set so the next app release that queries them
--    still works.
-- -------------------------------------------------------------
DROP VIEW IF EXISTS inventory_totals_by_sku;
DROP VIEW IF EXISTS inventory_levels_default;

-- -------------------------------------------------------------
-- 2. Drop the CHECK constraints from migration 006 that validate
--    non-negativity on the legacy columns. Must go before the
--    DROP COLUMN or Postgres refuses to drop a constrained column.
-- -------------------------------------------------------------
ALTER TABLE inventory_levels
  DROP CONSTRAINT IF EXISTS chk_inv_transit_air_nonneg,
  DROP CONSTRAINT IF EXISTS chk_inv_transit_sea_nonneg,
  DROP CONSTRAINT IF EXISTS chk_inv_transit_high_risk_nonneg,
  DROP CONSTRAINT IF EXISTS chk_inv_nancy_finished_nonneg,
  DROP CONSTRAINT IF EXISTS chk_inv_nancy_ordered_nonneg,
  DROP CONSTRAINT IF EXISTS chk_inv_yx_finished_nonneg,
  DROP CONSTRAINT IF EXISTS chk_inv_yx_ordered_nonneg;

-- -------------------------------------------------------------
-- 3. Rewrite archive_sku to remove the legacy-column sum in its
--    safety check. Pre-041 it summed all 11 bucket columns; post-041
--    there are only 4 warehouse_* buckets. Transit + On Order stock
--    lives elsewhere — if an ops person wants to archive a SKU with
--    open freight or factory orders, the in-app flow guides them;
--    the DB check only guards against "there's still stock in the
--    warehouse." archive_sku_force() remains the escape hatch for
--    genuine write-offs.
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION archive_sku(
  p_sku_id UUID,
  p_actor_id UUID,
  p_reason TEXT
) RETURNS VOID AS $$
DECLARE
  v_sku RECORD;
  v_inv_total INTEGER;
BEGIN
  SELECT * INTO v_sku FROM product_skus WHERE id = p_sku_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SKU % not found', p_sku_id;
  END IF;
  IF v_sku.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'SKU % is already archived', v_sku.sku;
  END IF;

  -- Warehouse-only on-hand check. See migration 041 header for the
  -- reasoning: in-transit + on-order stock lives in freight_shipments
  -- + factory_orders respectively; archiving a SKU with open upstream
  -- activity is an app-layer concern.
  SELECT COALESCE(
    warehouse_raw + warehouse_in_production + warehouse_finished + warehouse_other,
    0
  ) INTO v_inv_total
  FROM inventory_levels WHERE sku_id = p_sku_id;

  IF COALESCE(v_inv_total, 0) > 0 THEN
    RAISE EXCEPTION 'Cannot archive SKU % — has % units on hand in the warehouse. Move stock to warehouse_other or mark as breakage first.',
      v_sku.sku, v_inv_total
      USING HINT = 'If this is intentional, call archive_sku_force() instead.';
  END IF;

  UPDATE product_skus
     SET archived_at = now(),
         archived_by = p_actor_id,
         archive_reason = p_reason,
         is_active = false
   WHERE id = p_sku_id;

  INSERT INTO inventory_transactions (
    sku_id, transaction_type, quantity, field_affected,
    reference_id, reference_type, notes, performed_by
  ) VALUES (
    p_sku_id, 'sku_archived', 0, 'archived_at',
    p_sku_id, 'product_sku',
    format('%s archived: %s', v_sku.sku, p_reason),
    p_actor_id
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- -------------------------------------------------------------
-- 4. Drop the seven legacy columns.
-- -------------------------------------------------------------
ALTER TABLE inventory_levels
  DROP COLUMN IF EXISTS in_transit_air,
  DROP COLUMN IF EXISTS in_transit_sea,
  DROP COLUMN IF EXISTS in_transit_high_risk,
  DROP COLUMN IF EXISTS nancy_finished,
  DROP COLUMN IF EXISTS nancy_ordered,
  DROP COLUMN IF EXISTS yx_finished,
  DROP COLUMN IF EXISTS yx_ordered;

-- -------------------------------------------------------------
-- 5. Recreate the two convenience views, now without the legacy
--    columns. Identical shape to migration 014's definitions minus
--    the dropped fields.
-- -------------------------------------------------------------
CREATE OR REPLACE VIEW inventory_levels_default AS
  SELECT il.*
    FROM inventory_levels il
    JOIN locations l ON l.id = il.location_id
   WHERE l.is_default = true;

COMMENT ON VIEW inventory_levels_default IS
  'Single-location view. Use this for queries that assume one warehouse. Switch to inventory_totals_by_sku when multi-location.';

CREATE OR REPLACE VIEW inventory_totals_by_sku AS
  SELECT
    sku_id,
    SUM(warehouse_raw) AS warehouse_raw,
    SUM(warehouse_in_production) AS warehouse_in_production,
    SUM(warehouse_finished) AS warehouse_finished,
    SUM(warehouse_other) AS warehouse_other,
    COUNT(*) AS location_count,
    MAX(updated_at) AS most_recent_update
  FROM inventory_levels
  GROUP BY sku_id;

-- -------------------------------------------------------------
-- 6. Sanity checks. Any of these raising means we're in a bad state
--    and the enclosing transaction rolls back.
-- -------------------------------------------------------------
DO $$
DECLARE
  v_missing TEXT;
BEGIN
  -- Legacy columns really are gone
  FOR v_missing IN
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'inventory_levels'
       AND column_name IN (
         'in_transit_air', 'in_transit_sea', 'in_transit_high_risk',
         'nancy_finished', 'nancy_ordered', 'yx_finished', 'yx_ordered'
       )
  LOOP
    RAISE EXCEPTION 'Legacy column % still present on inventory_levels after migration 041', v_missing;
  END LOOP;

  -- Warehouse columns survive
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'inventory_levels'
       AND column_name = 'warehouse_raw'
  ) THEN
    RAISE EXCEPTION 'warehouse_raw missing after migration 041 — dropped too much';
  END IF;

  -- Views recreated
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.views
     WHERE table_schema = 'public' AND table_name = 'inventory_levels_default'
  ) THEN
    RAISE EXCEPTION 'inventory_levels_default view was not recreated';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.views
     WHERE table_schema = 'public' AND table_name = 'inventory_totals_by_sku'
  ) THEN
    RAISE EXCEPTION 'inventory_totals_by_sku view was not recreated';
  END IF;

  -- archive_sku still present
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'archive_sku'
  ) THEN
    RAISE EXCEPTION 'archive_sku function went missing after migration 041';
  END IF;
END$$;
