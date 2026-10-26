-- =============================================================
-- Warehouse module Phase 1, slice 3C test suite (pgTAP): receiving
-- mints carton license plates
-- =============================================================
-- Covers migration 20261023000001 (rpc_record_freight_receipt,
-- rpc_apply_freight_delivery, _wh_label_payload). Synthetic fixtures
-- only (shipments TP3-90x, SKUs TP3-*, rack T96 with faces 96/97);
-- everything rolls back.
-- Run with: supabase test db
--
-- Areas tested:
--   A. mint_lpns off: the receipt writes what it always wrote and no wh_* row
--   B. mint_lpns on: a two-group shipment (one mixed) checked in over two
--      calls: LPN codes, per-carton units summing to the credit, IN-01
--      balances, one putaway task per carton with a suggestion, one print
--      job per call (browser, then the dock station's printer), carton n of
--      N on the label, ledger rows identical to the control shipment's,
--      wh.mirror_skip on around the ledger credit and off afterwards
--   C. Corrections: a negative tap voids the newest sealed carton, a
--      freed number is re-issued with a letter, a split the remaining
--      cartons cannot match lands at UNLOCATED (physical = ledger), and
--      lpn_in_use when every carton has been opened; a floor user cannot
--      pass the system actor
--   D. Unit mode: loose units at IN-01, one task per SKU, no labels,
--      corrections shrink the task, units_put_away once moved
--   E. Receive-all through the carton path: LPNs plus loose leftovers
--   F. A group partly checked in before minting: a correction voids the
--      LPN carton and reverses the older carton in the ledger only

BEGIN;

SELECT plan(41);

-- =============================================================
-- Fixtures
-- =============================================================
INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change, is_sso_user, is_anonymous)
SELECT '00000000-0000-0000-0000-000000000000', x.id, 'authenticated', 'authenticated', x.email, '', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', '', false, false
  FROM (VALUES
   ('c3c00000-0000-0000-0000-000000000001'::uuid, 'wh3c-admin@test.local'),
   ('c3c00000-0000-0000-0000-000000000002', 'wh3c-manager@test.local'),
   ('c3c00000-0000-0000-0000-000000000003', 'wh3c-user@test.local')) AS x(id, email)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE profiles DISABLE TRIGGER USER;
INSERT INTO profiles (id, email, full_name, role, is_active, supplier_id, is_print_agent) VALUES
  ('c3c00000-0000-0000-0000-000000000001', 'wh3c-admin@test.local',   'Ada Admin',   'admin',   true, NULL, false),
  ('c3c00000-0000-0000-0000-000000000002', 'wh3c-manager@test.local', 'Mia Manager', 'manager', true, NULL, false),
  ('c3c00000-0000-0000-0000-000000000003', 'wh3c-user@test.local',    'Devon Floor', 'user',    true, NULL, false)
ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, is_active = true, supplier_id = NULL, full_name = EXCLUDED.full_name;
ALTER TABLE profiles ENABLE TRIGGER USER;

INSERT INTO product_skus (id, sku, product_name, category, display_category, standard_quantity_per_carton) VALUES
  ('c3c10000-0000-0000-0000-000000000001', 'TP3-A', 'Test finished A', 'non_fillable', 'Accessories', 12),
  ('c3c10000-0000-0000-0000-000000000002', 'TP3-B', 'Test fillable B', 'fillable',     'Pipes',       10),
  ('c3c10000-0000-0000-0000-000000000003', 'TP3-C', 'Test fillable C', 'fillable',     'Pipes',       10);

-- S0 (control, minting off) and S1 (minting on) have the same plan:
-- G1 = TP3-A, 4 cartons of 12; G2 = mixed, TP3-B 25 + TP3-C 10 over 4
-- cartons, which the rounding splits B 6/7/6/6 and C 3/2/3/2.
INSERT INTO freight_shipments (id, shipment_number, freight_type, status) VALUES
  ('c3c20000-0000-0000-0000-000000000000', 'TP3-900', 'sea', 'tracking'),
  ('c3c20000-0000-0000-0000-000000000001', 'TP3-901', 'sea', 'tracking'),
  ('c3c20000-0000-0000-0000-000000000002', 'TP3-902', 'air', 'tracking'),
  ('c3c20000-0000-0000-0000-000000000003', 'TP3-903', 'air', 'tracking'),
  ('c3c20000-0000-0000-0000-000000000004', 'TP3-904', 'air', 'tracking');
