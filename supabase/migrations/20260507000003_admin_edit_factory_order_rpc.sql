-- =============================================================
-- Migration: rpc_admin_edit_factory_order — atomic admin edits
-- =============================================================
-- Powers the new "Edit Mode" affordance on the admin factory-order
-- detail page. One mutation, one row_version bump, one audit log row.
--
-- Scope (matches the UI form):
--   Header  : order_number, supplier_id, order_date, expected_completion
--   Lines   : per-line sku_id + quantity_ordered, plus add/remove
--
-- Hard rules enforced server-side (UI mirrors all of these but the RPC
-- is the source of truth):
--   1. Admin or manager only (matches existing factory_orders RLS).
--   2. Order status must be in ('ordered', 'in_production', 'finished').
--      'shipped' and 'canceled' are post-flight; edits would lie about
--      audit history. Use the Cancel/Receive flows instead.
--   3. Lines with quantity_finished > 0 OR consolidator_confirmed_quantity
--      IS NOT NULL are LOCKED — the admin can't change sku_id or qty on
--      them, and can't delete them. The UI greys these out; the RPC
--      double-checks.
--   4. expected_version must match current row_version (optimistic
--      concurrency — same shape as updateWithVersion elsewhere).
--   5. Resulting line set must satisfy the (factory_order_id, sku_id)
--      unique index. We catch the duplicate case explicitly and return
--      a friendly error rather than letting Postgres raise.
--   6. expected_completion must be >= order_date if both are set
--      (matches the chk_fo_completion_after_order CHECK constraint).
--
-- Payload shape (jsonb):
--   {
--     "header": {
--       "order_number": "...",       // optional; null clears
--       "supplier_id": "<uuid>",      // optional
--       "order_date": "YYYY-MM-DD",   // optional; null clears
--       "expected_completion": "..."  // optional; null clears
--     },
--     "line_ops": [
--       { "op": "update", "id": "<uuid>", "sku_id": "<uuid>",
--         "quantity_ordered": <int> },
--       { "op": "delete", "id": "<uuid>" },
--       { "op": "insert", "sku_id": "<uuid>", "quantity_ordered": <int> }
--     ]
--   }
--
-- Each `header` field is optional; missing keys = no change. Same for
-- line ops — the UI only sends ops for lines that actually changed.
-- =============================================================

CREATE OR REPLACE FUNCTION public.rpc_admin_edit_factory_order(
  p_order_id         UUID,
  p_expected_version INTEGER,
  p_payload          JSONB
) RETURNS JSONB AS $$
DECLARE
  v_actor          UUID := auth.uid();
  v_role           TEXT;
  v_order          public.factory_orders%ROWTYPE;
  v_header         JSONB := COALESCE(p_payload -> 'header', '{}'::jsonb);
  v_ops            JSONB := COALESCE(p_payload -> 'line_ops', '[]'::jsonb);
  v_op             JSONB;
  v_line_id        UUID;
  v_sku_id         UUID;
  v_qty            INTEGER;
  v_line           public.factory_order_items%ROWTYPE;
  v_new_supplier   UUID;
  v_new_order_date DATE;
  v_new_exp_compl  DATE;
  v_changes        JSONB := '{}'::jsonb;
  v_new_version    INTEGER;
