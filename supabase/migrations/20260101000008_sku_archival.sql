-- =============================================================
-- Migration 008: SKU archival (soft delete)
-- =============================================================
-- Replaces hard DELETE on product_skus with a "hide but recoverable"
-- pattern. Hard deletes are dangerous because:
--
--   1. freight_line_items, inventory_transactions, factory_order_items,
--      and task_logs all reference product_skus — deleting a SKU would
--      orphan or cascade-destroy years of historical data.
--   2. Someone misclicks and you've permanently lost a product's record.
--
-- Archiving keeps the row intact. The UI filters out archived SKUs by
-- default; admins can toggle "Show archived" and restore.
--
-- This migration:
--   A. Removes ON DELETE CASCADE from FKs that pointed at product_skus
--      so that a hard-delete attempt fails loudly instead of cascading.
--   B. Adds archive_* columns to product_skus.
--   C. Creates archive_sku() and restore_sku() RPCs that also write audit entries.
--   D. Creates a view `product_skus_active` that callers can SELECT from
--      to automatically exclude archived rows.

-- -------------------------------------------------------------
-- A. Replace dangerous cascading deletes
-- -------------------------------------------------------------
-- Foreign keys that originally had ON DELETE CASCADE to product_skus:
--   sku_economics.sku_id  — 1:1, keeping cascade makes sense; lock via trigger instead
--   inventory_levels.sku_id — 1:1, same reasoning
-- Foreign keys that referenced product_skus without cascade (fine as-is):
--   task_logs.sku_id, freight_line_items.sku_id, factory_order_items.sku_id,
--   inventory_transactions.sku_id

-- Drop existing FK constraints and recreate them without cascade.
-- (These three are the only ones that had ON DELETE CASCADE.)
ALTER TABLE sku_economics
  DROP CONSTRAINT sku_economics_sku_id_fkey;
ALTER TABLE sku_economics
  ADD CONSTRAINT sku_economics_sku_id_fkey
    FOREIGN KEY (sku_id) REFERENCES product_skus(id) ON DELETE RESTRICT;

ALTER TABLE inventory_levels
  DROP CONSTRAINT inventory_levels_sku_id_fkey;
ALTER TABLE inventory_levels
  ADD CONSTRAINT inventory_levels_sku_id_fkey
    FOREIGN KEY (sku_id) REFERENCES product_skus(id) ON DELETE RESTRICT;

-- Block hard delete of any SKU — archiving is always the correct path.
CREATE OR REPLACE FUNCTION block_sku_hard_delete()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Hard delete of product_skus is not allowed. Use archive_sku() instead.'
    USING HINT = 'Call SELECT archive_sku(''<sku_id>'', auth.uid(), ''reason'') to hide the SKU.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_block_sku_delete
  BEFORE DELETE ON product_skus
  FOR EACH ROW EXECUTE FUNCTION block_sku_hard_delete();

-- -------------------------------------------------------------
-- B. Archive columns on product_skus
-- -------------------------------------------------------------
ALTER TABLE product_skus
  ADD COLUMN archived_at TIMESTAMPTZ,
  ADD COLUMN archived_by UUID REFERENCES profiles(id),
  ADD COLUMN archive_reason TEXT;

-- Index for the common "show only active" query
CREATE INDEX idx_product_skus_not_archived ON product_skus(id) WHERE archived_at IS NULL;

-- -------------------------------------------------------------
-- C. archive_sku() and restore_sku() RPCs
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

  -- Safety check: refuse to archive a SKU that still has on-hand inventory
  SELECT COALESCE(
    warehouse_raw + warehouse_in_production + warehouse_finished + warehouse_other
    + in_transit_air + in_transit_sea + in_transit_high_risk
    + nancy_finished + nancy_ordered + yx_finished + yx_ordered,
    0
  ) INTO v_inv_total
  FROM inventory_levels WHERE sku_id = p_sku_id;

  IF COALESCE(v_inv_total, 0) > 0 THEN
    RAISE EXCEPTION 'Cannot archive SKU % — has % units on hand across all buckets. Move stock to warehouse_other or mark as breakage first.',
      v_sku.sku, v_inv_total
      USING HINT = 'If this is intentional, call archive_sku_force() instead.';
  END IF;

  UPDATE product_skus
     SET archived_at = now(),
         archived_by = p_actor_id,
         archive_reason = p_reason,
         is_active = false
   WHERE id = p_sku_id;

  -- Audit entry
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

-- Escape hatch for when a SKU genuinely needs to be archived despite having stock
-- (e.g., discontinued, will be written off). Requires explicit call, different name.
CREATE OR REPLACE FUNCTION archive_sku_force(
  p_sku_id UUID,
  p_actor_id UUID,
  p_reason TEXT
) RETURNS VOID AS $$
DECLARE
  v_sku RECORD;
BEGIN
  SELECT * INTO v_sku FROM product_skus WHERE id = p_sku_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SKU % not found', p_sku_id;
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
    p_sku_id, 'sku_archived_force', 0, 'archived_at',
    p_sku_id, 'product_sku',
    format('%s force-archived: %s', v_sku.sku, p_reason),
    p_actor_id
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION restore_sku(
  p_sku_id UUID,
  p_actor_id UUID
) RETURNS VOID AS $$
DECLARE
  v_sku RECORD;
BEGIN
  SELECT * INTO v_sku FROM product_skus WHERE id = p_sku_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SKU % not found', p_sku_id;
  END IF;
  IF v_sku.archived_at IS NULL THEN
    RAISE EXCEPTION 'SKU % is not archived', v_sku.sku;
  END IF;

  UPDATE product_skus
     SET archived_at = NULL,
         archived_by = NULL,
         archive_reason = NULL,
         is_active = true
   WHERE id = p_sku_id;

  INSERT INTO inventory_transactions (
    sku_id, transaction_type, quantity, field_affected,
    reference_id, reference_type, notes, performed_by
  ) VALUES (
    p_sku_id, 'sku_restored', 0, 'archived_at',
    p_sku_id, 'product_sku',
    format('%s restored from archive', v_sku.sku),
    p_actor_id
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- -------------------------------------------------------------
-- D. Convenience view excluding archived SKUs
-- -------------------------------------------------------------
CREATE OR REPLACE VIEW product_skus_active AS
  SELECT * FROM product_skus WHERE archived_at IS NULL;

COMMENT ON COLUMN product_skus.archived_at IS
  'When non-null, SKU is archived (hidden from default queries). Data is preserved; use restore_sku() to undo.';
