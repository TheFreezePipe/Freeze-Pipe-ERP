-- =============================================================
-- Migration: freight receipt credits non-fillable SKUs to FINISHED
-- =============================================================
-- Bug: rpc_apply_freight_delivery split every received freight line into
--   warehouse_prefilled_raw (the quantity_prefilled portion) and
--   warehouse_raw (the remainder), WITHOUT checking whether the SKU is
--   fillable. Non-fillable SKUs (e.g. BW20-Bowl, a glass bowl) have no
--   filling / manufacturing step — they are ready-to-sell the moment they
--   arrive. Crediting them to warehouse_raw was wrong twice over:
--     1. It misrepresents them as needing manufacturing work.
--     2. There is NO task path that moves a non-fillable SKU out of raw
--        (the RTS / fill tasks only apply to fillable SKUs), so the units
--        were stranded in raw and invisible as sellable stock — the same
--        trap that lets a SKU silently oversell on ShipStation.
--
-- Fix: branch on product_skus.category inside the receipt loop.
--   - non_fillable  -> credit the ENTIRE line quantity to
--                      warehouse_finished (ready-to-sell on arrival).
--                      quantity_prefilled is meaningless here.
--   - fillable (else) -> unchanged: split into pre-filled raw vs raw.
--
-- Everything else (admin/manager guard, idempotency on
-- receipt_confirmed_at, status flip to 'delivered', structured error
-- envelope, audit transactions) is preserved verbatim.
-- =============================================================

CREATE OR REPLACE FUNCTION public.rpc_apply_freight_delivery(p_shipment_id uuid, p_actor_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_shipment      public.freight_shipments%ROWTYPE;
  v_li            RECORD;
  v_caller_role   TEXT;
  v_moved_count   INTEGER := 0;
  v_prefilled_qty INTEGER;
  v_unfilled_qty  INTEGER;
  v_category      TEXT;
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

      -- Determine the SKU's fill category. Non-fillable SKUs are RTS on
      -- arrival, so everything lands in warehouse_finished; fillable SKUs
      -- split into raw (needs filling) vs pre-filled raw (needs RTS only).
      SELECT category INTO v_category FROM public.product_skus WHERE id = v_li.sku_id;

      IF v_category = 'non_fillable' THEN
        -- Ready-to-sell on arrival: credit the full quantity to finished.
        IF v_li.quantity > 0 THEN
          UPDATE public.inventory_levels
             SET warehouse_finished = warehouse_finished + v_li.quantity
           WHERE sku_id = v_li.sku_id;

          INSERT INTO public.inventory_transactions (
            sku_id, transaction_type, quantity, field_affected,
            movement_kind, from_field, to_field,
            reference_id, reference_type, notes, performed_by
          ) VALUES (
            v_li.sku_id, 'freight_delivered', v_li.quantity, 'warehouse_finished',
            'net_change', NULL, 'warehouse_finished',
            p_shipment_id, 'freight_shipment',
            format('%s receipt confirmed: %s units credited to warehouse_finished (non-fillable, ready-to-sell)',
                   v_shipment.shipment_number, v_li.quantity),
            p_actor_id
          );
        END IF;

      ELSE
        -- Fillable: split into pre-filled raw vs unfilled raw.
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
$function$;