BEGIN
  -- 1. Authorize
  SELECT role INTO v_role FROM public.profiles WHERE id = v_actor;
  IF v_role IS NULL OR v_role NOT IN ('admin', 'manager') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'admin or manager role required');
  END IF;

  -- 2. Lock + load
  SELECT * INTO v_order FROM public.factory_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'order not found');
  END IF;

  -- 3. Version guard
  IF v_order.row_version <> p_expected_version THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'version_conflict',
      'current_version', v_order.row_version
    );
  END IF;

  -- 4. Status guard
  IF v_order.status NOT IN ('ordered', 'in_production', 'finished') THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', format(
        'cannot edit order in status %L; only ordered/in_production/finished are editable',
        v_order.status
      )
    );
  END IF;

  -- 5. Header updates. Each field is only touched if its key is present
  --    in the payload. JSON `null` for a key means "clear it"; absence
  --    means "leave it." Using JSONB ? to distinguish present-null from
  --    missing.
  IF v_header ? 'order_number' THEN
    UPDATE public.factory_orders
       SET order_number = NULLIF(trim(v_header ->> 'order_number'), '')
     WHERE id = p_order_id;
    v_changes := v_changes || jsonb_build_object(
      'order_number', jsonb_build_object('from', v_order.order_number, 'to', v_header -> 'order_number')
    );
  END IF;

  IF v_header ? 'supplier_id' THEN
    v_new_supplier := (v_header ->> 'supplier_id')::UUID;
    IF v_new_supplier IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'error', 'supplier_id cannot be null');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.suppliers WHERE id = v_new_supplier) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'supplier_id not found');
    END IF;
    UPDATE public.factory_orders SET supplier_id = v_new_supplier WHERE id = p_order_id;
    v_changes := v_changes || jsonb_build_object(
      'supplier_id', jsonb_build_object('from', v_order.supplier_id, 'to', v_new_supplier)
    );
  END IF;

  IF v_header ? 'order_date' THEN
    v_new_order_date := NULLIF(v_header ->> 'order_date', '')::DATE;
    UPDATE public.factory_orders SET order_date = v_new_order_date WHERE id = p_order_id;
    v_changes := v_changes || jsonb_build_object(
      'order_date', jsonb_build_object('from', v_order.order_date, 'to', v_new_order_date)
    );
  END IF;

  IF v_header ? 'expected_completion' THEN
    v_new_exp_compl := NULLIF(v_header ->> 'expected_completion', '')::DATE;
    UPDATE public.factory_orders SET expected_completion = v_new_exp_compl WHERE id = p_order_id;
    v_changes := v_changes || jsonb_build_object(
      'expected_completion', jsonb_build_object('from', v_order.expected_completion, 'to', v_new_exp_compl)
    );
  END IF;

  -- 6. Line operations. Process delete → update → insert in that order
  --    so we don't trip the (factory_order_id, sku_id) unique index when
  --    a user is, e.g., deleting line A and then re-inserting the same
  --    SKU on a fresh line.
  --
  --    Note: SECURITY DEFINER bypasses RLS, but we already gated to
  --    admin/manager above. The factory_order_items table inherits RLS
  --    from factory_orders for supplier-side reads.

  -- 6a. Deletes
  FOR v_op IN SELECT * FROM jsonb_array_elements(v_ops) WHERE value ->> 'op' = 'delete'
  LOOP
    v_line_id := (v_op ->> 'id')::UUID;
    SELECT * INTO v_line FROM public.factory_order_items
     WHERE id = v_line_id AND factory_order_id = p_order_id;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'error', format('line %s not found on this order', v_line_id));
    END IF;
    IF COALESCE(v_line.quantity_finished, 0) > 0
       OR v_line.consolidator_confirmed_quantity IS NOT NULL THEN
      RETURN jsonb_build_object(
        'ok', false,
        'error', 'cannot delete a line with finished or confirmed quantity; receipt is already credited'
      );
    END IF;
    DELETE FROM public.factory_order_items WHERE id = v_line_id;
    v_changes := v_changes || jsonb_build_object(
      format('line_deleted_%s', v_line_id),
      jsonb_build_object('sku_id', v_line.sku_id, 'quantity_ordered', v_line.quantity_ordered)
    );
  END LOOP;

  -- 6b. Updates
  FOR v_op IN SELECT * FROM jsonb_array_elements(v_ops) WHERE value ->> 'op' = 'update'
  LOOP
    v_line_id := (v_op ->> 'id')::UUID;
    v_sku_id  := (v_op ->> 'sku_id')::UUID;
    v_qty     := (v_op ->> 'quantity_ordered')::INTEGER;
    SELECT * INTO v_line FROM public.factory_order_items
     WHERE id = v_line_id AND factory_order_id = p_order_id;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'error', format('line %s not found on this order', v_line_id));
    END IF;
    IF COALESCE(v_line.quantity_finished, 0) > 0
       OR v_line.consolidator_confirmed_quantity IS NOT NULL THEN
      RETURN jsonb_build_object(
        'ok', false,
        'error', 'cannot edit a line with finished or confirmed quantity; receipt is already credited'
      );
    END IF;
    IF v_qty IS NULL OR v_qty < 1 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'quantity_ordered must be a positive integer');
    END IF;
    -- chk_fo_item_finished_bounded would catch this too, but we guard
    -- explicitly for a friendlier error.
    IF v_qty < COALESCE(v_line.quantity_finished, 0) THEN
      RETURN jsonb_build_object(
        'ok', false,
        'error', format(
          'quantity_ordered (%s) cannot be less than quantity_finished (%s)',
          v_qty, v_line.quantity_finished
        )
      );
    END IF;
    IF v_sku_id IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'error', 'sku_id is required');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.product_skus WHERE id = v_sku_id) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'sku_id not found');
    END IF;
    -- Catch the (order, sku) unique-index conflict explicitly so the
    -- error message is useful. Skip the check if the SKU is unchanged
    -- (updating qty on the same line is fine).
    IF v_sku_id <> v_line.sku_id
       AND EXISTS (
         SELECT 1 FROM public.factory_order_items
          WHERE factory_order_id = p_order_id
            AND sku_id = v_sku_id
            AND id <> v_line_id
       ) THEN
      RETURN jsonb_build_object(
        'ok', false,
        'error', 'another line on this order already uses that SKU; remove the duplicate first'
      );
    END IF;
    UPDATE public.factory_order_items
       SET sku_id = v_sku_id,
           quantity_ordered = v_qty
     WHERE id = v_line_id;
    v_changes := v_changes || jsonb_build_object(
      format('line_updated_%s', v_line_id),
      jsonb_build_object(
        'sku_id_from', v_line.sku_id, 'sku_id_to', v_sku_id,
        'qty_from', v_line.quantity_ordered, 'qty_to', v_qty
      )
    );
  END LOOP;

  -- 6c. Inserts
  FOR v_op IN SELECT * FROM jsonb_array_elements(v_ops) WHERE value ->> 'op' = 'insert'
  LOOP
    v_sku_id := (v_op ->> 'sku_id')::UUID;
    v_qty    := (v_op ->> 'quantity_ordered')::INTEGER;
    IF v_qty IS NULL OR v_qty < 1 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'quantity_ordered must be a positive integer for new lines');
    END IF;
    IF v_sku_id IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'error', 'sku_id is required for new lines');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.product_skus WHERE id = v_sku_id) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'sku_id not found');
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.factory_order_items
       WHERE factory_order_id = p_order_id AND sku_id = v_sku_id
    ) THEN
      RETURN jsonb_build_object(
        'ok', false,
        'error', 'this SKU is already a line on the order; edit that line instead'
      );
    END IF;
    INSERT INTO public.factory_order_items (factory_order_id, sku_id, quantity_ordered)
    VALUES (p_order_id, v_sku_id, v_qty)
    RETURNING id INTO v_line_id;
    v_changes := v_changes || jsonb_build_object(
      format('line_inserted_%s', v_line_id),
      jsonb_build_object('sku_id', v_sku_id, 'quantity_ordered', v_qty)
    );
  END LOOP;

  -- 7. Audit log + return new row_version. The factory_orders BEFORE
  --    UPDATE trigger bumps row_version on its own; if we made any
  --    header changes that's already done, but if we only touched
  --    line items we need to bump it manually so the optimistic
  --    concurrency hash on the client refreshes.
  IF NOT (v_header ? 'order_number' OR v_header ? 'supplier_id'
       OR v_header ? 'order_date' OR v_header ? 'expected_completion') THEN
    UPDATE public.factory_orders SET updated_at = now() WHERE id = p_order_id;
  END IF;

  SELECT row_version INTO v_new_version FROM public.factory_orders WHERE id = p_order_id;

  INSERT INTO public.audit_logs (actor_id, action, target_table, target_id, details)
  VALUES (
    v_actor,
    'factory_order.admin_edit',
    'factory_orders',
    p_order_id,
    jsonb_build_object(
      'changes', v_changes,
      'prev_version', p_expected_version,
      'new_version', v_new_version
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'new_version', v_new_version,
    'changes', v_changes
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.rpc_admin_edit_factory_order TO authenticated;
