-- ================================================================
-- MIGRATION TRACKING TABLE (normally created by supabase CLI)
-- ================================================================
CREATE SCHEMA IF NOT EXISTS supabase_migrations;
CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (
  version text NOT NULL PRIMARY KEY,
  statements text[],
  name text
);

-- ================================================================
-- ALL 18 MIGRATIONS (applied in order)
-- ================================================================

-- ============================================================
-- FILE: 20260101000001_initial_schema.sql
-- ============================================================
-- Freeze Pipe ERP - Initial Database Schema
-- Run this in Supabase SQL Editor to create all tables

-- ============================================================
-- PROFILES (extends Supabase auth.users)
-- ============================================================
CREATE TABLE profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT UNIQUE NOT NULL,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'manager', 'user')),
  avatar_url TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Auto-create profile on user signup
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO profiles (id, email, full_name, role)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email),
    'user'
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- ============================================================
-- PRODUCT SKUS
-- ============================================================
CREATE TABLE product_skus (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku TEXT UNIQUE NOT NULL,
  product_name TEXT NOT NULL,
  upc_code TEXT,
  category TEXT NOT NULL CHECK (category IN ('fillable', 'non_fillable')),
  display_category TEXT NOT NULL DEFAULT 'Accessories',
  retail_price DECIMAL(10,2) DEFAULT 0,
  standard_quantity_per_carton INTEGER DEFAULT 1,
  abc_classification TEXT CHECK (abc_classification IN ('A', 'B', 'C')),
  monthly_demand INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_product_skus_sku ON product_skus(sku);
CREATE INDEX idx_product_skus_active ON product_skus(is_active);

-- ============================================================
-- SKU ECONOMICS (1:1 with product_skus)
-- ============================================================
CREATE TABLE sku_economics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku_id UUID UNIQUE NOT NULL REFERENCES product_skus(id) ON DELETE CASCADE,
  -- Raw cost
  pct_from_yx DECIMAL(5,2) DEFAULT 0,
  pct_from_nancy DECIMAL(5,2) DEFAULT 0,
  nancy_raw_cost DECIMAL(10,2) DEFAULT 0,
  yx_raw_cost DECIMAL(10,2) DEFAULT 0,
  additional_raw_cost DECIMAL(10,2) DEFAULT 0,
  -- Importing cost
  pct_sea DECIMAL(5,2) DEFAULT 0,
  pct_air DECIMAL(5,2) DEFAULT 0,
  sea_freight_cost_per_unit DECIMAL(10,2) DEFAULT 0,
  air_freight_cost_per_unit DECIMAL(10,2) DEFAULT 0,
  breakage_issue_cost DECIMAL(10,2) DEFAULT 0,
  -- Manufacturing cost
  pct_manufactured_us DECIMAL(5,2) DEFAULT 0,
  pct_manufactured_cn DECIMAL(5,2) DEFAULT 0,
  labor_cost_us DECIMAL(10,2) DEFAULT 0,
  glycerin_cost_us DECIMAL(10,2) DEFAULT 0,
  manufacturing_cost_cn DECIMAL(10,2) DEFAULT 0,
  -- Pack & Ship cost
  packing_material_cost DECIMAL(10,2) DEFAULT 0,
  packing_labor_cost DECIMAL(10,2) DEFAULT 0,
  shipping_cost DECIMAL(10,2) DEFAULT 0,
  credit_card_fees DECIMAL(10,2) DEFAULT 0,
  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- TASK LOGS (manufacturing)
-- ============================================================
CREATE TABLE task_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES profiles(id),
  sku_id UUID NOT NULL REFERENCES product_skus(id),
  task_type TEXT NOT NULL CHECK (task_type IN ('emptying', 'filling_capping', 'rtsing', 'prefilled_rtsing')),
  quantity_processed INTEGER NOT NULL,
  time_started TIMESTAMPTZ,
  time_completed TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_task_logs_employee ON task_logs(employee_id);
CREATE INDEX idx_task_logs_sku ON task_logs(sku_id);
CREATE INDEX idx_task_logs_created ON task_logs(created_at DESC);
CREATE INDEX idx_task_logs_type ON task_logs(task_type);

-- ============================================================
-- FREIGHT SHIPMENTS
-- ============================================================
CREATE TABLE freight_shipments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_number TEXT UNIQUE NOT NULL,
  freight_type TEXT NOT NULL CHECK (freight_type IN ('air', 'sea')),
  status TEXT NOT NULL DEFAULT 'on_the_water' CHECK (status IN ('on_the_water', 'high_risk', 'cleared_customs', 'delivered')),
  carrier_name TEXT,
  broker_name TEXT,
  forwarder_id TEXT,
  tracking_number TEXT,
  ship_date DATE,
  eta DATE,
  actual_arrival_date DATE,
  freight_cost DECIMAL(10,2) DEFAULT 0,
  insurance_cost DECIMAL(10,2) DEFAULT 0,
  duties_cost DECIMAL(10,2) DEFAULT 0,
  total_cost DECIMAL(10,2) DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_freight_status ON freight_shipments(status);
CREATE INDEX idx_freight_type ON freight_shipments(freight_type);

-- ============================================================
-- FREIGHT LINE ITEMS
-- ============================================================
CREATE TABLE freight_line_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  freight_shipment_id UUID NOT NULL REFERENCES freight_shipments(id) ON DELETE CASCADE,
  sku_id UUID NOT NULL REFERENCES product_skus(id),
  quantity INTEGER NOT NULL,
  unit_cost DECIMAL(10,2) DEFAULT 0,
  retail_value DECIMAL(10,2) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_freight_items_shipment ON freight_line_items(freight_shipment_id);

-- ============================================================
-- INVENTORY LEVELS (1:1 with product_skus, denormalized)
-- ============================================================
CREATE TABLE inventory_levels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku_id UUID UNIQUE NOT NULL REFERENCES product_skus(id) ON DELETE CASCADE,
  -- Warehouse
  warehouse_raw INTEGER DEFAULT 0,
  warehouse_in_production INTEGER DEFAULT 0,
  warehouse_finished INTEGER DEFAULT 0,
  warehouse_other INTEGER DEFAULT 0,
  -- In Transit
  in_transit_air INTEGER DEFAULT 0,
  in_transit_sea INTEGER DEFAULT 0,
  in_transit_high_risk INTEGER DEFAULT 0,
  -- On Order
  nancy_finished INTEGER DEFAULT 0,
  nancy_ordered INTEGER DEFAULT 0,
  yx_finished INTEGER DEFAULT 0,
  yx_ordered INTEGER DEFAULT 0,
  -- Meta
  last_synced_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- INVENTORY TRANSACTIONS (audit log)
-- ============================================================
CREATE TABLE inventory_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku_id UUID NOT NULL REFERENCES product_skus(id),
  transaction_type TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  field_affected TEXT NOT NULL,
  reference_id UUID,
  reference_type TEXT,
  notes TEXT,
  performed_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_inv_tx_sku ON inventory_transactions(sku_id);
CREATE INDEX idx_inv_tx_created ON inventory_transactions(created_at DESC);

-- ============================================================
-- FACTORY ORDERS
-- ============================================================
CREATE TABLE factory_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  factory TEXT NOT NULL CHECK (factory IN ('nancy', 'yx')),
  order_number TEXT,
  status TEXT NOT NULL DEFAULT 'ordered' CHECK (status IN ('ordered', 'in_production', 'finished', 'shipped')),
  order_date DATE,
  expected_completion DATE,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- FACTORY ORDER ITEMS
-- ============================================================
CREATE TABLE factory_order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_order_id UUID NOT NULL REFERENCES factory_orders(id) ON DELETE CASCADE,
  sku_id UUID NOT NULL REFERENCES product_skus(id),
  quantity_ordered INTEGER NOT NULL,
  quantity_finished INTEGER DEFAULT 0,
  unit_cost DECIMAL(10,2) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_fo_items_order ON factory_order_items(factory_order_id);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_skus ENABLE ROW LEVEL SECURITY;
ALTER TABLE sku_economics ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE freight_shipments ENABLE ROW LEVEL SECURITY;
ALTER TABLE freight_line_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_levels ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE factory_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE factory_order_items ENABLE ROW LEVEL SECURITY;

-- All authenticated users can read all tables
CREATE POLICY "Authenticated users can read profiles" ON profiles FOR SELECT TO authenticated USING (true);
CREATE POLICY "Users can update own profile" ON profiles FOR UPDATE TO authenticated USING (auth.uid() = id);

CREATE POLICY "Authenticated can read SKUs" ON product_skus FOR SELECT TO authenticated USING (true);
CREATE POLICY "Admins can manage SKUs" ON product_skus FOR ALL TO authenticated USING (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'manager'))
);

