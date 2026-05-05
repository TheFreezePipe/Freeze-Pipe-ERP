-- =============================================================
-- Migration 017: Supplier / vendor master table
-- =============================================================
-- Replaces the `factory TEXT CHECK IN ('nancy','yx')` pattern with a proper
-- normalized supplier model.
--
-- The change touches two tables:
--   * factory_orders.factory (enum) → factory_orders.supplier_id (FK)
--   * inventory_levels per-supplier columns (nancy_ordered, yx_ordered, ...)
--     are mirrored into a new supplier_inventory table. The mirror lets
--     NEW code use the normalized model while the existing app continues
--     to read the legacy columns until it's fully migrated.
--
-- The mirror is maintained by a trigger in both directions so neither side
-- drifts during the transition. Once every application code path has been
-- updated to use supplier_inventory, a follow-up migration drops the
-- legacy columns.

-- -------------------------------------------------------------
-- A. suppliers master table
-- -------------------------------------------------------------
CREATE TABLE suppliers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Short code used in logs and UI; unique
  code TEXT UNIQUE NOT NULL,
  -- Display name
  name TEXT NOT NULL,
  -- Free-form contact fields — replace with a proper contacts table if you
  -- ever need multiple contacts per supplier.
  contact_name TEXT,
  contact_email TEXT CHECK (contact_email IS NULL OR contact_email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'),
  contact_phone TEXT,
  -- Address / geography
  address_line1 TEXT,
  address_line2 TEXT,
  city TEXT,
  state_region TEXT,
  postal_code TEXT,
  country TEXT NOT NULL DEFAULT 'CN',
  -- Operational
  default_lead_time_days INTEGER CHECK (default_lead_time_days IS NULL OR default_lead_time_days >= 0),
  -- Payment terms: free-form, e.g., "Net 30", "50% deposit, 50% on shipment".
  -- Consider a structured table if you start running AP reports out of this.
  payment_terms TEXT,
  -- Currency the supplier invoices in (ISO 4217). Used for AP + landed cost math.
  invoice_currency CHAR(3) NOT NULL DEFAULT 'USD',
  -- Notes field for operators
  notes TEXT,
  -- Status
  is_active BOOLEAN NOT NULL DEFAULT true,
  row_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_suppliers_active ON suppliers(is_active) WHERE is_active = true;

CREATE TRIGGER trg_bump_version_suppliers
  BEFORE UPDATE ON suppliers
  FOR EACH ROW EXECUTE FUNCTION bump_row_version();

CREATE TRIGGER set_updated_at BEFORE UPDATE ON suppliers
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated can read suppliers"
  ON suppliers FOR SELECT TO authenticated USING (true);
CREATE POLICY "Admins can manage suppliers"
  ON suppliers FOR ALL TO authenticated USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'manager'))
  );

-- -------------------------------------------------------------
-- B. Seed Nancy + YX as suppliers
-- -------------------------------------------------------------
-- Well-known UUIDs so application code can reference them if needed
-- during the transition period without a lookup round-trip.
INSERT INTO suppliers (id, code, name, country, invoice_currency, is_active)
VALUES
  ('00000000-0000-0000-0000-000000000201', 'NANCY', 'Nancy (Glass)', 'CN', 'CNY', true),
  ('00000000-0000-0000-0000-000000000202', 'YX',    'YX (Hardware)', 'CN', 'CNY', true);

-- -------------------------------------------------------------
-- C. supplier_inventory — normalized per-supplier stock
-- -------------------------------------------------------------
-- Replaces the nancy_ordered / nancy_finished / yx_ordered / yx_finished
-- columns on inventory_levels. Adding a third supplier is now a single
-- INSERT, not a schema migration.
CREATE TABLE supplier_inventory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku_id UUID NOT NULL REFERENCES product_skus(id) ON DELETE RESTRICT,
  supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  stage TEXT NOT NULL CHECK (stage IN ('ordered', 'finished')),
  quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  row_version INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (sku_id, supplier_id, stage)
);

