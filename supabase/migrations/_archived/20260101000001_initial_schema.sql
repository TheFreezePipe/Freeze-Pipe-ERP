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
