-- =============================================================
-- Warehouse module Phase 1, carton label pair (4x6) test suite (pgTAP)
-- =============================================================
-- Covers migration 20261028000001 (wh_labels_4x6). Synthetic fixtures
-- only (SKU TL6-A, cartons C-TL6-*, printers TL6-*); everything rolls
-- back.
-- Run with: supabase test db
--
-- Areas tested:
--   A. Printer stock: white_4x6 and green_4x6 are accepted by
--      rpc_wh_save_printer and the table CHECK; white_4x8 is refused
--   B. The labels setting: lpn is 4x2 or 4x6, location is 3x1, dpi as
--      before; admin only
--   C. _wh_label_payload: size follows labels.lpn, copies is 2 for a 4x6
--      carton label (lpn and lpn_rts), 1 otherwise; p_copies overrides
--   D. rpc_wh_request_labels p_copies: 1-5, invalid_copies otherwise,
--      stored on the job's payload; named arguments
--   E. _wh_queue_print_job routes a 4x6 carton job to the station's
--      white_4x6 (green_4x6 for RTS) printer, never to a 4x2 one, and
--      says "no white 4x6 printer" when the station has none; the
--      five-argument call of the receipt and RTS relabel still resolves
--   F. One overload of each re-created function, grants as before

BEGIN;

SELECT plan(34);

-- Staging may carry live printers (DOCK-1 at ST-DOCK); routing prefers an
-- active station printer, so park them for the duration of this transaction.
UPDATE wh_printers SET active = false;
UPDATE wh_settings SET value = '{"mode":"live"}'::jsonb WHERE key = 'outbound';
UPDATE wh_settings SET value = '{"lpn":"4x2","location":"3x1","dpi":203}'::jsonb WHERE key = 'labels';

-- =============================================================
-- Fixtures
-- =============================================================
INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change, is_sso_user, is_anonymous)
SELECT '00000000-0000-0000-0000-000000000000', x.id, 'authenticated', 'authenticated', x.email, '', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', '', false, false
  FROM (VALUES
   ('c6a00000-0000-0000-0000-000000000001'::uuid, 'whl6-admin@test.local'),
   ('c6a00000-0000-0000-0000-000000000002', 'whl6-user@test.local')) AS x(id, email)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE profiles DISABLE TRIGGER USER;
INSERT INTO profiles (id, email, full_name, role, is_active, supplier_id, is_print_agent) VALUES
  ('c6a00000-0000-0000-0000-000000000001', 'whl6-admin@test.local', 'Ada Admin',   'admin', true, NULL, false),
  ('c6a00000-0000-0000-0000-000000000002', 'whl6-user@test.local',  'Devon Floor', 'user',  true, NULL, false)
ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, is_active = true, supplier_id = NULL, full_name = EXCLUDED.full_name;
ALTER TABLE profiles ENABLE TRIGGER USER;

INSERT INTO product_skus (id, sku, product_name, category, display_category, standard_quantity_per_carton) VALUES
  ('c6a10000-0000-0000-0000-000000000001', 'TL6-A', 'Test label A', 'non_fillable', 'Accessories', 12);

-- one white carton at receiving, one green RTS carton at the line
INSERT INTO wh_containers (id, code, sku_id, qty_initial, qty, state, location_id, source, label_stock) VALUES
  ('c6a20000-0000-0000-0000-000000000001', 'C-TL6-001', 'c6a10000-0000-0000-0000-000000000001', 12, 12, 'sealed',
   (SELECT id FROM wh_locations WHERE code = 'IN-01'), 'manual', 'white'),
  ('c6a20000-0000-0000-0000-000000000002', 'C-TL6-002', 'c6a10000-0000-0000-0000-000000000001', 4, 4, 'sealed',
   (SELECT id FROM wh_locations WHERE code = 'MFG-LINE'), 'manufacturing', 'green');

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
CREATE OR REPLACE FUNCTION pg_temp.job_payload(p_result jsonb) RETURNS jsonb LANGUAGE sql AS $$
  SELECT payload FROM wh_print_jobs WHERE id = (p_result->>'job_id')::uuid;
$$;