CREATE INDEX idx_supplier_inventory_sku ON supplier_inventory(sku_id);
CREATE INDEX idx_supplier_inventory_supplier ON supplier_inventory(supplier_id);
CREATE INDEX idx_supplier_inventory_stage ON supplier_inventory(stage);

CREATE TRIGGER trg_bump_version_supplier_inventory
  BEFORE UPDATE ON supplier_inventory
  FOR EACH ROW EXECUTE FUNCTION bump_row_version();

CREATE TRIGGER set_updated_at BEFORE UPDATE ON supplier_inventory
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE supplier_inventory ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated can read supplier inventory"
  ON supplier_inventory FOR SELECT TO authenticated USING (true);
CREATE POLICY "Admins can manage supplier inventory"
  ON supplier_inventory FOR ALL TO authenticated USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'manager'))
  );

-- -------------------------------------------------------------
-- D. Backfill: migrate inventory_levels columns → supplier_inventory
-- -------------------------------------------------------------
-- One row per (sku, supplier, stage) derived from the legacy columns.
INSERT INTO supplier_inventory (sku_id, supplier_id, stage, quantity)
SELECT sku_id, '00000000-0000-0000-0000-000000000201'::uuid, 'ordered', nancy_ordered
  FROM inventory_levels WHERE nancy_ordered IS NOT NULL
UNION ALL
SELECT sku_id, '00000000-0000-0000-0000-000000000201'::uuid, 'finished', nancy_finished
  FROM inventory_levels WHERE nancy_finished IS NOT NULL
UNION ALL
SELECT sku_id, '00000000-0000-0000-0000-000000000202'::uuid, 'ordered', yx_ordered
  FROM inventory_levels WHERE yx_ordered IS NOT NULL
UNION ALL
SELECT sku_id, '00000000-0000-0000-0000-000000000202'::uuid, 'finished', yx_finished
  FROM inventory_levels WHERE yx_finished IS NOT NULL
ON CONFLICT (sku_id, supplier_id, stage) DO NOTHING;

-- -------------------------------------------------------------
-- E. factory_orders: add supplier_id, backfill, drop factory enum
-- -------------------------------------------------------------
ALTER TABLE factory_orders
  ADD COLUMN supplier_id UUID REFERENCES suppliers(id) ON DELETE RESTRICT;

UPDATE factory_orders SET supplier_id = CASE factory
  WHEN 'nancy' THEN '00000000-0000-0000-0000-000000000201'::uuid
  WHEN 'yx'    THEN '00000000-0000-0000-0000-000000000202'::uuid
END;

ALTER TABLE factory_orders
  ALTER COLUMN supplier_id SET NOT NULL,
  DROP CONSTRAINT factory_orders_factory_check,
  DROP COLUMN factory;

CREATE INDEX idx_factory_orders_supplier ON factory_orders(supplier_id);

-- -------------------------------------------------------------
-- F. Two-way sync trigger (transition period only)
-- -------------------------------------------------------------
-- Until every app code path reads from supplier_inventory instead of the
-- legacy columns, keep them in sync. A later migration will drop the
-- legacy columns and this trigger.
--
-- Direction 1: supplier_inventory change → update legacy columns on inventory_levels
CREATE OR REPLACE FUNCTION sync_supplier_inventory_to_legacy()
RETURNS TRIGGER AS $$
DECLARE
  v_sup_code TEXT;
  v_legacy_col TEXT;
BEGIN
  -- Only sync for the two legacy suppliers
  SELECT code INTO v_sup_code FROM suppliers WHERE id = NEW.supplier_id;
  IF v_sup_code NOT IN ('NANCY', 'YX') THEN
    RETURN NEW;
  END IF;
  v_legacy_col := lower(v_sup_code) || '_' || NEW.stage;
  EXECUTE format(
    'UPDATE inventory_levels SET %I = $1 WHERE sku_id = $2',
    v_legacy_col
  ) USING NEW.quantity, NEW.sku_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_sync_supplier_inv_to_legacy
  AFTER INSERT OR UPDATE ON supplier_inventory
  FOR EACH ROW EXECUTE FUNCTION sync_supplier_inventory_to_legacy();

