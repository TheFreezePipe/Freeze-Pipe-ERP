-- =============================================================
-- Migration 057: factory_orders parent link + BoM data + RPCs
-- =============================================================
-- Some SKUs are assembled at Nancy from a YX-produced sub-component.
-- BW58 takes 1× HT10, BW59 takes 1× HT10, BW62 takes 1× HT10 + 1× HT6,
-- BW63 takes 1× BW21-Revolver. Today these are placed as two
-- independent factory_orders (one to Nancy for the parent, one to
-- YX for the sub-component) with no schema-level link between them.
--
-- This migration delivers Phase 1A of the BoM-aware ordering work:
--
--   1. `factory_orders.parent_factory_order_id` — self-referential
--      nullable FK so a child YX order can point at the Nancy
--      parent order it fulfills. ON DELETE SET NULL — the child is
--      independent enough that deleting the parent shouldn't blow
--      away its component order.
--
--   2. `product_boms` rows for the four compound parents declared
--      above. Each row says "parent X needs N component Y, assembled
--      at supplier Z." Idempotent via the existing partial-unique
--      index on (parent_sku_id, component_sku_id) WHERE
--      effective_until IS NULL — re-running this migration won't
--      create duplicates.
--
--   3. `rpc_factory_order_component_status(p_factory_order_id)` —
--      returns the BoM-derived expected components and the actual
--      child orders that exist for a given parent factory_order. The
--      admin UI and Nancy supplier portal both call it. Authorization
--      check: caller must be internal staff OR the supplier that
--      owns the parent. Without this gating Nancy could query other
--      Nancy orders' YX dependencies (still hers) but not arbitrary
--      orders. Cross-supplier visibility (Nancy seeing YX child
--      data) is intentional — Nancy needs the YX order's status +
--      ETA to plan assembly.
--
--   4. `rpc_admin_link_factory_order_to_parent(child, parent)` and
--      `rpc_admin_unlink_factory_order_from_parent(child)` — admin-
--      only mutations to wire two existing orders together (or
--      break the link). Used by the linker UI on the order detail
--      page for backfill until Phase 2 (auto-create from dialog)
--      lands.
--
-- Naming nuance: the user's input was "BW58 -> HT10" without a
-- dash. The migration looks up SKUs by both spellings (HT10 first,
-- HT-10 fallback) so it works regardless of which the catalog uses
-- on staging. If neither resolves, the migration aborts loudly
-- with the missing SKU code.
-- =============================================================

-- -------------------------------------------------------------
-- Phase A: parent_factory_order_id column + constraints + index
-- -------------------------------------------------------------
ALTER TABLE factory_orders
  ADD COLUMN IF NOT EXISTS parent_factory_order_id UUID
    REFERENCES factory_orders(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_fo_no_self_parent'
      AND conrelid = 'factory_orders'::regclass
  ) THEN
    ALTER TABLE factory_orders
      ADD CONSTRAINT chk_fo_no_self_parent
      CHECK (parent_factory_order_id IS NULL OR parent_factory_order_id <> id);
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_factory_orders_parent
  ON factory_orders(parent_factory_order_id)
  WHERE parent_factory_order_id IS NOT NULL;

COMMENT ON COLUMN factory_orders.parent_factory_order_id IS
  'When this order fulfills a sub-component requirement of another order, the parent order id. Used for compound SKUs like BW58 (Nancy) which requires HT10 (YX). The parent and child are otherwise independent — child has its own status, ETA, supplier. ON DELETE SET NULL: deleting a parent does not cascade to children. One level of nesting only — enforced by the linker RPC (rpc_admin_link_factory_order_to_parent).';

-- -------------------------------------------------------------
-- Phase B: populate product_boms for the four compound parents
-- -------------------------------------------------------------
-- Top-level helper: resolve a SKU id by code, tolerant of dash-vs-no-
-- dash spelling (HT10 vs HT-10). Returns NULL if no match.
CREATE OR REPLACE FUNCTION migration_057_find_sku(v_code TEXT)
RETURNS UUID
LANGUAGE sql STABLE
AS $$
  SELECT id FROM product_skus WHERE sku = v_code
  UNION ALL
  SELECT id FROM product_skus WHERE sku = REPLACE(v_code, '-', '')
  UNION ALL
  SELECT id FROM product_skus WHERE sku = REGEXP_REPLACE(v_code, '([A-Z]+)([0-9]+)', '\1-\2')
  LIMIT 1;
$$;

DO $$
DECLARE
  v_nancy_id UUID;
  v_ht10_id UUID;
  v_ht6_id UUID;
  v_bw21rev_id UUID;
  v_parent_id UUID;
  v_pairs JSONB;
  v_pair JSONB;
  v_inserted INTEGER := 0;
