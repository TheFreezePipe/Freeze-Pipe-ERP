-- ============================================================================
-- Partial freight receiving (Phase 1) — carton-native incremental check-in
-- ============================================================================
-- Design (2026-07-22, from the dependency audit):
--   * freight_line_items.quantity stays "units that left the factory" — it is
--     NEVER mutated by receiving (factory-order shipped logic keys off it).
--   * NEW freight_line_items.quantity_received = units physically checked in.
--     In-transit everywhere becomes max(0, quantity - quantity_received) —
--     statusless, so carrier auto-flips to 'delivered' can't distort counts.
--   * No new shipment status: "partially received" is DERIVED (received > 0
--     and receipt_confirmed_at IS NULL). Three status whitelists have rotted
--     before; we don't add a fourth landmine.
--   * Carton groups (the New Shipment form's in-memory structure, previously
--     discarded) are persisted for the tap-per-carton receiving UX. Mixed
--     cartons = multiple sku rows per group.
--   * Receipts are an append-only event log (who/when/what); corrections are
--     negative events with reversing ledger rows.
--   * Close-short: emits shortage variances, reduces line quantity to the
--     received amount (returning units to on-order via existing netting),
--     reopens auto-completed factory orders, stamps the shipment closed.

-- ---- 1. Carton structure ---------------------------------------------------
CREATE TABLE IF NOT EXISTS public.freight_carton_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  freight_shipment_id uuid NOT NULL REFERENCES public.freight_shipments(id) ON DELETE CASCADE,
  carton_qty integer NOT NULL CHECK (carton_qty > 0),
  received_cartons integer NOT NULL DEFAULT 0 CHECK (received_cartons >= 0),
  notes text,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fcg_shipment ON public.freight_carton_groups (freight_shipment_id);

CREATE TABLE IF NOT EXISTS public.freight_carton_group_skus (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  carton_group_id uuid NOT NULL REFERENCES public.freight_carton_groups(id) ON DELETE CASCADE,
  sku_id uuid NOT NULL REFERENCES public.product_skus(id),
  units_total integer NOT NULL CHECK (units_total > 0),
  pre_filled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fcgs_group ON public.freight_carton_group_skus (carton_group_id);

-- ---- 2. Received rollup + receipt event log --------------------------------
ALTER TABLE public.freight_line_items
  ADD COLUMN IF NOT EXISTS quantity_received integer NOT NULL DEFAULT 0;
ALTER TABLE public.freight_line_items DROP CONSTRAINT IF EXISTS chk_freight_li_received_nonneg;
ALTER TABLE public.freight_line_items
  ADD CONSTRAINT chk_freight_li_received_nonneg CHECK (quantity_received >= 0);

CREATE TABLE IF NOT EXISTS public.freight_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  freight_shipment_id uuid NOT NULL REFERENCES public.freight_shipments(id) ON DELETE CASCADE,
  carton_group_id uuid REFERENCES public.freight_carton_groups(id),
  sku_id uuid REFERENCES public.product_skus(id),
  cartons integer,
  units integer NOT NULL,
  received_by uuid REFERENCES public.profiles(id),
  received_at timestamptz NOT NULL DEFAULT now(),
  note text
);
CREATE INDEX IF NOT EXISTS idx_freight_receipts_shipment
  ON public.freight_receipts (freight_shipment_id, received_at);

ALTER TABLE public.freight_shipments
  ADD COLUMN IF NOT EXISTS closed_short_at timestamptz,
  ADD COLUMN IF NOT EXISTS closed_short_reason text;

-- ---- 3. RLS ----------------------------------------------------------------
ALTER TABLE public.freight_carton_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.freight_carton_group_skus ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.freight_receipts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS fcg_read ON public.freight_carton_groups;
CREATE POLICY fcg_read ON public.freight_carton_groups FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS fcg_manage ON public.freight_carton_groups;
CREATE POLICY fcg_manage ON public.freight_carton_groups FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_active AND role IN ('admin','manager')))
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_active AND role IN ('admin','manager')));

