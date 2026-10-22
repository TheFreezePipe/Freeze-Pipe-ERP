-- =============================================================
-- Warehouse module Phase 1, slice 1 test suite (pgTAP)
-- =============================================================
-- Covers migrations 20261022000001-20261022000005 (layout, stock,
-- tasks, RPCs, realtime). Synthetic fixtures only (faces 91/92/95,
-- racks T91/T92, SKUs TP1-*); everything rolls back.
-- Run with: supabase test db
--
-- Areas tested:
--   A. Generator on a two-face rack template: codes, pickable levels,
--      overflow, interleaved pick_sequence, idempotent re-run
--   B. Opening stock import mints C-OB cartons (dry run, apply)
--   C. Putaway with and without the suggestion, idempotent replay
--   D. Move stock: loose move, insufficient, ambiguous_bucket
--   E. Open a level-3 carton down to a pick face; not_pickable warning
--   F. Take a raw carton to the line
--   G. RTS relabel: two green children plus a loose remainder, parent
--      voided and superseded, putaways, one lpn_rts job on the station
--      printer, the parent's code resolves to the child
--   H. Counts: accept (ledger row, inventory_levels), misplaced
--      (UNLOCATED), zero variance approves itself; a user cannot approve
--   I. Write-off: bin and ledger together
--   J. Station sessions route label requests to the station printer
--   K. Print agent: two claims of one job, one winner; mark printed
--   L. RLS: a supplier reads no wh_* rows; no self-granted print agent

BEGIN;

SELECT plan(67);

-- =============================================================
-- Fixtures
-- =============================================================
INSERT INTO suppliers (id, code, name, is_producer, is_filler, is_export_broker, consolidates_for)
VALUES ('c1000000-0000-0000-0000-0000000000aa', 'WHP1', 'WH Phase 1 Test Supplier', true, false, false, ARRAY[]::uuid[]);

INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change, is_sso_user, is_anonymous)
SELECT '00000000-0000-0000-0000-000000000000', x.id, 'authenticated', 'authenticated', x.email, '', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', '', false, false
  FROM (VALUES
   ('c1000000-0000-0000-0000-000000000001'::uuid, 'wh1-admin@test.local'),
   ('c1000000-0000-0000-0000-000000000002', 'wh1-manager@test.local'),
   ('c1000000-0000-0000-0000-000000000003', 'wh1-user@test.local'),
   ('c1000000-0000-0000-0000-000000000004', 'wh1-supplier@test.local'),
   ('c1000000-0000-0000-0000-000000000005', 'wh1-agent@test.local')) AS x(id, email)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE profiles DISABLE TRIGGER USER;
INSERT INTO profiles (id, email, full_name, role, is_active, supplier_id, is_print_agent) VALUES
  ('c1000000-0000-0000-0000-000000000001', 'wh1-admin@test.local',    'Ada Admin',     'admin',    true, NULL, false),
  ('c1000000-0000-0000-0000-000000000002', 'wh1-manager@test.local',  'Mia Manager',   'manager',  true, NULL, false),
  ('c1000000-0000-0000-0000-000000000003', 'wh1-user@test.local',     'Devon Floor',   'user',     true, NULL, false),
  ('c1000000-0000-0000-0000-000000000004', 'wh1-supplier@test.local', 'Sam Supplier',  'supplier', true, 'c1000000-0000-0000-0000-0000000000aa', false),
  ('c1000000-0000-0000-0000-000000000005', 'wh1-agent@test.local',    'Print Agent',   'user',     true, NULL, true)
ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, is_active = true, supplier_id = EXCLUDED.supplier_id,
                               full_name = EXCLUDED.full_name, is_print_agent = EXCLUDED.is_print_agent;
ALTER TABLE profiles ENABLE TRIGGER USER;

INSERT INTO product_skus (id, sku, product_name, category, display_category, standard_quantity_per_carton) VALUES
  ('c2000000-0000-0000-0000-000000000001', 'TP1-A',   'Test finished A', 'non_fillable', 'Accessories', 12),
  ('c2000000-0000-0000-0000-000000000002', 'TP1-B',   'Test fillable B', 'fillable',     'Pipes',       10),
  ('c2000000-0000-0000-0000-000000000003', 'TP1-RAW', 'Test raw',        'fillable',     'Pipes',       10);
