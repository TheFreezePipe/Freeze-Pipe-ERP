-- =============================================================
-- Warehouse module Phase 1, slice 4E test suite (pgTAP): ledger mirror,
-- ship settlement, nightly reconcile, count scheduler, daily report key,
-- printer RPCs
-- =============================================================
-- Covers migrations 20261027000001 (wh_ledger_sync), 20261027000002
-- (wh_reconcile) and 20261027000003 (wh_printers_rpc). Synthetic fixtures
-- only (SKUs TP4-*, rack T88 with faces 88 RTS and 89 RAW, shipments and
-- orders TP4E-*); everything rolls back.
-- Run with: supabase test db
--
-- Areas tested:
--   A. The mirror is dormant with live_since null or in the future, active
--      once it has passed; a ledger row dated before live_since is ignored;
--      rpc_wh_set_setting validates live_since
--   B. Manufacturing: emptying draws raw from the carton taken to the line
--      and credits in_production loose; past the carton the loose raw goes
--      negative; RTS credits finished loose at the line; filling_capping
--      posts nothing; breakage and a Stock Levels cycle count post at
--      UNLOCATED
--   C. wh.mirror_skip: an LPN receipt lands once; a receipt with minting
--      off posts loose at IN-01 with a putaway task (and a reversal takes
--      it back); a count approval posts once with the flag on
--   D. Ship settlement: from an open carton, then a sealed one (opened),
--      never from overflow, a shortfall to UNLOCATED with a reconcile
--      count, idempotent on repeat and on a re-ingest; an order shipped
--      before go-live is never settled
--   E. Reconcile: P − O = L on consistent SKUs, H on a cancelled order, a
--      non-zero residual with counts capped per SKU and no duplicates, a
--      residual from dormant ledger rows, other buckets R = P − L,
--      rts_unplaced, role gate
--   F. rpc_daily_report's warehouse key
--   G. rpc_wh_schedule_counts: ABC cadence, most overdue first, daily cap,
--      no duplicates
--   H. Printers: save, validation, stale row_version, delete with and
--      without jobs; rpc_wh_request_labels p_target browser under a
--      station session

BEGIN;

SELECT plan(63);

-- Staging may carry live printers; routing prefers an active station printer.
UPDATE wh_printers SET active = false;
UPDATE wh_settings SET value = '{"mode":"live"}'::jsonb WHERE key = 'outbound';
UPDATE wh_settings SET value = value || '{"live_since": null, "mint_lpns": false}'::jsonb WHERE key = 'physical_layer';
UPDATE wh_settings SET value = '{"create_counts": true, "max_counts_per_sku": 2}'::jsonb WHERE key = 'reconcile';

-- =============================================================
-- Fixtures
-- =============================================================
INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change, is_sso_user, is_anonymous)
SELECT '00000000-0000-0000-0000-000000000000', x.id, 'authenticated', 'authenticated', x.email, '', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', '', false, false
  FROM (VALUES
   ('c4e00000-0000-0000-0000-000000000001'::uuid, 'wh4e-admin@test.local'),
   ('c4e00000-0000-0000-0000-000000000002', 'wh4e-manager@test.local'),
   ('c4e00000-0000-0000-0000-000000000003', 'wh4e-user@test.local')) AS x(id, email)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE profiles DISABLE TRIGGER USER;
INSERT INTO profiles (id, email, full_name, role, is_active, supplier_id, is_print_agent) VALUES
  ('c4e00000-0000-0000-0000-000000000001', 'wh4e-admin@test.local',   'Ada Admin',   'admin',   true, NULL, false),
  ('c4e00000-0000-0000-0000-000000000002', 'wh4e-manager@test.local', 'Mia Manager', 'manager', true, NULL, false),
  ('c4e00000-0000-0000-0000-000000000003', 'wh4e-user@test.local',    'Devon Floor', 'user',    true, NULL, false)
ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, is_active = true, supplier_id = NULL, full_name = EXCLUDED.full_name;
ALTER TABLE profiles ENABLE TRIGGER USER;

INSERT INTO product_skus (id, sku, product_name, category, display_category, standard_quantity_per_carton, abc_classification) VALUES
  ('c4e10000-0000-0000-0000-000000000001', 'TP4-S',  'Test settle S',      'non_fillable', 'Accessories', 12, NULL),
  ('c4e10000-0000-0000-0000-000000000002', 'TP4-M',  'Test line M',        'fillable',     'Pipes',       10, NULL),
  ('c4e10000-0000-0000-0000-000000000003', 'TP4-R1', 'Test consistent R1', 'non_fillable', 'Accessories', 12, NULL),
  ('c4e10000-0000-0000-0000-000000000004', 'TP4-R2', 'Test broken R2',     'non_fillable', 'Accessories', 12, NULL),
  ('c4e10000-0000-0000-0000-000000000005', 'TP4-A',  'Test class A',       'non_fillable', 'Accessories', 12, 'A'),
  ('c4e10000-0000-0000-0000-000000000006', 'TP4-B',  'Test class B',       'non_fillable', 'Accessories', 12, 'B'),
  ('c4e10000-0000-0000-0000-000000000007', 'TP4-C',  'Test unclassified',  'non_fillable', 'Accessories', 12, NULL),
  ('c4e10000-0000-0000-0000-000000000008', 'TP4-F',  'Test freight F',     'non_fillable', 'Accessories', 12, NULL),
  ('c4e10000-0000-0000-0000-000000000009', 'TP4-D',  'Test dormant D',     'non_fillable', 'Accessories', 12, NULL);
-- the books start where the shelves are, except TP4-R2 (5 short) and TP4-M raw (1 over)
UPDATE inventory_levels SET warehouse_finished = 27 WHERE sku_id = 'c4e10000-0000-0000-0000-000000000001';
UPDATE inventory_levels SET warehouse_raw = 11      WHERE sku_id = 'c4e10000-0000-0000-0000-000000000002';
UPDATE inventory_levels SET warehouse_finished = 12 WHERE sku_id = 'c4e10000-0000-0000-0000-000000000003';
UPDATE inventory_levels SET warehouse_finished = 15 WHERE sku_id = 'c4e10000-0000-0000-0000-000000000004';
UPDATE inventory_levels SET warehouse_finished = 9  WHERE sku_id = 'c4e10000-0000-0000-0000-000000000005';
UPDATE inventory_levels SET warehouse_finished = 11 WHERE sku_id = 'c4e10000-0000-0000-0000-000000000006';
UPDATE inventory_levels SET warehouse_finished = 5  WHERE sku_id = 'c4e10000-0000-0000-0000-000000000007';

