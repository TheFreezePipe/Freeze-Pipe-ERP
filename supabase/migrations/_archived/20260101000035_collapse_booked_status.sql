-- =============================================================
-- Migration 035: collapse `booked` out of the freight state machine
-- =============================================================
-- Supersedes the booked status introduced in migration 022. In practice
-- "booked" and "departed" collapse to the same moment for our flow —
-- Nancy books the container with the carrier, gets a tracking number,
-- and at that point the shipment is as good as on the water. A separate
-- booked state added UI friction (the "Mark as booked" button) without
-- modeling a distinct reality.
--
-- New state machine:
--   pending (supplier drafted; no tracking yet)
--     └─► on_the_water (tracking + carrier submitted; reconcile loop
--                       takes over)
--            └─► high_risk | cleared_customs | tracking
--                   └─► delivered
--
-- Auto-promotion rule:
--   Whenever `tracking_number IS NOT NULL AND carrier_name IS NOT NULL`
--   and status is still `pending`, the row advances to `on_the_water`.
--   Applies on both create (rpc_supplier_create_freight_shipment) and
--   edit (rpc_supplier_update_shipment_tracking). ETA is intentionally
--   not required — it's cosmetic until something slips; the carrier
--   integration only needs the tracking number + carrier slug.
--
-- Editable window:
--   Suppliers can continue editing tracking/carrier/eta/ship_date/
--   freight_cost while the row is `pending` OR `on_the_water`. Once the
--   shipment reaches `cleared_customs` the supplier is done — further
--   corrections require an admin. This gives Nancy room to fix a
--   fat-fingered tracking number after she's already submitted.
--
-- Migration note: the comment in migration 022 ("set by internal
-- receive / ShipStation webhook") was wrong — ShipStation is outbound-
-- only (customer fulfillment / inventory deduction) and has no role in
-- inbound freight. Ignore that comment; this migration is the source of
-- truth for the state machine.
-- =============================================================

-- -------------------------------------------------------------
-- 1. Data: promote any surviving 'booked' rows to on_the_water.
-- -------------------------------------------------------------
UPDATE freight_shipments
   SET status = 'on_the_water'
 WHERE status = 'booked';

-- -------------------------------------------------------------
-- 2. CHECK constraint: drop 'booked' from the allowed set.
-- -------------------------------------------------------------
ALTER TABLE freight_shipments
  DROP CONSTRAINT IF EXISTS freight_shipments_status_check;

ALTER TABLE freight_shipments
  ADD CONSTRAINT freight_shipments_status_check
  CHECK (status IN (
    'pending',
    'on_the_water',
    'high_risk',
    'cleared_customs',
    'tracking',
    'delivered'
  ));

COMMENT ON COLUMN freight_shipments.status IS
  'Lifecycle: pending (supplier drafted, no tracking) -> on_the_water (tracking + carrier submitted; reconcile loop owns downstream transitions) -> high_risk | cleared_customs | tracking -> delivered.';

-- -------------------------------------------------------------
-- 3. Drop the now-dead book RPC. Its job (pending -> booked) is
--    replaced by auto-promotion inside create + update.
-- -------------------------------------------------------------
DROP FUNCTION IF EXISTS rpc_supplier_book_freight_shipment(
  UUID, INTEGER, TEXT, TEXT, DATE
);

-- -------------------------------------------------------------
-- 4. RLS INSERT policies — update to allow on_the_water as an initial
--    status (when the create RPC receives tracking + carrier up front
--    and auto-promotes at INSERT time).
-- -------------------------------------------------------------
DROP POLICY IF EXISTS "supplier_insert_own_shipments" ON freight_shipments;
CREATE POLICY "supplier_insert_own_shipments" ON freight_shipments
  FOR INSERT TO authenticated
  WITH CHECK (
    origin_supplier_id = jwt_supplier_id()
    AND created_by_supplier_user_id = auth.uid()
    AND status IN ('pending', 'on_the_water')
  );

DROP POLICY IF EXISTS "supplier_insert_own_freight_lines" ON freight_line_items;
CREATE POLICY "supplier_insert_own_freight_lines" ON freight_line_items
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM freight_shipments s
       WHERE s.id = freight_line_items.freight_shipment_id
         AND s.origin_supplier_id = jwt_supplier_id()
         AND s.status IN ('pending', 'on_the_water')
    )
    AND supplier_declared_quantity IS NOT NULL
    AND quantity = supplier_declared_quantity
  );

