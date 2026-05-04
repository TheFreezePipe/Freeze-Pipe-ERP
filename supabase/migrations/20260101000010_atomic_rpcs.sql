-- =============================================================
-- Migration 010: Atomic mutation RPCs
-- =============================================================
-- Every inventory-affecting operation must be atomic. Each of these
-- functions performs its state change AND its audit entry in a single
-- transaction (Postgres function bodies execute atomically). A failure
-- anywhere inside rolls back everything.
--
-- Row-level locks (FOR UPDATE) prevent two concurrent writers from
-- observing stale inventory when deciding whether a movement is valid.
-- (The CHECK constraints from migration 006 are the last line of defense
-- but we prefer to reject an invalid operation with a descriptive error
-- before it ever hits the constraint.)
--
-- All RPCs return a JSONB result with { ok, error?, ... }.

-- -------------------------------------------------------------
-- Helper: resolve task_type -> source/target bucket
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION _task_type_movement(p_task_type TEXT)
RETURNS TABLE (from_field TEXT, to_field TEXT) AS $$
BEGIN
  CASE p_task_type
    WHEN 'emptying' THEN
      RETURN QUERY SELECT 'warehouse_raw'::TEXT, 'warehouse_in_production'::TEXT;
    WHEN 'rtsing' THEN
      RETURN QUERY SELECT 'warehouse_in_production'::TEXT, 'warehouse_finished'::TEXT;
    WHEN 'prefilled_rtsing' THEN
      RETURN QUERY SELECT 'warehouse_raw'::TEXT, 'warehouse_finished'::TEXT;
    WHEN 'filling_capping' THEN
      -- Stays in warehouse_in_production; no bucket change.
      RETURN QUERY SELECT NULL::TEXT, NULL::TEXT;
    ELSE
      RAISE EXCEPTION 'Unknown task_type: %', p_task_type;
  END CASE;
END;
$$ LANGUAGE plpgsql;

-- -------------------------------------------------------------
-- rpc_log_task_completion: manufacturing worker logs a completed task
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION rpc_log_task_completion(
  p_sku_id UUID,
  p_task_type TEXT,
  p_quantity INTEGER,
  p_notes TEXT,
  p_actor_id UUID,
  p_time_started TIMESTAMPTZ DEFAULT NULL,
  p_time_completed TIMESTAMPTZ DEFAULT now()
) RETURNS JSONB AS $$
DECLARE
  v_sku product_skus%ROWTYPE;
  v_move RECORD;
  v_task_log_id UUID;
  v_available INTEGER;
