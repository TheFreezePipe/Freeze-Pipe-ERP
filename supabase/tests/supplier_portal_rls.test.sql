-- =============================================================
-- Supplier Portal RLS + RPC test suite (pgTAP)
-- =============================================================
-- Covers the security-critical surface introduced in migrations 020 + 021.
-- Run with: supabase test db
--
-- Test strategy:
--   1. Seed two suppliers (Nancy, YX) where Nancy consolidates for YX.
--   2. Seed one internal admin, one supplier user per supplier.
--   3. Use SET LOCAL role + request.jwt.claims to simulate each caller,
--      then assert what they can / can't see and do.
--
-- Areas tested (highest-risk first):
--   A. Scenario 4 — YX cannot see Nancy's koozie BOM (visibility leak)
--   B. Breakage reporter must consolidate for producer (trigger)
--   C. Optimistic concurrency — version conflicts rejected
--   D. Idempotency replay returns existing row, doesn't duplicate
--   E. Cross-supplier insertion blocked at RLS
--   F. Append-only tables reject UPDATE/DELETE of immutable fields
--   G. 'one active user per supplier' MVP rule
--
-- Not covered here (deferred): full happy-path create→advance→ship→receive
-- end-to-end. Those are integration tests for the hooks layer.

BEGIN;

SELECT plan(18);

-- =============================================================
-- Test fixtures
-- =============================================================
-- We insert directly (bypassing RLS as the test harness runs as superuser),
-- then switch to authenticated role with a specific JWT for each test.

-- Suppliers
INSERT INTO suppliers (id, name, is_producer, is_filler, is_export_broker, consolidates_for)
VALUES
  ('11111111-1111-1111-1111-111111111111', 'Nancy', true, true, true, ARRAY[]::UUID[]),
  ('22222222-2222-2222-2222-222222222222', 'YX',    true, false, false, ARRAY[]::UUID[]);

-- After insert, wire Nancy as consolidator for YX (circular FK avoided by post-insert UPDATE)
UPDATE suppliers SET consolidates_for = ARRAY['22222222-2222-2222-2222-222222222222'::UUID]
 WHERE id = '11111111-1111-1111-1111-111111111111';

-- Auth users (auth.users) — use minimal inserts; real flows use Supabase signup
INSERT INTO auth.users (id, email)
VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'admin@test.local'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'nancy@test.local'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'yx@test.local');

-- Profiles — the role trigger may auto-create these; assume we can UPSERT.
INSERT INTO profiles (id, role, supplier_id, is_active)
VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'admin',    NULL, true),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'supplier', '11111111-1111-1111-1111-111111111111', true),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'supplier', '22222222-2222-2222-2222-222222222222', true)
ON CONFLICT (id) DO UPDATE
  SET role = EXCLUDED.role, supplier_id = EXCLUDED.supplier_id, is_active = true;

-- SKUs — one YX-produced coil, one Nancy-assembled bowl that uses the coil + a koozie
INSERT INTO product_skus (id, sku, product_name, category, is_active)
VALUES
  ('d1111111-1111-1111-1111-111111111111', 'BW21P-COIL', 'Coil for BW21P', 'component', true),
  ('d2222222-2222-2222-2222-222222222222', 'BW20',       'Bowl BW20',      'product',   true),
  ('d3333333-3333-3333-3333-333333333333', 'KZ-BLU',     'Blue Koozie',    'consumable', true);

-- Location: Nancy's facility
INSERT INTO locations (id, name, owner_supplier_id)
VALUES ('e1111111-1111-1111-1111-111111111111', 'Nancy Dock', '11111111-1111-1111-1111-111111111111');

