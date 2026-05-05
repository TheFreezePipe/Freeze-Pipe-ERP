-- =============================================================
-- Migration: allow warehouse_finished to go negative + always
-- decrement on ShipStation sale
-- =============================================================
-- Operational requirement: when an order ships against insufficient
-- on-hand stock, the system must still record the shipment as an
-- inventory deduction (warehouse_finished can go negative). The
-- oversell_warning row continues to surface the situation for cycle-
-- counting, but inventory levels stay accurate to physical reality.
--
-- Old behavior (migration 006/012): warehouse_finished >= 0 enforced
-- by CHECK constraint; oversell path skipped the decrement and only
-- logged a warning. Net effect: positive-skewed inventory numbers
-- after any oversell.
--
-- New behavior: always decrement, always log order_shipped, ALSO log
-- oversell_warning when the resulting level goes (further) negative.
-- =============================================================

-- -------------------------------------------------------------
-- A. Drop the CHECK preventing negative warehouse_finished
-- -------------------------------------------------------------
-- Other warehouse_* fields keep their non-negative invariants since
-- only ShipStation sales decrement warehouse_finished, and only that
-- field has the documented oversell scenario.
ALTER TABLE public.inventory_levels
  DROP CONSTRAINT IF EXISTS chk_inv_warehouse_finished_nonneg;

-- -------------------------------------------------------------
-- B. Updated apply RPC: always decrement + always log shipment
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_apply_shipstation_sale(
  p_order_id        UUID,
  p_system_actor_id UUID DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
  v_order                 public.shipstation_orders%ROWTYPE;
  v_item                  RECORD;
  v_sku                   public.product_skus%ROWTYPE;
  v_available             INTEGER;
  v_resulting             INTEGER;
  v_line_items_applied    INTEGER := 0;
  v_line_items_unresolved INTEGER := 0;
  v_line_items_skipped    INTEGER := 0;
  v_oversells             INTEGER := 0;
BEGIN
  SELECT * INTO v_order FROM public.shipstation_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'order not found');
  END IF;
  IF v_order.inventory_applied_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'already_applied', true);
  END IF;

  FOR v_item IN
    SELECT * FROM public.shipstation_order_items WHERE shipstation_order_id = p_order_id
  LOOP
    -- Branch 1: unresolved sku → check non-inventory list, else block
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

    -- Branch 2: resolved sku → always decrement + log shipment
    SELECT * INTO v_sku FROM public.product_skus WHERE id = v_item.sku_id;
    PERFORM 1 FROM public.inventory_levels WHERE sku_id = v_item.sku_id FOR UPDATE;

    SELECT warehouse_finished INTO v_available
      FROM public.inventory_levels WHERE sku_id = v_item.sku_id;

    UPDATE public.inventory_levels
       SET warehouse_finished = warehouse_finished - v_item.quantity
     WHERE sku_id = v_item.sku_id;

    v_resulting := COALESCE(v_available, 0) - v_item.quantity;

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

    -- Additionally flag oversells (when resulting level is negative)
    IF v_resulting < 0 THEN
      INSERT INTO public.inventory_transactions (
        sku_id, transaction_type, quantity, field_affected,
        movement_kind, notes, performed_by
      ) VALUES (
        v_item.sku_id, 'shipstation_oversell_warning',
        -v_item.quantity, 'warehouse_finished',
        'metadata',
        format('%s: oversold on ShipStation order %s — available %s, sold %s, resulting %s. Cycle-count to confirm physical stock.',
          v_sku.sku, v_order.order_number, COALESCE(v_available, 0), v_item.quantity, v_resulting),
        p_system_actor_id
      );
      v_oversells := v_oversells + 1;
    END IF;
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
    'skipped',    v_line_items_skipped,
    'oversells',  v_oversells
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