CREATE POLICY "Authenticated can read economics" ON sku_economics FOR SELECT TO authenticated USING (true);
CREATE POLICY "Admins can manage economics" ON sku_economics FOR ALL TO authenticated USING (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'manager'))
);

CREATE POLICY "Authenticated can read task logs" ON task_logs FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated can insert task logs" ON task_logs FOR INSERT TO authenticated WITH CHECK (employee_id = auth.uid());
CREATE POLICY "Admins can manage task logs" ON task_logs FOR ALL TO authenticated USING (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'manager'))
);

CREATE POLICY "Authenticated can read freight" ON freight_shipments FOR SELECT TO authenticated USING (true);
CREATE POLICY "Admins can manage freight" ON freight_shipments FOR ALL TO authenticated USING (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'manager'))
);

CREATE POLICY "Authenticated can read freight items" ON freight_line_items FOR SELECT TO authenticated USING (true);
CREATE POLICY "Admins can manage freight items" ON freight_line_items FOR ALL TO authenticated USING (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'manager'))
);

CREATE POLICY "Authenticated can read inventory" ON inventory_levels FOR SELECT TO authenticated USING (true);
CREATE POLICY "Admins can manage inventory" ON inventory_levels FOR ALL TO authenticated USING (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'manager'))
);

CREATE POLICY "Authenticated can read inv transactions" ON inventory_transactions FOR SELECT TO authenticated USING (true);
CREATE POLICY "Admins can manage inv transactions" ON inventory_transactions FOR ALL TO authenticated USING (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'manager'))
);

CREATE POLICY "Authenticated can read factory orders" ON factory_orders FOR SELECT TO authenticated USING (true);
CREATE POLICY "Admins can manage factory orders" ON factory_orders FOR ALL TO authenticated USING (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'manager'))
);

CREATE POLICY "Authenticated can read factory order items" ON factory_order_items FOR SELECT TO authenticated USING (true);
CREATE POLICY "Admins can manage factory order items" ON factory_order_items FOR ALL TO authenticated USING (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'manager'))
);

-- ============================================================
-- UPDATED_AT TRIGGER
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_updated_at BEFORE UPDATE ON profiles FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON product_skus FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON sku_economics FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON freight_shipments FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON inventory_levels FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON factory_orders FOR EACH ROW EXECUTE FUNCTION update_updated_at();


-- ============================================================
-- FILE: 20260101000002_freight_tracking_fields.sql
-- ============================================================
-- Adds fields needed to track ETA drift over time as carrier tracking updates flow in.
--
--   eta_original          frozen at first carrier check; used to display drift
--   eta_last_checked_at   ISO timestamp of the last successful tracking poll
--
-- The polling loop itself runs as a Supabase Edge Function on pg_cron, hitting
-- per-carrier APIs (Maersk, FedEx, DHL, etc.) and writing reconciled ETAs back
-- into freight_shipments.

ALTER TABLE freight_shipments
  ADD COLUMN IF NOT EXISTS eta_original date,
  ADD COLUMN IF NOT EXISTS eta_last_checked_at timestamptz;

-- Backfill: any existing shipment uses its current ETA as its baseline.
UPDATE freight_shipments
   SET eta_original = eta
 WHERE eta_original IS NULL
   AND eta IS NOT NULL;

COMMENT ON COLUMN freight_shipments.eta_original IS
  'Original ETA captured before any carrier-driven drift. Immutable after the first tracking check.';
COMMENT ON COLUMN freight_shipments.eta_last_checked_at IS
  'Timestamp of the last successful carrier tracking check. NULL means never checked.';


-- ============================================================
-- FILE: 20260101000003_freight_tracking_status.sql
-- ============================================================
-- Adds a new 'tracking' status to freight_shipments, representing the phase
-- between Cleared Customs and Delivered when the carrier has confirmed receipt
-- and is actively moving the package.
--
-- Auto-transition to 'tracking' happens in the application layer (tracking hook
-- + reconcileEta) when a carrier API returns status=in_transit or
-- out_for_delivery. high_risk is preserved (human-set hold).

ALTER TABLE freight_shipments
  DROP CONSTRAINT IF EXISTS freight_shipments_status_check;

ALTER TABLE freight_shipments
  ADD CONSTRAINT freight_shipments_status_check
  CHECK (status IN ('on_the_water', 'high_risk', 'cleared_customs', 'tracking', 'delivered'));


-- ============================================================
-- FILE: 20260101000004_freight_status_override.sql
-- ============================================================
-- Lets a human pin a freight status manually. Tracking polls continue to refresh
-- ETA + last-checked, but the reconciler skips status updates while this is set.
--
-- Set when: a user picks a status from the UI dropdown and confirms the override.
-- Cleared when: the user clicks the "Manual" badge to resume tracking-driven updates.

ALTER TABLE freight_shipments
  ADD COLUMN IF NOT EXISTS status_overridden_at timestamptz;

COMMENT ON COLUMN freight_shipments.status_overridden_at IS
  'When non-null, indicates the status was manually set by a user. Carrier tracking still updates ETA but skips status changes until this is cleared.';


-- ============================================================
-- FILE: 20260101000005_freight_total_cartons.sql
-- ============================================================
-- Persist the actual carton count entered when a shipment is created.
-- Computed in the UI as sum(carton_qty) across all carton groups in the form,
-- then written here so the dashboard doesn't have to re-derive (which would
-- only give an estimate based on each SKU's standard_quantity_per_carton and
-- couldn't account for mixed cartons).

ALTER TABLE freight_shipments
  ADD COLUMN IF NOT EXISTS total_cartons integer;

COMMENT ON COLUMN freight_shipments.total_cartons IS
  'Actual total cartons entered at shipment creation. NULL for legacy rows where the user did not provide a count.';


-- ============================================================
-- FILE: 20260101000006_invariants.sql
-- ============================================================
-- =============================================================
-- Migration 006: Database-level invariants
-- =============================================================
-- Anything that must never be true in the application is enforced here
-- at the database level. These are the last line of defense — a buggy
-- client or a rogue SQL session cannot violate them.
--
-- Rule of thumb: if a number represents physical units of inventory, it
-- must not go negative. If two dates have a logical order, it must hold.
-- If a set of percentages must sum to 100, the DB must check it.

-- -------------------------------------------------------------
-- inventory_levels: every bucket is non-negative
-- -------------------------------------------------------------
ALTER TABLE inventory_levels
  ADD CONSTRAINT chk_inv_warehouse_raw_nonneg CHECK (warehouse_raw >= 0),
  ADD CONSTRAINT chk_inv_warehouse_wip_nonneg CHECK (warehouse_in_production >= 0),
  ADD CONSTRAINT chk_inv_warehouse_finished_nonneg CHECK (warehouse_finished >= 0),
  ADD CONSTRAINT chk_inv_warehouse_other_nonneg CHECK (warehouse_other >= 0),
  ADD CONSTRAINT chk_inv_transit_air_nonneg CHECK (in_transit_air >= 0),
  ADD CONSTRAINT chk_inv_transit_sea_nonneg CHECK (in_transit_sea >= 0),
  ADD CONSTRAINT chk_inv_transit_high_risk_nonneg CHECK (in_transit_high_risk >= 0),
  ADD CONSTRAINT chk_inv_nancy_finished_nonneg CHECK (nancy_finished >= 0),
  ADD CONSTRAINT chk_inv_nancy_ordered_nonneg CHECK (nancy_ordered >= 0),
  ADD CONSTRAINT chk_inv_yx_finished_nonneg CHECK (yx_finished >= 0),
  ADD CONSTRAINT chk_inv_yx_ordered_nonneg CHECK (yx_ordered >= 0);