INSERT INTO freight_line_items (id, freight_shipment_id, sku_id, quantity) VALUES
  ('c3c40000-0000-0000-0000-000000000001', 'c3c20000-0000-0000-0000-000000000000', 'c3c10000-0000-0000-0000-000000000001', 48),
  ('c3c40000-0000-0000-0000-000000000002', 'c3c20000-0000-0000-0000-000000000000', 'c3c10000-0000-0000-0000-000000000002', 25),
  ('c3c40000-0000-0000-0000-000000000003', 'c3c20000-0000-0000-0000-000000000000', 'c3c10000-0000-0000-0000-000000000003', 10),
  ('c3c40000-0000-0000-0000-000000000011', 'c3c20000-0000-0000-0000-000000000001', 'c3c10000-0000-0000-0000-000000000001', 48),
  ('c3c40000-0000-0000-0000-000000000012', 'c3c20000-0000-0000-0000-000000000001', 'c3c10000-0000-0000-0000-000000000002', 25),
  ('c3c40000-0000-0000-0000-000000000013', 'c3c20000-0000-0000-0000-000000000001', 'c3c10000-0000-0000-0000-000000000003', 10),
  ('c3c40000-0000-0000-0000-000000000021', 'c3c20000-0000-0000-0000-000000000002', 'c3c10000-0000-0000-0000-000000000002', 20),
  ('c3c40000-0000-0000-0000-000000000022', 'c3c20000-0000-0000-0000-000000000002', 'c3c10000-0000-0000-0000-000000000001', 7),
  ('c3c40000-0000-0000-0000-000000000031', 'c3c20000-0000-0000-0000-000000000003', 'c3c10000-0000-0000-0000-000000000001', 24),
  ('c3c40000-0000-0000-0000-000000000032', 'c3c20000-0000-0000-0000-000000000003', 'c3c10000-0000-0000-0000-000000000003', 5),
  ('c3c40000-0000-0000-0000-000000000041', 'c3c20000-0000-0000-0000-000000000004', 'c3c10000-0000-0000-0000-000000000001', 36);
INSERT INTO freight_carton_groups (id, freight_shipment_id, carton_qty, sort_order) VALUES
  ('c3c30000-0000-0000-0000-000000000001', 'c3c20000-0000-0000-0000-000000000000', 4, 0),
  ('c3c30000-0000-0000-0000-000000000002', 'c3c20000-0000-0000-0000-000000000000', 4, 1),
  ('c3c30000-0000-0000-0000-000000000011', 'c3c20000-0000-0000-0000-000000000001', 4, 0),
  ('c3c30000-0000-0000-0000-000000000012', 'c3c20000-0000-0000-0000-000000000001', 4, 1),
  ('c3c30000-0000-0000-0000-000000000031', 'c3c20000-0000-0000-0000-000000000003', 2, 0),
  ('c3c30000-0000-0000-0000-000000000041', 'c3c20000-0000-0000-0000-000000000004', 3, 0);
INSERT INTO freight_carton_group_skus (carton_group_id, sku_id, units_total, created_at) VALUES
  ('c3c30000-0000-0000-0000-000000000001', 'c3c10000-0000-0000-0000-000000000001', 48, now()),
  ('c3c30000-0000-0000-0000-000000000002', 'c3c10000-0000-0000-0000-000000000002', 25, now()),
  ('c3c30000-0000-0000-0000-000000000002', 'c3c10000-0000-0000-0000-000000000003', 10, now() + interval '1 second'),
  ('c3c30000-0000-0000-0000-000000000011', 'c3c10000-0000-0000-0000-000000000001', 48, now()),
  ('c3c30000-0000-0000-0000-000000000012', 'c3c10000-0000-0000-0000-000000000002', 25, now()),
  ('c3c30000-0000-0000-0000-000000000012', 'c3c10000-0000-0000-0000-000000000003', 10, now() + interval '1 second'),
  ('c3c30000-0000-0000-0000-000000000031', 'c3c10000-0000-0000-0000-000000000001', 24, now()),
  ('c3c30000-0000-0000-0000-000000000041', 'c3c10000-0000-0000-0000-000000000001', 36, now());

UPDATE wh_settings SET value = value || '{"mint_lpns": false}'::jsonb WHERE key = 'physical_layer';
UPDATE wh_settings SET value = '{"mode":"live"}'::jsonb WHERE key = 'outbound';
INSERT INTO wh_printers (code, name, station_location_id, transport, label_stock, agent_id)
SELECT 'TEST3C-DOCK', 'Test dock printer', id, 'agent', 'white_4x2', 'agent-dock-3c' FROM wh_locations WHERE code = 'ST-DOCK';

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
CREATE OR REPLACE FUNCTION pg_temp.v(p_key text) RETURNS jsonb LANGUAGE sql AS $$
  SELECT NULLIF(current_setting('wht.' || p_key, true), '')::jsonb;