INSERT INTO freight_shipments (id, shipment_number, freight_type, status) VALUES
  ('c4e20000-0000-0000-0000-000000000001', 'TP4E-901', 'sea', 'tracking'),
  ('c4e20000-0000-0000-0000-000000000002', 'TP4E-902', 'air', 'tracking');
INSERT INTO freight_line_items (id, freight_shipment_id, sku_id, quantity) VALUES
  ('c4e40000-0000-0000-0000-000000000001', 'c4e20000-0000-0000-0000-000000000001', 'c4e10000-0000-0000-0000-000000000008', 24),
  ('c4e40000-0000-0000-0000-000000000002', 'c4e20000-0000-0000-0000-000000000002', 'c4e10000-0000-0000-0000-000000000008', 10);
INSERT INTO freight_carton_groups (id, freight_shipment_id, carton_qty, sort_order) VALUES
  ('c4e30000-0000-0000-0000-000000000001', 'c4e20000-0000-0000-0000-000000000001', 2, 0);
INSERT INTO freight_carton_group_skus (carton_group_id, sku_id, units_total, created_at) VALUES
  ('c4e30000-0000-0000-0000-000000000001', 'c4e10000-0000-0000-0000-000000000008', 24, now());

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
-- units of a SKU at a location in a bucket (all containers, or loose only)
CREATE OR REPLACE FUNCTION pg_temp.bal(p_sku text, p_loc text, p_bucket text) RETURNS integer LANGUAGE sql AS $$
  SELECT COALESCE(sum(b.on_hand), 0)::int FROM wh_inventory_balances b
   WHERE b.sku_id = (SELECT id FROM product_skus WHERE sku = p_sku)
     AND b.location_id = (SELECT id FROM wh_locations WHERE code = p_loc) AND b.bucket = p_bucket;
$$;
CREATE OR REPLACE FUNCTION pg_temp.loose(p_sku text, p_loc text, p_bucket text) RETURNS integer LANGUAGE sql AS $$
  SELECT COALESCE(sum(b.on_hand), 0)::int FROM wh_inventory_balances b
   WHERE b.sku_id = (SELECT id FROM product_skus WHERE sku = p_sku)
     AND b.location_id = (SELECT id FROM wh_locations WHERE code = p_loc) AND b.bucket = p_bucket AND b.container_id IS NULL;
$$;
-- opening stock: loose units, or a sealed carton holding them
CREATE OR REPLACE FUNCTION pg_temp.put(p_sku text, p_loc text, p_ctr text, p_bucket text, p_qty integer) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_ctr uuid;
BEGIN
  IF p_ctr IS NOT NULL THEN
    INSERT INTO wh_containers (code, sku_id, qty_initial, qty, state, location_id, source, created_by)
    VALUES (p_ctr, pg_temp.sku(p_sku), p_qty, 0, 'sealed', pg_temp.loc(p_loc), 'manual', 'c4e00000-0000-0000-0000-000000000001')
    RETURNING id INTO v_ctr;
  END IF;
  PERFORM _wh_post_movement(gen_random_uuid(), 'opening_balance', pg_temp.sku(p_sku), p_bucket, p_qty, NULL, NULL,
                            pg_temp.loc(p_loc), v_ctr, NULL, 'c4e00000-0000-0000-0000-000000000001', NULL, NULL, 'test fixture');
END; $$;
-- the newest ledger row of a SKU
CREATE OR REPLACE FUNCTION pg_temp.last_tx(p_sku text) RETURNS uuid LANGUAGE sql AS $$
  SELECT id FROM inventory_transactions WHERE sku_id = (SELECT id FROM product_skus WHERE sku = p_sku) ORDER BY seq DESC LIMIT 1;
$$;
CREATE OR REPLACE FUNCTION pg_temp.settled(p_order uuid) RETURNS integer LANGUAGE sql AS $$
  SELECT settled_units FROM wh_order_settlements WHERE shipstation_order_id = p_order;
$$;
CREATE OR REPLACE FUNCTION pg_temp.line(p_sku text, p_bucket text) RETURNS wh_reconcile_lines LANGUAGE sql AS $$
  SELECT * FROM wh_reconcile_lines
   WHERE run_id = (pg_temp.v('rec')->>'run_id')::uuid AND sku_id = (SELECT id FROM product_skus WHERE sku = p_sku) AND bucket = p_bucket;
$$;

-- capture wh.mirror_skip as each ledger row lands
CREATE TEMP TABLE mirror_flags (tx_id uuid, tx_type text, flag text) ON COMMIT DROP;
GRANT ALL ON mirror_flags TO PUBLIC;
CREATE OR REPLACE FUNCTION pg_temp.capture_mirror_flag() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO mirror_flags VALUES (NEW.id, NEW.transaction_type, current_setting('wh.mirror_skip', true));
  RETURN NEW;
END; $$;
CREATE TRIGGER zz_test_capture_mirror_flag AFTER INSERT ON inventory_transactions
  FOR EACH ROW EXECUTE FUNCTION pg_temp.capture_mirror_flag();