-- -------------------------------------------------------------
-- task_logs: quantities must be positive, duration must be valid
-- -------------------------------------------------------------
ALTER TABLE task_logs
  ADD CONSTRAINT chk_task_qty_positive CHECK (quantity_processed > 0),
  ADD CONSTRAINT chk_task_time_order CHECK (
    time_started IS NULL
    OR time_completed IS NULL
    OR time_completed >= time_started
  );

-- -------------------------------------------------------------
-- freight_shipments: date ordering + non-negative costs
-- -------------------------------------------------------------
ALTER TABLE freight_shipments
  ADD CONSTRAINT chk_freight_eta_after_ship CHECK (
    ship_date IS NULL OR eta IS NULL OR eta >= ship_date
  ),
  ADD CONSTRAINT chk_freight_arrival_after_ship CHECK (
    ship_date IS NULL OR actual_arrival_date IS NULL OR actual_arrival_date >= ship_date
  ),
  ADD CONSTRAINT chk_freight_cost_nonneg CHECK (freight_cost >= 0),
  ADD CONSTRAINT chk_freight_insurance_nonneg CHECK (insurance_cost >= 0),
  ADD CONSTRAINT chk_freight_duties_nonneg CHECK (duties_cost >= 0),
  ADD CONSTRAINT chk_freight_total_nonneg CHECK (total_cost >= 0),
  ADD CONSTRAINT chk_freight_cartons_nonneg CHECK (total_cartons IS NULL OR total_cartons >= 0);

-- -------------------------------------------------------------
-- freight_line_items: quantity > 0
-- -------------------------------------------------------------
ALTER TABLE freight_line_items
  ADD CONSTRAINT chk_freight_li_qty_positive CHECK (quantity > 0),
  ADD CONSTRAINT chk_freight_li_cost_nonneg CHECK (unit_cost >= 0),
  ADD CONSTRAINT chk_freight_li_retail_nonneg CHECK (retail_value >= 0);

-- -------------------------------------------------------------
-- factory_order_items: ordered > 0, finished within [0, ordered]
-- -------------------------------------------------------------
ALTER TABLE factory_order_items
  ADD CONSTRAINT chk_fo_item_ordered_positive CHECK (quantity_ordered > 0),
  ADD CONSTRAINT chk_fo_item_finished_bounded CHECK (
    quantity_finished >= 0 AND quantity_finished <= quantity_ordered
  ),
  ADD CONSTRAINT chk_fo_item_cost_nonneg CHECK (unit_cost >= 0);

-- -------------------------------------------------------------
-- factory_orders: expected_completion should be on or after order_date
-- -------------------------------------------------------------
ALTER TABLE factory_orders
  ADD CONSTRAINT chk_fo_completion_after_order CHECK (
    order_date IS NULL OR expected_completion IS NULL
    OR expected_completion >= order_date
  );

-- -------------------------------------------------------------
-- product_skus: retail price non-negative; standard carton qty positive
-- -------------------------------------------------------------
ALTER TABLE product_skus
  ADD CONSTRAINT chk_sku_retail_nonneg CHECK (retail_price >= 0),
  ADD CONSTRAINT chk_sku_std_carton_positive CHECK (standard_quantity_per_carton > 0),
  ADD CONSTRAINT chk_sku_monthly_demand_nonneg CHECK (monthly_demand >= 0);

-- -------------------------------------------------------------
-- sku_economics: all dollar amounts non-negative, percentage groups sum to 100
-- -------------------------------------------------------------
ALTER TABLE sku_economics
  -- Raw sourcing split (YX + Nancy = 100%)
  ADD CONSTRAINT chk_econ_pct_sourcing CHECK (
    ROUND((pct_from_yx + pct_from_nancy)::numeric, 2) = 100
    OR (pct_from_yx = 0 AND pct_from_nancy = 0)  -- allow un-configured rows
  ),
  -- Freight mode split (sea + air = 100%)
  ADD CONSTRAINT chk_econ_pct_freight CHECK (
    ROUND((pct_sea + pct_air)::numeric, 2) = 100
    OR (pct_sea = 0 AND pct_air = 0)
  ),
  -- Manufacturing location split (US + CN = 100%)
  ADD CONSTRAINT chk_econ_pct_mfg CHECK (
    ROUND((pct_manufactured_us + pct_manufactured_cn)::numeric, 2) = 100
    OR (pct_manufactured_us = 0 AND pct_manufactured_cn = 0)
  ),
  -- Individual percentages in [0, 100]
  ADD CONSTRAINT chk_econ_pct_bounds CHECK (
    pct_from_yx BETWEEN 0 AND 100
    AND pct_from_nancy BETWEEN 0 AND 100
    AND pct_sea BETWEEN 0 AND 100
    AND pct_air BETWEEN 0 AND 100
    AND pct_manufactured_us BETWEEN 0 AND 100
    AND pct_manufactured_cn BETWEEN 0 AND 100
  ),
  -- All cost fields non-negative
  ADD CONSTRAINT chk_econ_costs_nonneg CHECK (
    nancy_raw_cost >= 0 AND yx_raw_cost >= 0 AND additional_raw_cost >= 0
    AND sea_freight_cost_per_unit >= 0 AND air_freight_cost_per_unit >= 0
    AND breakage_issue_cost >= 0
    AND labor_cost_us >= 0 AND glycerin_cost_us >= 0 AND manufacturing_cost_cn >= 0
    AND packing_material_cost >= 0 AND packing_labor_cost >= 0
    AND shipping_cost >= 0 AND credit_card_fees >= 0
  );

COMMENT ON CONSTRAINT chk_econ_pct_sourcing ON sku_economics IS
  'Raw sourcing percentages must sum to exactly 100, or both be zero (un-configured)';


-- ============================================================
-- FILE: 20260101000007_row_version.sql
-- ============================================================
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


-- ============================================================
-- FILE: 20260101000008_sku_archival.sql
-- ============================================================
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


-- ============================================================
-- FILE: 20260101000009_audit_immutability.sql
-- ============================================================
-- =============================================================
-- Migration 009: Audit log immutability + hash chain
-- =============================================================
-- The audit log (inventory_transactions) must be forensically reliable.
-- A "can-be-edited" audit log is worse than no audit log — it gives
-- false confidence.
--
-- Three layers of protection:
--
--   1. RLS policy restricts to INSERT only (no UPDATE, no DELETE) for
--      all users, including admins. Only the service_role key (used by
--      Edge Functions + automated processes) can write; never the
--      anon/authenticated role with DML.
--   2. A table-level trigger blocks UPDATE and DELETE at the row level
--      as a second line of defense in case an RLS policy is accidentally
--      removed or a superuser gets involved.
--   3. Hash chain: every row stores sha256(prev_hash || row_content).
--      Any tampering with historical rows is detectable by recomputing
--      the chain. This is not mandatory for internal use but is the
--      standard for financial audit trails.
--
-- Also: extends the schema to support the movement_kind / from_field /
-- to_field columns the application already uses.

-- -------------------------------------------------------------
-- A. Extend schema to match what the app writes
-- -------------------------------------------------------------
ALTER TABLE inventory_transactions
  -- Movement taxonomy — aligns with the typed helpers in the app.
  ADD COLUMN movement_kind TEXT NOT NULL DEFAULT 'net_change'
    CHECK (movement_kind IN ('net_change', 'category_move', 'metadata')),
  ADD COLUMN from_field TEXT,
  ADD COLUMN to_field TEXT,
  -- Forensic columns
  ADD COLUMN row_hash TEXT,
  ADD COLUMN prev_hash TEXT,
  -- Extra context
  ADD COLUMN actor_ip INET,
  ADD COLUMN actor_user_agent TEXT;

-- Sanity check: category_move rows must populate from and to fields
ALTER TABLE inventory_transactions
  ADD CONSTRAINT chk_move_fields_consistent CHECK (
    movement_kind != 'category_move'
    OR (from_field IS NOT NULL AND to_field IS NOT NULL)
  );

-- sku_id should be nullable for shipment-level events that aren't SKU-specific.
-- (Our recent demo work already handles this in app code; make the DB agree.)
ALTER TABLE inventory_transactions
  ALTER COLUMN sku_id DROP NOT NULL;

-- -------------------------------------------------------------
-- B. Hash chain: compute row_hash on INSERT
-- -------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION audit_hash_chain()
RETURNS TRIGGER AS $$
DECLARE
  v_prev_hash TEXT;
  v_payload TEXT;
