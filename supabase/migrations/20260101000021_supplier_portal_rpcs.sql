-- =============================================================
-- Migration 021: Supplier portal RPCs (part 2 of 2)
-- =============================================================
-- Companion to migration 020. 020 added the schema + RLS; this adds the
-- SECURITY DEFINER functions that suppliers (and internal users acting
-- on supplier data) call to mutate state.
--
-- Design rules for every RPC in this file:
--
--   1. SECURITY DEFINER + SET search_path = public. Prevents search_path
--      hijacking. Owner is postgres; execute is granted to authenticated.
--
--   2. Every RPC begins by asserting caller identity. Supplier RPCs check
--      jwt_supplier_id() is non-null and matches the target row's supplier.
--      Internal RPCs check jwt_is_internal().
--
--   3. Return a JSONB envelope: { ok: bool, error?: text, ... }. The hook
--      layer translates ok=false into thrown errors — see hooks.test.ts.
--
--   4. Every write emits an audit_logs entry. Audit hash-chaining from
--      migration 009 keeps integrity.
--
--   5. No UPDATE ... RETURNING *; use explicit SELECT then UPDATE then
--      return the computed envelope. Easier to reason about concurrency.
--
--   6. Idempotency keys (where applicable) are checked FIRST. If a prior
--      call with the same key succeeded, we return its outcome.
--
-- Sections:
--   A. Supplier: create factory order + items (with idempotency)
--   B. Supplier: advance / cancel factory order
--   C. Supplier: create freight shipment + lines (with idempotency)
--   D. Consolidator: confirm factory order receive (counts + breakage)
--   E. Consolidator: create component_breakage_report
--   F. Supplier: acknowledge variance / breakage report
--   G. Admin: promote user to supplier / deactivate supplier user

-- =============================================================
-- A. rpc_supplier_create_factory_order
-- =============================================================
-- A supplier logs a new production run. Creates factory_orders + its items
-- in one transaction. Idempotent via (origin_supplier, idempotency_key).
--
-- Input JSONB shape:
--   {
--     idempotency_key: uuid,
--     expected_completion: date,
--     notes: text | null,
--     items: [{ sku_id: uuid, quantity: int }, ...]
--   }
--
-- The caller's supplier_id is taken from their JWT; not passed in.
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
  v_order_id UUID;
  v_existing_order_id UUID;
  v_item JSONB;
  v_item_count INTEGER := 0;
BEGIN
  IF v_supplier_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_a_supplier');
  END IF;

  IF v_idempotency_key IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_idempotency_key');
  END IF;

  -- Idempotency: if a prior create with the same key exists, return it.
  -- Uses factory_orders.idempotency_key (per-supplier UNIQUE partial index).
  SELECT id INTO v_existing_order_id
    FROM factory_orders
   WHERE supplier_id = v_supplier_id
     AND idempotency_key = v_idempotency_key;
  IF v_existing_order_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'factory_order_id', v_existing_order_id, 'replayed', true);
  END IF;

  -- Validate items array
  IF jsonb_array_length(p_payload->'items') = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_items');
  END IF;

  -- Create the order
  INSERT INTO factory_orders (supplier_id, order_date, expected_completion, status, notes, idempotency_key)
  VALUES (
    v_supplier_id,
    CURRENT_DATE,
    (p_payload->>'expected_completion')::DATE,
    'ordered',
    p_payload->>'notes',
    v_idempotency_key
  )
  RETURNING id INTO v_order_id;

  -- Create items
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_payload->'items') LOOP
    INSERT INTO factory_order_items (factory_order_id, sku_id, quantity_ordered)
    VALUES (
      v_order_id,
      (v_item->>'sku_id')::UUID,
      (v_item->>'quantity')::INTEGER
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

GRANT EXECUTE ON FUNCTION rpc_supplier_create_factory_order(JSONB) TO authenticated;

-- =============================================================
-- B. rpc_supplier_advance_factory_order / rpc_supplier_cancel_factory_order
-- =============================================================
-- Allowed transitions by the PRODUCING supplier (not consolidator):
--   ordered → in_production → finished
-- 'shipped' is set only by the freight-creation flow (section C).
-- Cancellation: only from 'ordered' or 'in_production'. Finished/shipped
-- orders can't be canceled (they're already committed to inventory paths).