DROP POLICY IF EXISTS fcgs_read ON public.freight_carton_group_skus;
CREATE POLICY fcgs_read ON public.freight_carton_group_skus FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS fcgs_manage ON public.freight_carton_group_skus;
CREATE POLICY fcgs_manage ON public.freight_carton_group_skus FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_active AND role IN ('admin','manager')))
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_active AND role IN ('admin','manager')));

DROP POLICY IF EXISTS freight_receipts_read ON public.freight_receipts;
CREATE POLICY freight_receipts_read ON public.freight_receipts FOR SELECT TO authenticated USING (true);
-- receipts are written only by the SECURITY DEFINER RPCs.

-- ---- 4. Backfill: confirmed shipments are fully received --------------------
-- Delivered-but-unconfirmed ("pending receipt") stays at 0 — under the new
-- model those units are legitimately still awaiting check-in.
UPDATE public.freight_line_items li
   SET quantity_received = li.quantity
  FROM public.freight_shipments fs
 WHERE fs.id = li.freight_shipment_id
   AND fs.receipt_confirmed_at IS NOT NULL
   AND li.quantity_received = 0;

-- ---- 5. Incremental receipt RPC ---------------------------------------------
-- p_entries: jsonb array. Two entry shapes, mixable:
--   {"carton_group_id": uuid, "cartons": int}   (negative = correction)
--   {"line_item_id": uuid, "units": int}        (negative = correction)
-- Carton math: cumulative rounding so per-SKU credits sum exactly to
-- units_total when the last carton is tapped: cum(r) = round(U*r/M).
CREATE OR REPLACE FUNCTION public.rpc_record_freight_receipt(
  p_shipment_id uuid,
  p_entries jsonb,
  p_actor_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_shipment   freight_shipments%ROWTYPE;
  v_caller     text;
  v_entry      jsonb;
  v_group      freight_carton_groups%ROWTYPE;
  v_gs         RECORD;
  v_li         freight_line_items%ROWTYPE;
  v_cartons    int;
  v_units      int;
  v_r0         int;
  v_r1         int;
  v_delta      int;
  v_remaining  int;
  v_cap        int;
  v_take       int;
  v_pref_delta int;
  v_raw_delta  int;
  v_category   text;
  v_credited   jsonb := '[]'::jsonb;
  v_total_units int := 0;
  v_fully      boolean;
BEGIN
  IF p_actor_id <> '00000000-0000-0000-0000-000000000001'::uuid THEN
    SELECT role INTO v_caller FROM profiles WHERE id = p_actor_id AND is_active;
    IF v_caller IS NULL OR v_caller NOT IN ('admin','manager') THEN
      RETURN jsonb_build_object('ok', false, 'error', 'admin_or_manager_required',
        'message', 'Only admin or manager users may record freight receipts');
    END IF;
  END IF;

  SELECT * INTO v_shipment FROM freight_shipments WHERE id = p_shipment_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'shipment_not_found');
  END IF;
  IF v_shipment.receipt_confirmed_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'already_confirmed',
      'message', 'Shipment is fully received/closed — use a cycle count for corrections');
  END IF;
  IF p_entries IS NULL OR jsonb_typeof(p_entries) <> 'array' OR jsonb_array_length(p_entries) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_entries');
  END IF;

  FOR v_entry IN SELECT * FROM jsonb_array_elements(p_entries) LOOP

    IF v_entry ? 'carton_group_id' THEN
      -- ================= carton mode =================
      v_cartons := COALESCE((v_entry->>'cartons')::int, 0);
      IF v_cartons = 0 THEN CONTINUE; END IF;
      SELECT * INTO v_group FROM freight_carton_groups
       WHERE id = (v_entry->>'carton_group_id')::uuid AND freight_shipment_id = p_shipment_id
       FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'carton group % not on shipment', v_entry->>'carton_group_id';
      END IF;
      v_r0 := v_group.received_cartons;
      v_r1 := LEAST(GREATEST(v_r0 + v_cartons, 0), v_group.carton_qty);
      IF v_r1 = v_r0 THEN CONTINUE; END IF;

      UPDATE freight_carton_groups
         SET received_cartons = v_r1, updated_at = now()
       WHERE id = v_group.id;

      INSERT INTO freight_receipts (freight_shipment_id, carton_group_id, cartons, units, received_by, note)
      VALUES (p_shipment_id, v_group.id, v_r1 - v_r0, 0, p_actor_id, v_entry->>'note');

      -- Per-SKU unit delta via cumulative rounding, allocated across that
      -- SKU's line items (fill in creation order; drain in reverse).
      FOR v_gs IN
        SELECT sku_id, units_total, pre_filled FROM freight_carton_group_skus
        WHERE carton_group_id = v_group.id
      LOOP
        v_delta := round(v_gs.units_total::numeric * v_r1 / v_group.carton_qty)::int
                 - round(v_gs.units_total::numeric * v_r0 / v_group.carton_qty)::int;
        IF v_delta = 0 THEN CONTINUE; END IF;
        v_remaining := v_delta;

        IF v_delta > 0 THEN
          FOR v_li IN
            SELECT * FROM freight_line_items
            WHERE freight_shipment_id = p_shipment_id AND sku_id = v_gs.sku_id
            ORDER BY created_at
          LOOP
            EXIT WHEN v_remaining = 0;
            v_cap := GREATEST(v_li.quantity - v_li.quantity_received, 0);
            v_take := LEAST(v_cap, v_remaining);
            IF v_take > 0 THEN
              UPDATE freight_line_items SET quantity_received = quantity_received + v_take
               WHERE id = v_li.id;
              v_remaining := v_remaining - v_take;
            END IF;
          END LOOP;
          IF v_remaining > 0 THEN
            -- overage beyond declared: park on the last line of the SKU
            UPDATE freight_line_items SET quantity_received = quantity_received + v_remaining
             WHERE id = (SELECT id FROM freight_line_items
                          WHERE freight_shipment_id = p_shipment_id AND sku_id = v_gs.sku_id
                          ORDER BY created_at DESC LIMIT 1);
            v_remaining := 0;
          END IF;
        ELSE
          FOR v_li IN
            SELECT * FROM freight_line_items
            WHERE freight_shipment_id = p_shipment_id AND sku_id = v_gs.sku_id
            ORDER BY created_at DESC
          LOOP
            EXIT WHEN v_remaining = 0;
            v_take := LEAST(v_li.quantity_received, -v_remaining);
            IF v_take > 0 THEN
              UPDATE freight_line_items SET quantity_received = quantity_received - v_take
               WHERE id = v_li.id;
              v_remaining := v_remaining + v_take;
            END IF;
          END LOOP;
          v_delta := v_delta - v_remaining;  -- what we actually reversed
          v_remaining := 0;
        END IF;

        PERFORM _freight_credit_units(p_shipment_id, v_shipment.shipment_number,
                                      v_gs.sku_id, v_delta, v_gs.pre_filled, p_actor_id);
        v_total_units := v_total_units + v_delta;
        v_credited := v_credited || jsonb_build_object('sku_id', v_gs.sku_id, 'units', v_delta);
      END LOOP;

    ELSIF v_entry ? 'line_item_id' THEN
      -- ================= unit mode (legacy shipments) =================
      v_units := COALESCE((v_entry->>'units')::int, 0);
      IF v_units = 0 THEN CONTINUE; END IF;
      SELECT * INTO v_li FROM freight_line_items
       WHERE id = (v_entry->>'line_item_id')::uuid AND freight_shipment_id = p_shipment_id
       FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'line item % not on shipment', v_entry->>'line_item_id';
      END IF;
      IF v_li.sku_id IS NULL THEN
        RAISE EXCEPTION 'non-catalog lines cannot be received into inventory';
      END IF;
      v_r0 := v_li.quantity_received;
      v_r1 := GREATEST(v_r0 + v_units, 0);
      IF v_r1 = v_r0 THEN CONTINUE; END IF;

      UPDATE freight_line_items SET quantity_received = v_r1 WHERE id = v_li.id;

      -- prefilled share follows the line's declared ratio via cum-rounding
      v_pref_delta :=
        round(LEAST(COALESCE(v_li.quantity_prefilled,0), v_li.quantity)::numeric
              * LEAST(v_r1, v_li.quantity) / GREATEST(v_li.quantity,1))::int
      - round(LEAST(COALESCE(v_li.quantity_prefilled,0), v_li.quantity)::numeric
              * LEAST(v_r0, v_li.quantity) / GREATEST(v_li.quantity,1))::int;
      v_raw_delta := (v_r1 - v_r0) - v_pref_delta;

      INSERT INTO freight_receipts (freight_shipment_id, sku_id, units, received_by, note)
      VALUES (p_shipment_id, v_li.sku_id, v_r1 - v_r0, p_actor_id, v_entry->>'note');

      IF v_pref_delta <> 0 THEN
        PERFORM _freight_credit_units(p_shipment_id, v_shipment.shipment_number,
                                      v_li.sku_id, v_pref_delta, true, p_actor_id);
      END IF;
      IF v_raw_delta <> 0 THEN
        PERFORM _freight_credit_units(p_shipment_id, v_shipment.shipment_number,
                                      v_li.sku_id, v_raw_delta, false, p_actor_id);
      END IF;
      v_total_units := v_total_units + (v_r1 - v_r0);
      v_credited := v_credited || jsonb_build_object('sku_id', v_li.sku_id, 'units', v_r1 - v_r0);
    ELSE
      RAISE EXCEPTION 'entry must have carton_group_id or line_item_id';
    END IF;
  END LOOP;

  IF v_total_units > 0 THEN
    UPDATE freight_shipments
       SET actual_arrival_date = COALESCE(actual_arrival_date, CURRENT_DATE)
     WHERE id = p_shipment_id;
  END IF;

  -- Fully received? (catalog lines only; non-catalog never blocks)
  SELECT NOT EXISTS (
    SELECT 1 FROM freight_line_items
    WHERE freight_shipment_id = p_shipment_id AND sku_id IS NOT NULL
      AND quantity_received < quantity
  ) INTO v_fully;

  IF v_fully THEN
    UPDATE freight_shipments
       SET status = 'delivered',
           receipt_confirmed_at = now(),
           receipt_confirmed_by = p_actor_id
     WHERE id = p_shipment_id;
  END IF;

  RETURN jsonb_build_object('ok', true, 'units_credited', v_total_units,
                            'credited', v_credited, 'fully_received', v_fully);
