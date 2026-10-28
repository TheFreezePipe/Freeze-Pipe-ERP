-- =============================================================
-- Warehouse module Phase 1, slice 6 test suite (pgTAP): next carton
-- (FIFO), take-to-line overrides, FIFO compliance, carton passport
-- =============================================================
-- Covers migration 20261029000001 (wh_fifo_passport). Synthetic fixtures
-- only (SKUs TPF-*, factory orders TPF-FO-*, shipments TPF-90x, rack T86
-- with faces 86 and 87); everything rolls back.
-- Run with: supabase test db
--
-- Areas tested:
--   S. Stamping the carton group's factory order item: the insert trigger,
--      an ambiguous shipment (two orders of one SKU) stays NULL, a second
--      SKU clears the stamp, the resolver called directly
--   N. Next carton: the older factory order wins although its cartons
--      landed and were checked in later; within an order the shipment
--      that landed first wins over check-in; within a shipment the earlier
--      check-in wins over the carton number; an open carton beats sealed
--      ones; cartons at MFG-LINE, void, empty and mixed cartons are never
--      suggested; an ambiguous group falls back to check-in
--      (oldest_received); no raw stock, no cartons or an unknown id → null
--   T. Take to line: the suggested carton is followed; another carton
--      returns fifo_suggests and changes nothing; an override proceeds and
--      records a deviation; a bad override is invalid_override; one
--      overload
--   C. rpc_wh_fifo_compliance counts and role gate
--   P. Passport: carton_not_found; a carton with receipt, putaway,
--      pull-to-line and relabel has those entries in order, its legs, its
--      batch, summary and siblings, its children; the child shows its
--      parent and inherits the batch

BEGIN;

SELECT plan(42);

-- Staging may carry live printers; routing prefers an active station printer.
UPDATE wh_printers SET active = false;
UPDATE wh_settings SET value = '{"mode":"live"}'::jsonb WHERE key = 'outbound';
UPDATE wh_settings SET value = value || '{"live_since": "2026-01-01T00:00:00Z", "mint_lpns": true}'::jsonb WHERE key = 'physical_layer';

-- =============================================================
-- Fixtures
-- =============================================================
INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change, is_sso_user, is_anonymous)
SELECT '00000000-0000-0000-0000-000000000000', x.id, 'authenticated', 'authenticated', x.email, '', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', '', false, false
  FROM (VALUES
   ('f1f00000-0000-0000-0000-000000000001'::uuid, 'whff-admin@test.local'),
   ('f1f00000-0000-0000-0000-000000000002', 'whff-manager@test.local'),
   ('f1f00000-0000-0000-0000-000000000003', 'whff-user@test.local')) AS x(id, email)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE profiles DISABLE TRIGGER USER;
INSERT INTO profiles (id, email, full_name, role, is_active, supplier_id, is_print_agent) VALUES
  ('f1f00000-0000-0000-0000-000000000001', 'whff-admin@test.local',   'Ada Admin',   'admin',   true, NULL, false),
  ('f1f00000-0000-0000-0000-000000000002', 'whff-manager@test.local', 'Mia Manager', 'manager', true, NULL, false),
  ('f1f00000-0000-0000-0000-000000000003', 'whff-user@test.local',    'Devon Floor', 'user',    true, NULL, false)
ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, is_active = true, supplier_id = NULL, full_name = EXCLUDED.full_name;
ALTER TABLE profiles ENABLE TRIGGER USER;

INSERT INTO suppliers (id, code, name, is_producer, is_filler, is_export_broker, consolidates_for)
VALUES ('f1f10000-0000-0000-0000-000000000001', 'TPFS', 'FIFO Test Supplier', true, false, false, ARRAY[]::uuid[]);

INSERT INTO product_skus (id, sku, product_name, category, display_category, standard_quantity_per_carton) VALUES
  ('f1f20000-0000-0000-0000-000000000001', 'TPF-A', 'Test FIFO A',       'fillable',     'Pipes',       10),
  ('f1f20000-0000-0000-0000-000000000002', 'TPF-M', 'Test mixed partner', 'fillable',    'Pipes',       10),
  ('f1f20000-0000-0000-0000-000000000003', 'TPF-C', 'Test finished only', 'non_fillable', 'Accessories', 12),
  ('f1f20000-0000-0000-0000-000000000004', 'TPF-P', 'Test passport P',   'fillable',     'Pipes',       10),
  ('f1f20000-0000-0000-0000-000000000005', 'TPF-N', 'Test no cartons',   'fillable',     'Pipes',       10);

INSERT INTO factory_orders (id, order_number, supplier_id, order_date, expected_completion, status) VALUES
  ('f1f30000-0000-0000-0000-000000000001', 'TPF-FO-OLD', 'f1f10000-0000-0000-0000-000000000001', '2026-06-01', '2026-07-15', 'in_production'),
  ('f1f30000-0000-0000-0000-000000000002', 'TPF-FO-NEW', 'f1f10000-0000-0000-0000-000000000001', '2026-08-01', '2026-08-15', 'in_production'),
  ('f1f30000-0000-0000-0000-000000000003', 'TPF-FO-P',   'f1f10000-0000-0000-0000-000000000001', '2026-07-01', '2026-08-10', 'in_production');
