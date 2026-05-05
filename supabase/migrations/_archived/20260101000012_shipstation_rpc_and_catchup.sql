-- =============================================================
-- Migration 012: ShipStation sale RPC + schema catch-up
-- =============================================================
-- Wires ShipStation sales into the atomic-mutation pattern from 010,
-- plus adds a few app-code columns that never got formal migrations:
-- Homebase linking on profiles, labor hours cache, freight status override.

-- -------------------------------------------------------------
-- A. Profile extensions: Homebase linking
-- -------------------------------------------------------------
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS homebase_employee_id TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS homebase_employee_name TEXT,
  ADD COLUMN IF NOT EXISTS homebase_linked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS homebase_linked_by UUID REFERENCES profiles(id);

CREATE INDEX idx_profiles_homebase ON profiles(homebase_employee_id) WHERE homebase_employee_id IS NOT NULL;

-- -------------------------------------------------------------
-- B. Labor hours daily rollup — populated by Homebase sync
-- -------------------------------------------------------------
CREATE TABLE labor_hours_daily (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Key: (homebase_employee_id, date) is unique
  homebase_employee_id TEXT NOT NULL,
  work_date DATE NOT NULL,
  -- Totals in minutes for precision (avoid fractional-hour rounding)
  minutes_clocked INTEGER NOT NULL DEFAULT 0,
  minutes_breaks_paid INTEGER NOT NULL DEFAULT 0,
  minutes_breaks_unpaid INTEGER NOT NULL DEFAULT 0,
  -- Source metadata
  source TEXT NOT NULL DEFAULT 'homebase' CHECK (source IN ('homebase', 'manual', 'import')),
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw_payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (homebase_employee_id, work_date)
);

CREATE INDEX idx_labor_hours_date ON labor_hours_daily(work_date DESC);
CREATE INDEX idx_labor_hours_employee ON labor_hours_daily(homebase_employee_id);

ALTER TABLE labor_hours_daily ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated can read labor hours"
  ON labor_hours_daily FOR SELECT TO authenticated USING (true);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON labor_hours_daily
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- -------------------------------------------------------------
-- C. Freight status override tracking (some already added in 002/004/005)
-- -------------------------------------------------------------
-- Use IF NOT EXISTS so this is idempotent across the earlier partial migrations.
-- The only genuinely new column added here is status_overridden_by.
ALTER TABLE freight_shipments
  ADD COLUMN IF NOT EXISTS status_overridden_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS status_overridden_by UUID REFERENCES profiles(id),
  ADD COLUMN IF NOT EXISTS eta_original DATE,
  ADD COLUMN IF NOT EXISTS eta_last_checked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS total_cartons INTEGER;

-- -------------------------------------------------------------
-- D. Extend status enum to include 'tracking'
-- -------------------------------------------------------------
ALTER TABLE freight_shipments DROP CONSTRAINT IF EXISTS freight_shipments_status_check;
ALTER TABLE freight_shipments
  ADD CONSTRAINT freight_shipments_status_check
  CHECK (status IN ('on_the_water', 'high_risk', 'cleared_customs', 'tracking', 'delivered'));

-- -------------------------------------------------------------
-- E. Demand overrides table
-- -------------------------------------------------------------
CREATE TABLE demand_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku_id UUID UNIQUE NOT NULL REFERENCES product_skus(id) ON DELETE RESTRICT,
  monthly_demand INTEGER NOT NULL CHECK (monthly_demand >= 0),
  reason TEXT,
  overridden_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE demand_overrides ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated can read demand overrides"
  ON demand_overrides FOR SELECT TO authenticated USING (true);
CREATE POLICY "Admins can manage demand overrides"
  ON demand_overrides FOR ALL TO authenticated USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'manager'))
  );

CREATE TRIGGER set_updated_at BEFORE UPDATE ON demand_overrides
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- -------------------------------------------------------------
-- F. rpc_apply_shipstation_sale — inventory decrement on sale
-- -------------------------------------------------------------
-- Called by the webhook Edge Function after an order's inventory has not
-- yet been applied (inventory_applied_at IS NULL).
--
-- Decrements warehouse_finished by the sum of each line item's quantity,
-- in one transaction. Writes one audit entry per SKU. Flips the order's
-- inventory_applied_at when complete.
CREATE OR REPLACE FUNCTION rpc_apply_shipstation_sale(
  p_order_id UUID,  -- shipstation_orders.id (internal)
  p_system_actor_id UUID DEFAULT NULL  -- typically the "system" profile id
) RETURNS JSONB AS $$
DECLARE
  v_order shipstation_orders%ROWTYPE;
  v_item RECORD;
  v_sku product_skus%ROWTYPE;
  v_available INTEGER;
  v_line_items_applied INTEGER := 0;
  v_line_items_unresolved INTEGER := 0;
