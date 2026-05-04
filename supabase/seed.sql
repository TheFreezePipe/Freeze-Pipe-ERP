-- =============================================================
-- Dev seed data
-- =============================================================
-- Runs after migrations when `supabase db reset` or `supabase start` is used.
-- Creates a minimal, realistic dataset so a fresh dev DB is usable immediately.
--
-- Do NOT run in staging or prod — populate those environments from real data.
--
-- Size: ~5 SKUs, 3 employees, 2 suppliers (from migration 017), a handful of
-- freight shipments, factory orders, inventory levels, and audit entries.
-- This is intentionally small so devs can eyeball the UI without being buried
-- in noise. Expand via the UI or a backfill script once you need more coverage.

-- -------------------------------------------------------------
-- PROFILES — three demo employees + admin + system
-- -------------------------------------------------------------
-- The 'system' profile (id = 00000...01) is already created by migration 013
-- as the attribution target for automated writes.
--
-- Real users come from Supabase Auth via the handle_new_user trigger. For dev
-- we seed profile rows directly with fake UUIDs. To log in as these users,
-- create matching auth.users entries in the Auth dashboard or via SQL
-- (see docs/SUPABASE_SETUP.md).

INSERT INTO profiles (id, email, full_name, role) VALUES
  ('10000000-0000-0000-0000-000000000001', 'admin@example.com',  'Chase (Admin)',  'admin'),
  ('10000000-0000-0000-0000-000000000002', 'mike@example.com',   'Mike Torres',    'user'),
  ('10000000-0000-0000-0000-000000000003', 'sarah@example.com',  'Sarah Chen',     'user'),
  ('10000000-0000-0000-0000-000000000004', 'james@example.com',  'James Park',     'user'),
  ('10000000-0000-0000-0000-000000000005', 'lisa@example.com',   'Lisa Wang',      'manager')
ON CONFLICT (id) DO NOTHING;

-- -------------------------------------------------------------
-- PRODUCT SKUS — a handful of representative products
-- -------------------------------------------------------------
INSERT INTO product_skus (id, sku, product_name, category, display_category, retail_price, standard_quantity_per_carton, abc_classification, monthly_demand) VALUES
  ('20000000-0000-0000-0000-000000000001', 'BW20',     'Freeze Pipe',                'fillable',    'Pipes',        74.95,  12, 'A', 1200),
  ('20000000-0000-0000-0000-000000000002', 'BW20P',    'Freeze Pipe Revolver',       'fillable',    'Pipes',        84.95,  12, 'B',  270),
  ('20000000-0000-0000-0000-000000000003', 'BW20DNA',  'Freeze Pipe DNA',            'fillable',    'Pipes',        94.95,  12, 'A', 1300),
  ('20000000-0000-0000-0000-000000000007', 'BW21P',    'Freeze Pipe Bubbler Pro',    'fillable',    'Bubblers',    139.95,  12, 'A',  175),
  ('20000000-0000-0000-0000-000000000013', 'NB2',      'Freeze Pipe Bong Pro',       'fillable',    'Bongs',       209.95,   6, 'A',  130),
  ('20000000-0000-0000-0000-000000000036', 'Mini-ENAIL-Gray', 'Mini ENAIL (Gray)',   'non_fillable','Accessories',  44.95, 100, 'B',  330)
ON CONFLICT (id) DO NOTHING;

-- -------------------------------------------------------------
-- INVENTORY LEVELS — one row per SKU at the default location
-- -------------------------------------------------------------
-- The default location UUID 00000...100 is seeded by migration 014.
INSERT INTO inventory_levels (sku_id, location_id, warehouse_raw, warehouse_in_production, warehouse_finished, warehouse_other) VALUES
  ('20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000100',  48,  36,  120, 0),
  ('20000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000100', 200,   0,   48, 0),
  ('20000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000100',  60,  24,  180, 0),
  ('20000000-0000-0000-0000-000000000007', '00000000-0000-0000-0000-000000000100', 144,  96,   72, 0),
  ('20000000-0000-0000-0000-000000000013', '00000000-0000-0000-0000-000000000100',  36,  24,   42, 0),
  ('20000000-0000-0000-0000-000000000036', '00000000-0000-0000-0000-000000000100', 200,   0,  150, 0)
ON CONFLICT DO NOTHING;

-- -------------------------------------------------------------
-- SUPPLIER INVENTORY — replacement for the nancy_*/yx_* columns
-- -------------------------------------------------------------
-- Nancy supplier id (from migration 017): 00000...201
-- YX supplier id (from migration 017):    00000...202
INSERT INTO supplier_inventory (sku_id, supplier_id, stage, quantity) VALUES
  -- BW20 has an active Nancy order
  ('20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000201', 'finished', 300),
  ('20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000201', 'ordered',  200),
  -- BW20DNA Nancy
  ('20000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000201', 'finished', 150),
  -- Mini-ENAIL from YX
  ('20000000-0000-0000-0000-000000000036','00000000-0000-0000-0000-000000000202', 'finished', 500)
ON CONFLICT (sku_id, supplier_id, stage) DO NOTHING;

-- -------------------------------------------------------------
-- FREIGHT — one in-transit sea + one delivered
-- -------------------------------------------------------------
INSERT INTO freight_shipments (
  id, shipment_number, freight_type, status, carrier_name, tracking_number,
  ship_date, eta, eta_original, freight_cost, insurance_cost, duties_cost, total_cost, total_cartons, notes
) VALUES
  ('30000000-0000-0000-0000-000000000001', 'SEA-2026-0315', 'sea', 'on_the_water',
   'Maersk', 'MAEU1234567', '2026-03-15', '2026-04-18', '2026-04-18',
   4200, 350, 0, 4550, 22, 'Mixed SKUs — pipes and bongs'),
  ('30000000-0000-0000-0000-000000000004', 'SEA-2026-0220', 'sea', 'delivered',
   'Evergreen', 'EGLV5551234', '2026-02-20', '2026-03-25', '2026-03-25',
   5100, 400, 890, 6390, 31, NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO freight_line_items (freight_shipment_id, sku_id, quantity, unit_cost, retail_value) VALUES
  ('30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 144,  8.50,  74.95),
  ('30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000007',  96, 12.00, 139.95)
ON CONFLICT DO NOTHING;

-- -------------------------------------------------------------
-- FACTORY ORDERS — one open with Nancy
-- -------------------------------------------------------------
INSERT INTO factory_orders (id, supplier_id, order_number, status, order_date, expected_completion, notes) VALUES
  ('40000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000201',
   'NAN-2026-042', 'in_production', '2026-03-10', '2026-04-10', 'Standard monthly order')
ON CONFLICT (id) DO NOTHING;

INSERT INTO factory_order_items (factory_order_id, sku_id, quantity_ordered, quantity_finished, unit_cost) VALUES
  ('40000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 500, 300, 8.50),
  ('40000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000003', 200, 150, 9.25)
ON CONFLICT DO NOTHING;

-- -------------------------------------------------------------
-- One sample audit entry so the change log has something on load
-- -------------------------------------------------------------
INSERT INTO inventory_transactions (
  sku_id, transaction_type, quantity, field_affected, movement_kind,
  notes, performed_by
) VALUES (
  '20000000-0000-0000-0000-000000000001',
  'cycle_count', 5, 'warehouse_finished', 'net_change',
  'Initial seed — cycle count adjustment',
  '10000000-0000-0000-0000-000000000001'
);

-- Done.