INSERT INTO factory_order_items (id, factory_order_id, sku_id, quantity_ordered, unit_cost) VALUES
  ('f1f40000-0000-0000-0000-000000000001', 'f1f30000-0000-0000-0000-000000000001', 'f1f20000-0000-0000-0000-000000000001', 50, 1),
  ('f1f40000-0000-0000-0000-000000000002', 'f1f30000-0000-0000-0000-000000000002', 'f1f20000-0000-0000-0000-000000000001', 30, 1),
  ('f1f40000-0000-0000-0000-000000000003', 'f1f30000-0000-0000-0000-000000000003', 'f1f20000-0000-0000-0000-000000000004', 20, 1);

-- 901 carries the newer order and lands first; 902 and 904 carry the older
-- order (904 lands first); 903 carries both orders of TPF-A (ambiguous);
-- 905 is one mixed carton; 906 is the passport's shipment
INSERT INTO freight_shipments (id, shipment_number, freight_type, status, ship_date, actual_arrival_date) VALUES
  ('f1f50000-0000-0000-0000-000000000001', 'TPF-901', 'sea', 'tracking', '2026-08-20', '2026-09-25'),
  ('f1f50000-0000-0000-0000-000000000002', 'TPF-902', 'sea', 'tracking', '2026-09-01', '2026-10-10'),
  ('f1f50000-0000-0000-0000-000000000003', 'TPF-903', 'sea', 'tracking', '2026-08-25', '2026-09-20'),
  ('f1f50000-0000-0000-0000-000000000004', 'TPF-904', 'sea', 'tracking', '2026-08-28', '2026-10-01'),
  ('f1f50000-0000-0000-0000-000000000005', 'TPF-905', 'sea', 'tracking', '2026-08-01', '2026-09-01'),
  ('f1f50000-0000-0000-0000-000000000006', 'TPF-906', 'sea', 'tracking', '2026-08-20', '2026-09-19');
INSERT INTO freight_line_items (id, freight_shipment_id, sku_id, quantity, source_factory_order_item_id) VALUES
  ('f1f60000-0000-0000-0000-000000000001', 'f1f50000-0000-0000-0000-000000000001', 'f1f20000-0000-0000-0000-000000000001', 20, 'f1f40000-0000-0000-0000-000000000002'),
  ('f1f60000-0000-0000-0000-000000000002', 'f1f50000-0000-0000-0000-000000000002', 'f1f20000-0000-0000-0000-000000000001', 20, 'f1f40000-0000-0000-0000-000000000001'),
  ('f1f60000-0000-0000-0000-000000000003', 'f1f50000-0000-0000-0000-000000000003', 'f1f20000-0000-0000-0000-000000000001', 10, 'f1f40000-0000-0000-0000-000000000001'),
  ('f1f60000-0000-0000-0000-000000000004', 'f1f50000-0000-0000-0000-000000000003', 'f1f20000-0000-0000-0000-000000000001', 10, 'f1f40000-0000-0000-0000-000000000002'),
  ('f1f60000-0000-0000-0000-000000000005', 'f1f50000-0000-0000-0000-000000000004', 'f1f20000-0000-0000-0000-000000000001', 20, 'f1f40000-0000-0000-0000-000000000001'),
  ('f1f60000-0000-0000-0000-000000000006', 'f1f50000-0000-0000-0000-000000000005', 'f1f20000-0000-0000-0000-000000000001', 6,  'f1f40000-0000-0000-0000-000000000001'),
  ('f1f60000-0000-0000-0000-000000000007', 'f1f50000-0000-0000-0000-000000000005', 'f1f20000-0000-0000-0000-000000000002', 6,  NULL),
  ('f1f60000-0000-0000-0000-000000000008', 'f1f50000-0000-0000-0000-000000000006', 'f1f20000-0000-0000-0000-000000000004', 20, 'f1f40000-0000-0000-0000-000000000003');
INSERT INTO freight_carton_groups (id, freight_shipment_id, carton_qty, sort_order) VALUES
  ('f1f70000-0000-0000-0000-000000000001', 'f1f50000-0000-0000-0000-000000000001', 2, 0),
  ('f1f70000-0000-0000-0000-000000000002', 'f1f50000-0000-0000-0000-000000000002', 2, 0),
  ('f1f70000-0000-0000-0000-000000000003', 'f1f50000-0000-0000-0000-000000000003', 2, 0),
  ('f1f70000-0000-0000-0000-000000000004', 'f1f50000-0000-0000-0000-000000000004', 2, 0),
  ('f1f70000-0000-0000-0000-000000000005', 'f1f50000-0000-0000-0000-000000000005', 1, 0),
  ('f1f70000-0000-0000-0000-000000000006', 'f1f50000-0000-0000-0000-000000000006', 2, 0);