CREATE OR REPLACE FUNCTION rpc_supplier_advance_factory_order(
  p_factory_order_id UUID,
  p_expected_version INTEGER,
  p_notes TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_supplier_id UUID := jwt_supplier_id();
  v_row factory_orders%ROWTYPE;
  v_next_status TEXT;
BEGIN
  IF v_supplier_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_a_supplier');
  END IF;

  SELECT * INTO v_row FROM factory_orders WHERE id = p_factory_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  IF v_row.supplier_id != v_supplier_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_your_order');
  END IF;

  IF v_row.row_version != p_expected_version THEN
    RETURN jsonb_build_object('ok', false, 'error', 'version_conflict',
                              'current_version', v_row.row_version);
  END IF;

  v_next_status := CASE v_row.status
    WHEN 'ordered' THEN 'in_production'
    WHEN 'in_production' THEN 'finished'
    ELSE NULL
  END;

  IF v_next_status IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_transition',
                              'current_status', v_row.status);
  END IF;

  UPDATE factory_orders SET status = v_next_status WHERE id = p_factory_order_id;

  INSERT INTO audit_logs (actor_id, action, target_table, target_id, details)
  VALUES (
    auth.uid(),
    'factory_order.advance',
    'factory_orders',
    p_factory_order_id,
    jsonb_build_object(
      'from', v_row.status,
      'to', v_next_status,
      'notes', p_notes
    )
  );

  RETURN jsonb_build_object('ok', true, 'new_status', v_next_status);
END;
$$;

GRANT EXECUTE ON FUNCTION rpc_supplier_advance_factory_order(UUID, INTEGER, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION rpc_supplier_cancel_factory_order(
  p_factory_order_id UUID,
  p_expected_version INTEGER,
  p_reason TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_supplier_id UUID := jwt_supplier_id();
  v_row factory_orders%ROWTYPE;
BEGIN
  IF v_supplier_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_a_supplier');
  END IF;

  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'reason_required');
  END IF;

  SELECT * INTO v_row FROM factory_orders WHERE id = p_factory_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  -- Producing supplier OR consolidator may cancel.
  IF v_row.supplier_id != v_supplier_id
     AND NOT (v_row.supplier_id = ANY(jwt_supplier_scope())) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_your_order');
  END IF;

  IF v_row.row_version != p_expected_version THEN
    RETURN jsonb_build_object('ok', false, 'error', 'version_conflict',
                              'current_version', v_row.row_version);
  END IF;

  IF v_row.status NOT IN ('ordered', 'in_production') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_cancelable',
                              'current_status', v_row.status);
  END IF;

  UPDATE factory_orders
     SET status = 'canceled',
         canceled_at = now(),
         canceled_by = auth.uid(),
         canceled_reason = p_reason
   WHERE id = p_factory_order_id;

  INSERT INTO audit_logs (actor_id, action, target_table, target_id, details)
  VALUES (
    auth.uid(),
    'factory_order.cancel',
    'factory_orders',
    p_factory_order_id,
    jsonb_build_object('from_status', v_row.status, 'reason', p_reason)
  );

  RETURN jsonb_build_object('ok', true);
END;
$$;

GRANT EXECUTE ON FUNCTION rpc_supplier_cancel_factory_order(UUID, INTEGER, TEXT) TO authenticated;

