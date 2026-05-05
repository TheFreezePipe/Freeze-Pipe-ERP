-- =============================================================
-- Migration 030: rpc_supplier_report_item_finished
-- =============================================================
-- Supplier portal used to advance orders only at the order level (ordered
-- → in_production → finished). That's too coarse — a producer often
-- finishes SKU A on an order while SKU B is still mid-run. This RPC lets
-- the producing supplier set quantity_finished on a single line item, and
-- auto-derives the order-level status from the aggregate:
--
--   - Any item with quantity_finished > 0 on an 'ordered' order → promotes
--     the order to 'in_production'.
--   - Every item's quantity_finished >= quantity_ordered (or covered by
--     breakage) on an 'in_production' order → promotes to 'finished'.
--
-- Guardrails:
--   - Caller must be the producing supplier of the order (not the
--     consolidator — they have their own receive RPC).
--   - Order row_version must match (optimistic concurrency).
--   - Order must still be 'ordered' or 'in_production'. No edits once the
--     order has shipped or been canceled.
--   - quantity_finished can't drop below what's already been shipped
--     (sum of freight_line_items.quantity where source = this item).
--
-- The old rpc_supplier_advance_factory_order from migration 021 stays
-- deployed but is no longer called from the UI. Leaving it in place
-- means any integration tests or external callers keep working.

CREATE OR REPLACE FUNCTION rpc_supplier_report_item_finished(
  p_factory_order_item_id UUID,
  p_quantity_finished INTEGER,
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
  v_shipped INTEGER;
  v_prev_finished INTEGER;
  v_new_status TEXT;
  v_all_finished BOOLEAN;
BEGIN
  IF v_supplier_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_a_supplier');
  END IF;

  IF p_quantity_finished IS NULL OR p_quantity_finished < 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_quantity');
  END IF;

  -- Fetch + lock the item and its parent order. Locks in this order (item
  -- then order) match the surrounding RPCs — keeping lock order stable
  -- avoids cross-RPC deadlocks.
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
    -- Can't happen with the FK but defensive.
    RETURN jsonb_build_object('ok', false, 'error', 'order_not_found');
  END IF;

  IF v_order.supplier_id != v_supplier_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_your_order');
  END IF;

  IF v_order.row_version != p_expected_version THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'version_conflict',
      'current_version', v_order.row_version
    );
  END IF;

  IF v_order.status NOT IN ('ordered', 'in_production') THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'order_not_editable',
      'current_status', v_order.status
    );
  END IF;

  IF p_quantity_finished > v_item.quantity_ordered THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'exceeds_ordered',
      'quantity_ordered', v_item.quantity_ordered
    );
  END IF;

  -- Can't drop below the shipped count — those units are already out the
  -- door, claiming they aren't finished would be nonsensical.
  SELECT COALESCE(SUM(quantity), 0) INTO v_shipped
    FROM freight_line_items
   WHERE source_factory_order_item_id = p_factory_order_item_id;

  IF p_quantity_finished < v_shipped THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'cannot_reduce_below_shipped',
      'already_shipped', v_shipped
    );
  END IF;

  v_prev_finished := v_item.quantity_finished;

  -- Apply the update.
  UPDATE factory_order_items
     SET quantity_finished = p_quantity_finished
   WHERE id = p_factory_order_item_id;

  -- Auto-advance order status based on the aggregate. Two rules:
  --   ordered → in_production: any item with non-zero quantity_finished.
  --   in_production → finished: every item fully finished (or breakage
  --     accounts for the gap, mirroring orderFullyShipped logic on the UI).
  v_new_status := v_order.status;

  IF v_order.status = 'ordered' AND p_quantity_finished > 0 THEN
    v_new_status := 'in_production';
  END IF;

  SELECT NOT EXISTS (
    SELECT 1 FROM factory_order_items
     WHERE factory_order_id = v_order.id
       AND COALESCE(quantity_finished, 0) + COALESCE(quantity_breakage, 0)
           < quantity_ordered
  ) INTO v_all_finished;

  IF v_all_finished THEN
    v_new_status := 'finished';
  END IF;

  IF v_new_status != v_order.status THEN
    UPDATE factory_orders
       SET status = v_new_status
     WHERE id = v_order.id;
  ELSE
    -- No status change but bump row_version anyway so concurrent readers
    -- see the item update reflected in their cache-busting key.
    UPDATE factory_orders
       SET row_version = row_version + 1
     WHERE id = v_order.id;
  END IF;

  INSERT INTO audit_logs (actor_id, action, target_table, target_id, details)
  VALUES (
    auth.uid(),
    'factory_order_item.report_finished',
    'factory_order_items',
    p_factory_order_item_id,
    jsonb_build_object(
      'factory_order_id', v_order.id,
      'previous_quantity_finished', v_prev_finished,
      'new_quantity_finished', p_quantity_finished,
      'previous_status', v_order.status,
      'new_status', v_new_status
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'quantity_finished', p_quantity_finished,
    'order_status', v_new_status
  );
END;
$$;

GRANT EXECUTE ON FUNCTION rpc_supplier_report_item_finished(UUID, INTEGER, INTEGER) TO authenticated;