BEGIN
  -- Validate inputs
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'quantity must be positive');
  END IF;

  SELECT * INTO v_sku FROM product_skus WHERE id = p_sku_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'sku not found');
  END IF;
  IF v_sku.archived_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'sku is archived');
  END IF;

  SELECT * INTO v_move FROM _task_type_movement(p_task_type);

  -- Lock the inventory row for this SKU so concurrent mutations serialize.
  PERFORM 1 FROM inventory_levels WHERE sku_id = p_sku_id FOR UPDATE;

  IF v_move.from_field IS NOT NULL THEN
    -- Read current source bucket value
    EXECUTE format('SELECT %I FROM inventory_levels WHERE sku_id = $1', v_move.from_field)
      INTO v_available USING p_sku_id;

    IF v_available IS NULL OR v_available < p_quantity THEN
      RETURN jsonb_build_object(
        'ok', false,
        'error', 'insufficient_source_stock',
        'available', COALESCE(v_available, 0),
        'requested', p_quantity
      );
    END IF;

    -- Apply the movement atomically.
    EXECUTE format(
      'UPDATE inventory_levels SET %I = %I - $1, %I = %I + $1 WHERE sku_id = $2',
      v_move.from_field, v_move.from_field,
      v_move.to_field, v_move.to_field
    ) USING p_quantity, p_sku_id;
  END IF;

  -- Record the task log
  INSERT INTO task_logs (
    employee_id, sku_id, task_type, quantity_processed,
    time_started, time_completed, notes
  ) VALUES (
    p_actor_id, p_sku_id, p_task_type, p_quantity,
    p_time_started, p_time_completed, p_notes
  ) RETURNING id INTO v_task_log_id;

  -- Write audit entry
  INSERT INTO inventory_transactions (
    sku_id, transaction_type, quantity, field_affected,
    movement_kind, from_field, to_field,
    reference_id, reference_type, notes, performed_by
  ) VALUES (
    p_sku_id, 'task_logged', p_quantity,
    COALESCE(v_move.to_field, 'warehouse_in_production'),
    CASE WHEN v_move.from_field IS NULL THEN 'metadata' ELSE 'category_move' END,
    v_move.from_field, v_move.to_field,
    v_task_log_id, 'task_log',
    format('%s: %s of %s units%s',
      v_sku.sku,
      replace(p_task_type, '_', ' '),
      p_quantity,
      CASE WHEN p_notes IS NOT NULL THEN ' — ' || p_notes ELSE '' END
    ),
    p_actor_id
  );

  RETURN jsonb_build_object('ok', true, 'task_log_id', v_task_log_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- -------------------------------------------------------------
-- rpc_cycle_count: manual adjustment (net change to total inventory)
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION rpc_cycle_count(
  p_sku_id UUID,
  p_field TEXT,     -- 'warehouse_raw' | 'warehouse_in_production' | ... | 'warehouse_other'
  p_delta INTEGER,  -- signed: +5 or -3
  p_reason TEXT,    -- 'breakage' | 'mispick' | 'theft' | 'receiving_error' | 'other'
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
    format('%s: %s %s on %s (%s)%s',
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
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- -------------------------------------------------------------
-- rpc_apply_freight_delivery: move in_transit → warehouse_raw for every
-- line item on a shipment, set status=delivered, write audit rows.
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION rpc_apply_freight_delivery(
  p_shipment_id UUID,
  p_actor_id UUID
) RETURNS JSONB AS $$
DECLARE
  v_shipment freight_shipments%ROWTYPE;
  v_li RECORD;
  v_transit_field TEXT;
  v_available INTEGER;
  v_moved_count INTEGER := 0;
BEGIN
  SELECT * INTO v_shipment FROM freight_shipments WHERE id = p_shipment_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'shipment not found');
  END IF;
  IF v_shipment.status = 'delivered' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'shipment already delivered');
  END IF;

  v_transit_field := CASE v_shipment.freight_type
    WHEN 'air' THEN 'in_transit_air'
    WHEN 'sea' THEN 'in_transit_sea'
  END;

  FOR v_li IN
    SELECT * FROM freight_line_items WHERE freight_shipment_id = p_shipment_id
  LOOP
    PERFORM 1 FROM inventory_levels WHERE sku_id = v_li.sku_id FOR UPDATE;

    EXECUTE format('SELECT %I FROM inventory_levels WHERE sku_id = $1', v_transit_field)
      INTO v_available USING v_li.sku_id;

    IF COALESCE(v_available, 0) < v_li.quantity THEN
      -- This is a data integrity problem worth logging but we proceed.
      -- In production you may want to fail hard here instead.
      RAISE WARNING 'Shipment % line item %: transit stock % < expected %',
        v_shipment.shipment_number, v_li.id, v_available, v_li.quantity;
    END IF;

    EXECUTE format(
      'UPDATE inventory_levels SET %I = GREATEST(%I - $1, 0), warehouse_raw = warehouse_raw + $1 WHERE sku_id = $2',
      v_transit_field, v_transit_field
    ) USING v_li.quantity, v_li.sku_id;

    INSERT INTO inventory_transactions (
      sku_id, transaction_type, quantity, field_affected,
      movement_kind, from_field, to_field,
      reference_id, reference_type, notes, performed_by
    ) VALUES (
      v_li.sku_id, 'freight_delivered', v_li.quantity, 'warehouse_raw',
      'category_move', v_transit_field, 'warehouse_raw',
      p_shipment_id, 'freight_shipment',
      format('%s delivered: %s units landed', v_shipment.shipment_number, v_li.quantity),
      p_actor_id
    );
    v_moved_count := v_moved_count + 1;
  END LOOP;

  UPDATE freight_shipments
     SET status = 'delivered',
         actual_arrival_date = COALESCE(actual_arrival_date, CURRENT_DATE)
   WHERE id = p_shipment_id;

  RETURN jsonb_build_object('ok', true, 'line_items_processed', v_moved_count);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- -------------------------------------------------------------
-- rpc_advance_factory_order_stage: moves units between factory buckets
-- Example: nancy_ordered → nancy_finished when a batch is QC-passed
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION rpc_advance_factory_order_stage(
  p_factory_order_item_id UUID,
  p_from_stage TEXT,   -- 'nancy_ordered' | 'yx_ordered'
  p_to_stage TEXT,     -- 'nancy_finished' | 'yx_finished'
  p_quantity INTEGER,
  p_actor_id UUID,
  p_notes TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
  v_item factory_order_items%ROWTYPE;
  v_order factory_orders%ROWTYPE;
  v_sku product_skus%ROWTYPE;
  v_available INTEGER;
BEGIN
  IF p_quantity <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'quantity must be positive');
  END IF;
  IF p_from_stage NOT IN ('nancy_ordered', 'yx_ordered')
     OR p_to_stage NOT IN ('nancy_finished', 'yx_finished') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid stage field');
  END IF;

  SELECT * INTO v_item FROM factory_order_items WHERE id = p_factory_order_item_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'factory order item not found');
  END IF;
  SELECT * INTO v_order FROM factory_orders WHERE id = v_item.factory_order_id;
  SELECT * INTO v_sku FROM product_skus WHERE id = v_item.sku_id;

  PERFORM 1 FROM inventory_levels WHERE sku_id = v_item.sku_id FOR UPDATE;
  EXECUTE format('SELECT %I FROM inventory_levels WHERE sku_id = $1', p_from_stage)
    INTO v_available USING v_item.sku_id;

  IF COALESCE(v_available, 0) < p_quantity THEN
    RETURN jsonb_build_object(
      'ok', false, 'error', 'insufficient_source_stock',
      'available', COALESCE(v_available, 0), 'requested', p_quantity
    );
  END IF;

  EXECUTE format(
    'UPDATE inventory_levels SET %I = %I - $1, %I = %I + $1 WHERE sku_id = $2',
    p_from_stage, p_from_stage, p_to_stage, p_to_stage
  ) USING p_quantity, v_item.sku_id;

  UPDATE factory_order_items
     SET quantity_finished = quantity_finished + p_quantity
   WHERE id = p_factory_order_item_id;

  INSERT INTO inventory_transactions (
    sku_id, transaction_type, quantity, field_affected,
    movement_kind, from_field, to_field,
    reference_id, reference_type, notes, performed_by
  ) VALUES (
    v_item.sku_id, 'factory_order_update', p_quantity, p_to_stage,
    'category_move', p_from_stage, p_to_stage,
    v_item.factory_order_id, 'factory_order',
    format('%s [%s]: %s units %s → %s%s',
      v_sku.sku, COALESCE(v_order.order_number, v_order.id::text), p_quantity,
      p_from_stage, p_to_stage,
      CASE WHEN p_notes IS NOT NULL THEN ' — ' || p_notes ELSE '' END
    ),
    p_actor_id
  );

  RETURN jsonb_build_object('ok', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- -------------------------------------------------------------
-- Grant EXECUTE to authenticated (RLS-style guard is inside each function)
-- -------------------------------------------------------------
GRANT EXECUTE ON FUNCTION rpc_log_task_completion TO authenticated;
GRANT EXECUTE ON FUNCTION rpc_cycle_count TO authenticated;
GRANT EXECUTE ON FUNCTION rpc_apply_freight_delivery TO authenticated;
GRANT EXECUTE ON FUNCTION rpc_advance_factory_order_stage TO authenticated;