$$;
CREATE OR REPLACE FUNCTION pg_temp.ctr(p_code text) RETURNS uuid LANGUAGE sql AS $$
  SELECT id FROM wh_containers WHERE code = p_code;
$$;
-- per SKU and ledger column, "count:sum" of a shipment's freight_delivered rows
CREATE OR REPLACE FUNCTION pg_temp.ledger(p_shipment uuid) RETURNS text LANGUAGE sql AS $$
  SELECT string_agg(ps.sku || ':' || t.field_affected || ':' || t.n || ':' || t.s, ',' ORDER BY ps.sku, t.field_affected)
    FROM (SELECT sku_id, field_affected, count(*) AS n, sum(quantity) AS s FROM inventory_transactions
           WHERE reference_id = p_shipment AND transaction_type = 'freight_delivered' GROUP BY 1, 2) t
    JOIN product_skus ps ON ps.id = t.sku_id;
$$;
-- per SKU, the net units the physical layer gained from a shipment's receipts
CREATE OR REPLACE FUNCTION pg_temp.physical(p_shipment uuid) RETURNS text LANGUAGE sql AS $$
  SELECT string_agg(ps.sku || ':' || t.net, ',' ORDER BY ps.sku)
    FROM (SELECT m.sku_id, sum(CASE WHEN m.to_location_id IS NOT NULL THEN m.qty ELSE 0 END
                               - CASE WHEN m.from_location_id IS NOT NULL THEN m.qty ELSE 0 END) AS net
            FROM wh_inventory_movements m
           WHERE m.reference_type = 'freight_receipt'
             AND m.reference_id IN (SELECT id FROM freight_receipts WHERE freight_shipment_id = p_shipment)
           GROUP BY 1) t
    JOIN product_skus ps ON ps.id = t.sku_id;
$$;

-- capture wh.mirror_skip as each ledger row lands
CREATE TEMP TABLE mirror_flags (sku_id uuid, flag text) ON COMMIT DROP;
GRANT ALL ON mirror_flags TO PUBLIC;
CREATE OR REPLACE FUNCTION pg_temp.capture_mirror_flag() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO mirror_flags VALUES (NEW.sku_id, current_setting('wh.mirror_skip', true));
  RETURN NEW;
END; $$;
CREATE TRIGGER zz_test_capture_mirror_flag AFTER INSERT ON inventory_transactions
  FOR EACH ROW EXECUTE FUNCTION pg_temp.capture_mirror_flag();

-- a small rack so putaway always has empty bays to suggest
SELECT pg_temp.as_user('c3c00000-0000-0000-0000-000000000001');
SELECT set_config('wht.layout', rpc_wh_save_layout('{
  "templates":[{"code":"T3C-PR","name":"Test 3C pallet rack","kind":"pallet_rack","bays":3,"levels":3,
                "bay_width_mm":2743,"depth_mm":1067,"level_heights_mm":[0,1372,2743],
                "overflow_top_level":true,"capacity_cartons_per_level":4}],
  "racks":[{"code":"T96","template_code":"T3C-PR","x_mm":1000,"y_mm":1000,"rot_deg":90}],
  "faces":[{"rack_code":"T96","face_code":"96","side":"east","aisle":"Z","walk_pass":85,"walk_dir":"S","zone_by_bay":["RTS"]},
           {"rack_code":"T96","face_code":"97","side":"west","aisle":"Y","walk_pass":86,"walk_dir":"N","zone_by_bay":["RAW"]}]
}'::jsonb)::text, true);
SELECT rpc_wh_generate_locations((SELECT id FROM wh_racks WHERE code = 'T96'), false);
SELECT is((SELECT count(*)::int FROM wh_locations WHERE face IN ('96', '97')), 18, 'F0 the test rack has 18 bay-levels');

SELECT pg_temp.as_super();
SELECT set_config('wht.jobs0', to_jsonb((SELECT count(*) FROM wh_print_jobs))::text, true);

-- =============================================================
-- A. mint_lpns off: the receipt as before, nothing physical
-- =============================================================
SELECT pg_temp.as_user('c3c00000-0000-0000-0000-000000000002');
SELECT set_config('wht.a1', rpc_record_freight_receipt('c3c20000-0000-0000-0000-000000000000',
  '[{"carton_group_id":"c3c30000-0000-0000-0000-000000000001","cartons":1}]'::jsonb,
  'c3c00000-0000-0000-0000-000000000002')::text, true);
SELECT set_config('wht.a2', rpc_record_freight_receipt('c3c20000-0000-0000-0000-000000000000',
  '[{"carton_group_id":"c3c30000-0000-0000-0000-000000000001","cartons":2},
    {"carton_group_id":"c3c30000-0000-0000-0000-000000000002","cartons":4}]'::jsonb,
  'c3c00000-0000-0000-0000-000000000002')::text, true);