END;
$$;

-- Bucket credit helper: mirrors the original delivery RPC's category logic
-- (non_fillable -> finished; fillable -> prefilled_raw or raw) with signed
-- quantities for corrections. Ledger rows keep transaction_type
-- 'freight_delivered' so every history reconstruction keeps working.
CREATE OR REPLACE FUNCTION public._freight_credit_units(
  p_shipment_id uuid, p_shipment_number text,
  p_sku_id uuid, p_units int, p_pre_filled boolean, p_actor_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_category text;
  v_field text;
BEGIN
  IF p_units = 0 THEN RETURN; END IF;
  PERFORM 1 FROM inventory_levels WHERE sku_id = p_sku_id FOR UPDATE;
  SELECT category INTO v_category FROM product_skus WHERE id = p_sku_id;

  IF v_category = 'non_fillable' THEN v_field := 'warehouse_finished';
  ELSIF p_pre_filled THEN v_field := 'warehouse_prefilled_raw';
  ELSE v_field := 'warehouse_raw';
  END IF;

  EXECUTE format('UPDATE inventory_levels SET %I = GREATEST(%I + $1, 0) WHERE sku_id = $2', v_field, v_field)
  USING p_units, p_sku_id;

  INSERT INTO inventory_transactions (
    sku_id, transaction_type, quantity, field_affected,
    movement_kind, from_field, to_field,
    reference_id, reference_type, notes, performed_by
  ) VALUES (
    p_sku_id, 'freight_delivered', p_units, v_field,
    'net_change', NULL, v_field,
    p_shipment_id, 'freight_shipment',
    format('%s receipt: %s units %s %s', p_shipment_number, abs(p_units),
           CASE WHEN p_units > 0 THEN 'credited to' ELSE 'reversed from' END, v_field),
    p_actor_id
  );
END;
$$;

-- ---- 6. Close short ----------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_close_freight_short(
  p_shipment_id uuid,
  p_reason text,
  p_actor_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_shipment freight_shipments%ROWTYPE;
  v_caller text;
  v_li RECORD;
  v_short int;
  v_short_total int := 0;
  v_variances int := 0;
  v_fo uuid;
  v_fo_status text;
  v_reopened int := 0;
  v_affected_fos uuid[] := '{}';
BEGIN
  SELECT role INTO v_caller FROM profiles WHERE id = p_actor_id AND is_active;
  IF v_caller IS NULL OR v_caller NOT IN ('admin','manager') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'admin_or_manager_required');
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'reason_required');
  END IF;

  SELECT * INTO v_shipment FROM freight_shipments WHERE id = p_shipment_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'shipment_not_found');
  END IF;
  IF v_shipment.receipt_confirmed_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'already_confirmed');
  END IF;

  FOR v_li IN
    SELECT * FROM freight_line_items
    WHERE freight_shipment_id = p_shipment_id AND sku_id IS NOT NULL
    ORDER BY created_at
  LOOP
    v_short := v_li.quantity - v_li.quantity_received;
    IF v_short <= 0 THEN CONTINUE; END IF;
    v_short_total := v_short_total + v_short;

    IF v_li.source_factory_order_item_id IS NOT NULL THEN
      SELECT factory_order_id INTO v_fo FROM factory_order_items WHERE id = v_li.source_factory_order_item_id;
      IF v_fo IS NOT NULL AND NOT (v_fo = ANY(v_affected_fos)) THEN
        v_affected_fos := v_affected_fos || v_fo;
      END IF;
    END IF;

    -- Formal shortage record when the shipment has a portal supplier;
    -- always an audit log either way.
    IF v_shipment.origin_supplier_id IS NOT NULL THEN
      INSERT INTO shipment_variances (
        freight_line_item_id, shipment_id, sku_id, origin_supplier_id,
        declared_quantity, received_quantity, variance_quantity,
        variance_type, status, notes, created_by
      ) VALUES (
        v_li.id, p_shipment_id, v_li.sku_id, v_shipment.origin_supplier_id,
        v_li.quantity, v_li.quantity_received, v_short,
        'shortage', 'open',
        format('Closed short: %s — %s of %s units never arrived', p_reason, v_short, v_li.quantity),
        p_actor_id
      );
      v_variances := v_variances + 1;
    END IF;

    INSERT INTO audit_logs (actor_id, action, target_table, target_id, details)
    VALUES (p_actor_id, 'freight.closed_short_line', 'freight_line_items', v_li.id,
            jsonb_build_object('shipment', v_shipment.shipment_number, 'sku_id', v_li.sku_id,
                               'declared', v_li.quantity, 'received', v_li.quantity_received,
                               'short', v_short, 'reason', p_reason));

    -- Shrink the line to what physically arrived so on-order netting
    -- automatically restores the missing units. Fully-missing lines are
    -- deleted (quantity CHECK > 0); trg_freight_line_recompute_fo fires
    -- and keeps FO consumption math in sync.
    IF v_li.quantity_received = 0 THEN
      DELETE FROM freight_line_items WHERE id = v_li.id;
    ELSE
      UPDATE freight_line_items
         SET quantity = quantity_received,
             quantity_prefilled = LEAST(COALESCE(quantity_prefilled,0), quantity_received)
       WHERE id = v_li.id;
    END IF;
  END LOOP;

  -- Reopen factory orders that auto-completed on the now-reduced coverage.
  FOREACH v_fo IN ARRAY v_affected_fos LOOP
    SELECT status INTO v_fo_status FROM factory_orders WHERE id = v_fo;
    IF v_fo_status = 'shipped' AND NOT _factory_order_fully_shipped(v_fo) THEN
      UPDATE factory_orders SET status = 'in_production', shipped_at = NULL WHERE id = v_fo;
      INSERT INTO audit_logs (actor_id, action, target_table, target_id, details)
      VALUES (p_actor_id, 'factory_order.reopened_short_shipment', 'factory_orders', v_fo,
              jsonb_build_object('from', 'shipped', 'to', 'in_production',
                                 'reason', format('shipment %s closed short', v_shipment.shipment_number)));
      v_reopened := v_reopened + 1;
    END IF;
  END LOOP;

  UPDATE freight_shipments
     SET status = 'delivered',
         actual_arrival_date = COALESCE(actual_arrival_date, CURRENT_DATE),
         receipt_confirmed_at = now(),
         receipt_confirmed_by = p_actor_id,
         closed_short_at = now(),
         closed_short_reason = trim(p_reason)
   WHERE id = p_shipment_id;

  RETURN jsonb_build_object('ok', true, 'units_short', v_short_total,
                            'variances_created', v_variances, 'factory_orders_reopened', v_reopened);