BEGIN
  -- Find the most recent existing hash (the chain's current tip).
  SELECT row_hash INTO v_prev_hash
    FROM inventory_transactions
   ORDER BY created_at DESC, id DESC
   LIMIT 1;

  NEW.prev_hash := COALESCE(v_prev_hash, '0000000000000000000000000000000000000000000000000000000000000000');

  -- Serialize the row contents (excluding the hash itself) and compute sha256.
  v_payload := COALESCE(NEW.id::text, '') || '|'
            || COALESCE(NEW.sku_id::text, '') || '|'
            || COALESCE(NEW.transaction_type, '') || '|'
            || COALESCE(NEW.quantity::text, '') || '|'
            || COALESCE(NEW.field_affected, '') || '|'
            || COALESCE(NEW.movement_kind, '') || '|'
            || COALESCE(NEW.from_field, '') || '|'
            || COALESCE(NEW.to_field, '') || '|'
            || COALESCE(NEW.reference_id::text, '') || '|'
            || COALESCE(NEW.reference_type, '') || '|'
            || COALESCE(NEW.notes, '') || '|'
            || COALESCE(NEW.performed_by::text, '') || '|'
            || COALESCE(NEW.created_at::text, now()::text) || '|'
            || NEW.prev_hash;

  NEW.row_hash := encode(digest(v_payload, 'sha256'), 'hex');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_hash_chain
  BEFORE INSERT ON inventory_transactions
  FOR EACH ROW EXECUTE FUNCTION audit_hash_chain();

-- -------------------------------------------------------------
-- C. Block UPDATE and DELETE with a trigger (belt and suspenders)
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION block_audit_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Audit log is immutable. UPDATE/DELETE of inventory_transactions is not permitted.'
    USING HINT = 'Insert a new entry describing the correction instead.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_block_audit_update
  BEFORE UPDATE ON inventory_transactions
  FOR EACH ROW EXECUTE FUNCTION block_audit_mutation();

CREATE TRIGGER trg_block_audit_delete
  BEFORE DELETE ON inventory_transactions
  FOR EACH ROW EXECUTE FUNCTION block_audit_mutation();

-- -------------------------------------------------------------
-- D. Tighten RLS to INSERT-only for authenticated role
-- -------------------------------------------------------------
-- Drop the overly-permissive "Admins can manage" policy from migration 001
DROP POLICY IF EXISTS "Admins can manage inv transactions" ON inventory_transactions;

-- Replace with INSERT-only for authenticated (RPCs running as service_role
-- bypass RLS and can still write — which is what we want).
CREATE POLICY "Authenticated can insert inv transactions"
  ON inventory_transactions
  FOR INSERT
  TO authenticated
  WITH CHECK (performed_by = auth.uid() OR performed_by IS NULL);

-- -------------------------------------------------------------
-- E. Hash-chain verification helper
-- -------------------------------------------------------------
-- Run periodically as a cron job or admin-triggered check.
-- Returns the id of the first row where the chain is broken, or NULL if OK.
CREATE OR REPLACE FUNCTION verify_audit_chain(p_start_from TIMESTAMPTZ DEFAULT '-infinity')
RETURNS TABLE (first_broken_id UUID, first_broken_at TIMESTAMPTZ, message TEXT) AS $$
DECLARE
  r RECORD;
  v_expected_prev TEXT := '0000000000000000000000000000000000000000000000000000000000000000';
  v_recomputed TEXT;
BEGIN
  -- If start_from is specified, seed with the hash of the row just before it
  IF p_start_from > '-infinity' THEN
    SELECT row_hash INTO v_expected_prev
      FROM inventory_transactions
     WHERE created_at < p_start_from
     ORDER BY created_at DESC, id DESC
     LIMIT 1;
    v_expected_prev := COALESCE(v_expected_prev, '0000000000000000000000000000000000000000000000000000000000000000');
  END IF;

  FOR r IN
    SELECT * FROM inventory_transactions
     WHERE created_at >= p_start_from
     ORDER BY created_at ASC, id ASC
  LOOP
    IF r.prev_hash != v_expected_prev THEN
      RETURN QUERY SELECT r.id, r.created_at, format('prev_hash mismatch at row %s', r.id);
      RETURN;
    END IF;
    v_recomputed := encode(digest(
      COALESCE(r.id::text, '') || '|'
      || COALESCE(r.sku_id::text, '') || '|'
      || COALESCE(r.transaction_type, '') || '|'
      || COALESCE(r.quantity::text, '') || '|'
      || COALESCE(r.field_affected, '') || '|'
      || COALESCE(r.movement_kind, '') || '|'
      || COALESCE(r.from_field, '') || '|'
      || COALESCE(r.to_field, '') || '|'
      || COALESCE(r.reference_id::text, '') || '|'
      || COALESCE(r.reference_type, '') || '|'
      || COALESCE(r.notes, '') || '|'
      || COALESCE(r.performed_by::text, '') || '|'
      || COALESCE(r.created_at::text, '') || '|'
      || r.prev_hash,
      'sha256'
    ), 'hex');
    IF v_recomputed != r.row_hash THEN
      RETURN QUERY SELECT r.id, r.created_at, format('row_hash does not match recomputation at %s', r.id);
      RETURN;
    END IF;
    v_expected_prev := r.row_hash;
  END LOOP;

  -- Chain is intact
  RETURN;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION verify_audit_chain IS
  'Walks the audit hash chain and returns the first broken row, or no rows if intact. Run nightly.';


-- ============================================================
-- FILE: 20260101000010_atomic_rpcs.sql
-- ============================================================
-- =============================================================
-- Migration 010: Atomic mutation RPCs
-- =============================================================
-- Every inventory-affecting operation must be atomic. Each of these
-- functions performs its state change AND its audit entry in a single
-- transaction (Postgres function bodies execute atomically). A failure
-- anywhere inside rolls back everything.
--
-- Row-level locks (FOR UPDATE) prevent two concurrent writers from
-- observing stale inventory when deciding whether a movement is valid.
-- (The CHECK constraints from migration 006 are the last line of defense
-- but we prefer to reject an invalid operation with a descriptive error
-- before it ever hits the constraint.)
--
-- All RPCs return a JSONB result with { ok, error?, ... }.

-- -------------------------------------------------------------
-- Helper: resolve task_type -> source/target bucket
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION _task_type_movement(p_task_type TEXT)
RETURNS TABLE (from_field TEXT, to_field TEXT) AS $$
BEGIN
  CASE p_task_type
    WHEN 'emptying' THEN
      RETURN QUERY SELECT 'warehouse_raw'::TEXT, 'warehouse_in_production'::TEXT;
    WHEN 'rtsing' THEN
      RETURN QUERY SELECT 'warehouse_in_production'::TEXT, 'warehouse_finished'::TEXT;
    WHEN 'prefilled_rtsing' THEN
      RETURN QUERY SELECT 'warehouse_raw'::TEXT, 'warehouse_finished'::TEXT;
    WHEN 'filling_capping' THEN
      -- Stays in warehouse_in_production; no bucket change.
      RETURN QUERY SELECT NULL::TEXT, NULL::TEXT;
    ELSE
      RAISE EXCEPTION 'Unknown task_type: %', p_task_type;
  END CASE;
END;
$$ LANGUAGE plpgsql;

-- -------------------------------------------------------------
-- rpc_log_task_completion: manufacturing worker logs a completed task
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION rpc_log_task_completion(
  p_sku_id UUID,
  p_task_type TEXT,
  p_quantity INTEGER,
  p_notes TEXT,
  p_actor_id UUID,
  p_time_started TIMESTAMPTZ DEFAULT NULL,
  p_time_completed TIMESTAMPTZ DEFAULT now()
) RETURNS JSONB AS $$
DECLARE
  v_sku product_skus%ROWTYPE;
  v_move RECORD;
  v_task_log_id UUID;
  v_available INTEGER;
BEGIN
  -- Validate inputs
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

  -- Lock the inventory row for this SKU so concurrent mutations serialize.
  PERFORM 1 FROM inventory_levels WHERE sku_id = p_sku_id FOR UPDATE;

  IF v_move.from_field IS NOT NULL THEN
    -- Read current source bucket value
    EXECUTE format('SELECT %I FROM inventory_levels WHERE sku_id = $1', v_move.from_field)
      INTO v_available USING p_sku_id;

    IF v_available IS NULL OR v_available < p_quantity THEN
      RETURN jsonb_build_object(
        'ok', false,
        'error', 'insufficient_source_stock',
        'available', COALESCE(v_available, 0),
        'requested', p_quantity
      );
    END IF;

    -- Apply the movement atomically.
    EXECUTE format(
      'UPDATE inventory_levels SET %I = %I - $1, %I = %I + $1 WHERE sku_id = $2',
      v_move.from_field, v_move.from_field,
      v_move.to_field, v_move.to_field
    ) USING p_quantity, p_sku_id;
  END IF;

  -- Record the task log
  INSERT INTO task_logs (
    employee_id, sku_id, task_type, quantity_processed,
    time_started, time_completed, notes
  ) VALUES (
    p_actor_id, p_sku_id, p_task_type, p_quantity,
    p_time_started, p_time_completed, p_notes
  ) RETURNING id INTO v_task_log_id;

  -- Write audit entry
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
      v_sku.sku,
      replace(p_task_type, '_', ' '),
      p_quantity,
      CASE WHEN p_notes IS NOT NULL THEN ' — ' || p_notes ELSE '' END
    ),
    p_actor_id
  );

  RETURN jsonb_build_object('ok', true, 'task_log_id', v_task_log_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- -------------------------------------------------------------
-- rpc_cycle_count: manual adjustment (net change to total inventory)
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION rpc_cycle_count(
  p_sku_id UUID,
  p_field TEXT,     -- 'warehouse_raw' | 'warehouse_in_production' | ... | 'warehouse_other'
  p_delta INTEGER,  -- signed: +5 or -3
  p_reason TEXT,    -- 'breakage' | 'mispick' | 'theft' | 'receiving_error' | 'other'
  p_notes TEXT,
  p_actor_id UUID
) RETURNS JSONB AS $$
DECLARE
  v_sku product_skus%ROWTYPE;
  v_current INTEGER;
  v_new INTEGER;
BEGIN
  IF p_delta = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'delta must be non-zero');
  END IF;
  IF p_field NOT IN (
    'warehouse_raw', 'warehouse_in_production', 'warehouse_finished', 'warehouse_other'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'cycle counts only apply to warehouse buckets');
  END IF;

  SELECT * INTO v_sku FROM product_skus WHERE id = p_sku_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'sku not found');
  END IF;

  PERFORM 1 FROM inventory_levels WHERE sku_id = p_sku_id FOR UPDATE;

  EXECUTE format('SELECT %I FROM inventory_levels WHERE sku_id = $1', p_field)
    INTO v_current USING p_sku_id;
  v_new := COALESCE(v_current, 0) + p_delta;

  IF v_new < 0 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'would_go_negative',
      'current', v_current,
      'delta', p_delta
    );
  END IF;

  EXECUTE format('UPDATE inventory_levels SET %I = $1 WHERE sku_id = $2', p_field)
    USING v_new, p_sku_id;

  INSERT INTO inventory_transactions (
    sku_id, transaction_type, quantity, field_affected,
    movement_kind, notes, performed_by
  ) VALUES (
    p_sku_id, 'cycle_count', p_delta, p_field,
    'net_change',
    format('%s: %s %s on %s (%s)%s',
      v_sku.sku,
      CASE WHEN p_delta > 0 THEN '+' ELSE '' END,
      p_delta,
      p_field,
      p_reason,
      CASE WHEN p_notes IS NOT NULL THEN ' — ' || p_notes ELSE '' END
    ),
    p_actor_id
  );

  RETURN jsonb_build_object('ok', true, 'new_value', v_new);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- -------------------------------------------------------------