SELECT ok(pg_temp.v('a1')->>'units_credited' = '12' AND pg_temp.v('a2')->>'units_credited' = '59'
          AND pg_temp.v('a2')->>'fully_received' = 'false'
          AND pg_temp.v('a2')->'lpns' = '[]'::jsonb AND pg_temp.v('a2')->>'print_job_id' IS NULL
          AND pg_temp.v('a2')->'putaway_tasks' = '[]'::jsonb,
          'A1 with minting off the receipt credits 12 then 59 units and mints nothing');
SELECT is((SELECT count(*)::int FROM wh_containers WHERE freight_shipment_id = 'c3c20000-0000-0000-0000-000000000000')
          + (SELECT count(*)::int FROM wh_inventory_movements WHERE reference_type = 'freight_receipt'
               AND reference_id IN (SELECT id FROM freight_receipts WHERE freight_shipment_id = 'c3c20000-0000-0000-0000-000000000000'))
          + (SELECT count(*)::int FROM wh_moves WHERE source_id = 'c3c20000-0000-0000-0000-000000000000'),
          0, 'A2 no carton, movement or putaway task is written');
SELECT is((SELECT count(*)::int FROM wh_print_jobs), (pg_temp.v('jobs0')#>>'{}')::int, 'A3 no print job is queued');
SELECT ok(NOT EXISTS (SELECT 1 FROM mirror_flags WHERE flag = 'on'), 'A4 the mirror flag stays off when nothing is minted');

-- =============================================================
-- B. mint_lpns on: two calls on a two-group shipment
-- =============================================================
SELECT pg_temp.as_super();
UPDATE wh_settings SET value = value || '{"mint_lpns": true}'::jsonb WHERE key = 'physical_layer';
DELETE FROM mirror_flags;
SELECT pg_temp.as_user('c3c00000-0000-0000-0000-000000000002');
SELECT set_config('wht.b1', rpc_record_freight_receipt('c3c20000-0000-0000-0000-000000000001',
  '[{"carton_group_id":"c3c30000-0000-0000-0000-000000000011","cartons":1}]'::jsonb,
  'c3c00000-0000-0000-0000-000000000002')::text, true);
SELECT ok(pg_temp.v('b1')->'lpns'->0->>'code' = 'C-TP3901-001' AND pg_temp.v('b1')->'lpns'->0->>'qty' = '12'
          AND pg_temp.v('b1')->'lpns'->0->>'sku_id' = 'c3c10000-0000-0000-0000-000000000001',
          'B1 one carton tapped mints C-TP3901-001 holding 12 of TP3-A');
SELECT ok(pg_temp.v('b1')->'print'->>'target' = 'browser'
          AND (SELECT kind = 'lpn' AND item_ids = ARRAY[(pg_temp.v('b1')->'lpns'->0->>'id')::uuid] AND printer_id IS NULL
                 FROM wh_print_jobs WHERE id = (pg_temp.v('b1')->>'print_job_id')::uuid),
          'B2 without a station session the call''s one lpn job prints from the browser');
SELECT is((rpc_wh_start_station('%ST-DOCK'))->'session'->>'code', 'ST-DOCK', 'B3 the receiver scans into the dock station');
SELECT set_config('wht.b2', rpc_record_freight_receipt('c3c20000-0000-0000-0000-000000000001',
  '[{"carton_group_id":"c3c30000-0000-0000-0000-000000000011","cartons":2},
    {"carton_group_id":"c3c30000-0000-0000-0000-000000000012","cartons":4}]'::jsonb,
  'c3c00000-0000-0000-0000-000000000002')::text, true);
SELECT is((SELECT string_agg(l->>'code', ',' ORDER BY (l->>'carton_seq')::int) FROM jsonb_array_elements(pg_temp.v('b2')->'lpns') l),
          'C-TP3901-002,C-TP3901-003,C-TP3901-004,C-TP3901-005,C-TP3901-006,C-TP3901-007',
          'B4 the next six cartons count on across the shipment');
SELECT is((SELECT string_agg(qty_initial::text, ',' ORDER BY carton_seq) FROM wh_containers
            WHERE carton_group_id = 'c3c30000-0000-0000-0000-000000000012'),
          '9,9,9,8', 'B5 mixed cartons hold the rounding''s split: 6+3, 7+2, 6+3, 6+2');
SELECT ok((SELECT bool_and(sku_id IS NULL) FROM wh_containers WHERE carton_group_id = 'c3c30000-0000-0000-0000-000000000012')
          AND (SELECT bool_and(sku_id = 'c3c10000-0000-0000-0000-000000000001') FROM wh_containers
                WHERE carton_group_id = 'c3c30000-0000-0000-0000-000000000011'),
          'B6 mixed cartons leave sku_id null; single-SKU cartons carry it');
SELECT is((SELECT sum(qty)::int FROM wh_containers WHERE freight_shipment_id = 'c3c20000-0000-0000-0000-000000000001'),
          (pg_temp.v('b1')->>'units_credited')::int + (pg_temp.v('b2')->>'units_credited')::int,
          'B7 the cartons sum exactly to the units credited (71)');
SELECT is((SELECT string_agg(ps.sku || ':' || b.bucket || ':' || b.n, ',' ORDER BY ps.sku)
             FROM (SELECT b.sku_id, b.bucket, sum(b.on_hand) AS n FROM wh_inventory_balances b
                     JOIN wh_containers c ON c.id = b.container_id
                    WHERE c.freight_shipment_id = 'c3c20000-0000-0000-0000-000000000001' AND b.location_id = pg_temp.loc('IN-01')
                    GROUP BY 1, 2) b JOIN product_skus ps ON ps.id = b.sku_id),
          'TP3-A:finished:36,TP3-B:raw:25,TP3-C:raw:10', 'B8 the balances sit at IN-01 in the buckets the ledger credited');
SELECT ok((SELECT count(*) = 7 AND bool_and(m.status = 'open' AND m.origin = 'receipt' AND m.from_location_id = pg_temp.loc('IN-01')
                                       AND m.suggestion_reason IS NOT NULL AND m.suggested_location_id IS NOT NULL)
             FROM wh_moves m JOIN wh_containers c ON c.id = m.container_id
            WHERE c.freight_shipment_id = 'c3c20000-0000-0000-0000-000000000001' AND m.kind = 'putaway')
          AND jsonb_array_length(pg_temp.v('b2')->'putaway_tasks') = 6,
          'B9 every carton has one open putaway task from IN-01 with a suggested location and reason');
-- (TEST3C-DOCK guarantees a dock printer; a real one on the project may win the routing)
SELECT ok(pg_temp.v('b2')->'print'->>'target' = 'printer'
          AND (SELECT cardinality(j.item_ids) = 6 AND j.kind = 'lpn' AND p.station_location_id = pg_temp.loc('ST-DOCK')
                      AND p.label_stock = 'white_4x2' AND p.transport = 'agent'
                 FROM wh_print_jobs j JOIN wh_printers p ON p.id = j.printer_id
                WHERE j.id = (pg_temp.v('b2')->>'print_job_id')::uuid),
          'B10 the second call''s one job carries six labels to the dock station''s white label printer');
SELECT ok((SELECT p->'labels'->0->>'barcode' = '%C-TP3901-002' AND p->'labels'->0->>'carton_seq' = '2'
                  AND p->'labels'->0->>'carton_of' = '8' AND p->'labels'->2->>'contents' = 'MIXED TP3-B×6 + TP3-C×3'
             FROM (SELECT payload AS p FROM wh_print_jobs WHERE id = (pg_temp.v('b2')->>'print_job_id')::uuid) s),
          'B11 a label reads carton n of the shipment''s 8 and names a mixed carton''s contents');
SELECT is(pg_temp.ledger('c3c20000-0000-0000-0000-000000000001'), pg_temp.ledger('c3c20000-0000-0000-0000-000000000000'),
          'B12 the ledger rows equal the control shipment''s (same count and net units per SKU)');
SELECT ok((SELECT count(*) = 11 AND bool_and(type = 'receive' AND to_location_id = pg_temp.loc('IN-01') AND to_container_id IS NOT NULL)
                  AND count(DISTINCT movement_group_id) = 2
             FROM wh_inventory_movements
            WHERE reference_type = 'freight_receipt'
              AND reference_id IN (SELECT id FROM freight_receipts WHERE freight_shipment_id = 'c3c20000-0000-0000-0000-000000000001')),
          'B13 eleven receive movements (one per carton and SKU) reference the receipt rows, one group per call');
SELECT ok((SELECT count(*) = 4 AND bool_and(flag = 'on') FROM mirror_flags)
          AND current_setting('wh.mirror_skip', true) IS DISTINCT FROM 'on',
          'B14 wh.mirror_skip is on while the ledger credits land and off once the call returns');

-- =============================================================
-- C. Corrections
-- =============================================================
SELECT set_config('wht.c1', rpc_record_freight_receipt('c3c20000-0000-0000-0000-000000000001',
  '[{"carton_group_id":"c3c30000-0000-0000-0000-000000000011","cartons":-1}]'::jsonb,
  'c3c00000-0000-0000-0000-000000000002')::text, true);
SELECT ok(pg_temp.v('c1')->'voided'->0->>'code' = 'C-TP3901-003'
          AND (SELECT state = 'void' AND qty = 0 FROM wh_containers WHERE code = 'C-TP3901-003')
          AND (SELECT status FROM wh_moves WHERE container_id = pg_temp.ctr('C-TP3901-003')) = 'cancelled',
          'C1 a negative tap voids the group''s newest sealed carton and cancels its putaway');
SELECT ok((SELECT sum(b.on_hand) FROM wh_inventory_balances b JOIN wh_containers c ON c.id = b.container_id
            WHERE c.carton_group_id = 'c3c30000-0000-0000-0000-000000000011') = 24
          AND (SELECT sum(quantity) FROM inventory_transactions WHERE reference_id = 'c3c20000-0000-0000-0000-000000000001'
                 AND sku_id = 'c3c10000-0000-0000-0000-000000000001') = 24,
          'C2 its 12 units leave the physical layer and the ledger together');
SELECT set_config('wht.c2', rpc_record_freight_receipt('c3c20000-0000-0000-0000-000000000001',
  '[{"carton_group_id":"c3c30000-0000-0000-0000-000000000011","cartons":1}]'::jsonb,
  'c3c00000-0000-0000-0000-000000000002')::text, true);
SELECT ok(pg_temp.v('c2')->'lpns'->0->>'code' = 'C-TP3901-003B' AND pg_temp.v('c2')->'lpns'->0->>'carton_seq' = '3',
          'C3 the freed number 3 is re-issued with a letter, since the void keeps its code');
SELECT set_config('wht.c3', rpc_record_freight_receipt('c3c20000-0000-0000-0000-000000000001',
  '[{"carton_group_id":"c3c30000-0000-0000-0000-000000000012","cartons":-1}]'::jsonb,
  'c3c00000-0000-0000-0000-000000000002')::text, true);
SELECT ok(pg_temp.v('c3')->'voided'->0->>'code' = 'C-TP3901-007' AND pg_temp.v('c3')->'unlocated' = '[]'::jsonb,
          'C4 the mixed group''s newest carton (6+2, the split being reversed) is voided with nothing left over');
-- the floor opens two mixed cartons; the only sealed one left (005, 7+2) does not match slot 3 (6+3)
SELECT pg_temp.as_user('c3c00000-0000-0000-0000-000000000003');
SELECT rpc_wh_open_container(pg_temp.ctr('C-TP3901-006'));
SELECT rpc_wh_open_container(pg_temp.ctr('C-TP3901-004'));
SELECT pg_temp.as_user('c3c00000-0000-0000-0000-000000000002');
SELECT set_config('wht.c4', rpc_record_freight_receipt('c3c20000-0000-0000-0000-000000000001',
  '[{"carton_group_id":"c3c30000-0000-0000-0000-000000000012","cartons":-1}]'::jsonb,
  'c3c00000-0000-0000-0000-000000000002')::text, true);
SELECT ok(pg_temp.v('c4')->'voided'->0->>'code' = 'C-TP3901-005'
          AND (SELECT string_agg(ps.sku || ':' || (u->>'units'), ',' ORDER BY ps.sku)
                 FROM jsonb_array_elements(pg_temp.v('c4')->'unlocated') u JOIN product_skus ps ON ps.id = (u->>'sku_id')::uuid) = 'TP3-B:1,TP3-C:-1',
          'C5 with no exact match the newest sealed carton is voided and the split difference goes to UNLOCATED');
SELECT is(pg_temp.physical('c3c20000-0000-0000-0000-000000000001'),
          (SELECT string_agg(ps.sku || ':' || t.s, ',' ORDER BY ps.sku)
             FROM (SELECT sku_id, sum(quantity) AS s FROM inventory_transactions
                    WHERE reference_id = 'c3c20000-0000-0000-0000-000000000001' GROUP BY 1) t
             JOIN product_skus ps ON ps.id = t.sku_id),
          'C6 after every correction the physical layer and the ledger agree per SKU');
SELECT set_config('wht.c5', rpc_record_freight_receipt('c3c20000-0000-0000-0000-000000000001',
  '[{"carton_group_id":"c3c30000-0000-0000-0000-000000000012","cartons":-1}]'::jsonb,
  'c3c00000-0000-0000-0000-000000000002')::text, true);
SELECT is(pg_temp.v('c5')->>'error', 'lpn_in_use', 'C7 with every remaining carton opened the correction is refused');
SELECT is(pg_temp.v('c5')->>'message', 'Every carton from this group has been opened or split; count the location instead.',
          'C8 the refusal says to count the location instead');
SELECT ok((SELECT received_cartons FROM freight_carton_groups WHERE id = 'c3c30000-0000-0000-0000-000000000012') = 2
          AND (SELECT count(*) FROM freight_receipts WHERE freight_shipment_id = 'c3c20000-0000-0000-0000-000000000001') = 7,
          'C9 a refused correction changes nothing');
SELECT pg_temp.as_user('c3c00000-0000-0000-0000-000000000003');
SELECT is((rpc_record_freight_receipt('c3c20000-0000-0000-0000-000000000001',
            '[{"carton_group_id":"c3c30000-0000-0000-0000-000000000011","cartons":1}]'::jsonb,
            '00000000-0000-0000-0000-000000000001'))->>'error',
          'admin_or_manager_required', 'C10 a floor user cannot pass the system actor to record a receipt');

-- =============================================================
-- D. Unit mode (no carton plan)
-- =============================================================
SELECT pg_temp.as_user('c3c00000-0000-0000-0000-000000000002');
SELECT set_config('wht.d1', rpc_record_freight_receipt('c3c20000-0000-0000-0000-000000000002',
  '[{"line_item_id":"c3c40000-0000-0000-0000-000000000021","units":12},
    {"line_item_id":"c3c40000-0000-0000-0000-000000000022","units":7}]'::jsonb,
  'c3c00000-0000-0000-0000-000000000002')::text, true);