INSERT INTO freight_carton_group_skus (carton_group_id, sku_id, units_total) VALUES
  ('f1f70000-0000-0000-0000-000000000001', 'f1f20000-0000-0000-0000-000000000001', 20),
  ('f1f70000-0000-0000-0000-000000000002', 'f1f20000-0000-0000-0000-000000000001', 20),
  ('f1f70000-0000-0000-0000-000000000003', 'f1f20000-0000-0000-0000-000000000001', 20),
  ('f1f70000-0000-0000-0000-000000000004', 'f1f20000-0000-0000-0000-000000000001', 20),
  ('f1f70000-0000-0000-0000-000000000005', 'f1f20000-0000-0000-0000-000000000001', 6),
  ('f1f70000-0000-0000-0000-000000000006', 'f1f20000-0000-0000-0000-000000000004', 20);
-- group 5 had one SKU so far (stamped); its second SKU makes it mixed
SELECT set_config('wht.g5a', COALESCE((SELECT factory_order_item_id::text FROM freight_carton_groups WHERE id = 'f1f70000-0000-0000-0000-000000000005'), ''), true);
INSERT INTO freight_carton_group_skus (carton_group_id, sku_id, units_total) VALUES
  ('f1f70000-0000-0000-0000-000000000005', 'f1f20000-0000-0000-0000-000000000002', 6);

CREATE OR REPLACE FUNCTION pg_temp.as_user(p_id uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_id, 'role', 'authenticated')::text, true);
  PERFORM set_config('role', 'authenticated', true);
END; $$;
CREATE OR REPLACE FUNCTION pg_temp.as_super() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('role', 'postgres', true);
  PERFORM set_config('request.jwt.claims', '', true);
END; $$;
CREATE OR REPLACE FUNCTION pg_temp.loc(p_code text) RETURNS uuid LANGUAGE sql AS $$
  SELECT id FROM wh_locations WHERE code = p_code;
$$;
CREATE OR REPLACE FUNCTION pg_temp.sku(p_code text) RETURNS uuid LANGUAGE sql AS $$
  SELECT id FROM product_skus WHERE sku = p_code;
$$;
CREATE OR REPLACE FUNCTION pg_temp.ctr(p_code text) RETURNS uuid LANGUAGE sql AS $$
  SELECT id FROM wh_containers WHERE code = p_code;
$$;
CREATE OR REPLACE FUNCTION pg_temp.v(p_key text) RETURNS jsonb LANGUAGE sql AS $$
  SELECT NULLIF(current_setting('wht.' || p_key, true), '')::jsonb;
$$;
-- the next carton for one SKU, through the RPC
CREATE OR REPLACE FUNCTION pg_temp.nx(p_sku text) RETURNS jsonb LANGUAGE sql AS $$
  SELECT rpc_wh_next_cartons(ARRAY[(SELECT id FROM product_skus WHERE sku = p_sku)])->'next'->((SELECT id FROM product_skus WHERE sku = p_sku)::text);
$$;
-- the first timeline position of a kind, and whether a title is present
CREATE OR REPLACE FUNCTION pg_temp.pos(p_tl jsonb, p_kind text) RETURNS integer LANGUAGE sql AS $$
  SELECT min(e.n)::int FROM jsonb_array_elements(p_tl) WITH ORDINALITY AS e(x, n) WHERE e.x->>'kind' = p_kind;
$$;
CREATE OR REPLACE FUNCTION pg_temp.has_title(p_tl jsonb, p_title text) RETURNS boolean LANGUAGE sql AS $$
  SELECT EXISTS (SELECT 1 FROM jsonb_array_elements(p_tl) AS e(x) WHERE e.x->>'title' = p_title);
$$;
-- opening stock: a sealed carton holding units
CREATE OR REPLACE FUNCTION pg_temp.put(p_sku text, p_loc text, p_ctr text, p_bucket text, p_qty integer) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_ctr uuid;
BEGIN
  INSERT INTO wh_containers (code, sku_id, qty_initial, qty, state, location_id, source, created_by)
  VALUES (p_ctr, pg_temp.sku(p_sku), p_qty, 0, 'sealed', pg_temp.loc(p_loc), 'manual', 'f1f00000-0000-0000-0000-000000000001')
  RETURNING id INTO v_ctr;
  PERFORM _wh_post_movement(gen_random_uuid(), 'opening_balance', pg_temp.sku(p_sku), p_bucket, p_qty, NULL, NULL,
                            pg_temp.loc(p_loc), v_ctr, NULL, 'f1f00000-0000-0000-0000-000000000001', NULL, NULL, 'test fixture');
END; $$;

