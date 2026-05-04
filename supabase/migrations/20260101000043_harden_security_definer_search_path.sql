-- =============================================================
-- Migration 043: SECURITY DEFINER search_path hardening
-- =============================================================
-- A SECURITY DEFINER function that doesn't pin its `search_path`
-- inherits the caller's. An attacker with CREATE on any schema in the
-- caller's path can shadow `public.SomeRelation` (or even
-- `pg_catalog.format`) with a malicious definition, and that
-- malicious definition runs with the function's elevated privileges.
-- The standard hardening is one line per function:
--
--     ... LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
--
-- Most newer RPCs (migrations 020+) already have this. Six older
-- SECURITY DEFINER functions that are still live in the DB do not:
--
--   archive_sku            (recreated in 041 from 008's body)
--   archive_sku_force      (008)
--   restore_sku            (008)
--   rpc_cycle_count        (010)
--   rpc_apply_shipstation_sale (012)
--   rpc_update_user_role   (015)
--
-- This migration re-creates each with the pragma added. Bodies are
-- replayed verbatim from the canonical source migration — zero
-- behavior change. While we're here, add explicit
-- `GRANT EXECUTE TO authenticated` for the archive trio (the original
-- 008 migration relied on the PUBLIC default; 041 carried that
-- forward; better to be explicit).
--
-- Sanity guard at the end queries pg_proc.proconfig to verify the
-- search_path setting actually landed on every function.
-- =============================================================

-- -------------------------------------------------------------
-- A. archive_sku — body from migration 041
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION archive_sku(
  p_sku_id UUID,
  p_actor_id UUID,
  p_reason TEXT
) RETURNS VOID AS $$
DECLARE
  v_sku RECORD;
  v_inv_total INTEGER;
BEGIN
  SELECT * INTO v_sku FROM product_skus WHERE id = p_sku_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SKU % not found', p_sku_id;
  END IF;
  IF v_sku.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'SKU % is already archived', v_sku.sku;
  END IF;

  SELECT COALESCE(
    warehouse_raw + warehouse_in_production + warehouse_finished + warehouse_other,
    0
  ) INTO v_inv_total
  FROM inventory_levels WHERE sku_id = p_sku_id;

  IF COALESCE(v_inv_total, 0) > 0 THEN
    RAISE EXCEPTION 'Cannot archive SKU % — has % units on hand in the warehouse. Move stock to warehouse_other or mark as breakage first.',
      v_sku.sku, v_inv_total
      USING HINT = 'If this is intentional, call archive_sku_force() instead.';
  END IF;

  UPDATE product_skus
     SET archived_at = now(),
         archived_by = p_actor_id,
         archive_reason = p_reason,
         is_active = false
   WHERE id = p_sku_id;

  INSERT INTO inventory_transactions (
    sku_id, transaction_type, quantity, field_affected,
    reference_id, reference_type, notes, performed_by
  ) VALUES (
    p_sku_id, 'sku_archived', 0, 'archived_at',
    p_sku_id, 'product_sku',
    format('%s archived: %s', v_sku.sku, p_reason),
    p_actor_id
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- -------------------------------------------------------------
-- B. archive_sku_force — body from migration 008
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION archive_sku_force(
  p_sku_id UUID,
  p_actor_id UUID,
  p_reason TEXT
) RETURNS VOID AS $$
DECLARE
  v_sku RECORD;
BEGIN
  SELECT * INTO v_sku FROM product_skus WHERE id = p_sku_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SKU % not found', p_sku_id;
  END IF;

  UPDATE product_skus
     SET archived_at = now(),
         archived_by = p_actor_id,
         archive_reason = p_reason,
         is_active = false
   WHERE id = p_sku_id;

  INSERT INTO inventory_transactions (
    sku_id, transaction_type, quantity, field_affected,
    reference_id, reference_type, notes, performed_by
  ) VALUES (
    p_sku_id, 'sku_archived_force', 0, 'archived_at',
    p_sku_id, 'product_sku',
    format('%s force-archived: %s', v_sku.sku, p_reason),
    p_actor_id
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- -------------------------------------------------------------
-- C. restore_sku — body from migration 008
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION restore_sku(
  p_sku_id UUID,
  p_actor_id UUID
) RETURNS VOID AS $$
DECLARE
  v_sku RECORD;
BEGIN
  SELECT * INTO v_sku FROM product_skus WHERE id = p_sku_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SKU % not found', p_sku_id;
  END IF;
  IF v_sku.archived_at IS NULL THEN
    RAISE EXCEPTION 'SKU % is not archived', v_sku.sku;
  END IF;

  UPDATE product_skus
     SET archived_at = NULL,
         archived_by = NULL,
         archive_reason = NULL,
         is_active = true
   WHERE id = p_sku_id;

  INSERT INTO inventory_transactions (
    sku_id, transaction_type, quantity, field_affected,
    reference_id, reference_type, notes, performed_by
  ) VALUES (
    p_sku_id, 'sku_restored', 0, 'archived_at',
    p_sku_id, 'product_sku',
    format('%s restored from archive', v_sku.sku),
    p_actor_id
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- -------------------------------------------------------------
-- D. rpc_cycle_count — body from migration 010
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION rpc_cycle_count(
  p_sku_id UUID,
  p_field TEXT,
  p_delta INTEGER,
  p_reason TEXT,
  p_notes TEXT,
  p_actor_id UUID
) RETURNS JSONB AS $$
DECLARE
  v_sku product_skus%ROWTYPE;
  v_current INTEGER;
  v_new INTEGER;
BEGIN
  IF p_delta = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'delta must be non-zero');
  END IF;
  IF p_field NOT IN (
    'warehouse_raw', 'warehouse_in_production', 'warehouse_finished', 'warehouse_other'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'cycle counts only apply to warehouse buckets');
  END IF;

  SELECT * INTO v_sku FROM product_skus WHERE id = p_sku_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'sku not found');
  END IF;

  PERFORM 1 FROM inventory_levels WHERE sku_id = p_sku_id FOR UPDATE;

  EXECUTE format('SELECT %I FROM inventory_levels WHERE sku_id = $1', p_field)
    INTO v_current USING p_sku_id;
  v_new := COALESCE(v_current, 0) + p_delta;

  IF v_new < 0 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'would_go_negative',
      'current', v_current,
      'delta', p_delta
    );
  END IF;

  EXECUTE format('UPDATE inventory_levels SET %I = $1 WHERE sku_id = $2', p_field)
    USING v_new, p_sku_id;

  INSERT INTO inventory_transactions (
    sku_id, transaction_type, quantity, field_affected,
    movement_kind, notes, performed_by
  ) VALUES (
    p_sku_id, 'cycle_count', p_delta, p_field,
    'net_change',
    format('%s: %s%s on %s (%s)%s',
      v_sku.sku,
      CASE WHEN p_delta > 0 THEN '+' ELSE '' END,
      p_delta,
      p_field,
      p_reason,
      CASE WHEN p_notes IS NOT NULL THEN ' — ' || p_notes ELSE '' END
    ),
    p_actor_id
  );

  RETURN jsonb_build_object('ok', true, 'new_value', v_new);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- -------------------------------------------------------------
-- E. rpc_apply_shipstation_sale — body from migration 012
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION rpc_apply_shipstation_sale(
  p_order_id UUID,
  p_system_actor_id UUID DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
  v_order shipstation_orders%ROWTYPE;
  v_item RECORD;
  v_sku product_skus%ROWTYPE;
  v_available INTEGER;
  v_line_items_applied INTEGER := 0;
  v_line_items_unresolved INTEGER := 0;
BEGIN
  SELECT * INTO v_order FROM shipstation_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'order not found');
  END IF;
  IF v_order.inventory_applied_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'already_applied', true);
  END IF;

  FOR v_item IN
    SELECT * FROM shipstation_order_items WHERE shipstation_order_id = p_order_id
  LOOP
    IF v_item.sku_id IS NULL THEN
      v_line_items_unresolved := v_line_items_unresolved + 1;
      CONTINUE;
    END IF;

    SELECT * INTO v_sku FROM product_skus WHERE id = v_item.sku_id;
    PERFORM 1 FROM inventory_levels WHERE sku_id = v_item.sku_id FOR UPDATE;

    SELECT warehouse_finished INTO v_available
      FROM inventory_levels WHERE sku_id = v_item.sku_id;

    IF COALESCE(v_available, 0) < v_item.quantity THEN
      INSERT INTO inventory_transactions (
        sku_id, transaction_type, quantity, field_affected,
        movement_kind, notes, performed_by
      ) VALUES (
        v_item.sku_id, 'shipstation_oversell_warning',
        -v_item.quantity, 'warehouse_finished',
        'metadata',
        format('%s: oversold on ShipStation order %s — available %s, sold %s. Requires cycle-count correction.',
          v_sku.sku, v_order.order_number, COALESCE(v_available, 0), v_item.quantity),
        p_system_actor_id
      );
      CONTINUE;
    END IF;

    UPDATE inventory_levels
       SET warehouse_finished = warehouse_finished - v_item.quantity
     WHERE sku_id = v_item.sku_id;

    INSERT INTO inventory_transactions (
      sku_id, transaction_type, quantity, field_affected,
      movement_kind, reference_id, reference_type, notes, performed_by
    ) VALUES (
      v_item.sku_id, 'order_shipped', -v_item.quantity, 'warehouse_finished',
      'net_change', p_order_id, 'shipstation_order',
      format('ShipStation order %s: -%s units', v_order.order_number, v_item.quantity),
      p_system_actor_id
    );
    v_line_items_applied := v_line_items_applied + 1;
  END LOOP;

  IF v_line_items_unresolved = 0 THEN
    UPDATE shipstation_orders
       SET inventory_applied_at = now(),
           inventory_apply_error = NULL,
           inventory_apply_attempts = inventory_apply_attempts + 1
     WHERE id = p_order_id;
  ELSE
    UPDATE shipstation_orders
       SET inventory_apply_attempts = inventory_apply_attempts + 1,
           inventory_apply_error = format('%s line item(s) have unresolved SKU codes', v_line_items_unresolved)
     WHERE id = p_order_id;
  END IF;

  RETURN jsonb_build_object(
    'ok', v_line_items_unresolved = 0,
    'applied', v_line_items_applied,
    'unresolved', v_line_items_unresolved
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- -------------------------------------------------------------
-- F. rpc_update_user_role — body from migration 015
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION rpc_update_user_role(
  p_target_user_id UUID,
  p_new_role TEXT,
  p_actor_id UUID
) RETURNS JSONB AS $$
DECLARE
  v_actor profiles%ROWTYPE;
  v_target profiles%ROWTYPE;
BEGIN
  IF p_new_role NOT IN ('admin', 'manager', 'user') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid role');
  END IF;

  SELECT * INTO v_actor FROM profiles WHERE id = p_actor_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'actor not found');
  END IF;

  SELECT * INTO v_target FROM profiles WHERE id = p_target_user_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'target user not found');
  END IF;

  IF v_actor.role NOT IN ('admin', 'manager') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'only admins and managers can change roles');
  END IF;

  IF v_actor.id = v_target.id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'cannot change your own role');
  END IF;

  IF v_actor.role = 'manager' AND p_new_role = 'admin' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'managers cannot grant admin role');
  END IF;

  IF v_actor.role = 'manager' AND v_target.role = 'admin' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'managers cannot change an admin role');
  END IF;

  IF v_target.role = p_new_role THEN
    RETURN jsonb_build_object('ok', true, 'noop', true);
  END IF;

  PERFORM set_config('app.role_change_allowed', 'yes', true);
  UPDATE profiles SET role = p_new_role WHERE id = p_target_user_id;
  PERFORM set_config('app.role_change_allowed', '', true);

  INSERT INTO inventory_transactions (
    sku_id, transaction_type, quantity, field_affected,
    movement_kind, reference_id, reference_type, notes, performed_by
  ) VALUES (
    NULL, 'user_role_change', 0, 'role',
    'metadata', p_target_user_id, 'profile',
    format('%s: role changed %s → %s by %s',
      v_target.full_name, v_target.role, p_new_role, v_actor.full_name),
    p_actor_id
  );

  RETURN jsonb_build_object('ok', true, 'previous_role', v_target.role, 'new_role', p_new_role);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- -------------------------------------------------------------
