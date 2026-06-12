-- =============================================================
-- Migration: non-catalog (sample/prototype) freight line items
-- =============================================================
-- One-off items — factory samples, prototypes, spare parts not in the
-- catalog — need to ride on freight shipments and be tracked through
-- ETA + receipt without existing as product_skus.
--
-- Model: a freight line is EITHER a catalog line (sku_id set) OR a
-- non-catalog line (sku_id NULL + custom_description). Non-catalog
-- lines:
--   * cannot link a source factory order item,
--   * are skipped by receipt confirmation (nothing to credit — they
--     have no SKU, so inventory stays honest),
--   * are excluded from in-transit/on-order math client-side.
--
-- The existing unique index (shipment, sku, source_FO) ignores NULL
-- sku rows (NULLs are distinct), so multiple non-catalog lines per
-- shipment are fine.
-- =============================================================

ALTER TABLE public.freight_line_items
  ALTER COLUMN sku_id DROP NOT NULL;

ALTER TABLE public.freight_line_items
  ADD COLUMN IF NOT EXISTS custom_description text;

ALTER TABLE public.freight_line_items
  DROP CONSTRAINT IF EXISTS chk_freight_li_sku_or_custom;
ALTER TABLE public.freight_line_items
  ADD CONSTRAINT chk_freight_li_sku_or_custom CHECK (
    (sku_id IS NOT NULL AND custom_description IS NULL)
    OR (
      sku_id IS NULL
      AND custom_description IS NOT NULL
      AND btrim(custom_description) <> ''
      AND source_factory_order_item_id IS NULL
    )
  );

-- Receipt confirmation: skip non-catalog lines (count them in the
-- response envelope so the UI can mention it). Identical to the
-- 20260609000001 version otherwise (non-fillable -> finished branch
-- preserved).
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
  v_non_catalog   INTEGER := 0;
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
      -- Non-catalog (sample/prototype) line: tracked on the shipment but
      -- never credited to inventory — there is no SKU to credit.
      IF v_li.sku_id IS NULL THEN
        v_non_catalog := v_non_catalog + 1;
        CONTINUE;
      END IF;

      PERFORM 1 FROM public.inventory_levels WHERE sku_id = v_li.sku_id FOR UPDATE;

      SELECT category INTO v_category FROM public.product_skus WHERE id = v_li.sku_id;

      IF v_category = 'non_fillable' THEN
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
        v_prefilled_qty := COALESCE(v_li.quantity_prefilled, 0);
        IF v_prefilled_qty < 0 THEN
          v_prefilled_qty := 0;
        ELSIF v_prefilled_qty > v_li.quantity THEN
          v_prefilled_qty := v_li.quantity;
        END IF;
        v_unfilled_qty := v_li.quantity - v_prefilled_qty;

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
      'non_catalog_skipped', v_non_catalog,
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