SELECT ok(pg_temp.v('d1')->'lpns' = '[]'::jsonb AND pg_temp.v('d1')->>'print_job_id' IS NULL
          AND jsonb_array_length(pg_temp.v('d1')->'putaway_tasks') = 2,
          'D1 unit mode mints no carton and prints nothing, but opens a putaway per SKU');
SELECT is((SELECT string_agg(ps.sku || ':' || b.bucket || ':' || b.on_hand, ',' ORDER BY ps.sku)
             FROM wh_inventory_balances b JOIN product_skus ps ON ps.id = b.sku_id
            WHERE b.location_id = pg_temp.loc('IN-01') AND b.container_id IS NULL
              AND b.sku_id IN ('c3c10000-0000-0000-0000-000000000001', 'c3c10000-0000-0000-0000-000000000002')),
          'TP3-A:finished:7,TP3-B:raw:12', 'D2 the units land loose at IN-01');
SELECT set_config('wht.d2', rpc_record_freight_receipt('c3c20000-0000-0000-0000-000000000002',
  '[{"line_item_id":"c3c40000-0000-0000-0000-000000000021","units":3}]'::jsonb,
  'c3c00000-0000-0000-0000-000000000002')::text, true);
SELECT set_config('wht.d3', rpc_record_freight_receipt('c3c20000-0000-0000-0000-000000000002',
  '[{"line_item_id":"c3c40000-0000-0000-0000-000000000021","units":-5}]'::jsonb,
  'c3c00000-0000-0000-0000-000000000002')::text, true);