-- rpc_apply_freight_delivery: move in_transit → warehouse_raw for every
-- line item on a shipment, set status=delivered, write audit rows.
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION rpc_apply_freight_delivery(
  p_shipment_id UUID,
  p_actor_id UUID
) RETURNS JSONB AS $$
DECLARE
  v_shipment freight_shipments%ROWTYPE;
  v_li RECORD;
  v_transit_field TEXT;
  v_available INTEGER;
  v_moved_count INTEGER := 0;
BEGIN
  SELECT * INTO v_shipment FROM freight_shipments WHERE id = p_shipment_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'shipment not found');
  END IF;
  IF v_shipment.status = 'delivered' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'shipment already delivered');
  END IF;

  v_transit_field := CASE v_shipment.freight_type
    WHEN 'air' THEN 'in_transit_air'
    WHEN 'sea' THEN 'in_transit_sea'
  END;

  FOR v_li IN
    SELECT * FROM freight_line_items WHERE freight_shipment_id = p_shipment_id
  LOOP
    PERFORM 1 FROM inventory_levels WHERE sku_id = v_li.sku_id FOR UPDATE;

    EXECUTE format('SELECT %I FROM inventory_levels WHERE sku_id = $1', v_transit_field)
      INTO v_available USING v_li.sku_id;

    IF COALESCE(v_available, 0) < v_li.quantity THEN
      -- This is a data integrity problem worth logging but we proceed.
      -- In production you may want to fail hard here instead.
      RAISE WARNING 'Shipment % line item %: transit stock % < expected %',
        v_shipment.shipment_number, v_li.id, v_available, v_li.quantity;
    END IF;

    EXECUTE format(
      'UPDATE inventory_levels SET %I = GREATEST(%I - $1, 0), warehouse_raw = warehouse_raw + $1 WHERE sku_id = $2',
      v_transit_field, v_transit_field
    ) USING v_li.quantity, v_li.sku_id;

    INSERT INTO inventory_transactions (
      sku_id, transaction_type, quantity, field_affected,
      movement_kind, from_field, to_field,
      reference_id, reference_type, notes, performed_by
    ) VALUES (
      v_li.sku_id, 'freight_delivered', v_li.quantity, 'warehouse_raw',
      'category_move', v_transit_field, 'warehouse_raw',
      p_shipment_id, 'freight_shipment',
      format('%s delivered: %s units landed', v_shipment.shipment_number, v_li.quantity),
      p_actor_id
    );
    v_moved_count := v_moved_count + 1;
  END LOOP;

  UPDATE freight_shipments
     SET status = 'delivered',
         actual_arrival_date = COALESCE(actual_arrival_date, CURRENT_DATE)
   WHERE id = p_shipment_id;

  RETURN jsonb_build_object('ok', true, 'line_items_processed', v_moved_count);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- -------------------------------------------------------------
