-- =============================================================
-- Migration 014: Locations — ready for multi-warehouse growth
-- =============================================================
-- Today: one warehouse. Seeded automatically below as "Main Warehouse".
-- Tomorrow: a second warehouse, a 3PL, an overstock location — all handled
-- by inserting a row into `locations` and an inventory_levels row per SKU
-- for that location.
--
-- The structural change: inventory_levels becomes uniquely keyed on
-- (sku_id, location_id) instead of just sku_id. Queries that want "total
-- on-hand across all locations" sum across rows. Queries that want "what's
-- at Main Warehouse" filter by location.
--
-- Application code that currently assumes one row per SKU continues to work:
-- we keep a default location and always query with `location_id = default`
-- until the day a second location exists.

-- -------------------------------------------------------------
-- A. locations table
-- -------------------------------------------------------------
CREATE TABLE locations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT UNIQUE NOT NULL,              -- short identifier, e.g. "MAIN", "3PL-WEST"
  name TEXT NOT NULL,
  location_type TEXT NOT NULL CHECK (location_type IN ('warehouse', 'three_pl', 'supplier_warehouse', 'store')),
  -- Address (optional but commonly used)
  address_line1 TEXT,
  address_line2 TEXT,
  city TEXT,
  state TEXT,
  postal_code TEXT,
  country TEXT DEFAULT 'US',
  -- A single location can be flagged default; exactly one default at a time.
  is_default BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  row_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Only one default location allowed
CREATE UNIQUE INDEX idx_locations_single_default
  ON locations(is_default) WHERE is_default = true;

CREATE INDEX idx_locations_active ON locations(is_active) WHERE is_active = true;

-- Auto-bump row_version
CREATE TRIGGER trg_bump_version_locations
  BEFORE UPDATE ON locations
  FOR EACH ROW EXECUTE FUNCTION bump_row_version();

-- updated_at
CREATE TRIGGER set_updated_at BEFORE UPDATE ON locations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- RLS
ALTER TABLE locations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated can read locations" ON locations
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "Admins can manage locations" ON locations
  FOR ALL TO authenticated USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'manager'))
  );

-- -------------------------------------------------------------
-- B. Seed the Main Warehouse as the default
-- -------------------------------------------------------------
-- Well-known UUID so application code can reference it without a lookup.
INSERT INTO locations (id, code, name, location_type, is_default, is_active)
VALUES (
  '00000000-0000-0000-0000-000000000100',
  'MAIN',
  'Main Warehouse',
  'warehouse',
  true,
  true
);

-- -------------------------------------------------------------
-- C. Restructure inventory_levels — add location_id
-- -------------------------------------------------------------
-- The existing unique constraint on sku_id needs to become (sku_id, location_id).
-- Strategy:
--   1. Add column (nullable, default to main location for backfill)
--   2. Backfill all existing rows
--   3. Make NOT NULL
--   4. Drop old unique constraint on sku_id
--   5. Add new unique constraint on (sku_id, location_id)

ALTER TABLE inventory_levels
  ADD COLUMN location_id UUID REFERENCES locations(id) ON DELETE RESTRICT;

UPDATE inventory_levels
   SET location_id = '00000000-0000-0000-0000-000000000100'
 WHERE location_id IS NULL;

ALTER TABLE inventory_levels
  ALTER COLUMN location_id SET NOT NULL;

-- Drop the old unique constraint (it was on sku_id alone)
ALTER TABLE inventory_levels
  DROP CONSTRAINT IF EXISTS inventory_levels_sku_id_key;

-- Add the new compound unique constraint
ALTER TABLE inventory_levels
  ADD CONSTRAINT inventory_levels_sku_location_unique UNIQUE (sku_id, location_id);

-- Index for "give me everything at location X"
CREATE INDEX idx_inventory_by_location ON inventory_levels(location_id);

-- -------------------------------------------------------------
-- D. Convenience view: current totals at default location
-- -------------------------------------------------------------
-- Most existing app queries want "inventory at our one warehouse". This
-- view gives them exactly that without a JOIN.
CREATE OR REPLACE VIEW inventory_levels_default AS
  SELECT il.*
    FROM inventory_levels il
    JOIN locations l ON l.id = il.location_id
   WHERE l.is_default = true;

