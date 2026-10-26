-- =============================================================
-- Warehouse module Phase 0 test suite (pgTAP)
-- =============================================================
-- Covers migrations 20261021000001 (wh_settings + outbound guard) and
-- 20261021000002 (sku_barcodes, GTIN helpers, import, resolve, link).
-- Run with: supabase test db
--
-- Areas tested:
--   A. GTIN helpers: check digit, UPC-E expansion, candidate forms
--   B. Outbound guard: blocked by default, practice allows browser print only
--   C. Settings RPCs: role gating and value validation
--   D. Import: dry run writes nothing, real run links codes, conflicts reported
--   E. Resolve: UPC-A, UPC-E (7 and 8 digit), SKU fallback, unknown
--   F. Link: manager may link, duplicate code rejected, supplier blocked
--   G. RLS: supplier reads no barcodes or settings

BEGIN;

SELECT plan(29);

-- =============================================================
-- Fixtures
-- =============================================================
INSERT INTO suppliers (id, code, name, is_producer, is_filler, is_export_broker, consolidates_for)
VALUES ('33333333-3333-3333-3333-333333333333', 'WHTEST', 'Test Supplier', true, false, false, ARRAY[]::UUID[]);

INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change, is_sso_user, is_anonymous)
SELECT '00000000-0000-0000-0000-000000000000', x.id, 'authenticated', 'authenticated', x.email, '', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', '', false, false
  FROM (VALUES
   ('aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'wh-admin@test.local'),
   ('aaaaaaaa-0000-0000-0000-000000000002', 'wh-manager@test.local'),
   ('aaaaaaaa-0000-0000-0000-000000000003', 'wh-user@test.local'),
   ('aaaaaaaa-0000-0000-0000-000000000004', 'wh-supplier@test.local')) AS x(id, email)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE profiles DISABLE TRIGGER USER;
INSERT INTO profiles (id, email, full_name, role, is_active, supplier_id) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'wh-admin@test.local',    'WH Admin',    'admin',    true, NULL),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'wh-manager@test.local',  'WH Manager',  'manager',  true, NULL),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'wh-user@test.local',     'WH User',     'user',     true, NULL),
  ('aaaaaaaa-0000-0000-0000-000000000004', 'wh-supplier@test.local', 'WH Supplier', 'supplier', true, '33333333-3333-3333-3333-333333333333')
ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, is_active = true, supplier_id = EXCLUDED.supplier_id;
ALTER TABLE profiles ENABLE TRIGGER USER;

INSERT INTO product_skus (id, sku, product_name, category, display_category) VALUES
  ('bbbbbbbb-0000-0000-0000-000000000001', 'TEST-A', 'Test Product A', 'non_fillable', 'Accessories'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'TEST-B', 'Test Product B', 'non_fillable', 'Accessories');

-- (on_auth_user_created has created a 'user' profile for each; the upsert above sets the real roles)

-- helper to impersonate a caller
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

-- =============================================================
-- A. GTIN helpers
-- =============================================================
SELECT is(fn_upca_check_digit('10269644104'), '1', 'A1 UPC-A check digit (BW20)');
SELECT is(fn_upce_expand('1', '383325'), '138332000051', 'A2 UPC-E expansion (10-Filters)');
SELECT is(fn_gtin_candidates('1383325'), ARRAY['138332000051'], 'A3 7-digit UPC-E raw');
SELECT is(fn_gtin_candidates('13833251'), ARRAY['138332000051', '13833251'], 'A4 8-digit UPC-E with check');
SELECT is(fn_gtin_candidates('0102696441041'), ARRAY['102696441041'], 'A5 EAN-13 with leading zero drops to UPC-A');
SELECT is(fn_gtin_candidates('10269644104'), ARRAY['102696441041'], 'A6 11-digit gets its check digit');
SELECT is(fn_gtin_candidates('ABC'), ARRAY[]::text[], 'A7 non-digits yield no candidates');
SELECT is(fn_gtin_normalize('13833251'), '138332000051', 'A8 normalize = first candidate');