UPDATE inventory_levels SET warehouse_finished = 100 WHERE sku_id = 'c2000000-0000-0000-0000-000000000001';

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
-- run a statement and return 'ok' or the error text
CREATE OR REPLACE FUNCTION pg_temp.try_sql(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN
  RETURN SQLERRM;
END; $$;
CREATE OR REPLACE FUNCTION pg_temp.loc(p_code text) RETURNS uuid LANGUAGE sql AS $$
  SELECT id FROM wh_locations WHERE code = p_code;
$$;
CREATE OR REPLACE FUNCTION pg_temp.v(p_key text) RETURNS jsonb LANGUAGE sql AS $$
  SELECT NULLIF(current_setting('wht.' || p_key, true), '')::jsonb;
$$;

-- =============================================================
-- A. Layout and the generator
-- =============================================================
SELECT pg_temp.as_user('c1000000-0000-0000-0000-000000000001');
SELECT set_config('wht.layout', rpc_wh_save_layout('{
  "templates":[{"code":"T-PR","name":"Test pallet rack","kind":"pallet_rack","bays":3,"levels":3,
                "bay_width_mm":2743,"depth_mm":1067,"level_heights_mm":[0,1372,2743],
                "overflow_top_level":true,"capacity_cartons_per_level":4}],
  "racks":[{"code":"T91","template_code":"T-PR","x_mm":0,"y_mm":6000,"rot_deg":90},
           {"code":"T92","template_code":"T-PR","x_mm":4000,"y_mm":7000,"rot_deg":90}],
  "faces":[{"rack_code":"T91","face_code":"91","side":"east","aisle":"Z","walk_pass":80,"walk_dir":"S","zone_by_bay":["RTS"]},
           {"rack_code":"T92","face_code":"92","side":"west","aisle":"Z","walk_pass":80,"walk_dir":"S","zone_by_bay":["RTS"]},
           {"rack_code":"T92","face_code":"95","side":"east","aisle":"Y","walk_pass":81,"walk_dir":"N","zone_by_bay":["RAW"]}]
}'::jsonb)::text, true);
SELECT is(pg_temp.v('layout')->>'ok', 'true', 'A0 admin saves a layout of two racks and three faces');

SELECT is(jsonb_array_length(rpc_wh_generate_locations((SELECT id FROM wh_racks WHERE code = 'T91'), true)->'create'), 9,
          'A1 dry run on a 3-bay, 3-level face proposes 9 bay-levels');
SELECT is((SELECT count(*)::int FROM wh_locations WHERE face IN ('91', '92', '95')), 0, 'A2 a dry run writes nothing');
SELECT is((rpc_wh_generate_locations((SELECT id FROM wh_racks WHERE code = 'T91'), false))->>'created', '9', 'A3 applying T91 creates 9');
SELECT is((rpc_wh_generate_locations((SELECT id FROM wh_racks WHERE code = 'T92'), false))->>'created', '18', 'A4 applying T92 (two faces) creates 18');
SELECT ok((SELECT pickable AND NOT is_overflow FROM wh_locations WHERE code = '91-01-1')
      AND (SELECT is_overflow AND NOT pickable FROM wh_locations WHERE code = '91-01-3')
      AND (SELECT NOT pickable FROM wh_locations WHERE code = '95-01-2'),
          'A5 levels 1-2 of RTS are pickable, level 3 is overflow, RAW is not pickable');
SELECT is((SELECT string_agg(code, ',' ORDER BY pick_sequence) FROM wh_locations WHERE face IN ('91', '92') AND level = 1),
          '91-01-1,92-01-1,91-02-1,92-02-1,91-03-1,92-03-1', 'A6 facing faces of one walk pass interleave');
SELECT is((SELECT pick_sequence FROM wh_locations WHERE code = '91-01-1'), 80011, 'A7 pick_sequence = pass x 1000 + rank x 10 + level');
SELECT ok((SELECT y_mm FROM wh_locations WHERE code = '95-01-1') > (SELECT y_mm FROM wh_locations WHERE code = '95-03-1')
          AND (SELECT string_agg(code, ',' ORDER BY pick_sequence) FROM wh_locations WHERE face = '95' AND level = 1) = '95-01-1,95-02-1,95-03-1',
          'A8 a north-walking face numbers bay 01 at its south end and walks it first');
SELECT ok((SELECT jsonb_array_length(r->'create') = 0 AND jsonb_array_length(r->'conflicts') = 0 AND r->'update' ? '91-01-1'
             FROM (SELECT rpc_wh_generate_locations(NULL, true) AS r) s),
          'A9 re-running the generator proposes only in-place updates');

-- =============================================================
-- B. Opening stock import
-- =============================================================
SELECT is((rpc_wh_import_stock('[
   {"sku":"TP1-A","location":"91-01-3","sealed_cartons":2,"units_per_carton":12},
   {"sku":"TP1-A","location":"91-02-1","sealed_cartons":0,"open_units":7},
   {"sku":"TP1-RAW","location":"95-01-1","sealed_cartons":1,"units_per_carton":10,"bucket":"raw"},
   {"sku":"TP1-A","location":"IN-01","sealed_cartons":2,"units_per_carton":12},
   {"sku":"NOPE","location":"91-01-1","sealed_cartons":1}]'::jsonb, true))->'rejected'->0->>'error',
          'unknown_sku', 'B1 the dry run rejects an unknown SKU');
SELECT is((rpc_wh_import_stock('[
   {"sku":"TP1-A","location":"91-01-3","sealed_cartons":2,"units_per_carton":12},
   {"sku":"TP1-A","location":"91-02-1","sealed_cartons":0,"open_units":7},
   {"sku":"TP1-RAW","location":"95-01-1","sealed_cartons":1,"units_per_carton":10,"bucket":"raw"},
   {"sku":"TP1-A","location":"IN-01","sealed_cartons":2,"units_per_carton":12}]'::jsonb, false))->>'cartons',
          '6', 'B2 applying mints 6 cartons');
SELECT is((SELECT count(*)::int FROM wh_containers WHERE code LIKE 'C-OB-%' AND sku_id IN
            ('c2000000-0000-0000-0000-000000000001', 'c2000000-0000-0000-0000-000000000003')), 6, 'B3 the cartons carry C-OB codes');
SELECT is((SELECT sum(on_hand)::int FROM wh_inventory_balances WHERE location_id = pg_temp.loc('91-01-3') AND bucket = 'finished'),
          24, 'B4 overflow 91-01-3 holds two sealed cartons of 12');
SELECT is((SELECT state FROM wh_containers WHERE location_id = pg_temp.loc('91-02-1')), 'open', 'B5 open units become one open carton');
SELECT is((SELECT count(*)::int FROM inventory_transactions WHERE sku_id = 'c2000000-0000-0000-0000-000000000001'), 0,
          'B6 opening stock writes no ledger row');

-- =============================================================
-- C. Putaway
-- =============================================================
SELECT pg_temp.as_super();
INSERT INTO wh_moves (kind, origin, container_id, from_location_id)
SELECT 'putaway', 'receipt', c.id, c.location_id FROM wh_containers c WHERE c.location_id = pg_temp.loc('IN-01')
   AND c.sku_id = 'c2000000-0000-0000-0000-000000000001';
SELECT set_config('wht.in1', to_jsonb((SELECT id FROM wh_containers WHERE location_id = pg_temp.loc('IN-01') ORDER BY code LIMIT 1))::text, true);
SELECT set_config('wht.in2', to_jsonb((SELECT id FROM wh_containers WHERE location_id = pg_temp.loc('IN-01') ORDER BY code DESC LIMIT 1))::text, true);
SELECT pg_temp.as_user('c1000000-0000-0000-0000-000000000003');

SELECT is((rpc_wh_suggest_putaway((pg_temp.v('in1')#>>'{}')::uuid, '{}'))->'suggestion'->>'code', '91-01-3',
          'C1 a sealed carton is suggested to the same-SKU reserve');
SELECT set_config('wht.put1', rpc_wh_putaway_container((pg_temp.v('in1')#>>'{}')::uuid, pg_temp.loc('91-01-3'), NULL,
                                                       'c3000000-0000-0000-0000-000000000001')::text, true);
SELECT ok((pg_temp.v('put1')->>'followed_suggestion')::boolean
          AND (SELECT location_id FROM wh_containers WHERE id = (pg_temp.v('in1')#>>'{}')::uuid) = pg_temp.loc('91-01-3')
          AND (SELECT status FROM wh_moves WHERE container_id = (pg_temp.v('in1')#>>'{}')::uuid) = 'done',
          'C2 putaway to the suggestion moves the carton and closes the task as followed');
SELECT is((rpc_wh_putaway_container((pg_temp.v('in1')#>>'{}')::uuid, pg_temp.loc('91-01-3'), NULL,
                                    'c3000000-0000-0000-0000-000000000001'))->>'duplicate', 'true',
          'C3 the same client_event_id replays the first result');
SELECT is((rpc_wh_putaway_container((pg_temp.v('in2')#>>'{}')::uuid, pg_temp.loc('92-03-2')))->>'followed_suggestion', 'false',
          'C4 a putaway elsewhere is accepted and recorded as not followed');
SELECT is((rpc_wh_putaway_container((pg_temp.v('in2')#>>'{}')::uuid, pg_temp.loc('UNLOCATED')))->>'error', 'location_not_storable',
          'C5 a virtual location is refused');
SELECT is((rpc_wh_putaway_container((pg_temp.v('in2')#>>'{}')::uuid, pg_temp.loc('92-03-2')))->>'error', 'already_there',
          'C6 putting a carton where it already is is refused');

-- =============================================================
-- D. Move stock
-- =============================================================
SELECT is((rpc_wh_move_stock('c2000000-0000-0000-0000-000000000001', 3, pg_temp.loc('91-02-1'), pg_temp.loc('92-01-1'),
                             (SELECT id FROM wh_containers WHERE location_id = pg_temp.loc('91-02-1'))))->>'available_after', '4',
          'D1 three units leave the open carton for loose stock');
SELECT is((rpc_wh_move_stock('c2000000-0000-0000-0000-000000000001', 50, pg_temp.loc('91-02-1'), pg_temp.loc('92-01-1'),
                             (SELECT id FROM wh_containers WHERE location_id = pg_temp.loc('91-02-1'))))->>'error', 'insufficient',
          'D2 moving more than is there is insufficient');
SELECT pg_temp.as_super();
SELECT _wh_post_movement(gen_random_uuid(), 'opening_balance', 'c2000000-0000-0000-0000-000000000002', 'raw', 3,
                         NULL, NULL, pg_temp.loc('92-02-1'), NULL, NULL, 'c1000000-0000-0000-0000-000000000001', NULL, NULL, 'test');
SELECT _wh_post_movement(gen_random_uuid(), 'opening_balance', 'c2000000-0000-0000-0000-000000000002', 'finished', 2,
                         NULL, NULL, pg_temp.loc('92-02-1'), NULL, NULL, 'c1000000-0000-0000-0000-000000000001', NULL, NULL, 'test');
SELECT pg_temp.as_user('c1000000-0000-0000-0000-000000000003');
SELECT is((rpc_wh_move_stock('c2000000-0000-0000-0000-000000000002', 1, pg_temp.loc('92-02-1'), pg_temp.loc('92-02-2')))->>'error',
          'ambiguous_bucket', 'D3 two buckets at the source need an explicit bucket');

-- =============================================================
-- E. Open a level-3 carton down to the pick face
-- =============================================================
SELECT set_config('wht.opened', to_jsonb((SELECT id FROM wh_containers WHERE location_id = pg_temp.loc('91-01-3') AND state = 'sealed' ORDER BY code LIMIT 1))::text, true);
SELECT set_config('wht.open1', rpc_wh_open_container((pg_temp.v('opened')#>>'{}')::uuid, pg_temp.loc('91-01-2'))::text, true);
SELECT ok(pg_temp.v('open1')->>'ok' = 'true' AND pg_temp.v('open1')->>'warning' IS NULL
          AND (SELECT state = 'open' AND location_id = pg_temp.loc('91-01-2') AND qty = 12 FROM wh_containers WHERE id = (pg_temp.v('opened')#>>'{}')::uuid),
          'E1 the carton moves to the pick face and opens');
SELECT is((rpc_wh_open_container((SELECT id FROM wh_containers WHERE location_id = pg_temp.loc('91-01-3') AND state = 'sealed' ORDER BY code LIMIT 1),
                                 pg_temp.loc('95-02-1')))->>'warning', 'not_pickable', 'E2 opening onto a non-pickable bay warns');

-- =============================================================
-- F. Take a raw carton to the line
-- =============================================================
SELECT set_config('wht.parent', to_jsonb((SELECT id FROM wh_containers WHERE location_id = pg_temp.loc('95-01-1')))::text, true);
SELECT set_config('wht.ttl', rpc_wh_take_to_line((pg_temp.v('parent')#>>'{}')::uuid)::text, true);
SELECT ok(pg_temp.v('ttl')->>'units' = '10'
          AND (SELECT location_id FROM wh_containers WHERE id = (pg_temp.v('parent')#>>'{}')::uuid) = pg_temp.loc('MFG-LINE')
          AND (SELECT on_hand FROM wh_inventory_balances WHERE location_id = pg_temp.loc('95-01-1') AND container_id = (pg_temp.v('parent')#>>'{}')::uuid) = 0,
          'F1 the carton and its 10 raw units move to MFG-LINE and the bay is released');
SELECT is((rpc_wh_take_to_line((pg_temp.v('parent')#>>'{}')::uuid))->>'error', 'already_at_line', 'F2 a carton already at the line is refused');

-- =============================================================
-- G. RTS relabel
-- =============================================================
SELECT is((rpc_wh_rts_relabel('c2000000-0000-0000-0000-000000000003', '[{"qty":4}]'::jsonb))->>'dormant', 'true',
          'G0 the relabel is dormant before physical_layer.live_since');
SELECT pg_temp.as_super();
UPDATE wh_settings SET value = value || '{"live_since":"2026-01-01T00:00:00Z"}'::jsonb WHERE key = 'physical_layer';
UPDATE wh_settings SET value = '{"mode":"live"}'::jsonb WHERE key = 'outbound';
INSERT INTO wh_printers (code, name, station_location_id, transport, label_stock, agent_id) VALUES
  ('TEST-MFG-G1', 'Test mfg green', pg_temp.loc('ST-MFG-1'), 'agent', 'green_4x2', 'agent-mfg'),
  ('TEST-MFG-W1', 'Test mfg white', pg_temp.loc('ST-MFG-1'), 'agent', 'white_4x2', 'agent-mfg'),
  ('TEST-DOCK-W1', 'Test dock white', pg_temp.loc('ST-DOCK'), 'agent', 'white_4x2', 'agent-dock');
-- the line empties the raw carton and RTS's its contents (the ledger mirror's job in a later slice)
SELECT _wh_post_movement(gen_random_uuid(), 'bucket_convert', 'c2000000-0000-0000-0000-000000000003', 'raw', 10,
                         pg_temp.loc('MFG-LINE'), (pg_temp.v('parent')#>>'{}')::uuid, pg_temp.loc('MFG-LINE'), NULL, 'finished',
                         'c1000000-0000-0000-0000-000000000003', NULL, NULL, 'test: emptied, filled and RTS');
-- the SKU's pick face holds loose finished units
SELECT _wh_post_movement(gen_random_uuid(), 'opening_balance', 'c2000000-0000-0000-0000-000000000003', 'finished', 5,
                         NULL, NULL, pg_temp.loc('92-01-2'), NULL, NULL, 'c1000000-0000-0000-0000-000000000001', NULL, NULL, 'test');
SELECT pg_temp.as_user('c1000000-0000-0000-0000-000000000003');
SELECT is((rpc_wh_start_station('%ST-MFG-1'))->'session'->>'code', 'ST-MFG-1', 'G1 a worker scans into Mfg desk 1');
SELECT set_config('wht.rts', rpc_wh_rts_relabel('c2000000-0000-0000-0000-000000000003',
  '[{"qty":4,"state":"sealed"},{"qty":4,"state":"sealed"},{"qty":2,"loose":true}]'::jsonb,
  (pg_temp.v('parent')#>>'{}')::uuid, NULL, 'c3000000-0000-0000-0000-000000000002')::text, true);
SELECT is(jsonb_array_length(pg_temp.v('rts')->'containers'), 2, 'G2 two green cartons are minted');
SELECT is(pg_temp.v('rts')->'containers'->1->>'code',
          (SELECT code FROM wh_containers WHERE id = (pg_temp.v('parent')#>>'{}')::uuid) || 'R2', 'G3 children are the parent code plus R<n>');
SELECT ok((SELECT state = 'void' AND superseded_by = (pg_temp.v('rts')->'containers'->0->>'id')::uuid
             FROM wh_containers WHERE id = (pg_temp.v('parent')#>>'{}')::uuid),
          'G4 the drained parent is void and superseded by the first child');
SELECT is((SELECT count(*)::int FROM wh_containers
            WHERE parent_container_id = (pg_temp.v('parent')#>>'{}')::uuid AND label_stock = 'green' AND state = 'sealed'
              AND location_id = pg_temp.loc('MFG-LINE') AND qty = 4 AND finished_by = 'c1000000-0000-0000-0000-000000000003'),
          2, 'G5 both children sit green and sealed at MFG-LINE with 4 units and the worker');
SELECT is((SELECT count(*)::int FROM wh_moves WHERE origin = 'rts' AND kind = 'putaway' AND status = 'open' AND container_id IN
            (SELECT id FROM wh_containers WHERE parent_container_id = (pg_temp.v('parent')#>>'{}')::uuid)),
          2, 'G6 each child has an open RTS putaway');
SELECT ok((SELECT kind = 'lpn_rts' AND cardinality(item_ids) = 2 AND printer_id = (SELECT id FROM wh_printers WHERE code = 'TEST-MFG-G1')
             FROM wh_print_jobs WHERE id = (pg_temp.v('rts')->>'print_job_id')::uuid),
          'G7 one lpn_rts job for both children goes to the station''s green printer');
SELECT ok((SELECT on_hand FROM wh_inventory_balances WHERE location_id = pg_temp.loc('92-01-2') AND container_id IS NULL
             AND sku_id = 'c2000000-0000-0000-0000-000000000003' AND bucket = 'finished') = 7
          AND (SELECT on_hand FROM wh_inventory_balances WHERE location_id = pg_temp.loc('MFG-LINE') AND container_id IS NULL
                 AND sku_id = 'c2000000-0000-0000-0000-000000000003' AND bucket = 'finished') = 0,
          'G8 the loose remainder joins the pick face and nothing is left at the line');
SELECT ok((SELECT r->>'kind' = 'container' AND r->>'id' = pg_temp.v('rts')->'containers'->0->>'id' AND (r->>'superseded')::boolean
             FROM (SELECT rpc_wh_resolve_scan('%' || (SELECT code FROM wh_containers WHERE id = (pg_temp.v('parent')#>>'{}')::uuid)) AS r) s),
          'G9 scanning the parent''s white label resolves to the green child');
SELECT is((rpc_wh_rts_relabel('c2000000-0000-0000-0000-000000000003', '[{"qty":4}]'::jsonb, NULL, NULL,
                              'c3000000-0000-0000-0000-000000000002'))->>'duplicate', 'true', 'G10 a repeated relabel replays');
SELECT is((rpc_wh_rts_relabel('c2000000-0000-0000-0000-000000000003', '[{"qty":4}]'::jsonb))->>'error', 'insufficient_at_line',
          'G11 a relabel without finished units at the line is refused');
SELECT is((rpc_wh_putaway_container((pg_temp.v('rts')->'containers'->0->>'id')::uuid,
                                    (pg_temp.v('rts')->'containers'->0->'suggested'->>'location_id')::uuid))->>'followed_suggestion',
          'true', 'G12 the first green carton is placed in its suggested bay');

-- =============================================================
-- H. Counts and variance approval
-- =============================================================
SELECT set_config('wht.cnt1', rpc_wh_record_count(pg_temp.loc('91-01-2'),
  jsonb_build_array(jsonb_build_object('container_id', pg_temp.v('opened')#>>'{}', 'counted_qty', 10, 'scan_value', 'test')))::text, true);
SELECT ok(pg_temp.v('cnt1')->>'status' = 'submitted' AND NOT (pg_temp.v('cnt1')->'lines'->0 ? 'expected_qty')
          AND NOT (pg_temp.v('cnt1')->'lines'->0 ? 'variance'),
          'H1 a short count is submitted and the phone never sees expected quantities');
SELECT is((rpc_wh_approve_variance((pg_temp.v('cnt1')->>'count_task_id')::uuid, '[]'::jsonb))->>'error', 'forbidden',
          'H2 a floor user cannot approve a variance');
SELECT pg_temp.as_user('c1000000-0000-0000-0000-000000000002');
SELECT set_config('wht.appr1', rpc_wh_approve_variance((pg_temp.v('cnt1')->>'count_task_id')::uuid, '[]'::jsonb)::text, true);
SELECT ok(pg_temp.v('appr1')->>'adjusted_units' = '2' AND pg_temp.v('appr1')->>'levels_delta' = '-2',
          'H3 a manager accepts: two units adjusted, levels move by the variance');
SELECT ok(EXISTS (SELECT 1 FROM inventory_transactions
                   WHERE transaction_type = 'wh_count_adjust' AND reference_type = 'wh_count_task'
                     AND reference_id = (pg_temp.v('cnt1')->>'count_task_id')::uuid AND quantity = -2
                     AND field_affected = 'warehouse_finished' AND row_hash IS NOT NULL),
          'H4 accept writes a hash-chained wh_count_adjust ledger row');
SELECT is((SELECT warehouse_finished FROM inventory_levels WHERE sku_id = 'c2000000-0000-0000-0000-000000000001'), 98,
          'H5 inventory_levels.warehouse_finished moved from 100 to 98');
SELECT is((SELECT on_hand FROM wh_inventory_balances WHERE container_id = (pg_temp.v('opened')#>>'{}')::uuid AND location_id = pg_temp.loc('91-01-2')),
          10, 'H6 the bin is set to the counted 10');
SELECT set_config('wht.cnt2', rpc_wh_record_count(pg_temp.loc('92-01-1'),
  '[{"sku_id":"c2000000-0000-0000-0000-000000000001","counted_qty":5}]'::jsonb)::text, true);
SELECT is((rpc_wh_approve_variance((pg_temp.v('cnt2')->>'count_task_id')::uuid,
            jsonb_build_array(jsonb_build_object('line_id', pg_temp.v('cnt2')->'lines'->0->>'id', 'resolution', 'misplaced'))))->>'levels_delta',
          '0', 'H7 misplaced leaves the SKU total alone');
SELECT is((SELECT on_hand FROM wh_inventory_balances WHERE location_id = pg_temp.loc('UNLOCATED')
             AND sku_id = 'c2000000-0000-0000-0000-000000000001' AND bucket = 'finished'), -2,
          'H8 the two found units come from UNLOCATED');
SELECT is((SELECT count(*)::int FROM inventory_transactions WHERE reference_id = (pg_temp.v('cnt2')->>'count_task_id')::uuid), 0,
          'H9 misplaced writes no ledger row');
SELECT set_config('wht.cnt3', rpc_wh_record_count(pg_temp.loc('91-03-1'), '[]'::jsonb)::text, true);
SELECT ok(pg_temp.v('cnt3')->>'status' = 'approved'
          AND (SELECT last_counted_at IS NOT NULL FROM wh_locations WHERE code = '91-03-1'),
          'H10 a count with no variance approves itself and stamps last_counted_at');

-- =============================================================
-- I. Write-off
-- =============================================================
SELECT pg_temp.as_user('c1000000-0000-0000-0000-000000000003');
SELECT set_config('wht.wo', rpc_wh_write_off('c2000000-0000-0000-0000-000000000001', pg_temp.loc('92-01-1'), NULL, 1, 'dropped')::text, true);
SELECT ok(pg_temp.v('wo')->>'ok' = 'true'
          AND (SELECT warehouse_finished FROM inventory_levels WHERE sku_id = 'c2000000-0000-0000-0000-000000000001') = 97
          AND (SELECT on_hand FROM wh_inventory_balances WHERE location_id = pg_temp.loc('92-01-1') AND container_id IS NULL
                 AND sku_id = 'c2000000-0000-0000-0000-000000000001') = 4,
          'I1 a write-off takes the unit from the bin and the SKU total together');
SELECT ok(EXISTS (SELECT 1 FROM inventory_transactions WHERE id = (pg_temp.v('wo')->>'ledger_tx_id')::uuid
                   AND transaction_type = 'wh_write_off' AND movement_kind = 'write_off' AND quantity = 1 AND from_field = 'warehouse_finished'),
          'I2 the write-off ledger row is stored positive with movement_kind write_off');

-- =============================================================
-- J. Stations and label routing
-- =============================================================
SELECT pg_temp.as_user('c1000000-0000-0000-0000-000000000002');
SELECT is((rpc_wh_start_station('%ST-DOCK'))->'session'->>'code', 'ST-DOCK', 'J1 a manager scans into the dock station');
SELECT set_config('wht.dockjob', rpc_wh_request_labels('lpn', ARRAY[(pg_temp.v('opened')#>>'{}')::uuid], 'phone')::text, true);
SELECT ok(pg_temp.v('dockjob')->>'target' = 'printer' AND pg_temp.v('dockjob')->'printer'->>'code' = 'TEST-DOCK-W1',
          'J2 a phone request prints at the dock printer');
SELECT set_config('wht.st2', rpc_wh_start_station('%ST-MFG-2')::text, true);
SELECT set_config('wht.req2', rpc_wh_request_labels('lpn', ARRAY[(pg_temp.v('opened')#>>'{}')::uuid], 'phone')::text, true);
SELECT ok(pg_temp.v('st2')->>'ended_previous' IS NOT NULL
          AND (SELECT count(*) FROM wh_station_sessions WHERE profile_id = 'c1000000-0000-0000-0000-000000000002' AND ended_at IS NULL) = 1
          AND pg_temp.v('req2')->>'target' = 'browser' AND pg_temp.v('req2')->>'routed_by' = 'no_matching_printer',
          'J3 scanning another station ends the old session; a station without a printer falls back to the browser');

-- =============================================================
-- K. Print agent claims
-- =============================================================
SELECT is((rpc_wh_claim_print_jobs(ARRAY[(SELECT id FROM wh_printers WHERE code = 'TEST-DOCK-W1')], 'agent-dock'))->>'error', 'forbidden',
          'K1 a manager is not a print agent');
SELECT pg_temp.as_user('c1000000-0000-0000-0000-000000000005');
SELECT is(jsonb_array_length((rpc_wh_claim_print_jobs(ARRAY[(SELECT id FROM wh_printers WHERE code = 'TEST-DOCK-W1')], 'agent-dock'))->'jobs'), 1,
          'K2 the first agent claims the dock job');
SELECT is(jsonb_array_length((rpc_wh_claim_print_jobs(ARRAY[(SELECT id FROM wh_printers WHERE code = 'TEST-DOCK-W1')], 'agent-other'))->'jobs'), 0,
          'K3 a second claim of the same job wins nothing');
SELECT set_config('wht.mp', rpc_wh_mark_printed((pg_temp.v('dockjob')->>'job_id')::uuid, 'printed')::text, true);
SELECT ok(pg_temp.v('mp')->>'status' = 'printed'
          AND (SELECT print_count FROM wh_containers WHERE id = (pg_temp.v('opened')#>>'{}')::uuid) = 1,
          'K4 the agent marks it printed and the carton''s print count rises');

-- =============================================================
-- L. RLS and the print-agent flag
-- =============================================================
SELECT pg_temp.as_user('c1000000-0000-0000-0000-000000000004');
SELECT is((SELECT count(*)::int FROM wh_locations), 0, 'L1 a supplier reads no locations');
SELECT is((SELECT count(*)::int FROM wh_inventory_balances) + (SELECT count(*)::int FROM wh_containers)
          + (SELECT count(*)::int FROM wh_inventory_movements), 0, 'L2 a supplier reads no balances, cartons or movements');
SELECT is((SELECT count(*)::int FROM wh_location_summary) + (SELECT count(*)::int FROM wh_print_jobs)
          + (SELECT count(*)::int FROM wh_moves) + (SELECT count(*)::int FROM wh_count_tasks), 0,
          'L3 a supplier reads no summary, print jobs, moves or counts');
SELECT is((rpc_wh_resolve_scan('%91-01-1'))->>'error', 'internal role required', 'L4 a supplier cannot resolve scans');
SELECT pg_temp.as_user('c1000000-0000-0000-0000-000000000003');
SELECT ok((SELECT count(*) FROM wh_location_summary WHERE face = '91') = 9, 'L5 a floor user reads the location summary');
SELECT ok(pg_temp.try_sql('UPDATE profiles SET is_print_agent = true WHERE id = ''c1000000-0000-0000-0000-000000000003''') LIKE '%is_print_agent%',
          'L6 a user cannot make themselves a print agent');

SELECT pg_temp.as_super();
SELECT * FROM finish();
ROLLBACK;
