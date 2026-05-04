-- =============================================================
-- Migration 027: breakage task type + freight quantity_prefilled
-- =============================================================
-- Two related changes bundled because they both feed the SKU detail page's
-- refreshed cost breakdown:
--
--   A. New task_type 'breakage' — internal team logs broken units via the
--      workspace. Decrements warehouse_finished; no destination bucket. We
--      extend the task_type CHECK, extend `_task_type_movement` to support a
--      pure-decrement move (from_field set, to_field NULL), and update
--      rpc_log_task_completion to handle that shape.
--
--   B. freight_line_items.quantity_prefilled INTEGER — the portion of each
--      line's `quantity` that arrived already filled at the supplier.
--      Captured at shipment-create time by whoever declares the line
--      (supplier portal or internal admin). A single line can be mixed
--      (e.g. 100 units: 60 prefilled, 40 unfilled) — keeping it as a
--      subset-of-quantity integer rather than a boolean handles that
--      without forcing line splits. NULL = unknown / pre-migration; rows
--      with NULL are excluded from the prefill ratio on the SKU detail
--      page. The computed unfilled qty = quantity - quantity_prefilled.

-- =============================================================
-- A. Extend task_logs.task_type CHECK to include 'breakage'
-- =============================================================
ALTER TABLE task_logs DROP CONSTRAINT IF EXISTS task_logs_task_type_check;
ALTER TABLE task_logs
  ADD CONSTRAINT task_logs_task_type_check
  CHECK (task_type IN ('emptying', 'filling_capping', 'rtsing', 'prefilled_rtsing', 'breakage'));

-- =============================================================
-- A. Extend _task_type_movement to return (warehouse_finished, NULL) for 'breakage'
-- =============================================================
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
    WHEN 'breakage' THEN
      -- Pure decrement: units discovered broken are removed from
      -- warehouse_finished without landing anywhere else. The RPC handles
      -- to_field IS NULL as a plain subtract (no increment).
      RETURN QUERY SELECT 'warehouse_finished'::TEXT, NULL::TEXT;
    ELSE
      RAISE EXCEPTION 'Unknown task_type: %', p_task_type;
  END CASE;
END;
$$ LANGUAGE plpgsql;

