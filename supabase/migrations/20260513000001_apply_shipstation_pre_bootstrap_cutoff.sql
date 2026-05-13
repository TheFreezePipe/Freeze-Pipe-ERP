-- =============================================================
-- Migration: rpc_apply_shipstation_sale — pre-bootstrap order cutoff
-- =============================================================
-- Background: ShipStation pipeline went live 2026-05-05. Orders placed
-- before then weren't tracked by this system at the time. They flow in
-- now whenever ShipStation modifies them (status flip, label print, tag
-- added, etc.) because our nightly cron uses modifyDateStart filtering.
--
-- Problem: deducting inventory on first sight for a pre-bootstrap order
-- assumes the inventory hasn't already been adjusted for that sale by
-- whatever process managed inventory before this system existed. In
-- reality, prior manual cycle counts, spreadsheet management, or other
-- tooling already accounted for those sales. Re-deducting now is double-
-- counting and silently corrupts warehouse_finished.
--
-- Fix: skip the inventory deduction entirely when order_date predates
-- the 2026-05-05 system bootstrap. Mark the order as applied (so the
-- nightly cron stops retrying it) and write a metadata audit transaction
-- explaining why nothing moved. Numbers in the transaction are zero so
-- this doesn't pollute any aggregations.
--
-- All other behavior preserved: post-bootstrap orders deduct normally,
-- unresolved-SKU + oversell handling unchanged, audit trail unchanged.
--
-- Scope of impact: today's run will continue to ingest pre-bootstrap
-- orders for header/items, but the apply step will short-circuit. No
-- new double-counting from this point forward. The ~159 already-double-
-- counted today are accepted as known noise to be reconciled by the
-- next physical cycle count per SKU.
-- =============================================================

CREATE OR REPLACE FUNCTION public.rpc_apply_shipstation_sale(
  p_order_id        UUID,
  p_system_actor_id UUID DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
  v_order                 public.shipstation_orders%ROWTYPE;
  v_item                  RECORD;
  v_sku                   public.product_skus%ROWTYPE;
  v_available             INTEGER;
  v_line_items_applied    INTEGER := 0;
  v_line_items_unresolved INTEGER := 0;
  v_line_items_skipped    INTEGER := 0;
  -- Bootstrap date — when this system started ingesting ShipStation
  -- orders. Anything older than this gets skipped (see migration body).
  v_bootstrap_cutoff      DATE := '2026-05-05';
BEGIN
  SELECT * INTO v_order FROM public.shipstation_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'order not found');
  END IF;
  IF v_order.inventory_applied_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'already_applied', true);
  END IF;

  -- Pre-bootstrap cutoff. Mark the order as handled (so cron stops
  -- retrying it) but don't touch inventory. Single audit row records
  -- the skip with enough context to reconstruct what happened later.
  IF v_order.order_date::date < v_bootstrap_cutoff THEN
    UPDATE public.shipstation_orders
       SET inventory_applied_at      = now(),
           inventory_apply_attempts  = inventory_apply_attempts + 1,
           inventory_apply_error     = NULL
     WHERE id = p_order_id;

    INSERT INTO public.inventory_transactions (
      sku_id, transaction_type, quantity, field_affected,
      movement_kind, reference_id, reference_type, notes, performed_by
    ) VALUES (
      NULL, 'shipstation_pre_bootstrap_skip', 0, 'warehouse_finished',
      'metadata', p_order_id, 'shipstation_order',
      format(
        'ShipStation order %s (placed %s): skipped — predates system bootstrap (%s). Inventory was managed elsewhere at the time; deducting now would double-count.',
        v_order.order_number,
        v_order.order_date::date,
        v_bootstrap_cutoff
      ),
      p_system_actor_id
    );

    RETURN jsonb_build_object(
      'ok',                    true,
      'skipped_pre_bootstrap', true,
      'applied',               0,
      'unresolved',            0,
      'skipped',               0,
      'oversells',             0
    );
  END IF;

  FOR v_item IN
    SELECT * FROM public.shipstation_order_items WHERE shipstation_order_id = p_order_id
  LOOP
    -- Branch 1: unresolved sku → check non-inventory list, else count as blocking
    IF v_item.sku_id IS NULL THEN
      IF EXISTS (
        SELECT 1 FROM public.shipstation_sku_handling
         WHERE sku_code = v_item.sku_code AND is_non_inventory
      ) THEN
        v_line_items_skipped := v_line_items_skipped + 1;
      ELSE
        v_line_items_unresolved := v_line_items_unresolved + 1;
      END IF;
      CONTINUE;
    END IF;

    -- Branch 2: resolved sku → apply inventory (oversell-tolerant)
    SELECT * INTO v_sku FROM public.product_skus WHERE id = v_item.sku_id;
    PERFORM 1 FROM public.inventory_levels WHERE sku_id = v_item.sku_id FOR UPDATE;

    SELECT warehouse_finished INTO v_available
      FROM public.inventory_levels WHERE sku_id = v_item.sku_id;

    IF COALESCE(v_available, 0) < v_item.quantity THEN
      INSERT INTO public.inventory_transactions (
        sku_id, transaction_type, quantity, field_affected,
        movement_kind, notes, performed_by
      ) VALUES (
        v_item.sku_id, 'shipstation_oversell_warning',
        -v_item.quantity, 'warehouse_finished',
        'metadata',
        format('%s: oversold on ShipStation order %s — available %s, sold %s. Requires cycle-count correction.',
          v_sku.sku, v_order.order_number, COALESCE(v_available, 0), v_item.quantity),
        p_system_actor_id
      );
      -- intentional fallthrough: still decrement (negative-allowed policy)
    END IF;

    UPDATE public.inventory_levels
       SET warehouse_finished = warehouse_finished - v_item.quantity
     WHERE sku_id = v_item.sku_id;

    INSERT INTO public.inventory_transactions (
      sku_id, transaction_type, quantity, field_affected,
      movement_kind, reference_id, reference_type, notes, performed_by
    ) VALUES (
      v_item.sku_id, 'order_shipped', -v_item.quantity, 'warehouse_finished',
      'net_change', p_order_id, 'shipstation_order',
      format('ShipStation order %s: -%s units', v_order.order_number, v_item.quantity),
      p_system_actor_id
    );
    v_line_items_applied := v_line_items_applied + 1;
  END LOOP;

  IF v_line_items_unresolved = 0 THEN
    UPDATE public.shipstation_orders
       SET inventory_applied_at      = now(),
           inventory_apply_error     = NULL,
           inventory_apply_attempts  = inventory_apply_attempts + 1
     WHERE id = p_order_id;
  ELSE
    UPDATE public.shipstation_orders
       SET inventory_apply_attempts  = inventory_apply_attempts + 1,
           inventory_apply_error     = format('%s line item(s) have unresolved SKU codes',
                                              v_line_items_unresolved)
     WHERE id = p_order_id;
  END IF;

  RETURN jsonb_build_object(
    'ok',         v_line_items_unresolved = 0,
    'applied',    v_line_items_applied,
    'unresolved', v_line_items_unresolved,
    'skipped',    v_line_items_skipped
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