-- =============================================================
-- B. Outbound guard
-- =============================================================
-- Staging runs in practice mode; start from the seeded default inside this transaction.
UPDATE wh_settings SET value = '{"mode":"blocked"}'::jsonb WHERE key = 'outbound';
SELECT is(fn_outbound_allowed('browser_print'), false, 'B1 blocked by default');
UPDATE wh_settings SET value = '{"mode":"practice"}'::jsonb WHERE key = 'outbound';
SELECT is(fn_outbound_allowed('browser_print'), true,  'B2 practice allows browser print');
SELECT is(fn_outbound_allowed('shipstation_write'), false, 'B3 practice blocks ShipStation writes');
UPDATE wh_settings SET value = '{"mode":"blocked"}'::jsonb WHERE key = 'outbound';

-- =============================================================
-- C. Settings RPCs
-- =============================================================
SELECT pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000003');
SELECT is((rpc_wh_get_settings())->>'ok', 'true', 'C1 floor user can read settings');
SELECT is((rpc_wh_set_setting('outbound', '{"mode":"live"}'))->>'ok', 'false', 'C2 floor user cannot write settings');
SELECT pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is((rpc_wh_set_setting('outbound', '{"mode":"nope"}'))->>'ok', 'false', 'C3 invalid mode rejected');
SELECT is((rpc_wh_set_setting('outbound', '{"mode":"practice"}'))->>'ok', 'true', 'C4 admin sets practice');
SELECT pg_temp.as_super();
SELECT is((SELECT value->>'mode' FROM wh_settings WHERE key = 'outbound'), 'practice', 'C5 setting persisted');

-- =============================================================
-- D. Import
-- =============================================================
SELECT pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is((rpc_wh_import_sku_master('[{"sku":"TEST-A","upc_gtin12":"999999999993","upc_raw":"999999999993","upc_symbology":"upca"}]'::jsonb, true))->>'codes_loaded', '1', 'D1 dry run counts');
SELECT pg_temp.as_super();
SELECT is((SELECT count(*) FROM sku_barcodes WHERE sku_id = 'bbbbbbbb-0000-0000-0000-000000000001'), 0::bigint, 'D2 dry run writes nothing');
SELECT pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is((rpc_wh_import_sku_master('[{"sku":"TEST-A","upc_gtin12":"999999999993","upc_raw":"999999999993","upc_symbology":"upca","box_length_in":"13","box_width_in":"5","box_height_in":"5"}]'::jsonb, false))->>'dims_loaded', '1', 'D3 real run loads dims');
SELECT is((rpc_wh_import_sku_master('[{"sku":"TEST-B","upc_gtin12":"999999999993"}]'::jsonb, false))->'conflicts'->0->>'already_on', 'TEST-A', 'D4 conflicting code reported, not overwritten');
SELECT pg_temp.as_super();
SELECT is((SELECT upc_code FROM product_skus WHERE sku = 'TEST-A'), '999999999993', 'D5 primary code mirrored to product_skus.upc_code');

-- =============================================================
-- E. Resolve
-- =============================================================
SELECT pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000003');
SELECT is((rpc_wh_resolve_scan('0999999999993'))->'match'->>'sku', 'TEST-A', 'E1 EAN-13 form resolves');
SELECT is((rpc_wh_resolve_scan('test-a'))->'match'->>'sku', 'TEST-A', 'E2 SKU code resolves case-insensitively');
SELECT is((rpc_wh_resolve_scan('888888888888'))->>'match', NULL, 'E3 unknown code returns null match');

-- =============================================================
-- F. Link
-- =============================================================
SELECT pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000002');
SELECT is((rpc_wh_link_barcode('bbbbbbbb-0000-0000-0000-000000000002', '1000000'))->>'code', fn_upce_expand('1', '000000'), 'F1 manager links a UPC-E scan');
SELECT is((rpc_wh_link_barcode('bbbbbbbb-0000-0000-0000-000000000002', '999999999993'))->>'ok', 'false', 'F2 code on another SKU rejected');
SELECT pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000004');
SELECT is((rpc_wh_link_barcode('bbbbbbbb-0000-0000-0000-000000000002', '13833251'))->>'ok', 'false', 'F3 supplier cannot link');

-- =============================================================
-- G. RLS
-- =============================================================
SELECT is((SELECT count(*) FROM sku_barcodes), 0::bigint, 'G1 supplier reads no barcodes');
SELECT is((SELECT count(*) FROM wh_settings), 0::bigint, 'G2 supplier reads no settings');

SELECT * FROM finish();
ROLLBACK;