-- -------------------------------------------------------------
-- E. Convenience view: totals across ALL locations per SKU
-- -------------------------------------------------------------
-- For dashboards that want "total on-hand worldwide" once we go multi-location.
CREATE OR REPLACE VIEW inventory_totals_by_sku AS
  SELECT
    sku_id,
    SUM(warehouse_raw) AS warehouse_raw,
    SUM(warehouse_in_production) AS warehouse_in_production,
    SUM(warehouse_finished) AS warehouse_finished,
    SUM(warehouse_other) AS warehouse_other,
    SUM(in_transit_air) AS in_transit_air,
    SUM(in_transit_sea) AS in_transit_sea,
    SUM(in_transit_high_risk) AS in_transit_high_risk,
    SUM(nancy_finished) AS nancy_finished,
    SUM(nancy_ordered) AS nancy_ordered,
    SUM(yx_finished) AS yx_finished,
    SUM(yx_ordered) AS yx_ordered,
    COUNT(*) AS location_count,
    MAX(updated_at) AS most_recent_update
  FROM inventory_levels
  GROUP BY sku_id;

-- -------------------------------------------------------------
-- F. Update the atomic RPCs from migration 010 to accept optional location_id
-- -------------------------------------------------------------
-- We overload rather than replacing; the no-location call targets the
-- default location, which is the behavior the existing app needs.

CREATE OR REPLACE FUNCTION _default_location_id() RETURNS UUID AS $$
  SELECT id FROM locations WHERE is_default = true LIMIT 1
$$ LANGUAGE SQL STABLE;

-- Example: rpc_log_task_completion now accepts p_location_id and defaults.
-- Redefined here so existing callers need no change.
CREATE OR REPLACE FUNCTION rpc_log_task_completion(
  p_sku_id UUID,
  p_task_type TEXT,
  p_quantity INTEGER,
  p_notes TEXT,
  p_actor_id UUID,
  p_time_started TIMESTAMPTZ DEFAULT NULL,
  p_time_completed TIMESTAMPTZ DEFAULT now(),
  p_location_id UUID DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
  v_sku product_skus%ROWTYPE;
  v_move RECORD;
  v_task_log_id UUID;
  v_available INTEGER;
  v_location_id UUID;
BEGIN
  v_location_id := COALESCE(p_location_id, _default_location_id());

  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'quantity must be positive');
  END IF;

  SELECT * INTO v_sku FROM product_skus WHERE id = p_sku_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'sku not found');
  END IF;
  IF v_sku.archived_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'sku is archived');
  END IF;

  SELECT * INTO v_move FROM _task_type_movement(p_task_type);

  PERFORM 1 FROM inventory_levels
    WHERE sku_id = p_sku_id AND location_id = v_location_id FOR UPDATE;

  IF v_move.from_field IS NOT NULL THEN
    EXECUTE format(
      'SELECT %I FROM inventory_levels WHERE sku_id = $1 AND location_id = $2',
      v_move.from_field
    ) INTO v_available USING p_sku_id, v_location_id;

    IF v_available IS NULL OR v_available < p_quantity THEN
      RETURN jsonb_build_object(
        'ok', false,
        'error', 'insufficient_source_stock',
        'available', COALESCE(v_available, 0),
        'requested', p_quantity,
        'location_id', v_location_id
      );
    END IF;

    EXECUTE format(
      'UPDATE inventory_levels SET %I = %I - $1, %I = %I + $1 WHERE sku_id = $2 AND location_id = $3',
      v_move.from_field, v_move.from_field,
      v_move.to_field, v_move.to_field
    ) USING p_quantity, p_sku_id, v_location_id;
  END IF;

  INSERT INTO task_logs (
    employee_id, sku_id, task_type, quantity_processed,
    time_started, time_completed, notes
  ) VALUES (
    p_actor_id, p_sku_id, p_task_type, p_quantity,
    p_time_started, p_time_completed, p_notes
  ) RETURNING id INTO v_task_log_id;

  INSERT INTO inventory_transactions (
    sku_id, transaction_type, quantity, field_affected,
    movement_kind, from_field, to_field,
    reference_id, reference_type, notes, performed_by
  ) VALUES (
    p_sku_id, 'task_logged', p_quantity,
    COALESCE(v_move.to_field, 'warehouse_in_production'),
    CASE WHEN v_move.from_field IS NULL THEN 'metadata' ELSE 'category_move' END,
    v_move.from_field, v_move.to_field,
    v_task_log_id, 'task_log',
    format('%s: %s of %s units%s',
      v_sku.sku, replace(p_task_type, '_', ' '), p_quantity,
      CASE WHEN p_notes IS NOT NULL THEN ' — ' || p_notes ELSE '' END),
    p_actor_id
  );

  RETURN jsonb_build_object('ok', true, 'task_log_id', v_task_log_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION rpc_log_task_completion(UUID, TEXT, INTEGER, TEXT, UUID, TIMESTAMPTZ, TIMESTAMPTZ, UUID) TO authenticated;

COMMENT ON VIEW inventory_levels_default IS
  'Single-location view. Use this for queries that assume one warehouse. Switch to inventory_totals_by_sku when multi-location.';