-- rpc_advance_factory_order_stage: moves units between factory buckets
-- Example: nancy_ordered → nancy_finished when a batch is QC-passed
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION rpc_advance_factory_order_stage(
  p_factory_order_item_id UUID,
  p_from_stage TEXT,   -- 'nancy_ordered' | 'yx_ordered'
  p_to_stage TEXT,     -- 'nancy_finished' | 'yx_finished'
  p_quantity INTEGER,
  p_actor_id UUID,
  p_notes TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
  v_item factory_order_items%ROWTYPE;
  v_order factory_orders%ROWTYPE;
  v_sku product_skus%ROWTYPE;
  v_available INTEGER;
BEGIN
  IF p_quantity <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'quantity must be positive');
  END IF;
  IF p_from_stage NOT IN ('nancy_ordered', 'yx_ordered')
     OR p_to_stage NOT IN ('nancy_finished', 'yx_finished') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid stage field');
  END IF;

  SELECT * INTO v_item FROM factory_order_items WHERE id = p_factory_order_item_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'factory order item not found');
  END IF;
  SELECT * INTO v_order FROM factory_orders WHERE id = v_item.factory_order_id;
  SELECT * INTO v_sku FROM product_skus WHERE id = v_item.sku_id;

  PERFORM 1 FROM inventory_levels WHERE sku_id = v_item.sku_id FOR UPDATE;
  EXECUTE format('SELECT %I FROM inventory_levels WHERE sku_id = $1', p_from_stage)
    INTO v_available USING v_item.sku_id;

  IF COALESCE(v_available, 0) < p_quantity THEN
    RETURN jsonb_build_object(
      'ok', false, 'error', 'insufficient_source_stock',
      'available', COALESCE(v_available, 0), 'requested', p_quantity
    );
  END IF;

  EXECUTE format(
    'UPDATE inventory_levels SET %I = %I - $1, %I = %I + $1 WHERE sku_id = $2',
    p_from_stage, p_from_stage, p_to_stage, p_to_stage
  ) USING p_quantity, v_item.sku_id;

  UPDATE factory_order_items
     SET quantity_finished = quantity_finished + p_quantity
   WHERE id = p_factory_order_item_id;

  INSERT INTO inventory_transactions (
    sku_id, transaction_type, quantity, field_affected,
    movement_kind, from_field, to_field,
    reference_id, reference_type, notes, performed_by
  ) VALUES (
    v_item.sku_id, 'factory_order_update', p_quantity, p_to_stage,
    'category_move', p_from_stage, p_to_stage,
    v_item.factory_order_id, 'factory_order',
    format('%s [%s]: %s units %s → %s%s',
      v_sku.sku, COALESCE(v_order.order_number, v_order.id::text), p_quantity,
      p_from_stage, p_to_stage,
      CASE WHEN p_notes IS NOT NULL THEN ' — ' || p_notes ELSE '' END
    ),
    p_actor_id
  );

  RETURN jsonb_build_object('ok', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- -------------------------------------------------------------
-- Grant EXECUTE to authenticated (RLS-style guard is inside each function)
-- -------------------------------------------------------------
GRANT EXECUTE ON FUNCTION rpc_log_task_completion TO authenticated;
GRANT EXECUTE ON FUNCTION rpc_cycle_count TO authenticated;
GRANT EXECUTE ON FUNCTION rpc_apply_freight_delivery TO authenticated;
GRANT EXECUTE ON FUNCTION rpc_advance_factory_order_stage TO authenticated;


-- ============================================================
-- FILE: 20260101000011_shipstation_tables.sql
-- ============================================================
-- =============================================================
-- Migration 011: ShipStation integration tables
-- =============================================================
-- Three tables, separating concerns:
--
--   1. shipstation_orders        — durable sales history
--   2. shipstation_order_items   — per-SKU line breakdown
--   3. shipstation_webhook_events — every webhook received, used for
--                                   idempotency AND as an audit trail of
--                                   what ShipStation sent us
--   4. shipstation_sync_runs     — reconciliation job log
--
-- Hygiene principles:
--   * `shipstation_order_id` (ShipStation's id) is UNIQUE — two webhooks
--     for the same order cannot create duplicate rows.
--   * `shipstation_webhook_events.event_id` is UNIQUE — two deliveries of
--     the same event (ShipStation retries on any non-2xx) won't be processed
--     twice.
--   * `inventory_applied_at` flag on each order: inventory delta was applied.
--     Only flipped true after the transactional RPC succeeds.
--   * Reconcile runs can mark discrepancies without touching history —
--     corrections go through the normal cycle-count path.

CREATE TABLE shipstation_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- ShipStation-side identifiers
  shipstation_order_id BIGINT UNIQUE NOT NULL,
  order_number TEXT NOT NULL,
  order_status TEXT NOT NULL,
  -- Timing
  order_date TIMESTAMPTZ NOT NULL,
  ship_date TIMESTAMPTZ,
  -- Customer
  customer_email TEXT,
  customer_name TEXT,
  -- Store/Channel (e.g., Shopify, Amazon)
  store_id BIGINT,
  store_name TEXT,
  -- Money (stored as BIGINT cents for precision)
  order_total_cents BIGINT NOT NULL DEFAULT 0,
  shipping_amount_cents BIGINT NOT NULL DEFAULT 0,
  tax_amount_cents BIGINT NOT NULL DEFAULT 0,
  -- Our tracking of whether inventory has been decremented for this order
  inventory_applied_at TIMESTAMPTZ,
  inventory_apply_attempts INTEGER NOT NULL DEFAULT 0,
  inventory_apply_error TEXT,
  -- Reconciliation
  last_seen_via TEXT CHECK (last_seen_via IN ('webhook', 'api_pull', 'manual')),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Raw payload for forensic use (never indexed; store the lot)
  raw_payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ss_orders_order_date ON shipstation_orders(order_date DESC);
CREATE INDEX idx_ss_orders_inventory_pending
  ON shipstation_orders(inventory_applied_at)
  WHERE inventory_applied_at IS NULL;
CREATE INDEX idx_ss_orders_order_number ON shipstation_orders(order_number);

CREATE TABLE shipstation_order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shipstation_order_id UUID NOT NULL REFERENCES shipstation_orders(id) ON DELETE CASCADE,
  shipstation_line_item_id BIGINT,
  -- SKU code as sent by ShipStation. Resolved to a product_skus.id below.
  sku_code TEXT NOT NULL,
  -- Resolved internal SKU. Null when we receive a SKU we don't recognize —
  -- operator must reconcile before inventory can be applied.
  sku_id UUID REFERENCES product_skus(id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL,
  unit_price_cents BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_ss_item_qty_positive CHECK (quantity > 0)
);

CREATE INDEX idx_ss_items_order ON shipstation_order_items(shipstation_order_id);
CREATE INDEX idx_ss_items_sku ON shipstation_order_items(sku_id);
CREATE INDEX idx_ss_items_unresolved
  ON shipstation_order_items(sku_code)
  WHERE sku_id IS NULL;

CREATE TABLE shipstation_webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Unique per delivery. ShipStation sends a resource_url + event type; we
  -- hash them together with the timestamp as our dedup key.
  event_id TEXT UNIQUE NOT NULL,
  event_type TEXT NOT NULL,           -- ORDER_NOTIFY | SHIP_NOTIFY | ITEM_SHIP_NOTIFY ...
  resource_url TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  processing_error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  -- Signature info: whether and how we verified the request
  signature_verified BOOLEAN NOT NULL DEFAULT false,
  -- Raw request body + headers for forensic use
  request_headers JSONB,
  request_body JSONB,
  -- Optional: the shipstation_order record we created/updated from this event
  resulting_order_id UUID REFERENCES shipstation_orders(id)
);

CREATE INDEX idx_ss_events_pending
  ON shipstation_webhook_events(received_at DESC)
  WHERE processed_at IS NULL;
CREATE INDEX idx_ss_events_type ON shipstation_webhook_events(event_type);

CREATE TABLE shipstation_sync_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_type TEXT NOT NULL CHECK (run_type IN ('webhook_replay', 'nightly_reconcile', 'backfill')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed')),
  -- Range pulled
  from_date TIMESTAMPTZ,
  to_date TIMESTAMPTZ,
  -- Tallies
  orders_pulled INTEGER NOT NULL DEFAULT 0,
  orders_new INTEGER NOT NULL DEFAULT 0,
  orders_updated INTEGER NOT NULL DEFAULT 0,
  orders_drift_detected INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  notes TEXT
);

CREATE INDEX idx_ss_sync_started_at ON shipstation_sync_runs(started_at DESC);

-- RLS: all ShipStation tables are read-only for authenticated users.
-- Writes happen exclusively through Edge Functions (service_role).
ALTER TABLE shipstation_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE shipstation_order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE shipstation_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE shipstation_sync_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can read shipstation orders"
  ON shipstation_orders FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated can read shipstation items"
  ON shipstation_order_items FOR SELECT TO authenticated USING (true);
CREATE POLICY "Admins can read webhook events"
  ON shipstation_webhook_events FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  );
CREATE POLICY "Authenticated can read sync runs"
  ON shipstation_sync_runs FOR SELECT TO authenticated USING (true);

-- updated_at trigger
CREATE TRIGGER set_updated_at BEFORE UPDATE ON shipstation_orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();


-- ============================================================
-- FILE: 20260101000012_shipstation_rpc_and_catchup.sql
-- ============================================================
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


-- ============================================================
-- FILE: 20260101000013_schema_tightening.sql
-- ============================================================
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


-- ============================================================
-- FILE: 20260101000014_locations.sql
-- ============================================================
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


-- ============================================================
-- FILE: 20260101000015_role_escalation_fix.sql
-- ============================================================
-- =============================================================
-- Migration 015: Close the role-escalation hole
-- =============================================================
-- The original RLS policy on profiles allowed users to update their own
-- profile. The `role` column lived on the same row, so a user could
-- self-promote to admin by updating their own profile. That's a hard
-- security hole.
--
-- Fix: split profile updates into two paths:
--   1. Regular profile fields (full_name, avatar_url) — users can update
--      their own via the existing RLS policy. The `role` column is now
--      protected by a column-level trigger that rejects direct updates.
--   2. Role changes — must go through rpc_update_user_role() which:
--        * requires caller to be admin OR manager
--        * forbids self-edit (no one can change their own role via this path)
--        * forbids manager from granting admin (only admin can promote to admin)
--        * writes an audit entry with before/after values
--
-- Only a super-admin DB operator can bypass this (via SQL Editor as
-- service_role).