END;
$$;

-- ---- 7. Legacy wrapper: receive everything remaining -------------------------
-- Same signature + result keys as before, so useConfirmFreightReceipt and the
-- manual-status override keep working untouched. Now implemented as "record a
-- receipt for every catalog line's remaining units".
CREATE OR REPLACE FUNCTION public.rpc_apply_freight_delivery(p_shipment_id uuid, p_actor_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_shipment freight_shipments%ROWTYPE;
  v_entries jsonb;
  v_result jsonb;
  v_lines int;
  v_non_catalog int;
BEGIN
  SELECT * INTO v_shipment FROM freight_shipments WHERE id = p_shipment_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'shipment not found');
  END IF;
  IF v_shipment.receipt_confirmed_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'already_confirmed', true,
                              'confirmed_at', v_shipment.receipt_confirmed_at);
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('line_item_id', id, 'units', quantity - quantity_received)), '[]'::jsonb),
         count(*)
    INTO v_entries, v_lines
    FROM freight_line_items
   WHERE freight_shipment_id = p_shipment_id AND sku_id IS NOT NULL
     AND quantity_received < quantity;

  SELECT count(*) INTO v_non_catalog
    FROM freight_line_items
   WHERE freight_shipment_id = p_shipment_id AND sku_id IS NULL;

  IF v_lines = 0 THEN
    -- nothing left to credit; just stamp confirmation
    UPDATE freight_shipments
       SET status = 'delivered',
           actual_arrival_date = COALESCE(actual_arrival_date, CURRENT_DATE),
           receipt_confirmed_at = now(), receipt_confirmed_by = p_actor_id
     WHERE id = p_shipment_id;
    RETURN jsonb_build_object('ok', true, 'line_items_processed', 0,
                              'non_catalog_skipped', v_non_catalog, 'confirmed_at', now());
  END IF;

  v_result := rpc_record_freight_receipt(p_shipment_id, v_entries, p_actor_id);
  IF NOT COALESCE((v_result->>'ok')::boolean, false) THEN
    RETURN v_result;
  END IF;
  RETURN jsonb_build_object('ok', true, 'line_items_processed', v_lines,
                            'non_catalog_skipped', v_non_catalog, 'confirmed_at', now());
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_record_freight_receipt(uuid, jsonb, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.rpc_record_freight_receipt(uuid, jsonb, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.rpc_close_freight_short(uuid, text, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.rpc_close_freight_short(uuid, text, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public._freight_credit_units(uuid, text, uuid, int, boolean, uuid) FROM public;