SELECT is((SELECT string_agg(ps.sku || ':' || m.qty || ':' || m.status, ',' ORDER BY ps.sku)
             FROM wh_moves m JOIN product_skus ps ON ps.id = m.sku_id
            WHERE m.source_id = 'c3c20000-0000-0000-0000-000000000002' AND m.container_id IS NULL),
          'TP3-A:7:open,TP3-B:10:open', 'D3 later receipts add to the SKU''s one task and a correction shrinks it');
SELECT rpc_wh_move_stock('c3c10000-0000-0000-0000-000000000002', 10, pg_temp.loc('IN-01'), pg_temp.loc('97-01-1'), NULL, NULL, 'raw',
                         (SELECT id FROM wh_moves WHERE source_id = 'c3c20000-0000-0000-0000-000000000002'
                             AND sku_id = 'c3c10000-0000-0000-0000-000000000002' AND status = 'open'));
SELECT set_config('wht.d4', rpc_record_freight_receipt('c3c20000-0000-0000-0000-000000000002',
  '[{"line_item_id":"c3c40000-0000-0000-0000-000000000021","units":-1}]'::jsonb,
  'c3c00000-0000-0000-0000-000000000002')::text, true);
SELECT is(pg_temp.v('d4')->>'error', 'units_put_away', 'D4 correcting units that were already put away is refused');
SELECT is((SELECT quantity_received FROM freight_line_items WHERE id = 'c3c40000-0000-0000-0000-000000000021'), 10,
          'D5 the refused correction leaves the line at 10 received');