-- rack T88: face 88 RTS (levels 1-2 pickable, 3 overflow), face 89 RAW
SELECT pg_temp.as_user('c4e00000-0000-0000-0000-000000000001');
SELECT set_config('wht.layout', rpc_wh_save_layout('{
  "templates":[{"code":"T4E-PR","name":"Test 4E pallet rack","kind":"pallet_rack","bays":3,"levels":3,
                "bay_width_mm":2743,"depth_mm":1067,"level_heights_mm":[0,1372,2743],
                "overflow_top_level":true,"capacity_cartons_per_level":4}],
  "racks":[{"code":"T88","template_code":"T4E-PR","x_mm":3000,"y_mm":3000,"rot_deg":90}],
  "faces":[{"rack_code":"T88","face_code":"88","side":"east","aisle":"X","walk_pass":77,"walk_dir":"S","zone_by_bay":["RTS"]},
           {"rack_code":"T88","face_code":"89","side":"west","aisle":"W","walk_pass":78,"walk_dir":"N","zone_by_bay":["RAW"]}]
}'::jsonb)::text, true);
SELECT rpc_wh_generate_locations((SELECT id FROM wh_racks WHERE code = 'T88'), false);
SELECT is((SELECT count(*)::int FROM wh_locations WHERE face IN ('88', '89')), 18, 'F0 the test rack has 18 bay-levels');

SELECT pg_temp.as_super();
SELECT pg_temp.put('TP4-S',  '88-01-3', 'C-TP4E-OVF', 'finished', 12);   -- overflow, never drawn
SELECT pg_temp.put('TP4-S',  '88-01-1', 'C-TP4E-OPN', 'finished', 3);    -- open carton on a pick face
UPDATE wh_containers SET state = 'open', opened_at = now() WHERE code = 'C-TP4E-OPN';
SELECT pg_temp.put('TP4-S',  '88-02-1', 'C-TP4E-SLD', 'finished', 12);   -- sealed carton on a pick face
SELECT pg_temp.put('TP4-R2', '88-01-2', NULL, 'finished', 8);
SELECT pg_temp.put('TP4-R2', '88-02-2', NULL, 'finished', 7);
SELECT pg_temp.put('TP4-R2', '88-03-2', NULL, 'finished', 5);
SELECT pg_temp.put('TP4-R1', '88-03-1', NULL, 'finished', 10);
SELECT pg_temp.put('TP4-M',  '89-01-1', 'C-TP4E-RAW', 'raw', 10);
SELECT pg_temp.put('TP4-A',  '89-01-2', NULL, 'finished', 5);
SELECT pg_temp.put('TP4-B',  '89-01-2', NULL, 'finished', 5);
SELECT pg_temp.put('TP4-B',  '89-02-1', NULL, 'finished', 6);
SELECT pg_temp.put('TP4-C',  '89-02-2', NULL, 'finished', 3);
SELECT pg_temp.put('TP4-C',  '89-03-1', NULL, 'finished', 2);
SELECT pg_temp.put('TP4-A',  '89-03-2', NULL, 'finished', 4);

-- =============================================================
-- A. Dormant until live_since has passed
-- =============================================================
SELECT rpc_cycle_count(pg_temp.sku('TP4-D'), 'warehouse_finished', 2, 'test', NULL, 'c4e00000-0000-0000-0000-000000000001');
SELECT ok(NOT EXISTS (SELECT 1 FROM wh_inventory_movements WHERE sku_id = pg_temp.sku('TP4-D')),
          'A1 with live_since null a Stock Levels count posts nothing physical');

SELECT pg_temp.as_user('c4e00000-0000-0000-0000-000000000001');
SELECT set_config('wht.future', rpc_wh_set_setting('physical_layer',
  jsonb_build_object('enabled', false, 'mint_lpns', false, 'live_since', to_jsonb(now() + interval '1 day')))::text, true);
SELECT pg_temp.as_super();
SELECT rpc_cycle_count(pg_temp.sku('TP4-D'), 'warehouse_finished', 4, 'test', NULL, 'c4e00000-0000-0000-0000-000000000001');
SELECT ok(pg_temp.v('future')->>'ok' = 'true'
          AND NOT EXISTS (SELECT 1 FROM wh_inventory_movements WHERE sku_id = pg_temp.sku('TP4-D')),
          'A2 a live_since in the future keeps the mirror dormant');

SELECT pg_temp.as_user('c4e00000-0000-0000-0000-000000000001');
SELECT is((rpc_wh_set_setting('physical_layer', '{"live_since":"nope"}'::jsonb))->>'error', 'invalid_value',
          'A3 live_since must be an ISO timestamp or null');
SELECT set_config('wht.live', rpc_wh_set_setting('physical_layer',
  jsonb_build_object('enabled', false, 'mint_lpns', false, 'live_since', to_jsonb(now() - interval '1 hour')))::text, true);
SELECT pg_temp.as_super();
SELECT rpc_cycle_count(pg_temp.sku('TP4-D'), 'warehouse_finished', 3, 'test', NULL, 'c4e00000-0000-0000-0000-000000000001');
SELECT is(pg_temp.bal('TP4-D', 'UNLOCATED', 'finished'), 3, 'A4 once live, a Stock Levels count of +3 lands at UNLOCATED');
SELECT ok(EXISTS (SELECT 1 FROM wh_inventory_movements
                   WHERE ledger_tx_id = pg_temp.last_tx('TP4-D') AND type = 'ledger_mirror' AND qty = 3
                     AND from_location_id IS NULL AND to_location_id = pg_temp.loc('UNLOCATED')),
          'A5 the mirror movement carries the ledger row it mirrors');
WITH i AS (
  INSERT INTO inventory_transactions (sku_id, transaction_type, quantity, field_affected, movement_kind, notes, performed_by, created_at)
  VALUES (pg_temp.sku('TP4-D'), 'cycle_count', 1, 'warehouse_finished', 'net_change', 'test: dated before go-live',
          'c4e00000-0000-0000-0000-000000000001', now() - interval '2 hours')
  RETURNING id)
SELECT set_config('wht.old_tx', to_jsonb(id)::text, true) FROM i;
SELECT ok(NOT EXISTS (SELECT 1 FROM wh_inventory_movements WHERE ledger_tx_id = (pg_temp.v('old_tx')#>>'{}')::uuid),
          'A6 a ledger row dated before live_since is ignored');

-- =============================================================
-- B. Manufacturing: the line draws from the carton taken to it
-- =============================================================
SELECT pg_temp.as_user('c4e00000-0000-0000-0000-000000000003');
SELECT set_config('wht.ttl', rpc_wh_take_to_line(pg_temp.ctr('C-TP4E-RAW'))::text, true);
SELECT ok(pg_temp.v('ttl')->>'units' = '10' AND pg_temp.bal('TP4-M', 'MFG-LINE', 'raw') = 10,
          'B0 the raw carton and its 10 units are at the line');
SELECT set_config('wht.b1', rpc_log_task_completion(pg_temp.sku('TP4-M'), 'emptying', 6, 'test', 'c4e00000-0000-0000-0000-000000000003')::text, true);
SELECT ok(pg_temp.v('b1')->>'ok' = 'true'
          AND (SELECT qty = 4 AND state = 'open' FROM wh_containers WHERE code = 'C-TP4E-RAW')
          AND pg_temp.loose('TP4-M', 'MFG-LINE', 'in_production') = 6,
          'B1 emptying 6 draws raw from the carton at the line and credits in_production loose');
SELECT ok(EXISTS (SELECT 1 FROM wh_inventory_movements m
                   WHERE m.type = 'bucket_convert' AND m.from_container_id = pg_temp.ctr('C-TP4E-RAW') AND m.to_container_id IS NULL
                     AND m.bucket = 'raw' AND m.to_bucket = 'in_production' AND m.qty = 6
                     AND m.reference_type = 'task_log' AND m.reference_id = (pg_temp.v('b1')->>'task_log_id')::uuid
                     AND m.ledger_tx_id = (SELECT id FROM inventory_transactions WHERE reference_id = (pg_temp.v('b1')->>'task_log_id')::uuid)),
          'B2 the bucket_convert references the task log and its ledger row');
-- a second emptying log needs its own completion time (task_logs is unique per worker, SKU, type and time)
SELECT rpc_log_task_completion(pg_temp.sku('TP4-M'), 'emptying', 5, 'test', 'c4e00000-0000-0000-0000-000000000003',
                               NULL, now() + interval '1 minute');
SELECT ok((SELECT qty = 0 AND state = 'empty' FROM wh_containers WHERE code = 'C-TP4E-RAW')
          AND pg_temp.loose('TP4-M', 'MFG-LINE', 'raw') = -1 AND pg_temp.loose('TP4-M', 'MFG-LINE', 'in_production') = 11,
          'B3 past the carton the line goes negative on loose raw: the cue that a carton was not scanned');
SELECT rpc_log_task_completion(pg_temp.sku('TP4-M'), 'rtsing', 5, 'test', 'c4e00000-0000-0000-0000-000000000003');
SELECT is(pg_temp.loose('TP4-M', 'MFG-LINE', 'finished'), 5, 'B4 the RTS output lands as loose finished units at the line');
SELECT set_config('wht.b5', rpc_log_task_completion(pg_temp.sku('TP4-M'), 'filling_capping', 2, 'test', 'c4e00000-0000-0000-0000-000000000003')::text, true);
SELECT ok(NOT EXISTS (SELECT 1 FROM wh_inventory_movements m JOIN inventory_transactions x ON x.id = m.ledger_tx_id
                       WHERE x.reference_id = (pg_temp.v('b5')->>'task_log_id')::uuid),
          'B5 filling and capping changes no bucket and posts nothing');
SELECT rpc_log_task_completion(pg_temp.sku('TP4-M'), 'breakage', 1, 'test', 'c4e00000-0000-0000-0000-000000000003');
SELECT is(pg_temp.bal('TP4-M', 'UNLOCATED', 'finished'), -1, 'B6 a breakage write-off posts at UNLOCATED');
SELECT pg_temp.as_super();
SELECT rpc_cycle_count(pg_temp.sku('TP4-M'), 'warehouse_finished', 3, 'test', NULL, 'c4e00000-0000-0000-0000-000000000001');
SELECT is(pg_temp.bal('TP4-M', 'UNLOCATED', 'finished'), 2, 'B7 a Stock Levels cycle count posts at UNLOCATED');

-- =============================================================
-- C. wh.mirror_skip: explicit postings are not mirrored twice
-- =============================================================
UPDATE wh_settings SET value = value || '{"mint_lpns": true}'::jsonb WHERE key = 'physical_layer';
SELECT pg_temp.as_user('c4e00000-0000-0000-0000-000000000002');
SELECT set_config('wht.c1', rpc_record_freight_receipt('c4e20000-0000-0000-0000-000000000001',
  '[{"carton_group_id":"c4e30000-0000-0000-0000-000000000001","cartons":2}]'::jsonb,
  'c4e00000-0000-0000-0000-000000000002')::text, true);
SELECT ok(pg_temp.v('c1')->>'ok' = 'true' AND jsonb_array_length(pg_temp.v('c1')->'lpns') = 2
          AND pg_temp.bal('TP4-F', 'IN-01', 'finished') = 24,
          'C1 an LPN receipt of 24 lands at IN-01 once');
SELECT ok(NOT EXISTS (SELECT 1 FROM wh_inventory_movements m JOIN inventory_transactions x ON x.id = m.ledger_tx_id
                       WHERE x.transaction_type = 'freight_delivered' AND x.reference_id = 'c4e20000-0000-0000-0000-000000000001')
          AND EXISTS (SELECT 1 FROM mirror_flags WHERE tx_type = 'freight_delivered' AND flag = 'on'),
          'C2 its ledger credit lands with wh.mirror_skip on and is not mirrored');
SELECT pg_temp.as_super();
UPDATE wh_settings SET value = value || '{"mint_lpns": false}'::jsonb WHERE key = 'physical_layer';
SELECT pg_temp.as_user('c4e00000-0000-0000-0000-000000000002');
SELECT rpc_record_freight_receipt('c4e20000-0000-0000-0000-000000000002',
  '[{"line_item_id":"c4e40000-0000-0000-0000-000000000002","units":5}]'::jsonb, 'c4e00000-0000-0000-0000-000000000002');
SELECT ok(pg_temp.loose('TP4-F', 'IN-01', 'finished') = 5
          AND (SELECT qty FROM wh_moves WHERE kind = 'putaway' AND status = 'open' AND sku_id = pg_temp.sku('TP4-F')
                AND source_id = 'c4e20000-0000-0000-0000-000000000002') = 5,
          'C3 a receipt with minting off is mirrored loose at IN-01 with a putaway task');
SELECT rpc_record_freight_receipt('c4e20000-0000-0000-0000-000000000002',
  '[{"line_item_id":"c4e40000-0000-0000-0000-000000000002","units":-2}]'::jsonb, 'c4e00000-0000-0000-0000-000000000002');
SELECT ok(pg_temp.loose('TP4-F', 'IN-01', 'finished') = 3
          AND (SELECT qty FROM wh_moves WHERE kind = 'putaway' AND status = 'open' AND sku_id = pg_temp.sku('TP4-F')
                AND source_id = 'c4e20000-0000-0000-0000-000000000002') = 3,
          'C4 a receipt correction takes the units back from IN-01 and shrinks the task');
SELECT pg_temp.as_user('c4e00000-0000-0000-0000-000000000003');
SELECT set_config('wht.cnt', rpc_wh_record_count(pg_temp.loc('88-03-1'),
  '[{"sku_id":"c4e10000-0000-0000-0000-000000000003","counted_qty":9}]'::jsonb)::text, true);
SELECT pg_temp.as_user('c4e00000-0000-0000-0000-000000000002');
SELECT set_config('wht.appr', rpc_wh_approve_variance((pg_temp.v('cnt')->>'count_task_id')::uuid, '[]'::jsonb)::text, true);
SELECT ok(pg_temp.v('appr')->>'adjusted_units' = '1'
          AND (SELECT flag FROM mirror_flags f JOIN inventory_transactions x ON x.id = f.tx_id
                WHERE x.transaction_type = 'wh_count_adjust' AND x.reference_id = (pg_temp.v('cnt')->>'count_task_id')::uuid) = 'on'
          AND (SELECT count(*) FROM wh_inventory_movements m JOIN inventory_transactions x ON x.id = m.ledger_tx_id
                WHERE x.reference_id = (pg_temp.v('cnt')->>'count_task_id')::uuid) = 1
          AND (SELECT m.type FROM wh_inventory_movements m JOIN inventory_transactions x ON x.id = m.ledger_tx_id
                WHERE x.reference_id = (pg_temp.v('cnt')->>'count_task_id')::uuid) = 'count_adjust',
          'C5 a count approval writes its ledger row with the flag on and posts exactly once');

-- =============================================================
-- D. Ship settlement
-- =============================================================
SELECT pg_temp.as_super();
INSERT INTO shipstation_orders (id, shipstation_order_id, order_number, order_status, order_date, ship_date, last_seen_via) VALUES
  ('c4e50000-0000-0000-0000-000000000001', 940000001, 'TP4E-1001', 'awaiting_shipment', now(), NULL, 'manual');
INSERT INTO shipstation_order_items (shipstation_order_id, shipstation_line_item_id, sku_code, sku_id, quantity) VALUES
  ('c4e50000-0000-0000-0000-000000000001', 940000101, 'TP4-S', 'c4e10000-0000-0000-0000-000000000001', 2);
SELECT rpc_apply_shipstation_sale('c4e50000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001');
UPDATE shipstation_orders SET order_status = 'shipped', ship_date = now() WHERE id = 'c4e50000-0000-0000-0000-000000000001';
SELECT ok(pg_temp.settled('c4e50000-0000-0000-0000-000000000001') = 2
          AND (SELECT qty = 1 AND state = 'open' FROM wh_containers WHERE code = 'C-TP4E-OPN'),
          'D1 an order that becomes shipped settles 2 units from the open carton on the pick face');
SELECT set_config('wht.again', _wh_settle_order('c4e50000-0000-0000-0000-000000000001')::text, true);
UPDATE shipstation_orders SET order_status = 'shipped' WHERE id = 'c4e50000-0000-0000-0000-000000000001';
SELECT ok(pg_temp.v('again')->>'drawn' = '0'
          AND (SELECT count(*) FROM wh_inventory_movements WHERE type = 'ship_settle'
                AND reference_id = 'c4e50000-0000-0000-0000-000000000001') = 1,
          'D2 settling again, or a re-ingest of the shipped order, moves nothing');

INSERT INTO shipstation_orders (id, shipstation_order_id, order_number, order_status, order_date, ship_date, last_seen_via) VALUES
  ('c4e50000-0000-0000-0000-000000000002', 940000002, 'TP4E-1002', 'shipped', now(), now(), 'manual');
INSERT INTO shipstation_order_items (shipstation_order_id, shipstation_line_item_id, sku_code, sku_id, quantity) VALUES
  ('c4e50000-0000-0000-0000-000000000002', 940000102, 'TP4-S', 'c4e10000-0000-0000-0000-000000000001', 4);
SELECT is(pg_temp.settled('c4e50000-0000-0000-0000-000000000002'), 0,
          'D3 an order written as shipped is admitted before its sale rows land');
SELECT rpc_apply_shipstation_sale('c4e50000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001');
SELECT ok(pg_temp.settled('c4e50000-0000-0000-0000-000000000002') = 4
          AND (SELECT state FROM wh_containers WHERE code = 'C-TP4E-OPN') = 'empty'
          AND (SELECT qty = 9 AND state = 'open' FROM wh_containers WHERE code = 'C-TP4E-SLD'),
          'D4 the sale rows settle through the mirror: the open carton empties, then the sealed carton opens');

INSERT INTO shipstation_orders (id, shipstation_order_id, order_number, order_status, order_date, ship_date, last_seen_via) VALUES
  ('c4e50000-0000-0000-0000-000000000003', 940000003, 'TP4E-1003', 'shipped', now(), now(), 'manual');
INSERT INTO shipstation_order_items (shipstation_order_id, shipstation_line_item_id, sku_code, sku_id, quantity) VALUES
  ('c4e50000-0000-0000-0000-000000000003', 940000103, 'TP4-S', 'c4e10000-0000-0000-0000-000000000001', 20);
SELECT rpc_apply_shipstation_sale('c4e50000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001');
SELECT ok((SELECT state FROM wh_containers WHERE code = 'C-TP4E-SLD') = 'empty'
          AND (SELECT qty = 12 AND state = 'sealed' FROM wh_containers WHERE code = 'C-TP4E-OVF')
          AND pg_temp.bal('TP4-S', 'UNLOCATED', 'finished') = -11
          AND (SELECT settled_units = 20 AND shortfall_units = 11 FROM wh_order_settlements
                WHERE shipstation_order_id = 'c4e50000-0000-0000-0000-000000000003'),
          'D5 overflow is never drawn: 9 from the pick face, 11 short to UNLOCATED');
SELECT ok(EXISTS (SELECT 1 FROM wh_count_tasks t JOIN wh_locations l ON l.id = t.location_id
                   WHERE t.kind = 'reconcile' AND t.status = 'open' AND t.sku_id = pg_temp.sku('TP4-S')
                     AND t.source_id = 'c4e50000-0000-0000-0000-000000000003' AND l.pickable
                     AND l.code IN ('88-01-1', '88-02-1')),
          'D6 the shortfall opens a reconcile count on the SKU''s pick face');

INSERT INTO shipstation_orders (id, shipstation_order_id, order_number, order_status, order_date, ship_date, last_seen_via) VALUES
  ('c4e50000-0000-0000-0000-000000000004', 940000004, 'TP4E-1004', 'shipped', now() - interval '3 days', now() - interval '2 days', 'manual');
INSERT INTO shipstation_order_items (shipstation_order_id, shipstation_line_item_id, sku_code, sku_id, quantity) VALUES
  ('c4e50000-0000-0000-0000-000000000004', 940000104, 'TP4-R1', 'c4e10000-0000-0000-0000-000000000003', 2);
SELECT rpc_apply_shipstation_sale('c4e50000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001');
SELECT ok(NOT EXISTS (SELECT 1 FROM wh_order_settlements WHERE shipstation_order_id = 'c4e50000-0000-0000-0000-000000000004')
          AND NOT EXISTS (SELECT 1 FROM wh_inventory_movements WHERE reference_id = 'c4e50000-0000-0000-0000-000000000004'),
          'D7 an order shipped before the go-live day is never settled');

INSERT INTO shipstation_orders (id, shipstation_order_id, order_number, order_status, order_date, ship_date, last_seen_via) VALUES
  ('c4e50000-0000-0000-0000-000000000005', 940000005, 'TP4E-1005', 'awaiting_shipment', now(), NULL, 'manual'),
  ('c4e50000-0000-0000-0000-000000000006', 940000006, 'TP4E-1006', 'awaiting_shipment', now(), NULL, 'manual');
INSERT INTO shipstation_order_items (shipstation_order_id, shipstation_line_item_id, sku_code, sku_id, quantity) VALUES
  ('c4e50000-0000-0000-0000-000000000005', 940000105, 'TP4-R1', 'c4e10000-0000-0000-0000-000000000003', 3),
  ('c4e50000-0000-0000-0000-000000000006', 940000106, 'TP4-R1', 'c4e10000-0000-0000-0000-000000000003', 1);
SELECT rpc_apply_shipstation_sale('c4e50000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000001');
SELECT rpc_apply_shipstation_sale('c4e50000-0000-0000-0000-000000000006', '00000000-0000-0000-0000-000000000001');
UPDATE shipstation_orders SET order_status = 'cancelled' WHERE id = 'c4e50000-0000-0000-0000-000000000006';
SELECT ok(NOT EXISTS (SELECT 1 FROM wh_order_settlements
                       WHERE shipstation_order_id IN ('c4e50000-0000-0000-0000-000000000005', 'c4e50000-0000-0000-0000-000000000006'))
          AND pg_temp.bal('TP4-R1', '88-03-1', 'finished') = 9,
          'D8 open and cancelled orders leave the shelves alone');

-- =============================================================
-- E. Nightly reconciliation
-- =============================================================
-- green cartons at the line: one printed three hours ago, one just now
INSERT INTO wh_containers (code, sku_id, qty_initial, qty, state, location_id, source, label_stock, finished_at, finished_by)
VALUES ('C-TP4E-GRN1', pg_temp.sku('TP4-S'), 0, 0, 'sealed', pg_temp.loc('MFG-LINE'), 'manufacturing', 'green',
        now() - interval '3 hours', 'c4e00000-0000-0000-0000-000000000003'),
       ('C-TP4E-GRN2', pg_temp.sku('TP4-S'), 0, 0, 'sealed', pg_temp.loc('MFG-LINE'), 'manufacturing', 'green',
        now(), 'c4e00000-0000-0000-0000-000000000003');
-- the first R2 face in walk order already has an open count
SELECT set_config('wht.r2locs', to_jsonb(ARRAY(SELECT l.id FROM wh_locations l WHERE l.code IN ('88-01-2', '88-02-2', '88-03-2')
                                                ORDER BY l.pick_sequence, l.code))::text, true);
SELECT pg_temp.as_user('c4e00000-0000-0000-0000-000000000002');
SELECT set_config('wht.adhoc', rpc_wh_create_count(ARRAY[(pg_temp.v('r2locs')->>0)::uuid], 'ad_hoc', 'test')::text, true);
SELECT pg_temp.as_user('c4e00000-0000-0000-0000-000000000001');
SELECT set_config('wht.rec', rpc_wh_reconcile_physical()::text, true);
SELECT ok(pg_temp.v('rec')->>'ok' = 'true' AND pg_temp.v('rec')->>'live' = 'true' AND pg_temp.v('rec')->>'counts_enabled' = 'true'
          AND EXISTS (SELECT 1 FROM wh_reconcile_runs WHERE id = (pg_temp.v('rec')->>'run_id')::uuid),
          'E1 the reconcile runs live and records a run');
SELECT ok((pg_temp.line('TP4-R2', 'finished')).residual = 5 AND (pg_temp.line('TP4-R2', 'finished')).physical = 20
          AND (pg_temp.line('TP4-R2', 'finished')).levels_value = 15,
          'E2 a SKU with 20 on the shelves and 15 in the books shows R = +5');
SELECT ok(cardinality((pg_temp.line('TP4-R2', 'finished')).count_task_ids) = 2
          AND (pg_temp.v('adhoc')->'created'->>0)::uuid = ANY ((pg_temp.line('TP4-R2', 'finished')).count_task_ids),
          'E3 its counts are capped at max_counts_per_sku = 2 and reuse the open count');
SELECT is((SELECT count(*)::int FROM wh_count_tasks WHERE kind = 'reconcile' AND sku_id = pg_temp.sku('TP4-R2')
             AND source_id = (pg_temp.v('rec')->>'run_id')::uuid AND location_id = (pg_temp.v('r2locs')->>1)::uuid),
          1, 'E4 one new reconcile count, on the second face in walk order');
SELECT ok(NOT EXISTS (SELECT 1 FROM wh_count_tasks WHERE location_id = (pg_temp.v('r2locs')->>2)::uuid AND status IN ('open', 'counting')),
          'E5 the third face is past the cap');
SELECT is((SELECT count(*)::int FROM wh_reconcile_lines
            WHERE run_id = (pg_temp.v('rec')->>'run_id')::uuid
              AND sku_id IN (pg_temp.sku('TP4-S'), pg_temp.sku('TP4-F'), pg_temp.sku('TP4-A'), pg_temp.sku('TP4-B'), pg_temp.sku('TP4-C'))),
          0, 'E6 settled, received, counted and untouched SKUs reconcile: P - O = L');
SELECT ok((pg_temp.line('TP4-M', 'finished')).id IS NULL AND (pg_temp.line('TP4-M', 'in_production')).id IS NULL
          AND (pg_temp.line('TP4-M', 'raw')).residual = -1,
          'E7 other buckets reconcile as R = P - L: only the negative raw at the line is off');
SELECT ok((pg_temp.line('TP4-R1', 'finished')).residual = 0 AND (pg_temp.line('TP4-R1', 'finished')).open_order_units = 3
          AND (pg_temp.line('TP4-R1', 'finished')).cancelled_held_units = 1 AND (pg_temp.line('TP4-R1', 'finished')).physical = 9
          AND (pg_temp.line('TP4-R1', 'finished')).levels_value = 5,
          'E8 open orders (O = 3) and a cancelled hold (H = 1) explain the gap: 9 - 3 - 1 = 5');
SELECT is((pg_temp.line('TP4-D', 'finished')).residual, -6, 'E9 ledger rows written while dormant show as a residual');
SELECT ok((pg_temp.v('rec')->>'rts_unplaced_cartons')::int >= 1
          AND (pg_temp.v('rec')->>'rts_unplaced_cartons')::int =
              (SELECT count(*) FROM wh_containers WHERE label_stock = 'green' AND state IN ('sealed', 'open')
                 AND location_id = pg_temp.loc('MFG-LINE') AND COALESCE(finished_at, created_at) < now() - interval '2 hours'),
          'E10 rts_unplaced counts green cartons at the line older than two hours');
SELECT set_config('wht.rec2', rpc_wh_reconcile_physical()::text, true);
SELECT is((SELECT count(*)::int FROM wh_count_tasks WHERE kind = 'reconcile' AND sku_id = pg_temp.sku('TP4-R2')), 1,
          'E11 a second run never duplicates an open count');
SELECT is((rpc_wh_reconcile_physical(false))->>'counts_enabled', 'false', 'E12 p_create_counts false makes a read-only run');
SELECT pg_temp.as_user('c4e00000-0000-0000-0000-000000000003');
SELECT is((rpc_wh_reconcile_physical())->>'error', 'forbidden', 'E13 a floor user cannot run the reconcile');

-- =============================================================
-- F. The daily report's warehouse key
-- =============================================================
SELECT pg_temp.as_super();
SELECT set_config('wht.dr', ((rpc_daily_report())->'warehouse')::text, true);
SELECT ok((SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(pg_temp.v('dr')) AS k)
          = ARRAY['abs_units', 'counts_due', 'mismatched_skus', 'putaway_over_24h', 'rts_unplaced', 'run_at', 'unlocated_units'],
          'F1 the warehouse key carries the six numbers and the run time');
SELECT ok((pg_temp.v('dr')->>'mismatched_skus')::int = (SELECT mismatched_skus FROM wh_reconcile_runs ORDER BY run_at DESC LIMIT 1)
          AND (pg_temp.v('dr')->>'counts_due')::int =
              (SELECT count(*) FROM wh_count_tasks WHERE status IN ('open', 'counting')
                 AND (due_date IS NULL OR due_date <= (now() AT TIME ZONE 'America/New_York')::date)),
          'F2 its numbers come from the latest run and the open count tasks');

-- =============================================================
-- G. Count scheduling by ABC class
-- =============================================================
UPDATE wh_locations SET last_counted_at = now() WHERE face IS DISTINCT FROM '89';
UPDATE wh_locations SET last_counted_at = now() - interval '10 days'  WHERE code IN ('89-01-2', '89-02-1');
UPDATE wh_locations SET last_counted_at = now() - interval '100 days' WHERE code = '89-02-2';
UPDATE wh_locations SET last_counted_at = NULL                        WHERE code = '89-03-1';
UPDATE wh_locations SET last_counted_at = now() - interval '3 days'   WHERE code = '89-03-2';
UPDATE wh_settings SET value = '{"A_days": 7, "B_days": 30, "C_days": 90, "daily_cap": 2}'::jsonb WHERE key = 'count_schedule';
SELECT pg_temp.as_user('c4e00000-0000-0000-0000-000000000001');
SELECT set_config('wht.s1', rpc_wh_schedule_counts()::text, true);
SELECT ok(pg_temp.v('s1')->>'created' = '2' AND pg_temp.v('s1')->>'due' = '3' AND pg_temp.v('s1')->>'left_for_later' = '1',
          'G1 three locations are due and the daily cap of 2 schedules two');
SELECT ok(EXISTS (SELECT 1 FROM wh_count_tasks WHERE location_id = pg_temp.loc('89-03-1') AND kind = 'scheduled' AND status = 'open')
          AND EXISTS (SELECT 1 FROM wh_count_tasks WHERE location_id = pg_temp.loc('89-02-2') AND kind = 'scheduled' AND status = 'open')
          AND NOT EXISTS (SELECT 1 FROM wh_count_tasks WHERE location_id = pg_temp.loc('89-01-2')),
          'G2 most overdue first: never counted, then the unclassified (C) location 10 days late');
SELECT is((rpc_wh_schedule_counts())->>'created', '0', 'G3 the daily cap holds across calls');
SELECT pg_temp.as_super();
UPDATE wh_settings SET value = '{"A_days": 7, "B_days": 30, "C_days": 90, "daily_cap": 5}'::jsonb WHERE key = 'count_schedule';
SELECT pg_temp.as_user('c4e00000-0000-0000-0000-000000000001');
SELECT set_config('wht.s3', rpc_wh_schedule_counts()::text, true);
SELECT ok(pg_temp.v('s3')->>'created' = '1'
          AND (SELECT reason LIKE '%TP4-A%A-class%7 days%' AND sku_id = pg_temp.sku('TP4-A') FROM wh_count_tasks
                WHERE location_id = pg_temp.loc('89-01-2') AND kind = 'scheduled'),
          'G4 a location holding A and B stock is due on the A cadence');
SELECT ok(NOT EXISTS (SELECT 1 FROM wh_count_tasks WHERE location_id IN (pg_temp.loc('89-02-1'), pg_temp.loc('89-03-2'))),
          'G5 B stock counted 10 days ago and A stock counted 3 days ago are not due');
SELECT ok((SELECT r->>'created' = '0' AND r->>'already_open' = '3' FROM (SELECT rpc_wh_schedule_counts() AS r) s),
          'G6 a location with an open count is never scheduled twice');
SELECT pg_temp.as_user('c4e00000-0000-0000-0000-000000000003');
SELECT is((rpc_wh_schedule_counts())->>'error', 'forbidden', 'G7 a floor user cannot schedule counts');

-- =============================================================
-- H. Printers and the browser target
-- =============================================================
SELECT is((rpc_wh_save_printer('{"code":"TP4E-X","transport":"browser","label_stock":"white_4x2"}'::jsonb))->>'error', 'forbidden',
          'H1 a floor user cannot register printers');
SELECT pg_temp.as_user('c4e00000-0000-0000-0000-000000000001');
SELECT set_config('wht.p1', rpc_wh_save_printer('{"code":"tp4e-mfg","name":"Test 4E mfg","transport":"agent",
  "address":"tcp://10.0.0.5:9100","label_stock":"white_3x1","station_code":"ST-MFG-3","agent_id":"agent-4e"}'::jsonb)::text, true);
SELECT ok(pg_temp.v('p1')->>'created' = 'true' AND pg_temp.v('p1')->'printer'->>'code' = 'TP4E-MFG'
          AND (pg_temp.v('p1')->'printer'->>'station_location_id')::uuid = pg_temp.loc('ST-MFG-3')
          AND pg_temp.v('p1')->'printer'->>'dpi' = '203' AND pg_temp.v('p1')->'printer'->>'active' = 'true',
          'H2 an admin registers an agent printer at a station');
SELECT is((rpc_wh_save_printer('{"code":"TP4E-MFG","address":"lpt1"}'::jsonb))->>'error', 'invalid_address',
          'H3 an address the agent cannot parse is refused');
SELECT ok((rpc_wh_save_printer('{"code":"TP4E-MFG","address":"share://DOCK-PC/Zebra Dock"}'::jsonb))->'printer'->>'address' = 'share://DOCK-PC/Zebra Dock'
          AND (rpc_wh_save_printer('{"code":"TP4E-MFG","address":"file://C:/labels"}'::jsonb))->'printer'->>'address' = 'file://C:/labels'
          AND (rpc_wh_save_printer('{"code":"TP4E-MFG","address":"tcp://10.0.0.5:9100"}'::jsonb))->>'ok' = 'true',
          'H4 share:// and file:// addresses are accepted too');
SELECT ok((rpc_wh_save_printer('{"code":"TP4E-MFG","transport":"usb"}'::jsonb))->>'error' = 'invalid_transport'
          AND (rpc_wh_save_printer('{"code":"TP4E-MFG","label_stock":"pink_4x2"}'::jsonb))->>'error' = 'invalid_label_stock'
          AND (rpc_wh_save_printer('{"code":"TP4E-MFG","dpi":150}'::jsonb))->>'error' = 'invalid_dpi'
          AND (rpc_wh_save_printer('{"code":"TP4E-MFG","station_code":"IN-01"}'::jsonb))->>'error' = 'invalid_station'
          AND (rpc_wh_save_printer('{"code":"TP4E-B","transport":"browser","address":"tcp://1.2.3.4","label_stock":"white_4x2"}'::jsonb))->>'error' = 'invalid_address',
          'H5 transport, label stock, dpi, station and a browser printer''s address are validated');
SELECT is((rpc_wh_save_printer('{"code":"TP4E-MFG","name":"Renamed","row_version":999}'::jsonb))->>'error', 'stale',
          'H6 an edit from a stale row_version is refused');
SELECT set_config('wht.p2', rpc_wh_save_printer(jsonb_build_object('id', pg_temp.v('p1')->'printer'->>'id', 'name', 'Mfg desk 3',
  'row_version', (SELECT row_version FROM wh_printers WHERE code = 'TP4E-MFG')))::text, true);
SELECT ok(pg_temp.v('p2')->>'created' = 'false' AND pg_temp.v('p2')->'printer'->>'name' = 'Mfg desk 3'
          AND (pg_temp.v('p2')->'printer'->>'row_version')::int > (pg_temp.v('p1')->'printer'->>'row_version')::int,
          'H7 an edit by id with the current row_version saves');
SELECT pg_temp.as_user('c4e00000-0000-0000-0000-000000000003');
SELECT rpc_wh_start_station('%ST-MFG-3');
SELECT set_config('wht.j1', rpc_wh_request_labels('location', ARRAY[pg_temp.loc('88-01-1')], 'phone')::text, true);
SELECT ok(pg_temp.v('j1')->>'target' = 'printer' AND pg_temp.v('j1')->'printer'->>'code' = 'TP4E-MFG',
          'H8 under a station session a label goes to the station printer');
SELECT set_config('wht.j2', rpc_wh_request_labels('location', ARRAY[pg_temp.loc('88-01-1')], 'phone', NULL, 'browser')::text, true);
SELECT ok(pg_temp.v('j2')->>'target' = 'browser' AND pg_temp.v('j2')->>'routed_by' = 'requested' AND pg_temp.v('j2')->'printer' = 'null'::jsonb
          AND (SELECT printer_id IS NULL AND station_location_id = pg_temp.loc('ST-MFG-3') FROM wh_print_jobs WHERE id = (pg_temp.v('j2')->>'job_id')::uuid),
          'H9 p_target browser prints from the browser even with a station session');
SELECT is((rpc_wh_request_labels('location', ARRAY[pg_temp.loc('88-01-1')], 'phone', NULL, 'nope'))->>'error', 'invalid_target',
          'H10 an unknown target is refused');
SELECT pg_temp.as_user('c4e00000-0000-0000-0000-000000000001');
SELECT is((rpc_wh_delete_printer((pg_temp.v('p1')->'printer'->>'id')::uuid))->>'error', 'printer_has_jobs',
          'H11 a printer with a queued job cannot be removed');
SELECT pg_temp.as_super();
UPDATE wh_print_jobs SET status = 'printed', printed_at = now() WHERE printer_id = (pg_temp.v('p1')->'printer'->>'id')::uuid;
SELECT pg_temp.as_user('c4e00000-0000-0000-0000-000000000001');
SELECT set_config('wht.del', rpc_wh_delete_printer((pg_temp.v('p1')->'printer'->>'id')::uuid)::text, true);
SELECT ok(pg_temp.v('del')->>'ok' = 'true' AND pg_temp.v('del')->>'already_inactive' = 'false'
          AND (SELECT NOT active FROM wh_printers WHERE code = 'TP4E-MFG'),
          'H12 once its jobs are done the printer is deactivated, not deleted');
SELECT is((rpc_wh_delete_printer((pg_temp.v('p1')->'printer'->>'id')::uuid))->>'already_inactive', 'true',
          'H13 removing it again reports it was already inactive');

SELECT pg_temp.as_super();
SELECT * FROM finish();
ROLLBACK;