-- rack T86: faces 86 and 87
SELECT pg_temp.as_user('f1f00000-0000-0000-0000-000000000001');
SELECT set_config('wht.layout', rpc_wh_save_layout('{
  "templates":[{"code":"TFF-PR","name":"Test FIFO pallet rack","kind":"pallet_rack","bays":3,"levels":3,
                "bay_width_mm":2743,"depth_mm":1067,"level_heights_mm":[0,1372,2743],
                "overflow_top_level":true,"capacity_cartons_per_level":4}],
  "racks":[{"code":"T86","template_code":"TFF-PR","x_mm":3000,"y_mm":3000,"rot_deg":90}],
  "faces":[{"rack_code":"T86","face_code":"86","side":"east","aisle":"X","walk_pass":77,"walk_dir":"S","zone_by_bay":["RAW"]},
           {"rack_code":"T86","face_code":"87","side":"west","aisle":"W","walk_pass":78,"walk_dir":"N","zone_by_bay":["RTS"]}]
}'::jsonb)::text, true);
SELECT rpc_wh_generate_locations((SELECT id FROM wh_racks WHERE code = 'T86'), false);
SELECT is((SELECT count(*)::int FROM wh_locations WHERE face IN ('86', '87')), 18, 'F0 the test rack has 18 bay-levels');

-- check-in of every group (minting on): two cartons each, one mixed carton for 905
SELECT pg_temp.as_user('f1f00000-0000-0000-0000-000000000002');
SELECT rpc_record_freight_receipt(s.id, jsonb_build_array(jsonb_build_object('carton_group_id', g.id, 'cartons', g.carton_qty)),
                                  'f1f00000-0000-0000-0000-000000000002')
  FROM freight_shipments s JOIN freight_carton_groups g ON g.freight_shipment_id = s.id
 WHERE s.shipment_number LIKE 'TPF-90%'
 ORDER BY s.shipment_number;
SELECT pg_temp.as_super();
SELECT ok((SELECT count(*) FROM wh_containers WHERE code LIKE 'C-TPF90%') = 11
          AND (SELECT sku_id IS NULL FROM wh_containers WHERE code = 'C-TPF905-001')
          AND (SELECT count(*) FROM wh_containers WHERE code LIKE 'C-TPF90%' AND location_id = pg_temp.loc('IN-01')) = 11,
          'F1 eleven cartons are checked in at IN-01, the 905 carton mixed');

-- check-in times; 902 is checked in before 904 although it landed later, so arrival decides
UPDATE wh_containers c SET created_at = x.t::timestamptz
  FROM (VALUES ('C-TPF901-001', '2026-09-26 10:00+00'), ('C-TPF901-002', '2026-09-26 10:01+00'),
               ('C-TPF902-001', '2026-09-30 08:00+00'), ('C-TPF902-002', '2026-09-30 08:01+00'),
               ('C-TPF903-001', '2026-09-21 10:00+00'), ('C-TPF903-002', '2026-09-21 10:01+00'),
               ('C-TPF904-001', '2026-10-02 10:05+00'), ('C-TPF904-002', '2026-10-02 10:00+00'),
               ('C-TPF905-001', '2026-09-02 10:00+00'),
               ('C-TPF906-001', '2026-09-20 15:00+00'), ('C-TPF906-002', '2026-09-20 15:05+00')) AS x(code, t)
 WHERE c.code = x.code;
UPDATE freight_receipts SET received_at = '2026-09-20 15:00+00' WHERE carton_group_id = 'f1f70000-0000-0000-0000-000000000006';
-- a finished-only carton of TPF-C
SELECT pg_temp.put('TPF-C', '87-01-1', 'C-TPFC-FIN', 'finished', 12);

-- =============================================================
-- S. Stamping the carton group's batch
-- =============================================================
SELECT is((SELECT factory_order_item_id::text FROM freight_carton_groups WHERE id = 'f1f70000-0000-0000-0000-000000000001'),
          'f1f40000-0000-0000-0000-000000000002', 'S1 the insert trigger stamps a one-SKU group from its shipment''s only line');
SELECT ok((SELECT factory_order_item_id IS NULL FROM freight_carton_groups WHERE id = 'f1f70000-0000-0000-0000-000000000003'),
          'S2 two orders of the SKU on one shipment leave the group unstamped');
SELECT ok(current_setting('wht.g5a', true) = 'f1f40000-0000-0000-0000-000000000001'
          AND (SELECT factory_order_item_id IS NULL FROM freight_carton_groups WHERE id = 'f1f70000-0000-0000-0000-000000000005'),
          'S3 a group stamped on its first SKU is cleared when a second SKU makes it mixed');
SELECT is(_wh_resolve_group_fo_item('f1f70000-0000-0000-0000-000000000004')::text, 'f1f40000-0000-0000-0000-000000000001',
          'S4 the resolver returns the line''s factory order item');

-- =============================================================
-- N. Next carton
-- =============================================================
SELECT pg_temp.as_user('f1f00000-0000-0000-0000-000000000003');
SELECT set_config('wht.n1', rpc_wh_next_cartons(ARRAY[pg_temp.sku('TPF-A'), pg_temp.sku('TPF-C'), pg_temp.sku('TPF-N'),
                                                      'f1f2ffff-0000-0000-0000-000000000000'::uuid])::text, true);
SELECT set_config('wht.na', (pg_temp.v('n1')->'next'->(pg_temp.sku('TPF-A')::text))::text, true);
SELECT is(pg_temp.v('na')->>'code', 'C-TPF904-002', 'N1 within one shipment the earlier check-in wins over the carton number');
SELECT ok(pg_temp.v('na')->>'reason' = 'oldest_batch' AND pg_temp.v('na')->>'factory_order_number' = 'TPF-FO-OLD'
          AND (SELECT max(created_at) FROM wh_containers WHERE code LIKE 'C-TPF901-%') < (SELECT min(created_at) FROM wh_containers WHERE code LIKE 'C-TPF904-%'),
          'N2 the older factory order wins although its cartons landed and were checked in later');
SELECT ok(pg_temp.v('na')->>'shipment_number' = 'TPF-904'
          AND (SELECT max(created_at) FROM wh_containers WHERE code LIKE 'C-TPF902-%') < (SELECT min(created_at) FROM wh_containers WHERE code LIKE 'C-TPF904-%'),
          'N3 within one order the shipment that landed first wins over an earlier check-in');
SELECT ok(pg_temp.v('na')->>'container_id' = pg_temp.ctr('C-TPF904-002')::text AND pg_temp.v('na')->>'state' = 'sealed'
          AND pg_temp.v('na')->>'bucket' = 'raw' AND (pg_temp.v('na')->>'qty')::int = 10
          AND pg_temp.v('na')->>'location_code' = 'IN-01' AND pg_temp.v('na')->>'location_id' = pg_temp.loc('IN-01')::text
          AND pg_temp.v('na')->>'order_date' = '2026-06-01'
          AND pg_temp.v('na')->>'factory_order_id' = 'f1f30000-0000-0000-0000-000000000001'
          AND pg_temp.v('na')->>'shipment_id' = 'f1f50000-0000-0000-0000-000000000004'
          AND pg_temp.v('na')->>'received_at' IS NOT NULL,
          'N4 the suggestion carries the carton, its bucket, quantity, location, order and shipment');
SELECT ok(pg_temp.v('n1')->'next'->(pg_temp.sku('TPF-C')::text) = 'null'::jsonb
          AND pg_temp.v('n1')->'next'->(pg_temp.sku('TPF-N')::text) = 'null'::jsonb
          AND pg_temp.v('n1')->'next'->'f1f2ffff-0000-0000-0000-000000000000' = 'null'::jsonb
          AND (SELECT count(*) FROM jsonb_object_keys(pg_temp.v('n1')->'next')) = 4,
          'N5 no raw stock, no cartons or an unknown id map to null');
SELECT is((rpc_wh_next_cartons(ARRAY(SELECT gen_random_uuid() FROM generate_series(1, 201)))->>'error'), 'too_many',
          'N6 at most 200 SKUs per call');

-- an open carton of the newer order beats every sealed one
SELECT rpc_wh_open_container(pg_temp.ctr('C-TPF901-001'));
SELECT ok(pg_temp.nx('TPF-A')->>'code' = 'C-TPF901-001' AND pg_temp.nx('TPF-A')->>'reason' = 'open_carton',
          'O1 an open carton is suggested before any sealed one');

-- =============================================================
-- T. Take to line
-- =============================================================
SELECT pg_temp.as_user('f1f00000-0000-0000-0000-000000000002');
SELECT set_config('wht.c0', rpc_wh_fifo_compliance(30)::text, true);
SELECT pg_temp.as_user('f1f00000-0000-0000-0000-000000000003');
SELECT set_config('wht.t1', rpc_wh_take_to_line(pg_temp.ctr('C-TPF902-001'))::text, true);
SELECT ok(pg_temp.v('t1')->>'error' = 'fifo_suggests' AND pg_temp.v('t1')->'suggested'->>'code' = 'C-TPF901-001'
          AND pg_temp.v('t1')->'suggested'->>'reason' = 'open_carton'
          AND pg_temp.v('t1')->'scanned'->>'code' = 'C-TPF902-001'
          AND pg_temp.v('t1')->'scanned'->>'factory_order_number' = 'TPF-FO-OLD'
          AND pg_temp.v('t1')->'scanned'->>'location_code' = 'IN-01'
          AND pg_temp.v('t1')->'scanned'->>'received_at' IS NOT NULL,
          'T1 scanning another carton returns fifo_suggests with the suggested and the scanned carton');
SELECT is(pg_temp.v('t1')->>'message', 'C-TPF902-001 is sealed; C-TPF901-001 in IN-01 is already open.',
          'T2 the message names the open carton and where it is');
SELECT ok((SELECT location_id = pg_temp.loc('IN-01') AND state = 'sealed' AND qty = 10 FROM wh_containers WHERE code = 'C-TPF902-001')
          AND NOT EXISTS (SELECT 1 FROM wh_inventory_movements WHERE type = 'move' AND from_container_id = pg_temp.ctr('C-TPF902-001'))
          AND NOT EXISTS (SELECT 1 FROM wh_fifo_deviations WHERE container_id = pg_temp.ctr('C-TPF902-001')),
          'T3 fifo_suggests changes nothing');
SELECT set_config('wht.t4', rpc_wh_take_to_line(pg_temp.ctr('C-TPF901-001'))::text, true);
SELECT ok(pg_temp.v('t4')->>'ok' = 'true' AND (pg_temp.v('t4')->>'units')::int = 10
          AND pg_temp.v('t4')->'fifo' = '{"followed": true, "suggested_code": "C-TPF901-001", "override": null}'::jsonb,
          'T4 taking the suggested carton succeeds with fifo.followed true');
SELECT is(pg_temp.nx('TPF-A')->>'code', 'C-TPF904-002', 'N7 an open carton at MFG-LINE is never suggested');
SELECT is((rpc_wh_take_to_line(pg_temp.ctr('C-TPF902-001')))->>'message',
          'C-TPF902-001 is newer; C-TPF904-002 in IN-01 is older.', 'T5 the message says which carton is older and where');
SELECT set_config('wht.t6', rpc_wh_take_to_line(pg_temp.ctr('C-TPF902-001'), NULL, NULL, 'Buried')::text, true);
SELECT ok(pg_temp.v('t6')->>'ok' = 'true'
          AND pg_temp.v('t6')->'fifo' = '{"followed": false, "suggested_code": "C-TPF904-002", "override": "buried"}'::jsonb
          AND (SELECT location_id FROM wh_containers WHERE code = 'C-TPF902-001') = pg_temp.loc('MFG-LINE'),
          'T6 with an override the carton goes to the line and fifo.followed is false');
SELECT ok((SELECT count(*) = 1 AND bool_and(d.sku_id = pg_temp.sku('TPF-A') AND d.suggested_container_id = pg_temp.ctr('C-TPF904-002')
                                           AND d.reason = 'buried' AND d.actor_id = 'f1f00000-0000-0000-0000-000000000003')
             FROM wh_fifo_deviations d WHERE d.container_id = pg_temp.ctr('C-TPF902-001')),
          'T7 the override records one deviation with the suggested carton, the reason and the worker');
SELECT ok((rpc_wh_take_to_line(pg_temp.ctr('C-TPF902-002'), NULL, NULL, 'lazy'))->>'error' = 'invalid_override'
          AND (SELECT location_id FROM wh_containers WHERE code = 'C-TPF902-002') = pg_temp.loc('IN-01'),
          'T8 any other override is invalid_override and changes nothing');
SELECT is((SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proname = 'rpc_wh_take_to_line'), 1, 'T9 rpc_wh_take_to_line has one overload');

-- void and empty cartons are never suggested
SELECT pg_temp.as_super();
UPDATE wh_containers SET state = 'void' WHERE code = 'C-TPF904-002';
SELECT pg_temp.as_user('f1f00000-0000-0000-0000-000000000003');
SELECT is(pg_temp.nx('TPF-A')->>'code', 'C-TPF904-001', 'V1 a void carton is never suggested');
SELECT pg_temp.as_super();
UPDATE wh_containers SET state = 'empty' WHERE code = 'C-TPF904-001';
SELECT pg_temp.as_user('f1f00000-0000-0000-0000-000000000003');
SELECT is(pg_temp.nx('TPF-A')->>'code', 'C-TPF902-002', 'V2 an empty carton is never suggested');
SELECT rpc_wh_take_to_line(pg_temp.ctr('C-TPF902-002'));
SELECT rpc_wh_take_to_line(pg_temp.ctr('C-TPF901-002'));
SELECT ok(pg_temp.nx('TPF-A')->>'code' = 'C-TPF903-001' AND pg_temp.nx('TPF-A')->>'reason' = 'oldest_received'
          AND pg_temp.nx('TPF-A')->>'factory_order_number' IS NULL,
          'R1 an unstamped group falls back to check-in (oldest_received)');
SELECT rpc_wh_take_to_line(pg_temp.ctr('C-TPF903-001'));
SELECT rpc_wh_take_to_line(pg_temp.ctr('C-TPF903-002'));
SELECT ok(pg_temp.nx('TPF-A') = 'null'::jsonb
          AND EXISTS (SELECT 1 FROM wh_inventory_balances WHERE container_id = pg_temp.ctr('C-TPF905-001')
                       AND sku_id = pg_temp.sku('TPF-A') AND bucket = 'raw' AND on_hand > 0),
          'M1 a mixed carton holding raw units of the SKU is never suggested');

-- =============================================================
-- C. Compliance
-- =============================================================
SELECT pg_temp.as_user('f1f00000-0000-0000-0000-000000000002');
SELECT set_config('wht.c1', rpc_wh_fifo_compliance(30)::text, true);
SELECT ok((pg_temp.v('c1')->>'pulls')::int - (pg_temp.v('c0')->>'pulls')::int = 6
          AND (pg_temp.v('c1')->>'followed')::int - (pg_temp.v('c0')->>'followed')::int = 5
          AND (pg_temp.v('c1')->'deviations'->>'buried')::int - (pg_temp.v('c0')->'deviations'->>'buried')::int = 1
          AND (pg_temp.v('c1')->'deviations'->>'damaged')::int = (pg_temp.v('c0')->'deviations'->>'damaged')::int,
          'C1 six pulls, five followed, one buried');
SELECT pg_temp.as_user('f1f00000-0000-0000-0000-000000000003');
SELECT ok((rpc_wh_fifo_compliance(30))->>'error' = 'forbidden', 'C2 a floor user cannot read compliance');
SELECT pg_temp.as_user('f1f00000-0000-0000-0000-000000000002');
SELECT is((rpc_wh_fifo_compliance(0))->>'error', 'invalid_days', 'C3 the window is at least one day');

-- =============================================================
-- P. Carton passport
-- =============================================================
SELECT pg_temp.as_super();
INSERT INTO audit_logs (actor_id, action, target_table, target_id, details, created_at)
VALUES ('f1f00000-0000-0000-0000-000000000001', 'factory_order.advance', 'factory_orders', 'f1f30000-0000-0000-0000-000000000003',
        '{"from":"in_production","to":"finished"}'::jsonb, '2026-08-15 00:00+00');
SELECT pg_temp.as_user('f1f00000-0000-0000-0000-000000000003');
SELECT rpc_wh_putaway_container(pg_temp.ctr('C-TPF906-001'), pg_temp.loc('86-01-1'));
SELECT rpc_wh_take_to_line(pg_temp.ctr('C-TPF906-001'));
-- the line empties the raw carton and RTS's its contents (the ledger mirror's job)
SELECT pg_temp.as_super();
SELECT _wh_post_movement(gen_random_uuid(), 'bucket_convert', pg_temp.sku('TPF-P'), 'raw', 10,
                         pg_temp.loc('MFG-LINE'), pg_temp.ctr('C-TPF906-001'), pg_temp.loc('MFG-LINE'), NULL, 'finished',
                         'f1f00000-0000-0000-0000-000000000003', NULL, NULL, 'test: emptied, filled and RTS');