-- =============================================================
-- C. rpc_supplier_create_freight_shipment
-- =============================================================
-- Supplier-initiated shipment + its line items in one transaction.
-- Idempotent via (origin_supplier_id, idempotency_key) column on
-- freight_shipments (added in migration 020).
--
-- Input JSONB:
--   {
--     idempotency_key: uuid,
--     tracking_number: text | null,        -- optional at creation
--     carrier: text,
--     eta: date | null,
--     total_cartons: int,
--     lines: [{
--       sku_id: uuid,
--       supplier_declared_quantity: int,
--       source_factory_order_item_id: uuid | null
--     }, ...]
--   }
--
-- Status starts at 'pending'. The supplier transitions to 'booked' once
-- they've actually booked with the carrier (separate RPC, D.2 below).
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
BEGIN
  IF v_supplier_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_a_supplier');
  END IF;

  IF v_idempotency_key IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_idempotency_key');
  END IF;

  -- Additional gate: only suppliers with is_export_broker may create shipments.
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

    -- Validate: if source_foi is linked, it must belong to an order this
    -- supplier can see. Prevents attaching arbitrary factory-order-item ids.
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
      unit_cost
    ) VALUES (
      v_shipment_id,
      (v_line->>'sku_id')::UUID,
      (v_line->>'supplier_declared_quantity')::INTEGER,
      (v_line->>'supplier_declared_quantity')::INTEGER,
      v_source_foi,
      0  -- supplier doesn't set cost; receiver/admin fills on receive
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

-- =============================================================
-- C.2 rpc_supplier_book_freight_shipment
-- =============================================================
-- Transition pending → booked once the supplier has a confirmed booking.
-- Allows late addition/correction of tracking_number + eta at this point.
CREATE OR REPLACE FUNCTION rpc_supplier_book_freight_shipment(
  p_shipment_id UUID,
  p_expected_version INTEGER,
  p_tracking_number TEXT,
  p_carrier TEXT,
  p_eta DATE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_supplier_id UUID := jwt_supplier_id();
  v_row freight_shipments%ROWTYPE;
BEGIN
  IF v_supplier_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_a_supplier');
  END IF;

  IF p_tracking_number IS NULL OR length(trim(p_tracking_number)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'tracking_number_required_for_booking');
  END IF;

  SELECT * INTO v_row FROM freight_shipments WHERE id = p_shipment_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  IF v_row.origin_supplier_id != v_supplier_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_your_shipment');
  END IF;

  IF v_row.row_version != p_expected_version THEN
    RETURN jsonb_build_object('ok', false, 'error', 'version_conflict',
                              'current_version', v_row.row_version);
  END IF;

  IF v_row.status != 'pending' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_transition',
                              'current_status', v_row.status);
  END IF;

  UPDATE freight_shipments
     SET status = 'booked',
         tracking_number = p_tracking_number,
         carrier_name = p_carrier,
         eta = p_eta,
         -- Preserve eta_original if it was set at create; otherwise stamp it now.
         eta_original = COALESCE(eta_original, p_eta)
   WHERE id = p_shipment_id;

  INSERT INTO audit_logs (actor_id, action, target_table, target_id, details)
  VALUES (
    auth.uid(),
    'freight_shipment.book',
    'freight_shipments',
    p_shipment_id,
    jsonb_build_object('tracking_number', p_tracking_number, 'carrier', p_carrier, 'eta', p_eta)
  );

  RETURN jsonb_build_object('ok', true);
END;
$$;

GRANT EXECUTE ON FUNCTION rpc_supplier_book_freight_shipment(UUID, INTEGER, TEXT, TEXT, DATE) TO authenticated;

-- =============================================================
-- D. rpc_consolidator_confirm_factory_order_receive
-- =============================================================
-- Nancy (the consolidator) physically receives a producer's (YX's) finished
-- order. She counts each item, records breakage, and this RPC:
--   - writes consolidator_confirmed_* fields on each item
--   - advances the order to 'finished' if it wasn't already
--   - (optionally) triggers a breakage report insert per item with breakage > 0
--
-- Input JSONB:
--   {
--     factory_order_id: uuid,
--     expected_version: int,
--     items: [{
--       factory_order_item_id: uuid,
--       confirmed_quantity: int,
--       breakage_quantity: int,
--       breakage_reason_category?: text,
--       breakage_description?: text
--     }, ...]
--   }
--
-- Inventory-level effects are NOT produced here. The usable quantity
-- (confirmed − breakage) feeds into the downstream freight flow — this
-- RPC captures a dock-level count, not a stock-level movement.
CREATE OR REPLACE FUNCTION rpc_consolidator_confirm_factory_order_receive(
  p_payload JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_supplier_id UUID := jwt_supplier_id();
  v_order_id UUID := (p_payload->>'factory_order_id')::UUID;
  v_expected_version INTEGER := (p_payload->>'expected_version')::INTEGER;
  v_order factory_orders%ROWTYPE;
  v_item JSONB;
  v_foi factory_order_items%ROWTYPE;
  v_confirmed INTEGER;
  v_breakage INTEGER;
  v_items_processed INTEGER := 0;
  v_breakage_reports_created INTEGER := 0;
  v_report_id UUID;
BEGIN
  -- Internal users (admin/manager) may also call — they act as Nancy's delegate.
  -- Supplier caller must be a consolidator of the producing supplier.
  IF v_caller_supplier_id IS NULL AND NOT jwt_is_internal() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authorized');
  END IF;

  SELECT * INTO v_order FROM factory_orders WHERE id = v_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  IF v_order.row_version != v_expected_version THEN
    RETURN jsonb_build_object('ok', false, 'error', 'version_conflict',
                              'current_version', v_order.row_version);
  END IF;

  -- If supplier caller: must consolidate for producer
  IF v_caller_supplier_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM suppliers
       WHERE id = v_caller_supplier_id
         AND v_order.supplier_id = ANY(consolidates_for)
    ) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'not_consolidator_for_producer');
    END IF;
  END IF;

  -- Only 'finished' or 'in_production' orders can be received. Already-
  -- received (i.e. already has consolidator_confirmed_* set on all items)
  -- orders should be rejected to avoid double-receive.
  IF v_order.status NOT IN ('in_production', 'finished') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_receivable',
                              'current_status', v_order.status);
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_payload->'items') LOOP
    SELECT * INTO v_foi
      FROM factory_order_items
     WHERE id = (v_item->>'factory_order_item_id')::UUID
       AND factory_order_id = v_order_id
     FOR UPDATE;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'error', 'item_not_in_order',
                                'factory_order_item_id', v_item->>'factory_order_item_id');
    END IF;

    IF v_foi.consolidator_confirmed_quantity IS NOT NULL THEN
      RETURN jsonb_build_object('ok', false, 'error', 'already_confirmed',
                                'factory_order_item_id', v_foi.id);
    END IF;

    v_confirmed := (v_item->>'confirmed_quantity')::INTEGER;
    v_breakage := COALESCE((v_item->>'breakage_quantity')::INTEGER, 0);

    IF v_confirmed < 0 OR v_breakage < 0 OR v_breakage > v_confirmed THEN
      RETURN jsonb_build_object('ok', false, 'error', 'invalid_quantities',
                                'factory_order_item_id', v_foi.id);
    END IF;

    UPDATE factory_order_items
       SET consolidator_confirmed_quantity = v_confirmed,
           consolidator_confirmed_at = now(),
           consolidator_confirmed_by = auth.uid(),
           quantity_breakage = v_breakage
     WHERE id = v_foi.id;

    -- If breakage + supplier caller is distinct from producer, open a
    -- breakage report. Internal callers can still file reports — we use
    -- the order's consolidator routing. For internal callers where no
    -- single "reporter supplier" applies, we skip the auto-report and
    -- let the UI prompt for an explicit filing.
    IF v_breakage > 0 AND v_caller_supplier_id IS NOT NULL
       AND v_caller_supplier_id != v_order.supplier_id THEN
      INSERT INTO component_breakage_reports (
        factory_order_item_id,
        producing_supplier_id,
        reporter_supplier_id,
        sku_id,
        quantity_broken,
        reason_category,
        description,
        status,
        created_by
      ) VALUES (
        v_foi.id,
        v_order.supplier_id,
        v_caller_supplier_id,
        v_foi.sku_id,
        v_breakage,
        COALESCE(v_item->>'breakage_reason_category', 'other'),
        COALESCE(v_item->>'breakage_description', 'Auto-opened from receive. Add details.'),
        'open',
        auth.uid()
      ) RETURNING id INTO v_report_id;
      v_breakage_reports_created := v_breakage_reports_created + 1;
    END IF;

    v_items_processed := v_items_processed + 1;
  END LOOP;

  -- If every item on the order is now confirmed, advance to 'finished'
  -- (if not already). 'finished' here = "fully received at consolidator."
  IF NOT EXISTS (
    SELECT 1 FROM factory_order_items
     WHERE factory_order_id = v_order_id
       AND consolidator_confirmed_quantity IS NULL
  ) AND v_order.status != 'finished' THEN
    UPDATE factory_orders SET status = 'finished' WHERE id = v_order_id;
  END IF;

  INSERT INTO audit_logs (actor_id, action, target_table, target_id, details)
  VALUES (
    auth.uid(),
    'factory_order.consolidator_receive',
    'factory_orders',
    v_order_id,
    jsonb_build_object(
      'items_processed', v_items_processed,
      'breakage_reports_created', v_breakage_reports_created
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'items_processed', v_items_processed,
    'breakage_reports_created', v_breakage_reports_created
  );
END;
$$;

GRANT EXECUTE ON FUNCTION rpc_consolidator_confirm_factory_order_receive(JSONB) TO authenticated;

-- =============================================================
-- E. rpc_file_component_breakage_report
-- =============================================================
-- Standalone breakage filing (post-receive discovery, or when the receive
-- RPC was used without inline breakage details). Validates reporter-
-- consolidates-for-producer via the table's trigger.
CREATE OR REPLACE FUNCTION rpc_file_component_breakage_report(
  p_factory_order_item_id UUID,
  p_quantity_broken INTEGER,
  p_reason_category TEXT,
  p_description TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_supplier_id UUID := jwt_supplier_id();
  v_foi factory_order_items%ROWTYPE;
  v_order factory_orders%ROWTYPE;
  v_report_id UUID;
BEGIN
  IF v_caller_supplier_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_a_supplier');
  END IF;

  IF p_quantity_broken IS NULL OR p_quantity_broken <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_quantity');
  END IF;

  IF p_description IS NULL OR length(trim(p_description)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'description_required');
  END IF;

  SELECT * INTO v_foi FROM factory_order_items WHERE id = p_factory_order_item_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'item_not_found');
  END IF;

  SELECT * INTO v_order FROM factory_orders WHERE id = v_foi.factory_order_id;

  -- The table's trg_breakage_reporter_consolidates trigger enforces the
  -- consolidator relationship; we'd hit that error anyway, but return
  -- a cleaner envelope here.
  IF NOT EXISTS (
    SELECT 1 FROM suppliers
     WHERE id = v_caller_supplier_id
       AND v_order.supplier_id = ANY(consolidates_for)
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_consolidator_for_producer');
  END IF;

  INSERT INTO component_breakage_reports (
    factory_order_item_id,
    producing_supplier_id,
    reporter_supplier_id,
    sku_id,
    quantity_broken,
    reason_category,
    description,
    status,
    created_by
  ) VALUES (
    p_factory_order_item_id,
    v_order.supplier_id,
    v_caller_supplier_id,
    v_foi.sku_id,
    p_quantity_broken,
    p_reason_category,
    p_description,
    'open',
    auth.uid()
  ) RETURNING id INTO v_report_id;

  INSERT INTO audit_logs (actor_id, action, target_table, target_id, details)
  VALUES (
    auth.uid(),
    'breakage_report.create',
    'component_breakage_reports',
    v_report_id,
    jsonb_build_object(
      'factory_order_item_id', p_factory_order_item_id,
      'quantity_broken', p_quantity_broken,
      'reason_category', p_reason_category
    )
  );

  RETURN jsonb_build_object('ok', true, 'breakage_report_id', v_report_id);
END;
$$;

GRANT EXECUTE ON FUNCTION rpc_file_component_breakage_report(UUID, INTEGER, TEXT, TEXT) TO authenticated;

-- =============================================================
-- F. rpc_acknowledge_shipment_variance + rpc_resolve_shipment_variance
-- =============================================================
-- Variance acknowledgment transitions status open → acknowledged.
-- Resolution transitions acknowledged → resolved (or written_off).
-- Both mutate only workflow columns; base-table trigger blocks any
-- attempt to change the immutable facts.

CREATE OR REPLACE FUNCTION rpc_acknowledge_shipment_variance(
  p_variance_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row shipment_variances%ROWTYPE;
  v_scope UUID[] := jwt_supplier_scope();
BEGIN
  SELECT * INTO v_row FROM shipment_variances WHERE id = p_variance_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  -- Supplier caller must be the origin supplier (or their consolidator).
  -- Internal users always allowed.
  IF NOT jwt_is_internal() AND NOT (v_row.origin_supplier_id = ANY(v_scope)) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authorized');
  END IF;

  IF v_row.status != 'open' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_transition',
                              'current_status', v_row.status);
  END IF;

  UPDATE shipment_variances
     SET status = 'acknowledged',
         acknowledged_at = now(),
         acknowledged_by = auth.uid()
   WHERE id = p_variance_id;

  INSERT INTO audit_logs (actor_id, action, target_table, target_id, details)
  VALUES (auth.uid(), 'shipment_variance.acknowledge', 'shipment_variances',
          p_variance_id, '{}'::JSONB);

  RETURN jsonb_build_object('ok', true);
END;
$$;

GRANT EXECUTE ON FUNCTION rpc_acknowledge_shipment_variance(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION rpc_resolve_shipment_variance(
  p_variance_id UUID,
  p_resolution_notes TEXT,
  p_write_off BOOLEAN DEFAULT false
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row shipment_variances%ROWTYPE;
  v_final_status TEXT;
BEGIN
  -- Only internal users resolve. Suppliers can acknowledge but not close.
  IF NOT jwt_is_internal() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'internal_only');
  END IF;

  IF p_resolution_notes IS NULL OR length(trim(p_resolution_notes)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'resolution_notes_required');
  END IF;

  SELECT * INTO v_row FROM shipment_variances WHERE id = p_variance_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  IF v_row.status NOT IN ('open', 'acknowledged') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_transition',
                              'current_status', v_row.status);
  END IF;

  v_final_status := CASE WHEN p_write_off THEN 'written_off' ELSE 'resolved' END;

  UPDATE shipment_variances
     SET status = v_final_status,
         resolved_at = now(),
         resolved_by = auth.uid(),
         resolution_notes = p_resolution_notes,
         -- If moving straight from 'open' → resolved, backfill ack fields
         -- to satisfy chk_variance_ack_coherent.
         acknowledged_at = COALESCE(acknowledged_at, now()),
         acknowledged_by = COALESCE(acknowledged_by, auth.uid())
   WHERE id = p_variance_id;

  INSERT INTO audit_logs (actor_id, action, target_table, target_id, details)
  VALUES (auth.uid(), 'shipment_variance.resolve', 'shipment_variances',
          p_variance_id, jsonb_build_object('final_status', v_final_status));

  RETURN jsonb_build_object('ok', true, 'final_status', v_final_status);
END;
$$;

GRANT EXECUTE ON FUNCTION rpc_resolve_shipment_variance(UUID, TEXT, BOOLEAN) TO authenticated;

-- =============================================================
-- F.2 Breakage report status transitions
-- =============================================================
CREATE OR REPLACE FUNCTION rpc_acknowledge_breakage_report(
  p_report_id UUID,
  p_dispute BOOLEAN DEFAULT false
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row component_breakage_reports%ROWTYPE;
  v_scope UUID[] := jwt_supplier_scope();
  v_new_status TEXT;
BEGIN
  SELECT * INTO v_row FROM component_breakage_reports WHERE id = p_report_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  -- Producer (the supplier the report is against) acknowledges or disputes.
  -- Internal users can also act.
  IF NOT jwt_is_internal() AND NOT (v_row.producing_supplier_id = ANY(v_scope)) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authorized');
  END IF;

  IF v_row.status != 'open' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_transition',
                              'current_status', v_row.status);
  END IF;

  v_new_status := CASE WHEN p_dispute THEN 'disputed' ELSE 'acknowledged' END;

  UPDATE component_breakage_reports
     SET status = v_new_status,
         acknowledged_at = now(),
         acknowledged_by = auth.uid()
   WHERE id = p_report_id;

  INSERT INTO audit_logs (actor_id, action, target_table, target_id, details)
  VALUES (auth.uid(), 'breakage_report.acknowledge', 'component_breakage_reports',
          p_report_id, jsonb_build_object('new_status', v_new_status));

  RETURN jsonb_build_object('ok', true, 'new_status', v_new_status);
END;
$$;

GRANT EXECUTE ON FUNCTION rpc_acknowledge_breakage_report(UUID, BOOLEAN) TO authenticated;

CREATE OR REPLACE FUNCTION rpc_resolve_breakage_report(
  p_report_id UUID,
  p_resolution_notes TEXT,
  p_replacement_factory_order_id UUID DEFAULT NULL,
  p_write_off BOOLEAN DEFAULT false
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row component_breakage_reports%ROWTYPE;
  v_final_status TEXT;
BEGIN
  IF NOT jwt_is_internal() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'internal_only');
  END IF;

  IF p_resolution_notes IS NULL OR length(trim(p_resolution_notes)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'resolution_notes_required');
  END IF;

  SELECT * INTO v_row FROM component_breakage_reports WHERE id = p_report_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  IF v_row.status NOT IN ('open', 'acknowledged', 'disputed') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_transition',
                              'current_status', v_row.status);
  END IF;

  v_final_status := CASE WHEN p_write_off THEN 'written_off' ELSE 'resolved' END;

  UPDATE component_breakage_reports
     SET status = v_final_status,
         resolved_at = now(),
         resolved_by = auth.uid(),
         resolution_notes = p_resolution_notes,
         replacement_requested = CASE
           WHEN p_replacement_factory_order_id IS NOT NULL THEN true
           ELSE replacement_requested
         END,
         replacement_factory_order_id = COALESCE(p_replacement_factory_order_id, replacement_factory_order_id),
         acknowledged_at = COALESCE(acknowledged_at, now()),
         acknowledged_by = COALESCE(acknowledged_by, auth.uid())
   WHERE id = p_report_id;

  INSERT INTO audit_logs (actor_id, action, target_table, target_id, details)
  VALUES (auth.uid(), 'breakage_report.resolve', 'component_breakage_reports',
          p_report_id, jsonb_build_object(
            'final_status', v_final_status,
            'replacement_factory_order_id', p_replacement_factory_order_id
          ));

  RETURN jsonb_build_object('ok', true, 'final_status', v_final_status);
END;
$$;

GRANT EXECUTE ON FUNCTION rpc_resolve_breakage_report(UUID, TEXT, UUID, BOOLEAN) TO authenticated;

-- =============================================================
-- G. Admin RPCs — supplier user provisioning
-- =============================================================
-- rpc_promote_user_to_supplier: promotes a profile to role='supplier' and
-- sets their supplier_id. Inverse + deactivate covered by existing
-- rpc_update_user_role (migration 015) plus a targeted is_active toggle.

CREATE OR REPLACE FUNCTION rpc_promote_user_to_supplier(
  p_target_user_id UUID,
  p_supplier_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_role TEXT;
  v_target profiles%ROWTYPE;
BEGIN
  SELECT role INTO v_actor_role FROM profiles WHERE id = auth.uid();
  IF v_actor_role IS DISTINCT FROM 'admin' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'admin_only');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM suppliers WHERE id = p_supplier_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'supplier_not_found');
  END IF;

  SELECT * INTO v_target FROM profiles WHERE id = p_target_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'user_not_found');
  END IF;

  IF v_target.role = 'supplier' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'already_supplier',
                              'current_supplier_id', v_target.supplier_id);
  END IF;

  -- One user per supplier (per MVP decision). Reject if target supplier
  -- already has an active supplier user.
  IF EXISTS (
    SELECT 1 FROM profiles
     WHERE supplier_id = p_supplier_id
       AND role = 'supplier'
       AND is_active = true
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'supplier_already_has_active_user');
  END IF;

  UPDATE profiles
     SET role = 'supplier',
         supplier_id = p_supplier_id
   WHERE id = p_target_user_id;

  INSERT INTO audit_logs (actor_id, action, target_table, target_id, details)
  VALUES (auth.uid(), 'profile.promote_to_supplier', 'profiles', p_target_user_id,
          jsonb_build_object('supplier_id', p_supplier_id, 'previous_role', v_target.role));

  RETURN jsonb_build_object('ok', true, 'supplier_id', p_supplier_id);
