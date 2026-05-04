-- =============================================================
-- Migration 032: supplier shipment editing + factory-order order_number
-- =============================================================
-- Two small additions that go together because they both expand what a
-- supplier can do from the portal without going through admin:
--
--   A. rpc_supplier_update_shipment_tracking — post-create edits for
--      tracking_number, carrier_name, eta, ship_date. Only the origin
--      supplier can edit, and only before departure (pending | booked).
--      Version-gated via row_version on the shipment.
--
--   B. rpc_supplier_create_factory_order — now reads an optional
--      `order_number` off the payload and writes it onto the row. Matches
--      what the admin-side flow already did and lets suppliers stamp
--      their own reference (e.g., "NAN-2026-043") at creation time.

-- =============================================================
-- A. rpc_supplier_update_shipment_tracking
-- =============================================================
-- Every argument except the id is optional. NULL means "don't touch" —
-- this lets the UI submit just the fields the user changed and keep
-- everything else as-is without having to round-trip the full row.
CREATE OR REPLACE FUNCTION rpc_supplier_update_shipment_tracking(
  p_shipment_id UUID,
  p_expected_version INTEGER,
  p_tracking_number TEXT DEFAULT NULL,
  p_carrier TEXT DEFAULT NULL,
  p_eta DATE DEFAULT NULL,
  p_ship_date DATE DEFAULT NULL,
  -- Sentinels so callers can *clear* a field (vs "don't touch"). True on a
  -- field means "set it to the p_* value even if that's NULL". This avoids
  -- needing a second RPC for "remove tracking number".
  p_clear_tracking_number BOOLEAN DEFAULT false,
  p_clear_carrier BOOLEAN DEFAULT false,
  p_clear_eta BOOLEAN DEFAULT false,
  p_clear_ship_date BOOLEAN DEFAULT false
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_supplier_id UUID := jwt_supplier_id();
  v_row freight_shipments%ROWTYPE;
  v_prev_tracking TEXT;
  v_prev_carrier TEXT;
  v_prev_eta DATE;
  v_prev_ship_date DATE;
BEGIN
  IF v_supplier_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_a_supplier');
  END IF;

  SELECT * INTO v_row FROM freight_shipments WHERE id = p_shipment_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  IF v_row.origin_supplier_id IS DISTINCT FROM v_supplier_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_your_shipment');
  END IF;

  IF v_row.row_version != p_expected_version THEN
    RETURN jsonb_build_object(
      'ok', false, 'error', 'version_conflict',
      'current_version', v_row.row_version
    );
  END IF;

  IF v_row.status NOT IN ('pending', 'booked') THEN
    RETURN jsonb_build_object(
      'ok', false, 'error', 'shipment_not_editable',
      'current_status', v_row.status
    );
  END IF;

  v_prev_tracking := v_row.tracking_number;
  v_prev_carrier := v_row.carrier_name;
  v_prev_eta := v_row.eta;
  v_prev_ship_date := v_row.ship_date;

  UPDATE freight_shipments
     SET tracking_number = CASE
           WHEN p_clear_tracking_number THEN NULL
           WHEN p_tracking_number IS NOT NULL THEN NULLIF(trim(p_tracking_number), '')
           ELSE tracking_number
         END,
         carrier_name = CASE
           WHEN p_clear_carrier THEN NULL
           WHEN p_carrier IS NOT NULL THEN NULLIF(trim(p_carrier), '')
           ELSE carrier_name
         END,
         eta = CASE
           WHEN p_clear_eta THEN NULL
           WHEN p_eta IS NOT NULL THEN p_eta
           ELSE eta
         END,
         ship_date = CASE
           WHEN p_clear_ship_date THEN NULL
           WHEN p_ship_date IS NOT NULL THEN p_ship_date
           ELSE ship_date
         END
   WHERE id = p_shipment_id;

  INSERT INTO audit_logs (actor_id, action, target_table, target_id, details)
  VALUES (
    auth.uid(),
    'freight_shipment.update_tracking',
    'freight_shipments',
    p_shipment_id,
    jsonb_build_object(
      'prev_tracking_number', v_prev_tracking,
      'prev_carrier_name', v_prev_carrier,
      'prev_eta', v_prev_eta,
      'prev_ship_date', v_prev_ship_date,
      'new_tracking_number_requested', p_tracking_number,
      'new_carrier_requested', p_carrier,
      'new_eta_requested', p_eta,
      'new_ship_date_requested', p_ship_date,
      'clear_flags', jsonb_build_object(
        'tracking_number', p_clear_tracking_number,
        'carrier', p_clear_carrier,
        'eta', p_clear_eta,
        'ship_date', p_clear_ship_date
      )
    )
  );

  RETURN jsonb_build_object('ok', true);
END;
$$;

GRANT EXECUTE ON FUNCTION rpc_supplier_update_shipment_tracking(
  UUID, INTEGER, TEXT, TEXT, DATE, DATE, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN
) TO authenticated;

-- =============================================================
-- B. rpc_supplier_create_factory_order — accept order_number
-- =============================================================
-- Optional string field. Trimmed on save; empty string → NULL. No unique
-- constraint enforced here (different suppliers might reuse common refs
-- like "2026-Q2-01"). Backwards-compatible — payloads without
-- `order_number` still work exactly as before.
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
  v_order_number TEXT;
BEGIN
  IF v_supplier_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_a_supplier');
  END IF;

  IF v_idempotency_key IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_idempotency_key');
  END IF;

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

  v_order_number := NULLIF(trim(p_payload->>'order_number'), '');

  INSERT INTO factory_orders (
    supplier_id, order_date, expected_completion, status, notes,
    idempotency_key, order_number
  )
  VALUES (
    v_supplier_id,
    v_order_date,
    v_expected_completion,
    'ordered',
    p_payload->>'notes',
    v_idempotency_key,
    v_order_number
  )
  RETURNING id INTO v_order_id;

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

  INSERT INTO audit_logs (actor_id, action, target_table, target_id, details)
  VALUES (
    auth.uid(),
    'factory_order.create',
    'factory_orders',
    v_order_id,
    jsonb_build_object(
      'supplier_id', v_supplier_id,
      'item_count', v_item_count,
      'order_number', v_order_number
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'factory_order_id', v_order_id,
    'item_count', v_item_count,
    'order_number', v_order_number
  );
END;
$$;