-- G. Explicit GRANT EXECUTE for the archive trio. The other three
--    functions retain their grants from their original migrations
--    (rpc_apply_shipstation_sale + rpc_update_user_role had explicit
--    grants in 012/015; rpc_cycle_count gets one here for parity).
-- -------------------------------------------------------------
GRANT EXECUTE ON FUNCTION archive_sku(UUID, UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION archive_sku_force(UUID, UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION restore_sku(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION rpc_cycle_count(UUID, TEXT, INTEGER, TEXT, TEXT, UUID) TO authenticated;

-- -------------------------------------------------------------
-- H. Sanity guard: every function we touched should now report
--    `search_path=public` in pg_proc.proconfig. proconfig is a TEXT[]
--    of `KEY=VALUE` strings, so we look for the exact entry.
-- -------------------------------------------------------------
DO $$
DECLARE
  v_target TEXT[] := ARRAY[
    'archive_sku',
    'archive_sku_force',
    'restore_sku',
    'rpc_cycle_count',
    'rpc_apply_shipstation_sale',
    'rpc_update_user_role'
  ];
  v_name TEXT;
  v_has_search_path BOOLEAN;
BEGIN
  FOREACH v_name IN ARRAY v_target LOOP
    SELECT EXISTS (
      SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname = v_name
        AND 'search_path=public' = ANY(p.proconfig)
    ) INTO v_has_search_path;

    IF NOT v_has_search_path THEN
      RAISE EXCEPTION
        'Function %() did not get search_path=public after migration 043 — replay or drop+create needed',
        v_name;
    END IF;
  END LOOP;
END$$;
