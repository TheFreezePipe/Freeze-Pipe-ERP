-- =============================================================
-- Migration: warehouse_prefilled_raw inventory bucket
-- =============================================================
-- Pre-filled units arriving from suppliers (Nancy ships filled bongs;
-- YX ships unfilled glass) currently land in warehouse_raw lumped with
-- unfilled units. The "Pre-Filled RTSing" workspace button has always
-- existed but pulled from warehouse_raw — meaning operators could
-- "RTS" units that were never actually pre-filled, with no enforcement.
--
-- This migration:
--   1. Adds warehouse_prefilled_raw column to inventory_levels.
--   2. Modifies rpc_apply_freight_delivery (the receipt-confirmation
--      RPC) to split each line item's credit using the existing
--      freight_line_items.quantity_prefilled column:
--        * quantity_prefilled units → warehouse_prefilled_raw
--        * (quantity - quantity_prefilled) units → warehouse_raw
--      Issues one inventory_transactions row per non-zero credit so
--      the audit trail shows the split clearly.
--   3. Modifies _task_type_movement so the existing 'prefilled_rtsing'
--      task type sources from warehouse_prefilled_raw (was warehouse_raw).
--      The Workspace button + downstream UI need no changes — same
--      hook, same RPC, just the source bucket flips.
--
-- Side effect: the existing insufficient_source_stock check in
-- rpc_log_task_completion now correctly enforces "you can only RTS
-- as many pre-filled units as you actually received in pre-filled
-- shipments." Operators may see this fail until the first pre-filled
-- freight is received under the new logic — that's expected.
--
-- Historical data caveat: the pre-existing warehouse_raw values are
-- a mix of unfilled + pre-filled and there's no way to retroactively
-- separate them. New freight receipts will split correctly going
-- forward; existing balances stay where they are. Operators can
-- manually adjust via cycle count if needed.
-- =============================================================

ALTER TABLE public.inventory_levels
  ADD COLUMN IF NOT EXISTS warehouse_prefilled_raw INTEGER NOT NULL DEFAULT 0;

ALTER TABLE public.inventory_levels
  ADD CONSTRAINT chk_inv_warehouse_prefilled_raw_nonneg
    CHECK (warehouse_prefilled_raw >= 0);

-- -------------------------------------------------------------
-- _task_type_movement: prefilled_rtsing now sources from the new bucket
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._task_type_movement(p_task_type text)
RETURNS TABLE(from_field text, to_field text)
LANGUAGE plpgsql
AS $$
BEGIN
  CASE p_task_type
    WHEN 'emptying' THEN
      RETURN QUERY SELECT 'warehouse_raw'::TEXT, 'warehouse_in_production'::TEXT;
    WHEN 'rtsing' THEN
      RETURN QUERY SELECT 'warehouse_in_production'::TEXT, 'warehouse_finished'::TEXT;
    WHEN 'prefilled_rtsing' THEN
      -- Was: warehouse_raw → warehouse_finished (lumped pre-filled with unfilled).
      -- Now: warehouse_prefilled_raw → warehouse_finished (only what came in pre-filled).
      RETURN QUERY SELECT 'warehouse_prefilled_raw'::TEXT, 'warehouse_finished'::TEXT;
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
$$;

-- -------------------------------------------------------------
-- rpc_apply_freight_delivery: split per-line credit between buckets
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_apply_freight_delivery(
  p_shipment_id UUID,
  p_actor_id    UUID
) RETURNS JSONB AS $$
DECLARE
  v_shipment      public.freight_shipments%ROWTYPE;
  v_li            RECORD;
  v_caller_role   TEXT;
  v_moved_count   INTEGER := 0;
  v_prefilled_qty INTEGER;
  v_unfilled_qty  INTEGER;
BEGIN
  IF p_actor_id <> '00000000-0000-0000-0000-000000000001'::uuid THEN
    SELECT role INTO v_caller_role
      FROM public.profiles
     WHERE id = p_actor_id;
    IF v_caller_role IS NULL OR v_caller_role NOT IN ('admin', 'manager') THEN
      RETURN jsonb_build_object(
        'ok', false,
        'error', 'admin_or_manager_required',
        'message', 'Only admin or manager users may confirm freight receipt'
      );
    END IF;
  END IF;

  SELECT * INTO v_shipment FROM public.freight_shipments WHERE id = p_shipment_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'shipment not found');
  END IF;

  IF v_shipment.receipt_confirmed_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'ok', true,
      'already_confirmed', true,
      'confirmed_at', v_shipment.receipt_confirmed_at
    );
  END IF;

  BEGIN
    FOR v_li IN
      SELECT * FROM public.freight_line_items WHERE freight_shipment_id = p_shipment_id
    LOOP
      PERFORM 1 FROM public.inventory_levels WHERE sku_id = v_li.sku_id FOR UPDATE;

      -- Clamp prefilled to [0, quantity]; remainder is unfilled.
      v_prefilled_qty := COALESCE(v_li.quantity_prefilled, 0);
      IF v_prefilled_qty < 0 THEN
        v_prefilled_qty := 0;
      ELSIF v_prefilled_qty > v_li.quantity THEN
        v_prefilled_qty := v_li.quantity;
      END IF;
      v_unfilled_qty := v_li.quantity - v_prefilled_qty;

      -- Credit unfilled raw (when any)
      IF v_unfilled_qty > 0 THEN
        UPDATE public.inventory_levels
           SET warehouse_raw = warehouse_raw + v_unfilled_qty
         WHERE sku_id = v_li.sku_id;

        INSERT INTO public.inventory_transactions (
          sku_id, transaction_type, quantity, field_affected,
          movement_kind, from_field, to_field,
          reference_id, reference_type, notes, performed_by
        ) VALUES (
          v_li.sku_id, 'freight_delivered', v_unfilled_qty, 'warehouse_raw',
          'net_change', NULL, 'warehouse_raw',
          p_shipment_id, 'freight_shipment',
          format('%s receipt confirmed: %s unfilled units credited to warehouse_raw',
                 v_shipment.shipment_number, v_unfilled_qty),
          p_actor_id
        );
      END IF;

      -- Credit pre-filled raw (when any)
      IF v_prefilled_qty > 0 THEN
        UPDATE public.inventory_levels
           SET warehouse_prefilled_raw = warehouse_prefilled_raw + v_prefilled_qty
         WHERE sku_id = v_li.sku_id;

        INSERT INTO public.inventory_transactions (
          sku_id, transaction_type, quantity, field_affected,
          movement_kind, from_field, to_field,
          reference_id, reference_type, notes, performed_by
        ) VALUES (
          v_li.sku_id, 'freight_delivered', v_prefilled_qty, 'warehouse_prefilled_raw',
          'net_change', NULL, 'warehouse_prefilled_raw',
          p_shipment_id, 'freight_shipment',
          format('%s receipt confirmed: %s pre-filled units credited to warehouse_prefilled_raw',
                 v_shipment.shipment_number, v_prefilled_qty),
          p_actor_id
        );
      END IF;

      v_moved_count := v_moved_count + 1;
    END LOOP;

    UPDATE public.freight_shipments
       SET status               = 'delivered',
           actual_arrival_date  = COALESCE(actual_arrival_date, CURRENT_DATE),
           receipt_confirmed_at = now(),
           receipt_confirmed_by = p_actor_id
     WHERE id = p_shipment_id;

    RETURN jsonb_build_object(
      'ok', true,
      'line_items_processed', v_moved_count,
      'confirmed_at', now()
    );

  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'internal_error',
      'sqlstate', SQLSTATE,
      'message', SQLERRM
    );
  END;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