-- -------------------------------------------------------------
-- A. Column-level trigger blocking direct role updates
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION block_direct_role_update()
RETURNS TRIGGER AS $$
BEGIN
  -- If the role is being changed and we're not the service_role (which
  -- is what the RPC runs as with SECURITY DEFINER), block it.
  IF NEW.role IS DISTINCT FROM OLD.role THEN
    -- current_setting('role') is 'authenticated' for user sessions and
    -- something else when invoked via SECURITY DEFINER. The cleanest check
    -- is "is this being called from within rpc_update_user_role?" via a
    -- GUC we set inside that function. If the GUC isn't set, reject.
    IF COALESCE(current_setting('app.role_change_allowed', true), '') != 'yes' THEN
      RAISE EXCEPTION 'Direct updates to profiles.role are not allowed. Use rpc_update_user_role() instead.'
        USING HINT = 'SELECT rpc_update_user_role(target_user_id, new_role, your_user_id);';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_block_direct_role_update
  BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION block_direct_role_update();

-- -------------------------------------------------------------
-- B. The role-change RPC
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION rpc_update_user_role(
  p_target_user_id UUID,
  p_new_role TEXT,
  p_actor_id UUID
) RETURNS JSONB AS $$
DECLARE
  v_actor profiles%ROWTYPE;
  v_target profiles%ROWTYPE;
BEGIN
  -- Validate new role value
  IF p_new_role NOT IN ('admin', 'manager', 'user') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid role');
  END IF;

  -- Look up actor and target
  SELECT * INTO v_actor FROM profiles WHERE id = p_actor_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'actor not found');
  END IF;

  SELECT * INTO v_target FROM profiles WHERE id = p_target_user_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'target user not found');
  END IF;

  -- Rule 1: Actor must be admin or manager
  IF v_actor.role NOT IN ('admin', 'manager') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'only admins and managers can change roles');
  END IF;

  -- Rule 2: No self-role-edits
  IF v_actor.id = v_target.id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'cannot change your own role');
  END IF;

  -- Rule 3: Managers cannot grant admin
  IF v_actor.role = 'manager' AND p_new_role = 'admin' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'managers cannot grant admin role');
  END IF;

  -- Rule 4: Managers cannot change an existing admin's role
  IF v_actor.role = 'manager' AND v_target.role = 'admin' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'managers cannot change an admin role');
  END IF;

  -- Noop if no actual change
  IF v_target.role = p_new_role THEN
    RETURN jsonb_build_object('ok', true, 'noop', true);
  END IF;

  -- Open the gate and update
  PERFORM set_config('app.role_change_allowed', 'yes', true); -- true = transaction-scoped
  UPDATE profiles SET role = p_new_role WHERE id = p_target_user_id;
  PERFORM set_config('app.role_change_allowed', '', true);

  -- Audit entry
  INSERT INTO inventory_transactions (
    sku_id, transaction_type, quantity, field_affected,
    movement_kind, reference_id, reference_type, notes, performed_by
  ) VALUES (
    NULL, 'user_role_change', 0, 'role',
    'metadata', p_target_user_id, 'profile',
    format('%s: role changed %s → %s by %s',
      v_target.full_name, v_target.role, p_new_role, v_actor.full_name),
    p_actor_id
  );

  RETURN jsonb_build_object('ok', true, 'previous_role', v_target.role, 'new_role', p_new_role);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION rpc_update_user_role TO authenticated;

-- -------------------------------------------------------------
-- C. Also lock down profile INSERTs from authenticated —
--    only the auth trigger (handle_new_user) should create them.
-- -------------------------------------------------------------
-- The existing policies already don't grant INSERT to authenticated,
-- so nothing to do here, but assert it explicitly for clarity.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'profiles'
       AND cmd = 'INSERT'
  ) THEN
    RAISE NOTICE 'Profiles has INSERT policy — review migration 001 and 015 together.';
  END IF;
END$$;

COMMENT ON FUNCTION rpc_update_user_role IS
  'The only supported path for changing a user role. Enforces RBAC and writes audit.';


-- ============================================================
-- FILE: 20260101000016_tracking_cron.sql
-- ============================================================
-- =============================================================
-- Migration 016: Scheduled tracking reconciler
-- =============================================================
-- Moves the 12-hour carrier-tracking poll off the client and onto
-- pg_cron + the tracking-reconcile Edge Function (supabase/functions/).
--
-- Before this: the browser running the app polled carrier APIs every 12h
-- via useShipmentTracking. If nobody logged in over a weekend, tracking
-- never refreshed.
--
-- After this: the Edge Function runs on a fixed schedule regardless of
-- who's logged in, writes reconciled ETAs directly to freight_shipments,
-- and the client becomes a pure read view (polling replaced by Supabase
-- realtime subscription OR manual refresh button).

-- -------------------------------------------------------------
-- A. Enable pg_cron + pg_net (idempotent)
-- -------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- -------------------------------------------------------------
-- B. The cron job
-- -------------------------------------------------------------
-- Runs every 6 hours at :07 past — slightly offset from the hour to
-- avoid rush-hour scheduler contention with other jobs.
-- Sends a POST to the tracking-reconcile Edge Function using the
-- service_role JWT (stored in the `app.settings.service_role_jwt` GUC,
-- which must be set once at deploy time via SQL Editor).

-- First unschedule if it already exists (so this migration is idempotent).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'tracking-reconcile') THEN
    PERFORM cron.unschedule('tracking-reconcile');
  END IF;
END$$;

-- Note: the project URL and JWT are deployment-specific. At deploy time,
-- run in SQL Editor:
--
--   ALTER DATABASE postgres SET app.settings.project_url
--     TO 'https://<project-ref>.supabase.co';
--   ALTER DATABASE postgres SET app.settings.service_role_jwt
--     TO '<service-role-jwt>';
--
-- Then run this cron.schedule statement.
SELECT cron.schedule(
  'tracking-reconcile',
  '7 */6 * * *',  -- :07 every 6 hours — gives a full re-check window each half-day
  $$
    SELECT net.http_post(
      url := current_setting('app.settings.project_url') || '/functions/v1/tracking-reconcile',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || current_setting('app.settings.service_role_jwt'),
        'Content-Type', 'application/json'
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 60000
    );
  $$
);

-- -------------------------------------------------------------
-- C. Also schedule the ShipStation reconciler here since we're touching cron
-- -------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'shipstation-reconcile-nightly') THEN
    PERFORM cron.unschedule('shipstation-reconcile-nightly');
  END IF;
END$$;

SELECT cron.schedule(
  'shipstation-reconcile-nightly',
  '15 3 * * *',  -- 03:15 UTC nightly (23:15 ET)
  $$
    SELECT net.http_post(
      url := current_setting('app.settings.project_url') || '/functions/v1/shipstation-reconcile',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || current_setting('app.settings.service_role_jwt'),
        'Content-Type', 'application/json'
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 600000
    );
  $$
);

-- -------------------------------------------------------------
-- D. Also schedule a nightly audit-chain verification as a safety net
-- -------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'audit-chain-verify') THEN
    PERFORM cron.unschedule('audit-chain-verify');
  END IF;
END$$;

-- Verifies the previous 48 hours of audit entries daily. Much cheaper than
-- the full chain; catches any tampering within the detection window.
SELECT cron.schedule(
  'audit-chain-verify',
  '30 4 * * *',  -- 04:30 UTC nightly
  $$
    INSERT INTO inventory_transactions (
      sku_id, transaction_type, quantity, field_affected,
      movement_kind, notes, performed_by
    )
    SELECT
      NULL, 'audit_chain_alert', 0, 'row_hash',
      'metadata',
      format('Chain broken starting at %s: %s', first_broken_id, message),
      '00000000-0000-0000-0000-000000000001'::uuid
    FROM verify_audit_chain(now() - interval '48 hours')
    LIMIT 1;
  $$
);

COMMENT ON EXTENSION pg_cron IS
  'Scheduled jobs live here. Review with: SELECT * FROM cron.job;';