-- Direction 2: legacy column change → update supplier_inventory
CREATE OR REPLACE FUNCTION sync_legacy_to_supplier_inventory()
RETURNS TRIGGER AS $$
DECLARE
  v_nancy_id UUID := '00000000-0000-0000-0000-000000000201';
  v_yx_id UUID := '00000000-0000-0000-0000-000000000202';
BEGIN
  IF NEW.nancy_ordered IS DISTINCT FROM OLD.nancy_ordered THEN
    INSERT INTO supplier_inventory (sku_id, supplier_id, stage, quantity)
    VALUES (NEW.sku_id, v_nancy_id, 'ordered', NEW.nancy_ordered)
    ON CONFLICT (sku_id, supplier_id, stage)
      DO UPDATE SET quantity = EXCLUDED.quantity;
  END IF;
  IF NEW.nancy_finished IS DISTINCT FROM OLD.nancy_finished THEN
    INSERT INTO supplier_inventory (sku_id, supplier_id, stage, quantity)
    VALUES (NEW.sku_id, v_nancy_id, 'finished', NEW.nancy_finished)
    ON CONFLICT (sku_id, supplier_id, stage)
      DO UPDATE SET quantity = EXCLUDED.quantity;
  END IF;
  IF NEW.yx_ordered IS DISTINCT FROM OLD.yx_ordered THEN
    INSERT INTO supplier_inventory (sku_id, supplier_id, stage, quantity)
    VALUES (NEW.sku_id, v_yx_id, 'ordered', NEW.yx_ordered)
    ON CONFLICT (sku_id, supplier_id, stage)
      DO UPDATE SET quantity = EXCLUDED.quantity;
  END IF;
  IF NEW.yx_finished IS DISTINCT FROM OLD.yx_finished THEN
    INSERT INTO supplier_inventory (sku_id, supplier_id, stage, quantity)
    VALUES (NEW.sku_id, v_yx_id, 'finished', NEW.yx_finished)
    ON CONFLICT (sku_id, supplier_id, stage)
      DO UPDATE SET quantity = EXCLUDED.quantity;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_sync_legacy_to_supplier_inv
  AFTER UPDATE ON inventory_levels
  FOR EACH ROW
  WHEN (
    OLD.nancy_ordered IS DISTINCT FROM NEW.nancy_ordered OR
    OLD.nancy_finished IS DISTINCT FROM NEW.nancy_finished OR
    OLD.yx_ordered IS DISTINCT FROM NEW.yx_ordered OR
    OLD.yx_finished IS DISTINCT FROM NEW.yx_finished
  )
  EXECUTE FUNCTION sync_legacy_to_supplier_inventory();

-- -------------------------------------------------------------
-- G. Convenience views
-- -------------------------------------------------------------
-- Single-row-per-SKU view across all suppliers, pivoted on stage
CREATE OR REPLACE VIEW supplier_inventory_by_sku AS
SELECT
  sku_id,
  COUNT(DISTINCT supplier_id) AS supplier_count,
  SUM(CASE WHEN stage = 'ordered' THEN quantity ELSE 0 END) AS total_ordered,
  SUM(CASE WHEN stage = 'finished' THEN quantity ELSE 0 END) AS total_finished,
  SUM(quantity) AS total_on_supplier
FROM supplier_inventory
GROUP BY sku_id;

-- Per-supplier-per-SKU with supplier metadata joined
CREATE OR REPLACE VIEW supplier_inventory_detailed AS
SELECT
  si.sku_id,
  s.id AS supplier_id,
  s.code AS supplier_code,
  s.name AS supplier_name,
  si.stage,
  si.quantity,
  si.updated_at
FROM supplier_inventory si
JOIN suppliers s ON s.id = si.supplier_id;