END;
$$;

GRANT EXECUTE ON FUNCTION rpc_promote_user_to_supplier(UUID, UUID) TO authenticated;

CREATE OR REPLACE FUNCTION rpc_set_profile_active(
  p_target_user_id UUID,
  p_is_active BOOLEAN
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_role TEXT;
BEGIN
  SELECT role INTO v_actor_role FROM profiles WHERE id = auth.uid();
  IF v_actor_role IS DISTINCT FROM 'admin' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'admin_only');
  END IF;

  IF p_target_user_id = auth.uid() AND p_is_active = false THEN
    RETURN jsonb_build_object('ok', false, 'error', 'cannot_deactivate_self');
  END IF;

  UPDATE profiles SET is_active = p_is_active WHERE id = p_target_user_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'user_not_found');
  END IF;

  INSERT INTO audit_logs (actor_id, action, target_table, target_id, details)
  VALUES (auth.uid(),
          CASE WHEN p_is_active THEN 'profile.reactivate' ELSE 'profile.deactivate' END,
          'profiles', p_target_user_id, '{}'::JSONB);

  RETURN jsonb_build_object('ok', true, 'is_active', p_is_active);
END;
$$;

GRANT EXECUTE ON FUNCTION rpc_set_profile_active(UUID, BOOLEAN) TO authenticated;

-- =============================================================
-- End of Migration 021. Supplier portal RPCs complete.
-- =============================================================