SELECT pg_temp.as_user('f1f00000-0000-0000-0000-000000000003');
SELECT rpc_wh_rts_relabel(pg_temp.sku('TPF-P'), '[{"qty":5,"state":"sealed"},{"qty":5,"state":"sealed"}]'::jsonb,
                          pg_temp.ctr('C-TPF906-001'));

SELECT is((rpc_wh_carton_passport('C-NOPE-404'))->>'error', 'carton_not_found', 'P0 an unknown code is carton_not_found');
SELECT set_config('wht.pp', rpc_wh_carton_passport(' c-tpf906-001 ')::text, true);
SELECT set_config('wht.tl', (pg_temp.v('pp')->'timeline')::text, true);
SELECT ok(pg_temp.v('pp')->>'ok' = 'true' AND pg_temp.v('pp')->'carton'->>'code' = 'C-TPF906-001'
          AND pg_temp.v('pp')->'carton'->>'state' = 'void' AND pg_temp.v('pp')->'carton'->>'sku' = 'TPF-P'
          AND (pg_temp.v('pp')->'carton'->>'carton_seq')::int = 1 AND (pg_temp.v('pp')->'carton'->>'carton_of')::int = 2,
          'P1 the code matches case-insensitively and the carton is described');
SELECT ok(pg_temp.pos(pg_temp.v('tl'), 'checked_in') < pg_temp.pos(pg_temp.v('tl'), 'putaway')
          AND pg_temp.pos(pg_temp.v('tl'), 'putaway') < pg_temp.pos(pg_temp.v('tl'), 'pulled')
          AND pg_temp.pos(pg_temp.v('tl'), 'pulled') < pg_temp.pos(pg_temp.v('tl'), 'relabel'),
          'P2 check-in, putaway, pull to the line and relabel appear in that order');
