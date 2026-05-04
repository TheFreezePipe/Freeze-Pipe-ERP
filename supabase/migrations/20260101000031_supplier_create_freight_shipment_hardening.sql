-- =============================================================
-- Migration 031: rpc_supplier_create_freight_shipment hardening
-- =============================================================
-- Bug: the existing RPC didn't pass shipment_number or freight_type to the
-- INSERT, so the NOT NULL constraints on freight_shipments.shipment_number
-- and freight_shipments.freight_type fired on every supplier-side create
-- attempt. The admin-side form always provided them explicitly, which is
-- why only the supplier flow broke.
--
-- Fix:
--   A. Auto-generate a shipment_number when the payload doesn't carry one.
--      Format: <SUPPLIER_CODE>-<YYYYMMDD>-<8-char idempotency prefix>
--      Example: NANCY-20260423-a3f8c2d1
--      Stable across retries because the idempotency key is the same.
--   B. Accept freight_type in the payload ('sea' | 'air'); default 'sea'
--      (sea is Nancy's default channel). Validated server-side.
--   C. Accept optional ship_date in the payload (for suppliers who want to
--      declare when the container leaves their facility).
--
-- Payload shape (additions marked NEW):
--   {
--     idempotency_key: uuid,
--     shipment_number?: text              -- NEW, optional, auto-generated if omitted
--     freight_type?: 'sea' | 'air',        -- NEW, default 'sea'
--     ship_date?: date,                    -- NEW
--     tracking_number?: text,
--     carrier: text,
--     eta?: date,
--     total_cartons: int,
--     lines: [{
--       sku_id: uuid,
--       supplier_declared_quantity: int,
--       source_factory_order_item_id?: uuid,
--       quantity_prefilled?: int
--     }]
--   }
--
-- Backwards-compatible: callers that don't send the new fields still work
-- (with auto-generated shipment_number + default sea freight).

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
  v_supplier suppliers%ROWTYPE;
  v_idempotency_key UUID := (p_payload->>'idempotency_key')::UUID;
  v_shipment_id UUID;
  v_existing_id UUID;
  v_shipment_number TEXT;
  v_freight_type TEXT;
  v_ship_date DATE;
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

  SELECT * INTO v_supplier FROM suppliers WHERE id = v_supplier_id;
  IF NOT FOUND OR NOT v_supplier.is_export_broker THEN
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

  -- ----- Resolve shipment_number -----
  -- Auto-generate when the payload doesn't carry one. Format chosen to be
  -- human-readable AND deterministic given the idempotency key, so retries
  -- land on the same number (important if the UNIQUE constraint catches a
  -- duplicate mid-transaction).
  v_shipment_number := NULLIF(trim(p_payload->>'shipment_number'), '');
  IF v_shipment_number IS NULL THEN
    v_shipment_number := v_supplier.code
      || '-'
      || to_char((now() at time zone 'utc')::DATE, 'YYYYMMDD')
      || '-'
      || substring(v_idempotency_key::text, 1, 8);
  END IF;

  -- ----- Resolve freight_type -----
  v_freight_type := COALESCE(NULLIF(trim(p_payload->>'freight_type'), ''), 'sea');
  IF v_freight_type NOT IN ('sea', 'air') THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'invalid_freight_type',
      'freight_type', v_freight_type
    );
  END IF;

  -- ----- Optional ship_date -----
  v_ship_date := NULLIF(p_payload->>'ship_date', '')::DATE;

  INSERT INTO freight_shipments (
    origin_supplier_id,
    created_by_supplier_user_id,
    idempotency_key,
    shipment_number,
    freight_type,
    tracking_number,
    carrier_name,
    status,
    ship_date,
    eta,
    eta_original,
    total_cartons
  ) VALUES (
    v_supplier_id,
    auth.uid(),
    v_idempotency_key,
    v_shipment_number,
    v_freight_type,
    NULLIF(p_payload->>'tracking_number', ''),
    p_payload->>'carrier',
    'pending',
    v_ship_date,
    NULLIF(p_payload->>'eta', '')::DATE,
    NULLIF(p_payload->>'eta', '')::DATE,
    COALESCE((p_payload->>'total_cartons')::INTEGER, 0)
  ) RETURNING id INTO v_shipment_id;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_payload->'lines') LOOP
    v_source_foi := NULLIF(v_line->>'source_factory_order_item_id', '')::UUID;
    v_qty := (v_line->>'supplier_declared_quantity')::INTEGER;
    v_qty_prefilled := NULLIF(v_line->>'quantity_prefilled', '')::INTEGER;

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
    jsonb_build_object(
      'origin_supplier_id', v_supplier_id,
      'shipment_number', v_shipment_number,
      'freight_type', v_freight_type,
      'line_count', v_line_count
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'shipment_id', v_shipment_id,
    'shipment_number', v_shipment_number,
    'line_count', v_line_count
  );
END;
$$;

GRANT EXECUTE ON FUNCTION rpc_supplier_create_freight_shipment(JSONB) TO authenticated;