BEGIN
  -- Resolve supplier ids
  SELECT id INTO v_nancy_id FROM suppliers WHERE code = 'NANCY';
  IF v_nancy_id IS NULL THEN
    RAISE EXCEPTION 'Migration 057: supplier code NANCY not found';
  END IF;

  -- Verify YX exists; we don't need its id for the BoM rows (the BoM
  -- says where the parent is *assembled*, not where the component is
  -- produced — the latter is resolved at order time via the component
  -- SKU's primary supplier_costs row), but we abort early if YX is
  -- missing so the operator knows.
  IF NOT EXISTS (SELECT 1 FROM suppliers WHERE code = 'YX') THEN
    RAISE EXCEPTION 'Migration 057: supplier code YX not found — populate suppliers first';
  END IF;

  -- Resolve component SKUs (try both spellings)
  v_ht10_id    := migration_057_find_sku('HT10');
  v_ht6_id     := migration_057_find_sku('HT6');
  v_bw21rev_id := migration_057_find_sku('BW21-Revolver');

  IF v_ht10_id IS NULL THEN
    RAISE EXCEPTION 'Migration 057: SKU HT10 / HT-10 not found in product_skus';
  END IF;
  IF v_ht6_id IS NULL THEN
    RAISE EXCEPTION 'Migration 057: SKU HT6 / HT-6 not found in product_skus';
  END IF;
  IF v_bw21rev_id IS NULL THEN
    RAISE EXCEPTION 'Migration 057: SKU BW21-Revolver not found in product_skus';
  END IF;

  -- Build the (parent, component, units) tuples and walk them. Each
  -- iteration upserts one BoM row idempotently (skip if an active row
  -- already exists for the pair).
  v_pairs := jsonb_build_array(
    jsonb_build_object('parent', 'BW58', 'component_id', v_ht10_id,    'units', 1),
    jsonb_build_object('parent', 'BW59', 'component_id', v_ht10_id,    'units', 1),
    jsonb_build_object('parent', 'BW62', 'component_id', v_ht10_id,    'units', 1),
    jsonb_build_object('parent', 'BW62', 'component_id', v_ht6_id,     'units', 1),
    jsonb_build_object('parent', 'BW63', 'component_id', v_bw21rev_id, 'units', 1)
  );

  FOR v_pair IN SELECT * FROM jsonb_array_elements(v_pairs) LOOP
    v_parent_id := migration_057_find_sku(v_pair->>'parent');
    IF v_parent_id IS NULL THEN
      RAISE EXCEPTION 'Migration 057: parent SKU % not found', v_pair->>'parent';
    END IF;

    IF EXISTS (
      SELECT 1 FROM product_boms
      WHERE parent_sku_id    = v_parent_id
        AND component_sku_id = (v_pair->>'component_id')::UUID
        AND effective_until IS NULL
    ) THEN
      RAISE NOTICE 'Migration 057: BoM row already exists for % -> % (skipping)',
        v_pair->>'parent', v_pair->>'component_id';
      CONTINUE;
    END IF;

    INSERT INTO product_boms (
      parent_sku_id, component_sku_id, units_per_parent,
      component_type, assembled_at_supplier_id
    ) VALUES (
      v_parent_id,
      (v_pair->>'component_id')::UUID,
      (v_pair->>'units')::INTEGER,
      'produced',
      v_nancy_id
    );
    v_inserted := v_inserted + 1;
  END LOOP;

  RAISE NOTICE 'Migration 057: inserted % new BoM row(s)', v_inserted;
END$$;

-- Drop the migration helper — single-use, don't pollute the public namespace.
DROP FUNCTION migration_057_find_sku(TEXT);

-- -------------------------------------------------------------
-- Phase C: rpc_factory_order_component_status
-- -------------------------------------------------------------
-- Returns BoM-derived expected components + actual child orders for
-- a given parent factory_order_id. Authorization: internal staff
-- (admin/manager/user) sees any order; suppliers see only orders
-- they own (supplier_id in jwt_supplier_scope()). Cross-supplier
-- child data leaks intentionally — Nancy must see YX HT10 status
-- + ETA on her BW58 order to plan assembly.
CREATE OR REPLACE FUNCTION rpc_factory_order_component_status(
  p_factory_order_id UUID
) RETURNS JSONB AS $$
DECLARE
  v_parent factory_orders%ROWTYPE;
  v_is_internal BOOLEAN;
  v_supplier_scope UUID[];
