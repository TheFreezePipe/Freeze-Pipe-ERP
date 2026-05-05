-- =============================================================
-- Migration 033: supplier shipment freight_cost on create + edit
-- =============================================================
-- Adding freight cost to the supplier flow. Nancy (and eventually YX when
-- they broker) pays the carrier directly, so the cost is hers to record
-- at creation and adjustable afterward.
--
-- Two touch points:
--   A. rpc_supplier_create_freight_shipment — now reads `freight_cost`
--      off the payload. Optional; defaults to 0 when omitted so existing
--      callers are unaffected.
--   B. rpc_supplier_update_shipment_tracking — add p_freight_cost and
--      p_clear_freight_cost to the optional-edit set. Because Postgres
--      treats functions with different arg signatures as different
--      identities, we DROP + recreate the RPC to preserve its single
--      canonical signature (alphabetically ordered args in the generated
--      types stay tidy).
--
-- The total_cost column stays in sync — when freight_cost is provided we
-- set total_cost = freight_cost + insurance_cost + duties_cost. Admin flow
-- had this aggregation baked in already; matching it here.

-- =============================================================
-- A. rpc_supplier_create_freight_shipment — accept freight_cost
-- =============================================================
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
  v_freight_cost NUMERIC;
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

  v_shipment_number := NULLIF(trim(p_payload->>'shipment_number'), '');
  IF v_shipment_number IS NULL THEN
    v_shipment_number := v_supplier.code
      || '-'
      || to_char((now() at time zone 'utc')::DATE, 'YYYYMMDD')
      || '-'
      || substring(v_idempotency_key::text, 1, 8);
  END IF;

  v_freight_type := COALESCE(NULLIF(trim(p_payload->>'freight_type'), ''), 'sea');
  IF v_freight_type NOT IN ('sea', 'air') THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'invalid_freight_type',
      'freight_type', v_freight_type
    );
  END IF;

  v_ship_date := NULLIF(p_payload->>'ship_date', '')::DATE;

  -- Freight cost: optional, defaults to 0. Negative values rejected up
  -- front with a clean envelope rather than letting the CHECK trigger a
  -- raw exception.
  v_freight_cost := COALESCE((p_payload->>'freight_cost')::NUMERIC, 0);
  IF v_freight_cost < 0 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'invalid_freight_cost',
      'freight_cost', v_freight_cost
    );
  END IF;

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
    total_cartons,
    freight_cost,
    insurance_cost,
    duties_cost,
    total_cost
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
    COALESCE((p_payload->>'total_cartons')::INTEGER, 0),
    v_freight_cost,
    0,
    0,
    v_freight_cost  -- total = freight + 0 insurance + 0 duties at supplier stage
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
      'freight_cost', v_freight_cost,
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

-- =============================================================
-- B. rpc_supplier_update_shipment_tracking — + freight_cost
-- =============================================================
-- DROP first: adding two new args (p_freight_cost, p_clear_freight_cost)
-- changes the function's identity signature. CREATE OR REPLACE won't
-- handle that — it needs the same signature to "replace." So we drop the
-- 10-arg version and create the 12-arg one.
DROP FUNCTION IF EXISTS rpc_supplier_update_shipment_tracking(
  UUID, INTEGER, TEXT, TEXT, DATE, DATE, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN
);

CREATE OR REPLACE FUNCTION rpc_supplier_update_shipment_tracking(
  p_shipment_id UUID,
  p_expected_version INTEGER,
  p_tracking_number TEXT DEFAULT NULL,
  p_carrier TEXT DEFAULT NULL,
  p_eta DATE DEFAULT NULL,
  p_ship_date DATE DEFAULT NULL,
  p_freight_cost NUMERIC DEFAULT NULL,
  p_clear_tracking_number BOOLEAN DEFAULT false,
  p_clear_carrier BOOLEAN DEFAULT false,
  p_clear_eta BOOLEAN DEFAULT false,
  p_clear_ship_date BOOLEAN DEFAULT false,
  p_clear_freight_cost BOOLEAN DEFAULT false
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
  v_prev_freight_cost NUMERIC;
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

  IF p_freight_cost IS NOT NULL AND p_freight_cost < 0 THEN
    RETURN jsonb_build_object(
      'ok', false, 'error', 'invalid_freight_cost',
      'freight_cost', p_freight_cost
    );
  END IF;

  v_prev_tracking := v_row.tracking_number;
  v_prev_carrier := v_row.carrier_name;
  v_prev_eta := v_row.eta;
  v_prev_ship_date := v_row.ship_date;
  v_prev_freight_cost := v_row.freight_cost;

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
         END,
         freight_cost = CASE
           WHEN p_clear_freight_cost THEN 0
           WHEN p_freight_cost IS NOT NULL THEN p_freight_cost
           ELSE freight_cost
         END,
         total_cost = CASE
           -- Keep total_cost = freight + insurance + duties in sync. At this
           -- stage insurance and duties are always 0 for supplier-created
           -- rows, so total_cost tracks freight_cost 1:1.
           WHEN p_clear_freight_cost THEN COALESCE(insurance_cost, 0) + COALESCE(duties_cost, 0)
           WHEN p_freight_cost IS NOT NULL THEN
             p_freight_cost + COALESCE(insurance_cost, 0) + COALESCE(duties_cost, 0)
           ELSE total_cost
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
      'prev_freight_cost', v_prev_freight_cost,
      'new_tracking_number_requested', p_tracking_number,
      'new_carrier_requested', p_carrier,
      'new_eta_requested', p_eta,
      'new_ship_date_requested', p_ship_date,
      'new_freight_cost_requested', p_freight_cost,
      'clear_flags', jsonb_build_object(
        'tracking_number', p_clear_tracking_number,
        'carrier', p_clear_carrier,
        'eta', p_clear_eta,
        'ship_date', p_clear_ship_date,
        'freight_cost', p_clear_freight_cost
      )
    )
  );

  RETURN jsonb_build_object('ok', true);
END;
$$;

GRANT EXECUTE ON FUNCTION rpc_supplier_update_shipment_tracking(
  UUID, INTEGER, TEXT, TEXT, DATE, DATE, NUMERIC, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN
) TO authenticated;