SELECT ok(pg_temp.has_title(pg_temp.v('tl'), 'Ordered · TPF-FO-P') AND pg_temp.has_title(pg_temp.v('tl'), 'Finished')
          AND pg_temp.has_title(pg_temp.v('tl'), 'Shipped · TPF-906') AND pg_temp.has_title(pg_temp.v('tl'), 'Delivered')
          AND pg_temp.has_title(pg_temp.v('tl'), 'Put away · 86-01-1') AND pg_temp.has_title(pg_temp.v('tl'), 'Pulled to the line')
          AND pg_temp.has_title(pg_temp.v('tl'), 'Manufacturing step')
          AND pg_temp.has_title(pg_temp.v('tl'), 'Relabelled · C-TPF906-001R1')
          AND pg_temp.has_title(pg_temp.v('tl'), 'Relabelled · C-TPF906-001R2')
          AND pg_temp.has_title(pg_temp.v('tl'), 'Putaway task opened'),
          'P3 the timeline names the order, its status, the shipment, putaway, pull, line and both children');
SELECT ok(EXISTS (SELECT 1 FROM jsonb_array_elements(pg_temp.v('tl')) e(x)
                   WHERE e.x->>'kind' = 'checked_in' AND e.x->>'title' = 'Checked in' AND e.x->>'actor_name' = 'Mia Manager'
                     AND e.x->>'detail' = 'TPF-906 · 2 cartons' AND (e.x->>'at')::timestamptz = '2026-09-20 15:00+00')
          AND (SELECT count(*) FROM jsonb_array_elements(pg_temp.v('tl')) e(x) WHERE e.x->>'kind' = 'checked_in') = 1
          AND pg_temp.pos(pg_temp.v('tl'), 'labels') IS NOT NULL,
          'P4 the carton''s receipt is one check-in entry with who received it; its labels are listed');
