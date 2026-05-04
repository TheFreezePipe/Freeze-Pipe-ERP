-- =============================================================
-- Migration 007: Optimistic concurrency control
-- =============================================================
-- Adds a `row_version` integer to mutable tables. Every UPDATE from the
-- application must include the expected row_version in its WHERE clause:
--
--   UPDATE product_skus
--      SET retail_price = $1, row_version = row_version + 1
--    WHERE id = $2 AND row_version = $3;
--
-- If the update affects 0 rows, the client knows another actor modified
-- the row first, and surfaces a merge/retry prompt instead of silently
-- clobbering.
--
-- A trigger auto-increments row_version on any UPDATE so callers cannot
-- forget, and so RPCs don't need to manage it manually.

-- -------------------------------------------------------------
-- Add row_version to mutable tables
-- -------------------------------------------------------------
ALTER TABLE profiles           ADD COLUMN row_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE product_skus       ADD COLUMN row_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE sku_economics      ADD COLUMN row_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE freight_shipments  ADD COLUMN row_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE inventory_levels   ADD COLUMN row_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE factory_orders     ADD COLUMN row_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE factory_order_items ADD COLUMN row_version INTEGER NOT NULL DEFAULT 1;

-- -------------------------------------------------------------
-- Trigger: auto-increment row_version on UPDATE
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION bump_row_version()
RETURNS TRIGGER AS $$
BEGIN
  -- If caller did not touch row_version explicitly, bump it by 1.
  -- If caller set a specific value (e.g., to reset), respect it.
  IF NEW.row_version = OLD.row_version THEN
    NEW.row_version = OLD.row_version + 1;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_bump_version_profiles
  BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION bump_row_version();

CREATE TRIGGER trg_bump_version_product_skus
  BEFORE UPDATE ON product_skus
  FOR EACH ROW EXECUTE FUNCTION bump_row_version();

CREATE TRIGGER trg_bump_version_sku_economics
  BEFORE UPDATE ON sku_economics
  FOR EACH ROW EXECUTE FUNCTION bump_row_version();

CREATE TRIGGER trg_bump_version_freight_shipments
  BEFORE UPDATE ON freight_shipments
  FOR EACH ROW EXECUTE FUNCTION bump_row_version();

CREATE TRIGGER trg_bump_version_inventory_levels
  BEFORE UPDATE ON inventory_levels
  FOR EACH ROW EXECUTE FUNCTION bump_row_version();

CREATE TRIGGER trg_bump_version_factory_orders
  BEFORE UPDATE ON factory_orders
  FOR EACH ROW EXECUTE FUNCTION bump_row_version();

CREATE TRIGGER trg_bump_version_factory_order_items
  BEFORE UPDATE ON factory_order_items
  FOR EACH ROW EXECUTE FUNCTION bump_row_version();

COMMENT ON COLUMN profiles.row_version IS
  'Optimistic-concurrency guard. Clients must include in WHERE for UPDATE; 0 rows affected = conflict.';