-- =============================================================
-- A. rpc_log_task_completion — support pure-decrement moves
-- =============================================================
-- The previous version assumed a move is either "no change" (both NULL) or
-- "from → to" (both set). Breakage is the first case of "decrement only"
-- (from set, to NULL), so the UPDATE needs to branch.
CREATE OR REPLACE FUNCTION rpc_log_task_completion(
  p_sku_id UUID,
  p_task_type TEXT,
  p_quantity INTEGER,
  p_notes TEXT,
  p_actor_id UUID,
  p_time_started TIMESTAMPTZ DEFAULT NULL,
  p_time_completed TIMESTAMPTZ DEFAULT now(),
  p_location_id UUID DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
  v_sku product_skus%ROWTYPE;
  v_move RECORD;
  v_task_log_id UUID;
  v_available INTEGER;
  v_location_id UUID;
BEGIN
  v_location_id := COALESCE(p_location_id, _default_location_id());

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

  PERFORM 1 FROM inventory_levels
    WHERE sku_id = p_sku_id AND location_id = v_location_id FOR UPDATE;

  IF v_move.from_field IS NOT NULL THEN
    EXECUTE format(
      'SELECT %I FROM inventory_levels WHERE sku_id = $1 AND location_id = $2',
      v_move.from_field
    ) INTO v_available USING p_sku_id, v_location_id;

    IF v_available IS NULL OR v_available < p_quantity THEN
      RETURN jsonb_build_object(
        'ok', false,
        'error', 'insufficient_source_stock',
        'available', COALESCE(v_available, 0),
        'requested', p_quantity,
        'location_id', v_location_id
      );
    END IF;

    -- Branch on whether this is a move or a pure decrement. Both pathways
    -- decrement from_field; only the "move" pathway also increments to_field.
    IF v_move.to_field IS NOT NULL THEN
      EXECUTE format(
        'UPDATE inventory_levels SET %I = %I - $1, %I = %I + $1 WHERE sku_id = $2 AND location_id = $3',
        v_move.from_field, v_move.from_field,
        v_move.to_field, v_move.to_field
      ) USING p_quantity, p_sku_id, v_location_id;
    ELSE
      EXECUTE format(
        'UPDATE inventory_levels SET %I = %I - $1 WHERE sku_id = $2 AND location_id = $3',
        v_move.from_field, v_move.from_field
      ) USING p_quantity, p_sku_id, v_location_id;
    END IF;
  END IF;

  INSERT INTO task_logs (
    employee_id, sku_id, task_type, quantity_processed,
    time_started, time_completed, notes
  ) VALUES (
    p_actor_id, p_sku_id, p_task_type, p_quantity,
    p_time_started, p_time_completed, p_notes
  ) RETURNING id INTO v_task_log_id;

  INSERT INTO inventory_transactions (
    sku_id, transaction_type, quantity, field_affected,
    movement_kind, from_field, to_field,
    reference_id, reference_type, notes, performed_by
  ) VALUES (
    p_sku_id, 'task_logged', p_quantity,
    COALESCE(v_move.to_field, v_move.from_field, 'warehouse_in_production'),
    CASE
      WHEN v_move.from_field IS NULL THEN 'metadata'
      WHEN v_move.to_field IS NULL THEN 'write_off'
      ELSE 'category_move'
    END,
    v_move.from_field, v_move.to_field,
    v_task_log_id, 'task_log',
    format('%s: %s of %s units%s',
      v_sku.sku, replace(p_task_type, '_', ' '), p_quantity,
      CASE WHEN p_notes IS NOT NULL THEN ' — ' || p_notes ELSE '' END),
    p_actor_id
  );

  RETURN jsonb_build_object('ok', true, 'task_log_id', v_task_log_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION rpc_log_task_completion(UUID, TEXT, INTEGER, TEXT, UUID, TIMESTAMPTZ, TIMESTAMPTZ, UUID) TO authenticated;

-- =============================================================
-- B. freight_line_items.quantity_prefilled
-- =============================================================
-- Portion of `quantity` that arrived filled at the supplier. Feeds the SKU
-- detail page's Manufacturing Cost auto-derive — compute ratio as
-- sum(quantity_prefilled) / sum(quantity) for arrived lines in the window.
--
-- Semantics:
--   NULL        — unknown / pre-migration. Line is excluded from ratio stats.
--   0           — fully unfilled (needs US filling).
--   quantity    — fully prefilled.
--   between     — mixed: that many prefilled, rest unfilled.
--
-- Enforced via a CHECK. Existing rows default to NULL; the create-shipment
-- flows (supplier portal + internal admin) will surface an input so any
-- shipment going forward carries the signal.
ALTER TABLE freight_line_items
  ADD COLUMN quantity_prefilled INTEGER;

ALTER TABLE freight_line_items
  ADD CONSTRAINT chk_freight_line_items_prefilled_bounds
  CHECK (
    quantity_prefilled IS NULL
    OR (quantity_prefilled >= 0 AND quantity_prefilled <= quantity)
  );

COMMENT ON COLUMN freight_line_items.quantity_prefilled IS
  'Subset of quantity that arrived already filled at supplier. NULL = unknown, 0 = all unfilled, = quantity = all prefilled, between = mixed.';

-- Partial index: only tracked rows. Supports the "last N days of arrivals
-- per SKU" query on the SKU detail page.
CREATE INDEX idx_freight_line_items_prefill_tracked
  ON freight_line_items(sku_id, freight_shipment_id)
  WHERE quantity_prefilled IS NOT NULL;

-- =============================================================
-- B. rpc_supplier_create_freight_shipment — accept quantity_prefilled
-- =============================================================
-- Redefines the supplier create RPC (originally migration 021, revised in
-- 024-ish territory on live DB) to read an optional `quantity_prefilled`
-- per line item. Backwards-compatible: callers that don't include the
-- field just get NULL in the column, matching pre-migration behavior.
CREATE OR REPLACE FUNCTION rpc_supplier_create_freight_shipment(
  p_payload JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_supplier_id UUID := jwt_supplier_id();
  v_idempotency_key UUID := (p_payload->>'idempotency_key')::UUID;
  v_shipment_id UUID;
  v_existing_id UUID;
  v_line JSONB;
  v_line_count INTEGER := 0;
  v_source_foi UUID;
  v_qty INTEGER;
  v_qty_prefilled INTEGER;
BEGIN
  IF v_supplier_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_a_supplier');
  END IF;

  IF v_idempotency_key IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_idempotency_key');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM suppliers WHERE id = v_supplier_id AND is_export_broker = true
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authorized_as_broker');
  END IF;

  -- Idempotency replay
  SELECT id INTO v_existing_id
    FROM freight_shipments
   WHERE origin_supplier_id = v_supplier_id
     AND idempotency_key = v_idempotency_key;
  IF v_existing_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'shipment_id', v_existing_id, 'replayed', true);
  END IF;

  IF jsonb_array_length(p_payload->'lines') = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_lines');
  END IF;

  INSERT INTO freight_shipments (
    origin_supplier_id,
    created_by_supplier_user_id,
    idempotency_key,
    tracking_number,
    carrier_name,
    status,
    eta,
    eta_original,
    total_cartons
  ) VALUES (
    v_supplier_id,
    auth.uid(),
    v_idempotency_key,
    NULLIF(p_payload->>'tracking_number', ''),
    p_payload->>'carrier',
    'pending',
    NULLIF(p_payload->>'eta', '')::DATE,
    NULLIF(p_payload->>'eta', '')::DATE,
    COALESCE((p_payload->>'total_cartons')::INTEGER, 0)
  ) RETURNING id INTO v_shipment_id;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_payload->'lines') LOOP
    v_source_foi := NULLIF(v_line->>'source_factory_order_item_id', '')::UUID;
    v_qty := (v_line->>'supplier_declared_quantity')::INTEGER;
    v_qty_prefilled := NULLIF(v_line->>'quantity_prefilled', '')::INTEGER;

    -- Validate prefilled subset bounds (table CHECK does it too, but we
    -- want a clean envelope error instead of a raw exception).
    IF v_qty_prefilled IS NOT NULL AND (v_qty_prefilled < 0 OR v_qty_prefilled > v_qty) THEN
      RETURN jsonb_build_object(
        'ok', false,
        'error', 'invalid_prefilled_quantity',
        'sku_id', v_line->>'sku_id',
        'quantity', v_qty,
        'quantity_prefilled', v_qty_prefilled
      );
    END IF;

    IF v_source_foi IS NOT NULL THEN
      IF NOT EXISTS (
        SELECT 1 FROM factory_order_items foi
        JOIN factory_orders fo ON fo.id = foi.factory_order_id
        WHERE foi.id = v_source_foi
          AND (fo.supplier_id = ANY(jwt_supplier_scope())
               OR fo.ship_via_supplier_id = ANY(jwt_supplier_scope()))
      ) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_source_foi',
                                  'source_factory_order_item_id', v_source_foi);
      END IF;
    END IF;

    INSERT INTO freight_line_items (
      freight_shipment_id,
      sku_id,
      quantity,
      supplier_declared_quantity,
      source_factory_order_item_id,
      unit_cost,
      quantity_prefilled
    ) VALUES (
      v_shipment_id,
      (v_line->>'sku_id')::UUID,
      v_qty,
      v_qty,
      v_source_foi,
      0,
      v_qty_prefilled
    );
    v_line_count := v_line_count + 1;
  END LOOP;

  INSERT INTO audit_logs (actor_id, action, target_table, target_id, details)
  VALUES (
    auth.uid(),
    'freight_shipment.create',
    'freight_shipments',
    v_shipment_id,
    jsonb_build_object('origin_supplier_id', v_supplier_id, 'line_count', v_line_count)
  );

  RETURN jsonb_build_object('ok', true, 'shipment_id', v_shipment_id, 'line_count', v_line_count);
END;
$$;

GRANT EXECUTE ON FUNCTION rpc_supplier_create_freight_shipment(JSONB) TO authenticated;
