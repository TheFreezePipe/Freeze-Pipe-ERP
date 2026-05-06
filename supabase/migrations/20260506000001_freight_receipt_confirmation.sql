-- =============================================================
-- Migration: receipt-confirmation flow for freight shipments
-- =============================================================
-- Background: when carrier tracking flips a shipment's status to
-- 'delivered', we DO NOT want to auto-credit inventory_levels.
-- Carrier-reported delivery often doesn't match physical receipt at
-- the warehouse (units may sit at a freight terminal for days), and
-- we want explicit admin/manager sign-off before inventory moves.
--
-- This migration:
--   1. Adds receipt_confirmed_at + receipt_confirmed_by columns to
--      freight_shipments. NULL = not yet confirmed.
--   2. Rewrites rpc_apply_freight_delivery to be the "confirm receipt"
--      RPC: idempotency now keyed on receipt_confirmed_at (not status),
--      status-flip is skipped if already 'delivered' (carrier already
--      did that), and confirms the receipt by stamping the new columns.
--   3. Adds an admin/manager role check inside the RPC for defense-
--      in-depth (the RPC was previously security-definer with no
--      caller verification).
-- =============================================================

ALTER TABLE public.freight_shipments
  ADD COLUMN IF NOT EXISTS receipt_confirmed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS receipt_confirmed_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL;

-- Helpful index: the dashboard queries "delivered + not yet confirmed"
-- to pin those rows at the top of the freight list. Partial index keeps
-- it small (only matches rows in the pending state).
CREATE INDEX IF NOT EXISTS idx_freight_pending_receipt_confirmation
  ON public.freight_shipments(actual_arrival_date DESC)
  WHERE status = 'delivered' AND receipt_confirmed_at IS NULL;

-- -------------------------------------------------------------
-- Rewrite of rpc_apply_freight_delivery
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_apply_freight_delivery(
  p_shipment_id UUID,
  p_actor_id    UUID
) RETURNS JSONB AS $$
DECLARE
  v_shipment    public.freight_shipments%ROWTYPE;
  v_li          RECORD;
  v_caller_role TEXT;
  v_moved_count INTEGER := 0;
BEGIN
  -- Defense-in-depth role check. The UI passes auth.uid() as p_actor_id;
  -- here we verify that user is admin or manager. Service-role callers
  -- (e.g. the system actor 00000000-...001 used by the cron path) bypass
  -- because the system_actor_id is recognized as trusted internal.
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

  -- New idempotency check: receipt_confirmed_at, not status. Status may
  -- already be 'delivered' (set by tracking-reconcile based on carrier
  -- data); that's expected and not an error.
  IF v_shipment.receipt_confirmed_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'ok', true,
      'already_confirmed', true,
      'confirmed_at', v_shipment.receipt_confirmed_at
    );
  END IF;

  -- Protected section: any exception rolls back the whole confirmation
  -- (inventory increments + audit rows + receipt stamp + optional status
  -- flip) so partial confirmations never materialize.
  BEGIN
    FOR v_li IN
      SELECT * FROM public.freight_line_items WHERE freight_shipment_id = p_shipment_id
    LOOP
      PERFORM 1 FROM public.inventory_levels WHERE sku_id = v_li.sku_id FOR UPDATE;

      UPDATE public.inventory_levels
         SET warehouse_raw = warehouse_raw + v_li.quantity
       WHERE sku_id = v_li.sku_id;

      INSERT INTO public.inventory_transactions (
        sku_id, transaction_type, quantity, field_affected,
        movement_kind, from_field, to_field,
        reference_id, reference_type, notes, performed_by
      ) VALUES (
        v_li.sku_id, 'freight_delivered', v_li.quantity, 'warehouse_raw',
        'net_change', NULL, 'warehouse_raw',
        p_shipment_id, 'freight_shipment',
        format('%s receipt confirmed: %s units credited to warehouse_raw',
               v_shipment.shipment_number, v_li.quantity),
        p_actor_id
      );
      v_moved_count := v_moved_count + 1;
    END LOOP;

    -- Stamp the confirmation timestamp + actor regardless of whether
    -- status was already 'delivered' (carrier path) or needs flipping
    -- (legacy/manual path).
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

GRANT EXECUTE ON FUNCTION public.rpc_apply_freight_delivery TO authenticated;

-- -------------------------------------------------------------
-- Backfill: shipment 403's inventory was already credited via the
-- one-shot SQL backfill on 2026-05-06 (working around the prior
-- tracking-reconcile gap). Stamp its receipt_confirmed_at so the
-- new "pending receipt" UI doesn't surface it as needing action.
-- Idempotent — only runs if 403 exists and isn't yet stamped.
-- -------------------------------------------------------------
UPDATE public.freight_shipments
   SET receipt_confirmed_at = now(),
       receipt_confirmed_by = '00000000-0000-0000-0000-000000000001'::uuid
 WHERE shipment_number = '403'
   AND receipt_confirmed_at IS NULL
   AND status = 'delivered';