-- =============================================================
-- E. Receive-all through the carton path
-- =============================================================
SELECT set_config('wht.e1', rpc_apply_freight_delivery('c3c20000-0000-0000-0000-000000000003',
                                                       'c3c00000-0000-0000-0000-000000000002')::text, true);
SELECT ok(pg_temp.v('e1')->>'ok' = 'true' AND pg_temp.v('e1')->>'lpns_minted' = '2' AND pg_temp.v('e1')->>'print_job_id' IS NOT NULL,
          'E1 receive-all mints LPNs for the remaining cartons and queues their labels');
SELECT is((SELECT string_agg(code || ':' || qty, ',' ORDER BY code) FROM wh_containers
            WHERE freight_shipment_id = 'c3c20000-0000-0000-0000-000000000003'),
          'C-TP3903-001:12,C-TP3903-002:12', 'E2 two cartons of 12');
SELECT ok((SELECT on_hand FROM wh_inventory_balances WHERE location_id = pg_temp.loc('IN-01') AND container_id IS NULL
             AND sku_id = 'c3c10000-0000-0000-0000-000000000003' AND bucket = 'raw') = 5
          AND EXISTS (SELECT 1 FROM wh_moves WHERE source_id = 'c3c20000-0000-0000-0000-000000000003'
                       AND sku_id = 'c3c10000-0000-0000-0000-000000000003' AND qty = 5 AND status = 'open'),
          'E3 the line outside the carton plan arrives as 5 loose units with a putaway task');
