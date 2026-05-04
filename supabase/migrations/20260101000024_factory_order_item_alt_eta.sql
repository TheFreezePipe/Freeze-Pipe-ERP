-- =============================================================
-- Migration 024: per-item alternate ETA on factory_order_items
-- =============================================================
-- Context: the existing `expected_completion` column lives on the ORDER.
-- Suppliers often realize mid-run that one SKU on a multi-line order will
-- finish earlier or later than the rest, and need a way to signal that per
-- line without having to split orders.
--
-- Design choices:
--   - New column is NULLABLE. NULL means "inherit from parent order".
--     Effective ETA for overdue / ATP logic = COALESCE(alt, parent.expected_completion).
--   - No trigger to auto-bump the order ETA — consolidator gets to see the
--     per-item signal directly. If we later want the order-level ETA to be
--     `MAX(item.effective_eta)`, that's a view/computed column, not this.
--   - Setting the value goes through a SECURITY DEFINER RPC rather than
--     adding a broad UPDATE policy on factory_order_items. The existing RLS
--     only permits INSERTs by the producing supplier; this RPC is the
--     single sanctioned post-insert mutation path for items, so further
--     fields that suppliers can edit in-flight just get added here.

ALTER TABLE factory_order_items
  ADD COLUMN alternate_expected_completion DATE;

COMMENT ON COLUMN factory_order_items.alternate_expected_completion IS
  'Per-item override of the order-level expected_completion. NULL = inherit parent.';

-- =============================================================
-- rpc_supplier_set_item_alternate_eta
-- =============================================================
-- Producing supplier updates the alt ETA on one of their own items. The
-- order must still be in a pre-finished state (ordered / in_production) —
-- once finished/shipped/canceled, the ETA is moot and locking it prevents
-- weird revisionism in the audit log.
--
-- Input:
--   p_factory_order_item_id  UUID
--   p_alternate_eta          DATE | NULL   (NULL clears the override)
--   p_expected_version       INTEGER       (row_version on factory_orders,
--                                           not on items, because items
--                                           don't carry row_version today
--                                           and the order is the canonical
--                                           concurrency target)
CREATE OR REPLACE FUNCTION rpc_supplier_set_item_alternate_eta(
  p_factory_order_item_id UUID,
  p_alternate_eta DATE,
  p_expected_version INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_supplier_id UUID := jwt_supplier_id();
  v_item factory_order_items%ROWTYPE;
  v_order factory_orders%ROWTYPE;
BEGIN
  IF v_supplier_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_a_supplier');
  END IF;

  SELECT * INTO v_item
    FROM factory_order_items
   WHERE id = p_factory_order_item_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'item_not_found');
  END IF;

  SELECT * INTO v_order
    FROM factory_orders
   WHERE id = v_item.factory_order_id
   FOR UPDATE;
  IF NOT FOUND THEN
    -- Can't happen with FK but defensive.
    RETURN jsonb_build_object('ok', false, 'error', 'order_not_found');
  END IF;

  -- Must own the parent order. Consolidators shouldn't be editing the
  -- producer's item-level ETAs; that's the producer's call. If a
  -- consolidator needs to override, we'd add a separate RPC.
  IF v_order.supplier_id != v_supplier_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_your_order');
  END IF;

  IF v_order.row_version != p_expected_version THEN
    RETURN jsonb_build_object(
      'ok', false, 'error', 'version_conflict',
      'current_version', v_order.row_version
    );
  END IF;

  IF v_order.status NOT IN ('ordered', 'in_production') THEN
    RETURN jsonb_build_object(
      'ok', false, 'error', 'order_not_editable',
      'current_status', v_order.status
    );
  END IF;

  -- Optional sanity: alt ETA should be >= order_date. Let NULL past the check.
  IF p_alternate_eta IS NOT NULL AND p_alternate_eta < v_order.order_date THEN
    RETURN jsonb_build_object('ok', false, 'error', 'alt_eta_before_order_date');
  END IF;

  UPDATE factory_order_items
     SET alternate_expected_completion = p_alternate_eta
   WHERE id = p_factory_order_item_id;

  -- Bump parent order's row_version so other callers notice the change.
  -- We don't update order.updated_at explicitly — the set_updated_at
  -- trigger on factory_orders fires on UPDATE of any column, so the
  -- row_version bump below is sufficient and also triggers updated_at.
  UPDATE factory_orders
     SET row_version = row_version + 1
   WHERE id = v_order.id;

  INSERT INTO audit_logs (actor_id, action, target_table, target_id, details)
  VALUES (
    auth.uid(),
    'factory_order_item.set_alt_eta',
    'factory_order_items',
    p_factory_order_item_id,
    jsonb_build_object(
      'factory_order_id', v_order.id,
      'previous_alt_eta', v_item.alternate_expected_completion,
      'new_alt_eta', p_alternate_eta
    )
  );

  RETURN jsonb_build_object('ok', true);
END;
$$;

GRANT EXECUTE ON FUNCTION rpc_supplier_set_item_alternate_eta(UUID, DATE, INTEGER) TO authenticated;