SELECT ok(pg_temp.v('tl')->0->>'kind' = 'ordered'
          AND NOT EXISTS (SELECT 1 FROM (SELECT (e.x->>'at')::timestamptz AS at,
                                                lag((e.x->>'at')::timestamptz) OVER (ORDER BY e.n) AS prev
                                           FROM jsonb_array_elements(pg_temp.v('tl')) WITH ORDINALITY AS e(x, n)) s
                           WHERE s.at < s.prev),
          'P5 the timeline is oldest first, starting with the order');
SELECT ok((pg_temp.v('pp')->'legs'->>'order_to_finished_days')::numeric = 45
          AND (pg_temp.v('pp')->'legs'->>'finished_to_shipped_days')::numeric = 5
          AND (pg_temp.v('pp')->'legs'->>'water_days')::numeric = 30
          AND (pg_temp.v('pp')->'legs'->>'arrival_to_checkin_days')::numeric = 1.6
          AND (pg_temp.v('pp')->'legs'->>'checkin_to_shelf_minutes')::numeric > 0
          AND (pg_temp.v('pp')->'legs'->>'shelf_to_line_days')::numeric = 0
          AND (pg_temp.v('pp')->'legs'->>'line_to_rts_days')::numeric = 0,
          'P6 legs: 45 days to finished, 5 to shipped, 30 on the water, 1.6 to check-in, then shelf, line and RTS');