SELECT ok((SELECT receipt_confirmed_at IS NOT NULL FROM freight_shipments WHERE id = 'c3c20000-0000-0000-0000-000000000003')
          AND (SELECT received_cartons FROM freight_carton_groups WHERE id = 'c3c30000-0000-0000-0000-000000000031') = 2,
          'E4 the shipment is confirmed with its carton plan squared');
SELECT is(pg_temp.ledger('c3c20000-0000-0000-0000-000000000003'), 'TP3-A:warehouse_finished:1:24,TP3-C:warehouse_raw:1:5',
          'E5 the ledger gets one row per SKU, as receive-all always wrote');

-- =============================================================
-- F. A group partly checked in before minting was switched on
-- =============================================================
SELECT pg_temp.as_super();
UPDATE wh_settings SET value = value || '{"mint_lpns": false}'::jsonb WHERE key = 'physical_layer';
SELECT pg_temp.as_user('c3c00000-0000-0000-0000-000000000002');
SELECT rpc_record_freight_receipt('c3c20000-0000-0000-0000-000000000004',
  '[{"carton_group_id":"c3c30000-0000-0000-0000-000000000041","cartons":1}]'::jsonb, 'c3c00000-0000-0000-0000-000000000002');
SELECT pg_temp.as_super();
UPDATE wh_settings SET value = value || '{"mint_lpns": true}'::jsonb WHERE key = 'physical_layer';
SELECT pg_temp.as_user('c3c00000-0000-0000-0000-000000000002');
SELECT rpc_record_freight_receipt('c3c20000-0000-0000-0000-000000000004',
  '[{"carton_group_id":"c3c30000-0000-0000-0000-000000000041","cartons":1}]'::jsonb, 'c3c00000-0000-0000-0000-000000000002');
SELECT set_config('wht.f1', rpc_record_freight_receipt('c3c20000-0000-0000-0000-000000000004',
  '[{"carton_group_id":"c3c30000-0000-0000-0000-000000000041","cartons":-2}]'::jsonb,
  'c3c00000-0000-0000-0000-000000000002')::text, true);
SELECT ok(jsonb_array_length(pg_temp.v('f1')->'voided') = 1 AND pg_temp.v('f1')->'voided'->0->>'code' = 'C-TP3904-001'
          AND pg_temp.v('f1')->'unlocated' = '[]'::jsonb AND pg_temp.v('f1')->>'units_credited' = '-24',
          'F1 a −2 voids the one LPN and reverses the carton checked in before minting in the ledger only');
SELECT is(pg_temp.physical('c3c20000-0000-0000-0000-000000000004'), 'TP3-A:0',
          'F2 the physical layer is back to zero, as the ledger is');

SELECT pg_temp.as_super();
SELECT * FROM finish();
ROLLBACK;