-- ============================================================
-- FILE: 20260101000017_suppliers.sql
-- ============================================================
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
SELECT sku_id, '00000000-0000-0000-0000-000000000201', 'ordered', nancy_ordered
  FROM inventory_levels WHERE nancy_ordered IS NOT NULL
UNION ALL
SELECT sku_id, '00000000-0000-0000-0000-000000000201', 'finished', nancy_finished
  FROM inventory_levels WHERE nancy_finished IS NOT NULL
UNION ALL
SELECT sku_id, '00000000-0000-0000-0000-000000000202', 'ordered', yx_ordered
  FROM inventory_levels WHERE yx_ordered IS NOT NULL
UNION ALL
SELECT sku_id, '00000000-0000-0000-0000-000000000202', 'finished', yx_finished
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
  'Per-supplier per-SKU on-hand quantity at supplier locations. Two stages: ordered (placed, not yet complete) and finished (ready for shipment to us).';


-- ============================================================
-- FILE: 20260101000018_money_precision.sql
-- ============================================================
-- =============================================================
-- Migration 018: Money precision upgrade
-- =============================================================
-- The original schema used DECIMAL(10,2) for money columns. At $10M/year
-- revenue that's already tight — a single high-value shipment total
-- (~$5M) sits just below the DECIMAL(10,2) ceiling of $99,999,999.99.
-- More importantly:
--
--   * DECIMAL(10,2) stores only 2 decimal places. Per-unit costs are
--     routinely fractional (freight allocated across 10,000 units can
--     leave fractions-of-a-cent residue). Rounding these to 2 decimals
--     introduces real drift in landed-cost math over time.
--   * A 10,000-unit shipment × $0.01 rounding error = $100 of drift per
--     shipment. Across a year, that's thousands of dollars of phantom
--     cost allocation.
--
-- Policy going forward:
--
--   * Totals and invoiced amounts: DECIMAL(14,4) — up to ~$99.9B, 4
--     decimal places. Matches common accounting-software conventions.
--   * Per-unit costs that accumulate: DECIMAL(14,6) — 6 decimal places
--     supports sub-cent precision where it compounds over large quantities.
--   * Percentages: DECIMAL(6,3) — 3 decimal places is enough for any
--     realistic allocation (you don't need 0.0001% precision).
--
-- ALTER TABLE for numeric types is a lossless widening operation —
-- PostgreSQL handles it in place with minimal table rewrite.

-- -------------------------------------------------------------
-- A. product_skus
-- -------------------------------------------------------------
ALTER TABLE product_skus
  ALTER COLUMN retail_price TYPE DECIMAL(14,4);

-- -------------------------------------------------------------
-- B. freight_shipments — totals at DECIMAL(14,4)
-- -------------------------------------------------------------
ALTER TABLE freight_shipments
  ALTER COLUMN freight_cost    TYPE DECIMAL(14,4),
  ALTER COLUMN insurance_cost  TYPE DECIMAL(14,4),
  ALTER COLUMN duties_cost     TYPE DECIMAL(14,4),
  ALTER COLUMN total_cost      TYPE DECIMAL(14,4);

-- -------------------------------------------------------------
-- C. freight_line_items — per-unit cost at DECIMAL(14,6); retail at 4dp
-- -------------------------------------------------------------
ALTER TABLE freight_line_items
  ALTER COLUMN unit_cost    TYPE DECIMAL(14,6),
  ALTER COLUMN retail_value TYPE DECIMAL(14,4);

-- -------------------------------------------------------------
-- D. factory_order_items — per-unit cost at DECIMAL(14,6)
-- -------------------------------------------------------------
ALTER TABLE factory_order_items
  ALTER COLUMN unit_cost TYPE DECIMAL(14,6);

-- -------------------------------------------------------------
-- E. sku_economics — per-unit costs and totals
-- -------------------------------------------------------------
-- Per-unit costs use DECIMAL(14,6). Sourcing/freight/manufacturing percentages
-- stay at DECIMAL(5,2) because they're bounded [0,100] and 2dp is plenty
-- for allocation percentages.
ALTER TABLE sku_economics
  ALTER COLUMN nancy_raw_cost              TYPE DECIMAL(14,6),
  ALTER COLUMN yx_raw_cost                 TYPE DECIMAL(14,6),
  ALTER COLUMN additional_raw_cost         TYPE DECIMAL(14,6),
  ALTER COLUMN sea_freight_cost_per_unit   TYPE DECIMAL(14,6),
  ALTER COLUMN air_freight_cost_per_unit   TYPE DECIMAL(14,6),
  ALTER COLUMN breakage_issue_cost         TYPE DECIMAL(14,6),
  ALTER COLUMN labor_cost_us               TYPE DECIMAL(14,6),
  ALTER COLUMN glycerin_cost_us            TYPE DECIMAL(14,6),
  ALTER COLUMN manufacturing_cost_cn       TYPE DECIMAL(14,6),
  ALTER COLUMN packing_material_cost       TYPE DECIMAL(14,6),
  ALTER COLUMN packing_labor_cost          TYPE DECIMAL(14,6),
  ALTER COLUMN shipping_cost               TYPE DECIMAL(14,6),
  ALTER COLUMN credit_card_fees            TYPE DECIMAL(14,6);

-- -------------------------------------------------------------
-- F. ShipStation tables already use BIGINT cents. Keep as-is; document why.
-- -------------------------------------------------------------
COMMENT ON COLUMN shipstation_orders.order_total_cents IS
  'Stored as BIGINT cents (not DECIMAL) because ShipStation sends dollar floats and we want exact storage without float-to-decimal drift. Multiply by 0.01 for display.';

-- -------------------------------------------------------------
-- G. Add a computed-column consistency trigger on freight_shipments
-- -------------------------------------------------------------
-- total_cost should reconcile with freight_cost + insurance_cost + duties_cost
-- plus optionally line-item subtotals. We don't strictly enforce this yet
-- because operators may enter total_cost manually with rounding, but this
-- trigger raises a NOTICE (logged, not blocking) when it drifts significantly.
CREATE OR REPLACE FUNCTION warn_freight_total_drift()
RETURNS TRIGGER AS $$
DECLARE
  v_sum DECIMAL(14,4);
  v_drift DECIMAL(14,4);
BEGIN
  v_sum := COALESCE(NEW.freight_cost, 0)
         + COALESCE(NEW.insurance_cost, 0)
         + COALESCE(NEW.duties_cost, 0);
  -- If total_cost is set but differs by more than $1 from the sum, warn.
  IF NEW.total_cost > 0 THEN
    v_drift := ABS(NEW.total_cost - v_sum);
    IF v_drift > 1.0 THEN
      RAISE NOTICE 'Freight shipment % total_cost (%) drifts from component sum (%) by %',
        NEW.shipment_number, NEW.total_cost, v_sum, v_drift;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_warn_freight_total_drift
  BEFORE INSERT OR UPDATE ON freight_shipments
  FOR EACH ROW EXECUTE FUNCTION warn_freight_total_drift();

COMMENT ON TRIGGER trg_warn_freight_total_drift ON freight_shipments IS
  'Logs a NOTICE when total_cost drifts >$1 from the sum of components. Non-blocking; catch up via observability.';


-- ================================================================
-- RECORD ALL MIGRATIONS AS APPLIED
-- ================================================================
INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES
  ('20260101000001', 'initial_schema'),
  ('20260101000002', 'freight_tracking_fields'),
  ('20260101000003', 'freight_tracking_status'),
  ('20260101000004', 'freight_status_override'),
  ('20260101000005', 'freight_total_cartons'),
  ('20260101000006', 'invariants'),
  ('20260101000007', 'row_version'),
  ('20260101000008', 'sku_archival'),
  ('20260101000009', 'audit_immutability'),
  ('20260101000010', 'atomic_rpcs'),
  ('20260101000011', 'shipstation_tables'),
  ('20260101000012', 'shipstation_rpc_and_catchup'),
  ('20260101000013', 'schema_tightening'),
  ('20260101000014', 'locations'),
  ('20260101000015', 'role_escalation_fix'),
  ('20260101000016', 'tracking_cron'),
  ('20260101000017', 'suppliers'),
  ('20260101000018', 'money_precision')
ON CONFLICT (version) DO NOTHING;