SELECT ok(pg_temp.v('pp')->'batch'->'factory_order'->>'order_number' = 'TPF-FO-P'
          AND pg_temp.v('pp')->'batch'->'factory_order'->>'supplier_name' = 'FIFO Test Supplier'
          AND pg_temp.v('pp')->'batch'->'factory_order'->>'order_date' = '2026-07-01'
          AND pg_temp.v('pp')->'batch'->'shipment'->>'shipment_number' = 'TPF-906'
          AND pg_temp.v('pp')->'batch'->'shipment'->>'actual_arrival_date' = '2026-09-19'
          AND (pg_temp.v('pp')->'batch'->'item'->>'quantity_ordered')::int = 20,
          'P7 the batch is the factory order, its supplier, the item and the shipment');
SELECT ok(pg_temp.v('pp')->'batch'->'summary'
            = '{"cartons_received": 2, "cartons_short": 0, "finished": 1, "raw_on_shelf": 1, "at_the_line": 0, "broken_units": 0}'::jsonb,
          'P8 the batch summary: two received, one finished, one raw on the shelf');
SELECT ok((pg_temp.v('pp')->'batch'->>'siblings_total')::int = 1
          AND jsonb_array_length(pg_temp.v('pp')->'batch'->'siblings') = 1
          AND pg_temp.v('pp')->'batch'->'siblings'->0->>'code' = 'C-TPF906-002'
          AND pg_temp.v('pp')->'batch'->'siblings'->0->>'location_code' = 'IN-01'
          AND pg_temp.v('pp')->'batch'->'siblings'->0->>'since' IS NOT NULL,
          'P9 the sibling carton is listed with where it sits');
SELECT ok(jsonb_array_length(pg_temp.v('pp')->'carton'->'children') = 2
          AND pg_temp.v('pp')->'carton'->'children'->0->>'code' = 'C-TPF906-001R1'
          AND pg_temp.v('pp')->'carton'->'children'->1->>'location_code' = 'MFG-LINE'
          AND pg_temp.v('pp')->'carton'->'superseded_by'->>'code' = 'C-TPF906-001R1'
          AND pg_temp.v('pp')->'carton'->'parent' = 'null'::jsonb,
          'P10 the relabelled parent lists its children and the carton that superseded it');
SELECT set_config('wht.ch', rpc_wh_carton_passport('C-TPF906-001R2')::text, true);
SELECT ok(pg_temp.v('ch')->'carton'->'parent' = jsonb_build_object('id', pg_temp.ctr('C-TPF906-001'), 'code', 'C-TPF906-001', 'state', 'void')
          AND pg_temp.v('ch')->'carton'->>'label_stock' = 'green'
          AND pg_temp.v('ch')->'carton'->>'finished_by_name' = 'Devon Floor'
          AND pg_temp.v('ch')->'batch'->'factory_order'->>'order_number' = 'TPF-FO-P'
          AND (pg_temp.v('ch')->'batch'->>'siblings_total')::int = 1
          AND pg_temp.has_title(pg_temp.v('ch')->'timeline', 'Relabelled from · C-TPF906-001')
          AND (pg_temp.v('ch')->'legs'->>'line_to_rts_days') IS NOT NULL,
          'P11 the child shows its parent, inherits the batch and has its relabel in the timeline');

SELECT * FROM finish();
ROLLBACK;