-- -------------------------------------------------------------
-- H. Update rpc_advance_factory_order_stage to use supplier_id
-- -------------------------------------------------------------
-- Previously accepted p_from_stage / p_to_stage as literals like 'nancy_ordered'.
-- New signature takes supplier_id directly + stage names ('ordered' | 'finished').
CREATE OR REPLACE FUNCTION rpc_advance_factory_order_stage(
  p_factory_order_item_id UUID,
  p_from_stage TEXT,
  p_to_stage TEXT,
  p_quantity INTEGER,
  p_actor_id UUID,
  p_notes TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
  v_item factory_order_items%ROWTYPE;
  v_order factory_orders%ROWTYPE;
  v_sku product_skus%ROWTYPE;
  v_supplier suppliers%ROWTYPE;
  v_available INTEGER;
BEGIN
  IF p_quantity <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'quantity must be positive');
  END IF;
  IF p_from_stage NOT IN ('ordered', 'finished')
     OR p_to_stage NOT IN ('ordered', 'finished')
     OR p_from_stage = p_to_stage THEN
    RETURN jsonb_build_object('ok', false, 'error', 'stages must be ordered/finished and differ');
  END IF;

  SELECT * INTO v_item FROM factory_order_items WHERE id = p_factory_order_item_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'factory order item not found');
  END IF;
  SELECT * INTO v_order FROM factory_orders WHERE id = v_item.factory_order_id;
  SELECT * INTO v_sku FROM product_skus WHERE id = v_item.sku_id;
  SELECT * INTO v_supplier FROM suppliers WHERE id = v_order.supplier_id;

  -- Lock + fetch current quantity at source stage
  SELECT quantity INTO v_available
    FROM supplier_inventory
   WHERE sku_id = v_item.sku_id
     AND supplier_id = v_order.supplier_id
     AND stage = p_from_stage
   FOR UPDATE;

  IF COALESCE(v_available, 0) < p_quantity THEN
    RETURN jsonb_build_object(
      'ok', false, 'error', 'insufficient_source_stock',
      'available', COALESCE(v_available, 0), 'requested', p_quantity
    );
  END IF;

  UPDATE supplier_inventory
     SET quantity = quantity - p_quantity
   WHERE sku_id = v_item.sku_id
     AND supplier_id = v_order.supplier_id
     AND stage = p_from_stage;

  INSERT INTO supplier_inventory (sku_id, supplier_id, stage, quantity)
  VALUES (v_item.sku_id, v_order.supplier_id, p_to_stage, p_quantity)
  ON CONFLICT (sku_id, supplier_id, stage)
    DO UPDATE SET quantity = supplier_inventory.quantity + EXCLUDED.quantity;

  UPDATE factory_order_items
     SET quantity_finished = quantity_finished + p_quantity
   WHERE id = p_factory_order_item_id;

  INSERT INTO inventory_transactions (
    sku_id, transaction_type, quantity, field_affected,
    movement_kind, from_field, to_field,
    reference_id, reference_type, notes, performed_by
  ) VALUES (
    v_item.sku_id, 'factory_order_update', p_quantity,
    format('%s_%s', v_supplier.code, p_to_stage),
    'category_move',
    format('%s_%s', v_supplier.code, p_from_stage),
    format('%s_%s', v_supplier.code, p_to_stage),
    v_item.factory_order_id, 'factory_order',
    format('%s [%s @ %s]: %s units %s → %s%s',
      v_sku.sku, COALESCE(v_order.order_number, v_order.id::text),
      v_supplier.name, p_quantity, p_from_stage, p_to_stage,
      CASE WHEN p_notes IS NOT NULL THEN ' — ' || p_notes ELSE '' END
    ),
    p_actor_id
  );

  RETURN jsonb_build_object('ok', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION rpc_advance_factory_order_stage(UUID, TEXT, TEXT, INTEGER, UUID, TEXT) TO authenticated;

COMMENT ON TABLE suppliers IS
  'Vendor / supplier master. Replaces the nancy/yx enum. Adding a new supplier no longer requires a schema change.';
COMMENT ON TABLE supplier_inventory IS
  'Per-supplier per-SKU on-hand quantity at supplier locations. Two stages: ordered (placed, not yet complete) and finished (ready to ship from factory to warehouse).';