-- =============================================================
-- A. Printer stock
-- =============================================================
SELECT pg_temp.as_user('c6a00000-0000-0000-0000-000000000001');
SELECT set_config('wht.pw6', rpc_wh_save_printer('{"code":"TL6-W6","name":"Test 4x6 white","transport":"agent",
  "address":"tcp://10.0.0.61:9100","label_stock":"white_4x6","station_code":"ST-S1","agent_id":"agent-l6"}'::jsonb)::text, true);
SELECT is(pg_temp.v('pw6')->'printer'->>'label_stock', 'white_4x6', 'A1 an admin registers a white 4x6 printer');
SELECT set_config('wht.pg6', rpc_wh_save_printer('{"code":"TL6-G6","name":"Test 4x6 green","transport":"agent",
  "address":"tcp://10.0.0.62:9100","label_stock":"green_4x6","station_code":"ST-S1","agent_id":"agent-l6"}'::jsonb)::text, true);
SELECT is(pg_temp.v('pg6')->'printer'->>'label_stock', 'green_4x6', 'A2 and a green 4x6 printer');
SELECT set_config('wht.pbad', rpc_wh_save_printer('{"code":"TL6-W8","transport":"browser","label_stock":"white_4x8"}'::jsonb)::text, true);
SELECT is(pg_temp.v('pbad')->>'error', 'invalid_label_stock', 'A3 white_4x8 is not a label stock');
SELECT ok(pg_temp.v('pbad')->>'message' LIKE '%white_4x6%' AND pg_temp.v('pbad')->>'message' LIKE '%green_4x6%',
          'A4 the refusal lists the 4x6 stocks');
SELECT pg_temp.as_super();
SELECT ok(pg_temp.try_sql('INSERT INTO wh_printers (code, name, transport, label_stock) VALUES (''TL6-BAD'', ''Bad'', ''browser'', ''white_4x8'')')
            LIKE '%chk_wh_printers_label_stock%',
          'A5 the table CHECK refuses white_4x8 too');

-- =============================================================
-- B. The labels setting
-- =============================================================
SELECT pg_temp.as_user('c6a00000-0000-0000-0000-000000000001');
SELECT is((rpc_wh_set_setting('labels', '{"lpn":"4x6"}'::jsonb))->>'ok', 'true', 'B1 labels.lpn 4x6 is accepted');
SELECT is((rpc_wh_set_setting('labels', '{"lpn":"4x8"}'::jsonb))->>'error', 'invalid_value', 'B2 labels.lpn 4x8 is refused');
SELECT is((rpc_wh_set_setting('labels', '{"location":"4x2"}'::jsonb))->>'error', 'invalid_value', 'B3 labels.location must be 3x1');
SELECT is((rpc_wh_set_setting('labels', '{"lpn":"4x2","location":"3x1","dpi":203}'::jsonb))->>'ok', 'true',
          'B4 the staging shape (4x2, 3x1, 203 dpi) is accepted');
SELECT is((rpc_wh_set_setting('labels', '{"lpn":"4x6","dpi":150}'::jsonb))->>'error', 'invalid_value', 'B5 dpi is validated as before');
SELECT is((SELECT value->>'lpn' FROM wh_settings WHERE key = 'labels'), '4x2', 'B6 a refused value leaves the setting alone');
SELECT pg_temp.as_user('c6a00000-0000-0000-0000-000000000002');
SELECT is((rpc_wh_set_setting('labels', '{"lpn":"4x6"}'::jsonb))->>'error', 'admin role required', 'B7 a floor user cannot change the label size');

-- =============================================================
-- C. The payload: size and copies
-- =============================================================
SELECT pg_temp.as_super();
SELECT ok((SELECT p->>'size' = '4x2' AND p->>'copies' = '1' AND jsonb_array_length(p->'labels') = 1
             FROM (SELECT _wh_label_payload('lpn', ARRAY['c6a20000-0000-0000-0000-000000000001'::uuid], false) AS p) s),
          'C1 with labels.lpn 4x2 a carton label is 4x2, one copy');
UPDATE wh_settings SET value = value || '{"lpn":"4x6"}'::jsonb WHERE key = 'labels';
SELECT ok((SELECT p->>'size' = '4x6' AND p->>'copies' = '2'
             FROM (SELECT _wh_label_payload('lpn', ARRAY['c6a20000-0000-0000-0000-000000000001'::uuid], false) AS p) s),
          'C2 with labels.lpn 4x6 a carton label is a 4x6 pair');
SELECT ok((SELECT p->>'size' = '4x6' AND p->>'copies' = '2'
             FROM (SELECT _wh_label_payload('lpn_rts', ARRAY['c6a20000-0000-0000-0000-000000000002'::uuid], false) AS p) s),
          'C3 an RTS carton label is a 4x6 pair too');
SELECT ok((SELECT p->>'size' = '3x1' AND p->>'copies' = '1'
             FROM (SELECT _wh_label_payload('location', ARRAY[pg_temp.loc('IN-01')], false) AS p) s),
          'C4 a location label stays 3x1, one copy');
SELECT is((_wh_label_payload('lpn', ARRAY['c6a20000-0000-0000-0000-000000000001'::uuid], false, 1))->>'copies', '1',
          'C5 p_copies overrides the pair');
SELECT ok((SELECT p->'labels'->0->>'barcode' = '%ZC-TL6-001' AND p->'labels'->0->>'contents' = 'TL6-A'
                  AND p->'labels'->0->>'qty' = '12' AND p->>'practice' = 'true'
             FROM (SELECT _wh_label_payload('lpn', ARRAY['c6a20000-0000-0000-0000-000000000001'::uuid], true) AS p) s),
          'C6 the label lines are unchanged (practice barcode, contents, units)');
UPDATE wh_settings SET value = value - 'lpn' WHERE key = 'labels';
SELECT ok((SELECT p->>'size' = '4x2' AND p->>'copies' = '1'
             FROM (SELECT _wh_label_payload('lpn', ARRAY['c6a20000-0000-0000-0000-000000000001'::uuid], false) AS p) s),
          'C7 an unset labels.lpn means 4x2');
UPDATE wh_settings SET value = value || '{"lpn":"4x6"}'::jsonb WHERE key = 'labels';

-- =============================================================
-- D. rpc_wh_request_labels p_copies
-- =============================================================
SELECT pg_temp.as_user('c6a00000-0000-0000-0000-000000000002');
SELECT set_config('wht.d1', rpc_wh_request_labels('lpn', ARRAY['c6a20000-0000-0000-0000-000000000001'::uuid], 'desktop', NULL, NULL, 1)::text, true);
SELECT ok(pg_temp.v('d1')->>'ok' = 'true' AND pg_temp.v('d1')->'payload'->>'copies' = '1' AND pg_temp.v('d1')->'payload'->>'size' = '4x6'
          AND pg_temp.job_payload(pg_temp.v('d1'))->>'copies' = '1',
          'D1 p_copies 1 queues one 4x6 label (Reprint one)');
SELECT set_config('wht.d2', rpc_wh_request_labels('lpn', ARRAY['c6a20000-0000-0000-0000-000000000001'::uuid], 'desktop')::text, true);
SELECT ok(pg_temp.v('d2')->'payload'->>'copies' = '2' AND pg_temp.job_payload(pg_temp.v('d2'))->>'copies' = '2',
          'D2 without p_copies the job carries the pair');
SELECT is((rpc_wh_request_labels('lpn', ARRAY['c6a20000-0000-0000-0000-000000000001'::uuid], 'desktop', NULL, NULL, 9))->>'error',
          'invalid_copies', 'D3 nine copies is refused');
SELECT is((rpc_wh_request_labels('lpn', ARRAY['c6a20000-0000-0000-0000-000000000001'::uuid], 'desktop', NULL, NULL, 0))->>'error',
          'invalid_copies', 'D4 zero copies is refused');
SELECT is((rpc_wh_request_labels(p_kind => 'lpn', p_ids => ARRAY['c6a20000-0000-0000-0000-000000000001'::uuid],
                                 p_from => 'phone', p_copies => 3))->'payload'->>'copies',
          '3', 'D5 named arguments reach p_copies without p_printer_id or p_target');

-- =============================================================
-- E. Routing by stock
-- =============================================================
SELECT pg_temp.as_super();
INSERT INTO wh_printers (code, name, station_location_id, transport, address, label_stock, agent_id) VALUES
  ('TL6-W2',  'Test 4x2 white mfg', pg_temp.loc('ST-MFG-4'), 'agent', 'tcp://10.0.0.63:9100', 'white_4x2', 'agent-l6'),
  ('TL6-W2B', 'Test 4x2 white S1',  pg_temp.loc('ST-S1'),    'agent', 'tcp://10.0.0.64:9100', 'white_4x2', 'agent-l6');
SELECT pg_temp.as_user('c6a00000-0000-0000-0000-000000000002');
SELECT rpc_wh_start_station('%ST-MFG-4');
SELECT set_config('wht.e1', rpc_wh_request_labels('lpn', ARRAY['c6a20000-0000-0000-0000-000000000001'::uuid], 'phone')::text, true);
SELECT ok(pg_temp.v('e1')->>'target' = 'browser' AND pg_temp.v('e1')->>'routed_by' = 'no_matching_printer'
          AND pg_temp.v('e1')->>'message' = 'This station has no white 4x6 printer; print from this browser.',
          'E1 a station with only a white 4x2 printer sends a 4x6 carton job to the browser, naming white 4x6');
SELECT rpc_wh_start_station('%ST-S1');
SELECT set_config('wht.e2', rpc_wh_request_labels('lpn', ARRAY['c6a20000-0000-0000-0000-000000000001'::uuid], 'phone')::text, true);
SELECT ok(pg_temp.v('e2')->>'target' = 'printer' AND pg_temp.v('e2')->'printer'->>'code' = 'TL6-W6'
          AND (SELECT printer_id FROM wh_print_jobs WHERE id = (pg_temp.v('e2')->>'job_id')::uuid) = (SELECT id FROM wh_printers WHERE code = 'TL6-W6'),
          'E2 at a station with both, the 4x6 carton job goes to the white 4x6 printer, not the 4x2');
SELECT set_config('wht.e3', rpc_wh_request_labels('lpn_rts', ARRAY['c6a20000-0000-0000-0000-000000000002'::uuid], 'workspace')::text, true);
SELECT ok(pg_temp.v('e3')->>'target' = 'printer' AND pg_temp.v('e3')->'printer'->>'code' = 'TL6-G6',
          'E3 an RTS job goes to the green 4x6 printer');
SELECT pg_temp.as_super();
SELECT set_config('wht.e4', _wh_queue_print_job('lpn', ARRAY['c6a20000-0000-0000-0000-000000000001'::uuid], 'dock', NULL,
                                                'c6a00000-0000-0000-0000-000000000002', NULL, 1)::text, true);
SELECT ok(pg_temp.v('e4')->'printer'->>'code' = 'TL6-W6' AND pg_temp.v('e4')->'payload'->>'copies' = '1'
          AND pg_temp.job_payload(pg_temp.v('e4'))->>'copies' = '1',
          'E4 _wh_queue_print_job passes p_copies to the payload');
SELECT set_config('wht.e5', _wh_queue_print_job('lpn_rts', ARRAY['c6a20000-0000-0000-0000-000000000002'::uuid], 'workspace', NULL,
                                                'c6a00000-0000-0000-0000-000000000002')::text, true);
SELECT ok(pg_temp.v('e5')->'printer'->>'code' = 'TL6-G6' AND pg_temp.v('e5')->'payload'->>'copies' = '2'
          AND pg_temp.v('e5')->'payload'->>'size' = '4x6',
          'E5 the five-argument call (LPN receipt, RTS relabel) still resolves and prints the pair');
UPDATE wh_settings SET value = value || '{"lpn":"4x2"}'::jsonb WHERE key = 'labels';
SELECT pg_temp.as_user('c6a00000-0000-0000-0000-000000000002');
SELECT set_config('wht.e6', rpc_wh_request_labels('lpn', ARRAY['c6a20000-0000-0000-0000-000000000001'::uuid], 'phone')::text, true);
SELECT ok(pg_temp.v('e6')->'printer'->>'code' = 'TL6-W2B' AND pg_temp.v('e6')->'payload'->>'size' = '4x2'
          AND pg_temp.v('e6')->'payload'->>'copies' = '1',
          'E6 back on 4x2 the same station routes to its white 4x2 printer, one copy');
SELECT set_config('wht.e7', rpc_wh_request_labels('location', ARRAY[pg_temp.loc('IN-01')], 'phone')::text, true);
SELECT is(pg_temp.v('e7')->>'message', 'This station has no white 3x1 printer; print from this browser.',
          'E7 location labels still look for white 3x1');

-- =============================================================
-- F. Signatures and grants
-- =============================================================
SELECT pg_temp.as_super();
SELECT is((SELECT count(*)::int FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'rpc_wh_request_labels'), 1,
          'F1 rpc_wh_request_labels has exactly one overload (PostgREST can choose)');
SELECT is((SELECT array_agg(proname || '(' || pg_get_function_identity_arguments(oid) || ')' ORDER BY proname)
             FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('_wh_label_payload', '_wh_queue_print_job')),
          ARRAY['_wh_label_payload(p_kind text, p_ids uuid[], p_practice boolean, p_copies integer)',
                '_wh_queue_print_job(p_kind text, p_ids uuid[], p_from text, p_printer_id uuid, p_actor uuid, p_target text, p_copies integer)'],
          'F2 one payload builder and one queue function, both with p_copies');
SELECT ok(has_function_privilege('authenticated', 'public.rpc_wh_request_labels(text, uuid[], text, uuid, text, integer)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.rpc_wh_request_labels(text, uuid[], text, uuid, text, integer)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public._wh_label_payload(text, uuid[], boolean, integer)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public._wh_queue_print_job(text, uuid[], text, uuid, uuid, text, integer)', 'EXECUTE'),
          'F3 authenticated may request labels; the helpers stay private; anon gets nothing');

SELECT pg_temp.as_super();
SELECT * FROM finish();
ROLLBACK;