BEGIN
  SELECT * INTO v_parent FROM factory_orders WHERE id = p_factory_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'factory_order % not found', p_factory_order_id;
  END IF;

  v_is_internal := jwt_is_internal();
  IF NOT v_is_internal THEN
    v_supplier_scope := jwt_supplier_scope();
    IF NOT (v_parent.supplier_id = ANY(v_supplier_scope)) THEN
      RAISE EXCEPTION 'forbidden: caller does not own this order';
    END IF;
  END IF;

  RETURN jsonb_build_object(
    -- Expected components rolled up from BoM. quantity_needed =
    -- sum across line items of (item.quantity_ordered × bom.units_per_parent).
    'expected_components', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'component_sku_id', t.component_sku_id,
        'component_sku',    t.sku,
        'quantity_needed',  t.quantity_needed
      )), '[]'::JSONB)
      FROM (
        SELECT b.component_sku_id,
               sk.sku,
               SUM(foi.quantity_ordered * b.units_per_parent)::INTEGER AS quantity_needed
          FROM factory_order_items foi
          JOIN product_boms b
            ON b.parent_sku_id = foi.sku_id
           AND b.component_type = 'produced'
           AND b.effective_until IS NULL
          JOIN product_skus sk ON sk.id = b.component_sku_id
         WHERE foi.factory_order_id = p_factory_order_id
         GROUP BY b.component_sku_id, sk.sku
      ) t
    ),
    -- Actual child orders. For each, include its line items so the
    -- caller can compute fulfilled-vs-needed per component sku.
    'child_orders', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id',                  c.id,
        'order_number',        c.order_number,
        'supplier_id',         c.supplier_id,
        'supplier_code',       s.code,
        'supplier_name',       s.name,
        'status',              c.status,
        'order_date',          c.order_date,
        'expected_completion', c.expected_completion,
        'components', (
          SELECT COALESCE(jsonb_agg(jsonb_build_object(
            'sku_id',            ci.sku_id,
            'sku',               sk.sku,
            'quantity_ordered',  ci.quantity_ordered,
            'quantity_finished', ci.quantity_finished
          )), '[]'::JSONB)
          FROM factory_order_items ci
          JOIN product_skus sk ON sk.id = ci.sku_id
          WHERE ci.factory_order_id = c.id
        )
      )), '[]'::JSONB)
      FROM factory_orders c
      JOIN suppliers s ON s.id = c.supplier_id
      WHERE c.parent_factory_order_id = p_factory_order_id
    )
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION rpc_factory_order_component_status(UUID) TO authenticated;

COMMENT ON FUNCTION rpc_factory_order_component_status IS
  'Returns {expected_components, child_orders} for a factory_order. Expected comes from product_boms (active rows × line item qty). Child orders are factory_orders with parent_factory_order_id pointing at this one. Caller must be internal OR own the order; cross-supplier child metadata is intentionally exposed (the parent supplier needs visibility into component-supplier status to plan assembly).';

-- -------------------------------------------------------------
-- Phase D: linker RPCs (admin only)
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION rpc_admin_link_factory_order_to_parent(
  p_child_order_id  UUID,
  p_parent_order_id UUID
) RETURNS VOID AS $$
DECLARE
  v_role TEXT;
  v_parent factory_orders%ROWTYPE;
  v_child  factory_orders%ROWTYPE;
BEGIN
  SELECT role INTO v_role FROM profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin', 'manager') THEN
    RAISE EXCEPTION 'forbidden: admin/manager only';
  END IF;

  IF p_child_order_id = p_parent_order_id THEN
    RAISE EXCEPTION 'cannot link an order to itself';
  END IF;

  SELECT * INTO v_parent FROM factory_orders WHERE id = p_parent_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'parent order % not found', p_parent_order_id;
  END IF;
  -- One level of nesting only.
  IF v_parent.parent_factory_order_id IS NOT NULL THEN
    RAISE EXCEPTION 'parent order is itself a child — only one level of nesting allowed';
  END IF;

  SELECT * INTO v_child FROM factory_orders WHERE id = p_child_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'child order % not found', p_child_order_id;
  END IF;
  -- A child cannot itself have children (one-level-deep rule).
  IF EXISTS (
    SELECT 1 FROM factory_orders WHERE parent_factory_order_id = p_child_order_id
  ) THEN
    RAISE EXCEPTION 'child order already has its own children — cannot demote to grandchild';
  END IF;

  UPDATE factory_orders
     SET parent_factory_order_id = p_parent_order_id,
         updated_at = now()
   WHERE id = p_child_order_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION rpc_admin_link_factory_order_to_parent(UUID, UUID) TO authenticated;

CREATE OR REPLACE FUNCTION rpc_admin_unlink_factory_order_from_parent(
  p_child_order_id UUID
) RETURNS VOID AS $$
DECLARE
  v_role TEXT;
BEGIN
  SELECT role INTO v_role FROM profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin', 'manager') THEN
    RAISE EXCEPTION 'forbidden: admin/manager only';
  END IF;

  UPDATE factory_orders
     SET parent_factory_order_id = NULL,
         updated_at = now()
   WHERE id = p_child_order_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION rpc_admin_unlink_factory_order_from_parent(UUID) TO authenticated;

-- -------------------------------------------------------------
-- Sanity guard: every new function landed and is hardened.
-- -------------------------------------------------------------
DO $$
DECLARE
  v_target TEXT[] := ARRAY[
    'rpc_factory_order_component_status',
    'rpc_admin_link_factory_order_to_parent',
    'rpc_admin_unlink_factory_order_from_parent'
  ];
  v_name TEXT;
BEGIN
  FOREACH v_name IN ARRAY v_target LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname = v_name
        AND p.prosecdef = true
        AND 'search_path=public' = ANY(p.proconfig)
    ) THEN
      RAISE EXCEPTION 'Migration 057: %() did not land hardened', v_name;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public'
      AND table_name='factory_orders'
      AND column_name='parent_factory_order_id'
  ) THEN
    RAISE EXCEPTION 'Migration 057: parent_factory_order_id did not land';
  END IF;
END$$;