-- -------------------------------------------------------------
-- 5. rpc_supplier_create_freight_shipment — same body as migration 033
--    with two targeted changes:
--      (a) compute v_initial_status from tracking + carrier presence
--      (b) use v_initial_status instead of hardcoded 'pending' in INSERT
--    All other guardrails (broker auth, replay detect, no-lines reject,
--    per-line prefill validation, FOI scope check, audit log) preserved.
-- -------------------------------------------------------------
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
  v_tracking TEXT;
  v_carrier TEXT;
  v_initial_status TEXT;
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

  v_freight_cost := COALESCE((p_payload->>'freight_cost')::NUMERIC, 0);
  IF v_freight_cost < 0 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'invalid_freight_cost',
      'freight_cost', v_freight_cost
    );
  END IF;

  -- Auto-promote: tracking + carrier at creation time means the
  -- shipment is already on the water, per migration 035 state machine.
  v_tracking := NULLIF(p_payload->>'tracking_number', '');
  v_carrier := NULLIF(p_payload->>'carrier', '');
  IF v_tracking IS NOT NULL AND v_carrier IS NOT NULL THEN
    v_initial_status := 'on_the_water';
  ELSE
    v_initial_status := 'pending';
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
    v_tracking,
    v_carrier,
    v_initial_status,
    v_ship_date,
    NULLIF(p_payload->>'eta', '')::DATE,
    NULLIF(p_payload->>'eta', '')::DATE,
    COALESCE((p_payload->>'total_cartons')::INTEGER, 0),
    v_freight_cost,
    0,
    0,
    v_freight_cost
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
      'initial_status', v_initial_status,
      'line_count', v_line_count
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'shipment_id', v_shipment_id,
    'shipment_number', v_shipment_number,
    'status', v_initial_status,
    'line_count', v_line_count
  );
END;
$$;

GRANT EXECUTE ON FUNCTION rpc_supplier_create_freight_shipment(JSONB) TO authenticated;

-- -------------------------------------------------------------
-- 6. rpc_supplier_update_shipment_tracking — same signature as
--    migration 033, same body, two targeted changes:
--      (a) widen editable window from ('pending','booked') to
--          ('pending','on_the_water')
--      (b) auto-promote pending -> on_the_water after applying updates
--          when final tracking + carrier are both set
-- -------------------------------------------------------------
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
  v_prev_status TEXT;
  v_final_tracking TEXT;
  v_final_carrier TEXT;
  v_new_status TEXT;
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

  -- Editable while the supplier still owns the row. Once the freight
  -- has cleared customs, corrections require an admin.
  IF v_row.status NOT IN ('pending', 'on_the_water') THEN
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
  v_prev_status := v_row.status;

  -- Compute post-update tracking + carrier so we can decide whether to
  -- auto-promote. Mirrors the CASE logic in the UPDATE below.
  v_final_tracking := CASE
    WHEN p_clear_tracking_number THEN NULL
    WHEN p_tracking_number IS NOT NULL THEN NULLIF(trim(p_tracking_number), '')
    ELSE v_row.tracking_number
  END;
  v_final_carrier := CASE
    WHEN p_clear_carrier THEN NULL
    WHEN p_carrier IS NOT NULL THEN NULLIF(trim(p_carrier), '')
    ELSE v_row.carrier_name
  END;

  -- pending + both tracking and carrier set -> on_the_water. Never
  -- demote: once on_the_water, clearing tracking does NOT return to
  -- pending (would be odd semantically and would bounce the reconcile
  -- loop).
  IF v_row.status = 'pending'
     AND v_final_tracking IS NOT NULL
     AND v_final_carrier IS NOT NULL THEN
    v_new_status := 'on_the_water';
  ELSE
    v_new_status := v_row.status;
  END IF;

  UPDATE freight_shipments
     SET tracking_number = v_final_tracking,
         carrier_name = v_final_carrier,
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
           WHEN p_clear_freight_cost THEN COALESCE(insurance_cost, 0) + COALESCE(duties_cost, 0)
           WHEN p_freight_cost IS NOT NULL THEN
             p_freight_cost + COALESCE(insurance_cost, 0) + COALESCE(duties_cost, 0)
           ELSE total_cost
         END,
         status = v_new_status
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
      'prev_status', v_prev_status,
      'new_status', v_new_status,
      'auto_promoted', (v_prev_status = 'pending' AND v_new_status = 'on_the_water'),
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

  RETURN jsonb_build_object(
    'ok', true,
    'status', v_new_status,
    'promoted', (v_prev_status = 'pending' AND v_new_status = 'on_the_water')
  );
END;
$$;

GRANT EXECUTE ON FUNCTION rpc_supplier_update_shipment_tracking(
  UUID, INTEGER, TEXT, TEXT, DATE, DATE, NUMERIC, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN
) TO authenticated;