-- BOM: BW20 = 1 × coil (produced by YX, assembled by Nancy)
--           + 1 × koozie (consumable at Nancy's location)
INSERT INTO product_boms (parent_sku_id, component_sku_id, component_type,
                          units_per_parent, assembled_at_supplier_id, component_location_id)
VALUES
  ('d2222222-2222-2222-2222-222222222222', 'd1111111-1111-1111-1111-111111111111',
   'produced', 1, '11111111-1111-1111-1111-111111111111', NULL),
  ('d2222222-2222-2222-2222-222222222222', 'd3333333-3333-3333-3333-333333333333',
   'consumable_inventory', 1, '11111111-1111-1111-1111-111111111111',
   'e1111111-1111-1111-1111-111111111111');

-- Helper: set the JWT so auth.uid() returns the desired user id
CREATE OR REPLACE FUNCTION _as_user(p_uid UUID) RETURNS VOID AS $$
BEGIN
  PERFORM set_config('request.jwt.claims',
    jsonb_build_object('sub', p_uid::TEXT, 'role', 'authenticated')::TEXT, true);
  PERFORM set_config('role', 'authenticated', true);
END;
$$ LANGUAGE plpgsql;

-- =============================================================
-- A. Scenario 4 — YX cannot see Nancy's BOM rows
-- =============================================================
SELECT _as_user('cccccccc-cccc-cccc-cccc-cccccccccccc');  -- YX user

SELECT is(
  (SELECT COUNT(*)::INTEGER FROM product_boms),
  0,
  'A1: YX sees zero product_boms rows (Nancy assembles all BOMs in fixtures)'
);

-- Sanity: Nancy DOES see her BOM rows
SELECT _as_user('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');  -- Nancy user
SELECT is(
  (SELECT COUNT(*)::INTEGER FROM product_boms),
  2,
  'A2: Nancy sees both BOM rows she assembles'
);

-- =============================================================
-- B. Breakage reporter must consolidate for producer
-- =============================================================
SELECT _as_user('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');  -- admin bypass for fixture setup

-- Create a YX factory order for coils
INSERT INTO factory_orders (id, supplier_id, order_date, expected_completion, status)
VALUES ('f1111111-1111-1111-1111-111111111111',
        '22222222-2222-2222-2222-222222222222',
        CURRENT_DATE, CURRENT_DATE + 30, 'in_production');

INSERT INTO factory_order_items (id, factory_order_id, sku_id, quantity_ordered)
VALUES ('aa111111-1111-1111-1111-111111111111',
        'f1111111-1111-1111-1111-111111111111',
        'd1111111-1111-1111-1111-111111111111', 100);

-- Test: Nancy files breakage against YX — should succeed
SELECT lives_ok($$
  INSERT INTO component_breakage_reports
    (factory_order_item_id, producing_supplier_id, reporter_supplier_id, sku_id,
     quantity_broken, reason_category, description, created_by)
  VALUES
    ('aa111111-1111-1111-1111-111111111111',
     '22222222-2222-2222-2222-222222222222',
     '11111111-1111-1111-1111-111111111111',
     'd1111111-1111-1111-1111-111111111111',
     5, 'crushed_in_transit', 'Test damage', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')
$$, 'B1: Nancy (consolidator) CAN file breakage against YX (producer)');

-- Test: YX tries to file breakage against Nancy — should fail (YX doesn't consolidate)
SELECT throws_ok($$
  INSERT INTO component_breakage_reports
    (factory_order_item_id, producing_supplier_id, reporter_supplier_id, sku_id,
     quantity_broken, reason_category, description, created_by)
  VALUES
    ('aa111111-1111-1111-1111-111111111111',
     '11111111-1111-1111-1111-111111111111',
     '22222222-2222-2222-2222-222222222222',
     'd1111111-1111-1111-1111-111111111111',
     5, 'other', 'Not allowed', 'cccccccc-cccc-cccc-cccc-cccccccccccc')
$$, NULL, 'reporter_supplier_id (22222222-2222-2222-2222-222222222222) does not consolidate for producing_supplier_id (11111111-1111-1111-1111-111111111111)', 'B2: YX CANNOT file breakage against Nancy (not consolidator)');

-- Self-reports rejected by chk_breakage_distinct_parties
SELECT throws_ok($$
  INSERT INTO component_breakage_reports
    (factory_order_item_id, producing_supplier_id, reporter_supplier_id, sku_id,
     quantity_broken, reason_category, description, created_by)
  VALUES
    ('aa111111-1111-1111-1111-111111111111',
     '22222222-2222-2222-2222-222222222222',
     '22222222-2222-2222-2222-222222222222',
     'd1111111-1111-1111-1111-111111111111',
     5, 'other', 'Self report', 'cccccccc-cccc-cccc-cccc-cccccccccccc')
$$, '23514', NULL, 'B3: Self-reports blocked by chk_breakage_distinct_parties');

-- =============================================================
-- C. Optimistic concurrency — stale version rejected
-- =============================================================
SELECT _as_user('cccccccc-cccc-cccc-cccc-cccccccccccc');  -- YX user

SELECT is(
  ((SELECT rpc_supplier_advance_factory_order(
     'f1111111-1111-1111-1111-111111111111',
     999 -- stale version
   ))->>'error'),
  'version_conflict',
  'C1: Stale row_version returns error=version_conflict'
);

-- With correct version, advance works
SELECT is(
  ((SELECT rpc_supplier_advance_factory_order(
     'f1111111-1111-1111-1111-111111111111',
     (SELECT row_version FROM factory_orders WHERE id = 'f1111111-1111-1111-1111-111111111111')
   ))->>'ok')::BOOLEAN,
  true,
  'C2: Current row_version succeeds'
);

-- =============================================================
-- D. Idempotency replay
-- =============================================================
SELECT _as_user('cccccccc-cccc-cccc-cccc-cccccccccccc');  -- YX

-- First call creates
WITH r AS (
  SELECT rpc_supplier_create_factory_order(jsonb_build_object(
    'idempotency_key', '99999999-9999-9999-9999-999999999999',
    'expected_completion', (CURRENT_DATE + 30)::TEXT,
    'notes', 'Idempotency test',
    'items', jsonb_build_array(jsonb_build_object(
      'sku_id', 'd1111111-1111-1111-1111-111111111111',
      'quantity', 50))
  )) AS res
)
SELECT is((SELECT (res->>'ok')::BOOLEAN FROM r), true, 'D1: First create succeeds');

-- Replay with same key returns replayed=true and same id
WITH r AS (
  SELECT rpc_supplier_create_factory_order(jsonb_build_object(
    'idempotency_key', '99999999-9999-9999-9999-999999999999',
    'expected_completion', (CURRENT_DATE + 30)::TEXT,
    'notes', 'Idempotency test replay',
    'items', jsonb_build_array(jsonb_build_object(
      'sku_id', 'd1111111-1111-1111-1111-111111111111',
      'quantity', 50))
  )) AS res
)
SELECT is((SELECT (res->>'replayed')::BOOLEAN FROM r), true, 'D2: Replay returns replayed=true');

-- Only one row created despite two calls
SELECT is(
  (SELECT COUNT(*)::INTEGER FROM factory_orders
    WHERE idempotency_key = '99999999-9999-9999-9999-999999999999'),
  1,
  'D3: Exactly one factory_orders row despite replay'
);

-- =============================================================
-- E. Cross-supplier insertion blocked at RLS
-- =============================================================
-- YX tries to INSERT a factory_order with supplier_id = Nancy. The insert
-- policy's WITH CHECK rejects it.
SELECT _as_user('cccccccc-cccc-cccc-cccc-cccccccccccc');  -- YX

SELECT throws_ok($$
  INSERT INTO factory_orders (supplier_id, order_date, expected_completion, status)
  VALUES ('11111111-1111-1111-1111-111111111111',
          CURRENT_DATE, CURRENT_DATE + 30, 'ordered')
$$, '42501', NULL, 'E1: YX cannot INSERT a factory_order with Nancy as supplier (RLS block)');

-- =============================================================
-- F. Append-only tables reject immutable-field UPDATE
-- =============================================================
SELECT _as_user('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');  -- admin (can see rows)

-- Insert a variance row directly for the test
INSERT INTO shipment_variances
  (id, freight_line_item_id, shipment_id, sku_id, origin_supplier_id,
   declared_quantity, received_quantity, variance_type, created_by)
SELECT '77777777-7777-7777-7777-777777777777',
       gen_random_uuid(),  -- fake FK-safe id via a tangential insert below
       gen_random_uuid(),
       'd1111111-1111-1111-1111-111111111111',
       '22222222-2222-2222-2222-222222222222',
       100, 95, 'shortage',
       'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
WHERE false;  -- deliberately skipped: full FK fixture is heavier than value of this test
-- (covered more meaningfully by the status-transition test once freight
-- fixtures are in place; we assert the simpler trigger behavior instead)

-- Instead test the breakage report append-only trigger with real data:
SELECT throws_ok($$
  UPDATE component_breakage_reports
     SET quantity_broken = 999
   WHERE reporter_supplier_id = '11111111-1111-1111-1111-111111111111'
$$, 'P0001', NULL, 'F1: Mutating quantity_broken on breakage report is rejected by trigger');

-- DELETE is blocked
SELECT throws_ok($$
  DELETE FROM component_breakage_reports
   WHERE reporter_supplier_id = '11111111-1111-1111-1111-111111111111'
$$, 'P0001', NULL, 'F2: DELETE on component_breakage_reports is rejected');

-- Status-only update is permitted
SELECT lives_ok($$
  UPDATE component_breakage_reports
     SET status = 'acknowledged',
         acknowledged_at = now(),
         acknowledged_by = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
   WHERE reporter_supplier_id = '11111111-1111-1111-1111-111111111111'
$$, 'F3: Status / acknowledgment UPDATE is permitted');

-- =============================================================
-- G. 'One active supplier user per supplier' MVP rule
-- =============================================================
-- Create a second auth user and try to promote — should fail.
INSERT INTO auth.users (id, email) VALUES
  ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'yx2@test.local');
INSERT INTO profiles (id, role, supplier_id, is_active)
VALUES ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'user', NULL, true)
ON CONFLICT (id) DO UPDATE SET role = 'user', supplier_id = NULL, is_active = true;

SELECT _as_user('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');  -- admin

SELECT is(
  (SELECT rpc_promote_user_to_supplier(
    'dddddddd-dddd-dddd-dddd-dddddddddddd',
    '22222222-2222-2222-2222-222222222222'
  )->>'error'),
  'supplier_already_has_active_user',
  'G1: Cannot promote a second user to supplier when one is already active'
);

-- After deactivating the first, the second should succeed
SELECT is(
  (SELECT (rpc_set_profile_active(
    'cccccccc-cccc-cccc-cccc-cccccccccccc', false
  )->>'ok')::BOOLEAN),
  true,
  'G2: Deactivate existing supplier user succeeds'
);

SELECT is(
  (SELECT (rpc_promote_user_to_supplier(
    'dddddddd-dddd-dddd-dddd-dddddddddddd',
    '22222222-2222-2222-2222-222222222222'
  )->>'ok')::BOOLEAN),
  true,
  'G3: Promote second user after first deactivated succeeds'
);

-- Admin cannot deactivate themselves
SELECT is(
  (SELECT rpc_set_profile_active(
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', false
  )->>'error'),
  'cannot_deactivate_self',
  'G4: Admin self-deactivation is blocked'
);

SELECT * FROM finish();
ROLLBACK;
