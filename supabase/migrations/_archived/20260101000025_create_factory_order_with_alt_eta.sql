-- =============================================================
-- Migration 025: rpc_supplier_create_factory_order accepts optional alt ETA per item
-- =============================================================
-- Context: migration 024 added `factory_order_items.alternate_expected_completion`
-- and an RPC to set it post-creation. Suppliers quickly wanted to set it at
-- creation time too — so they don't have to create → redirect → edit.
--
-- This migration REPLACES rpc_supplier_create_factory_order to read an
-- optional `alternate_expected_completion` field on each item in the payload.
-- Input shape:
--
--   {
--     idempotency_key: uuid,
--     expected_completion: date,
--     notes: text | null,
--     items: [{
--       sku_id: uuid,
--       quantity: int,
--       alternate_expected_completion?: date | null   -- NEW
--     }, ...]
--   }
--
-- Missing / null alternate_expected_completion means "inherit from parent
-- order" (same semantics as the column's default). No other contract change;
-- existing callers that don't set the field continue to work unchanged.
--
-- Validation: alt ETA, when provided, must be >= order_date. Matches the
-- check in rpc_supplier_set_item_alternate_eta (migration 024) for consistency.

CREATE OR REPLACE FUNCTION rpc_supplier_create_factory_order(
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
  v_order_date DATE := CURRENT_DATE;
  v_expected_completion DATE := (p_payload->>'expected_completion')::DATE;
  v_order_id UUID;
  v_existing_order_id UUID;
  v_item JSONB;
  v_item_count INTEGER := 0;
  v_alt_eta DATE;
BEGIN
  IF v_supplier_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_a_supplier');
  END IF;

  IF v_idempotency_key IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_idempotency_key');
  END IF;

  -- Idempotency replay
  SELECT id INTO v_existing_order_id
    FROM factory_orders
   WHERE supplier_id = v_supplier_id
     AND idempotency_key = v_idempotency_key;
  IF v_existing_order_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'factory_order_id', v_existing_order_id, 'replayed', true);
  END IF;

  IF jsonb_array_length(p_payload->'items') = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_items');
  END IF;

  -- Pre-validate: alt ETAs can't be before the order date.
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_payload->'items') LOOP
    v_alt_eta := NULLIF(v_item->>'alternate_expected_completion', '')::DATE;
    IF v_alt_eta IS NOT NULL AND v_alt_eta < v_order_date THEN
      RETURN jsonb_build_object(
        'ok', false,
        'error', 'alt_eta_before_order_date',
        'sku_id', v_item->>'sku_id',
        'alternate_expected_completion', v_alt_eta
      );
    END IF;
  END LOOP;

  -- Create the order
  INSERT INTO factory_orders (supplier_id, order_date, expected_completion, status, notes, idempotency_key)
  VALUES (
    v_supplier_id,
    v_order_date,
    v_expected_completion,
    'ordered',
    p_payload->>'notes',
    v_idempotency_key
  )
  RETURNING id INTO v_order_id;

  -- Create items
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_payload->'items') LOOP
    v_alt_eta := NULLIF(v_item->>'alternate_expected_completion', '')::DATE;
    INSERT INTO factory_order_items (
      factory_order_id,
      sku_id,
      quantity_ordered,
      alternate_expected_completion
    ) VALUES (
      v_order_id,
      (v_item->>'sku_id')::UUID,
      (v_item->>'quantity')::INTEGER,
      v_alt_eta
    );
    v_item_count := v_item_count + 1;
  END LOOP;

  -- Audit
  INSERT INTO audit_logs (actor_id, action, target_table, target_id, details)
  VALUES (
    auth.uid(),
    'factory_order.create',
    'factory_orders',
    v_order_id,
    jsonb_build_object('supplier_id', v_supplier_id, 'item_count', v_item_count)
  );

  RETURN jsonb_build_object('ok', true, 'factory_order_id', v_order_id, 'item_count', v_item_count);
END;
$$;