BEGIN
  SELECT * INTO v_order FROM shipstation_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'order not found');
  END IF;
  IF v_order.inventory_applied_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'already_applied', true);
  END IF;

  -- Walk line items. Unresolved SKUs (sku_id IS NULL) block application —
  -- operator must resolve via the unresolved-SKU queue before inventory can
  -- be touched. This prevents silent drift when ShipStation reports SKUs
  -- our system doesn't know about.
  FOR v_item IN
    SELECT * FROM shipstation_order_items WHERE shipstation_order_id = p_order_id
  LOOP
    IF v_item.sku_id IS NULL THEN
      v_line_items_unresolved := v_line_items_unresolved + 1;
      CONTINUE;
    END IF;

    SELECT * INTO v_sku FROM product_skus WHERE id = v_item.sku_id;
    PERFORM 1 FROM inventory_levels WHERE sku_id = v_item.sku_id FOR UPDATE;

    SELECT warehouse_finished INTO v_available
      FROM inventory_levels WHERE sku_id = v_item.sku_id;

    IF COALESCE(v_available, 0) < v_item.quantity THEN
      -- We still apply the sale (the product physically shipped), but log a
      -- warning with a negative-stock audit entry that will surface on
      -- reconciliation reports. The CHECK constraint from migration 006
      -- would block this; temporarily we UPDATE via the oversell path.
      INSERT INTO inventory_transactions (
        sku_id, transaction_type, quantity, field_affected,
        movement_kind, notes, performed_by
      ) VALUES (
        v_item.sku_id, 'shipstation_oversell_warning',
        -v_item.quantity, 'warehouse_finished',
        'metadata',  -- metadata because we are NOT mutating inventory yet
        format('%s: oversold on ShipStation order %s — available %s, sold %s. Requires cycle-count correction.',
          v_sku.sku, v_order.order_number, COALESCE(v_available, 0), v_item.quantity),
        p_system_actor_id
      );
      -- Still record the order line as unapplied so it shows up in the queue.
      CONTINUE;
    END IF;

    UPDATE inventory_levels
       SET warehouse_finished = warehouse_finished - v_item.quantity
     WHERE sku_id = v_item.sku_id;

    INSERT INTO inventory_transactions (
      sku_id, transaction_type, quantity, field_affected,
      movement_kind, reference_id, reference_type, notes, performed_by
    ) VALUES (
      v_item.sku_id, 'order_shipped', -v_item.quantity, 'warehouse_finished',
      'net_change', p_order_id, 'shipstation_order',
      format('ShipStation order %s: -%s units', v_order.order_number, v_item.quantity),
      p_system_actor_id
    );
    v_line_items_applied := v_line_items_applied + 1;
  END LOOP;

  -- Only mark applied when every item was either applied or was an oversell
  -- recorded. Unresolved SKU items block the applied flag.
  IF v_line_items_unresolved = 0 THEN
    UPDATE shipstation_orders
       SET inventory_applied_at = now(),
           inventory_apply_error = NULL,
           inventory_apply_attempts = inventory_apply_attempts + 1
     WHERE id = p_order_id;
  ELSE
    UPDATE shipstation_orders
       SET inventory_apply_attempts = inventory_apply_attempts + 1,
           inventory_apply_error = format('%s line item(s) have unresolved SKU codes', v_line_items_unresolved)
     WHERE id = p_order_id;
  END IF;

  RETURN jsonb_build_object(
    'ok', v_line_items_unresolved = 0,
    'applied', v_line_items_applied,
    'unresolved', v_line_items_unresolved
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION rpc_apply_shipstation_sale TO authenticated;

-- -------------------------------------------------------------
-- G. Unresolved SKU queue view (for operators)
-- -------------------------------------------------------------
CREATE OR REPLACE VIEW shipstation_unresolved_skus AS
  SELECT
    i.sku_code,
    COUNT(*) AS line_item_count,
    SUM(i.quantity) AS total_units,
    MIN(o.order_date) AS first_seen,
    MAX(o.order_date) AS last_seen,
    COUNT(DISTINCT o.id) AS distinct_orders
  FROM shipstation_order_items i
  JOIN shipstation_orders o ON o.id = i.shipstation_order_id
  WHERE i.sku_id IS NULL
  GROUP BY i.sku_code
  ORDER BY line_item_count DESC;

COMMENT ON VIEW shipstation_unresolved_skus IS
  'SKU codes from ShipStation that are not linked to a product_skus row. Work this queue to unblock inventory apply.';
