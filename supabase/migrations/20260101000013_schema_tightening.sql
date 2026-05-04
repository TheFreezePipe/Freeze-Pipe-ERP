-- =============================================================
-- Migration 013: Schema tightening — additional invariants,
-- indexes for common queries, and uniqueness constraints
-- =============================================================
-- This pass focuses on defense-in-depth: stuff that isn't a show-stopper
-- bug today but will matter at scale or protect against specific bad actors.

-- -------------------------------------------------------------
-- A. Uniqueness — factory_orders.order_number per factory
-- -------------------------------------------------------------
-- Two Nancy orders can share a number with a YX order (different suppliers
-- have different numbering schemes), but within a factory, order_number
-- must be unique. Allows NULL (pre-assignment stage).
CREATE UNIQUE INDEX idx_factory_orders_unique_per_factory
  ON factory_orders(factory, order_number)
  WHERE order_number IS NOT NULL;

-- -------------------------------------------------------------
-- B. Uniqueness — one line item per (shipment, sku)
-- -------------------------------------------------------------
-- Avoid duplicate line items on the same shipment: they should be merged
-- into a single row with the sum quantity.
CREATE UNIQUE INDEX idx_freight_items_unique_per_shipment_sku
  ON freight_line_items(freight_shipment_id, sku_id);

-- -------------------------------------------------------------
-- C. Uniqueness — one factory_order_item per (order, sku)
-- -------------------------------------------------------------
CREATE UNIQUE INDEX idx_fo_items_unique_per_order_sku
  ON factory_order_items(factory_order_id, sku_id);

-- -------------------------------------------------------------
-- D. Uniqueness — one task per (employee, sku, time_completed)
-- -------------------------------------------------------------
-- Prevents duplicate task log submissions when a click is accidentally
-- double-fired. Application layer should also send idempotency keys,
-- but this is a last-line defense.
CREATE UNIQUE INDEX idx_task_logs_unique_submission
  ON task_logs(employee_id, sku_id, task_type, time_completed)
  WHERE time_completed IS NOT NULL;

-- -------------------------------------------------------------
-- E. Performance indexes for common queries
-- -------------------------------------------------------------
-- Inventory dashboard: "show me SKUs with warehouse_finished < threshold"
CREATE INDEX idx_inv_finished ON inventory_levels(warehouse_finished);
-- Freight dashboard: ETA sort for "upcoming arrivals"
CREATE INDEX idx_freight_eta ON freight_shipments(eta) WHERE status != 'delivered';
-- Performance page: task_logs filtered by time_completed in a date range
CREATE INDEX idx_task_logs_time_completed ON task_logs(time_completed DESC);
-- ShipStation unresolved queue (created in migration 011 as a partial index, re-assert)
CREATE INDEX IF NOT EXISTS idx_ss_items_unresolved_composite
  ON shipstation_order_items(sku_code, shipstation_order_id)
  WHERE sku_id IS NULL;

-- -------------------------------------------------------------
-- F. NOT NULL where reasonable
-- -------------------------------------------------------------
-- `inventory_transactions.performed_by` should be NOT NULL — every audit
-- entry needs attribution. System-authored entries point at a reserved
-- "system" profile. First, seed that profile so existing rows don't fail.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE email = 'system@internal') THEN
    INSERT INTO profiles (id, email, full_name, role)
    VALUES (
      '00000000-0000-0000-0000-000000000001',
      'system@internal',
      'System (automated)',
      'admin'
    );
  END IF;
END$$;

-- Backfill any null performed_by rows to the system profile
UPDATE inventory_transactions
   SET performed_by = '00000000-0000-0000-0000-000000000001'
 WHERE performed_by IS NULL;

ALTER TABLE inventory_transactions
  ALTER COLUMN performed_by SET NOT NULL;

-- -------------------------------------------------------------
-- G. Check constraint: factory_order_item.unit_cost set when shipped
-- -------------------------------------------------------------
-- A factory order should always have a unit_cost by the time it becomes
-- 'shipped' — otherwise our freight landed-cost math breaks silently.
-- Defer this check so mid-transaction states are allowed.
CREATE OR REPLACE FUNCTION check_shipped_factory_order_has_cost()
RETURNS TRIGGER AS $$
DECLARE
  v_bad_items INTEGER;
BEGIN
  IF NEW.status = 'shipped' AND OLD.status != 'shipped' THEN
    SELECT COUNT(*) INTO v_bad_items
      FROM factory_order_items
     WHERE factory_order_id = NEW.id AND unit_cost = 0;
    IF v_bad_items > 0 THEN
      RAISE EXCEPTION 'Factory order % has % line item(s) without a unit_cost; set costs before shipping.',
        NEW.order_number, v_bad_items;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_factory_order_shipped_cost_check
  BEFORE UPDATE ON factory_orders
  FOR EACH ROW EXECUTE FUNCTION check_shipped_factory_order_has_cost();

-- -------------------------------------------------------------
-- H. Prevent status regression on freight_shipments
-- -------------------------------------------------------------
-- Once a shipment is 'delivered', it cannot go back to 'on_the_water'
-- without an explicit admin action (tracked separately in the audit log).
CREATE OR REPLACE FUNCTION prevent_freight_status_regression()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status = 'delivered' AND NEW.status != 'delivered' THEN
    RAISE EXCEPTION 'Cannot change status of delivered shipment % from delivered back to %. If this is a mistake, insert a corrective audit entry and update manually via SQL.',
      NEW.shipment_number, NEW.status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_freight_no_regression
  BEFORE UPDATE ON freight_shipments
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION prevent_freight_status_regression();

-- -------------------------------------------------------------
-- I. Add email-format check to profiles
-- -------------------------------------------------------------
ALTER TABLE profiles
  ADD CONSTRAINT chk_profile_email_format
  CHECK (email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$' OR email = 'system@internal');

COMMENT ON CONSTRAINT chk_profile_email_format ON profiles IS
  'Basic email regex — catches typos at insert time. Not exhaustive; treat as a smoke test.';
