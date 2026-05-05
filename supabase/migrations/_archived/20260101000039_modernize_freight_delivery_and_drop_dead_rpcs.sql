-- =============================================================
-- Migration 039: modernize freight delivery, drop dead factory-stage RPC
-- =============================================================
-- Two related cleanups following the legacy-column audit:
--
--   A. rpc_apply_freight_delivery currently decrements
--      inventory_levels.in_transit_air / in_transit_sea on delivery,
--      expecting those buckets to have been populated when the shipment
--      left the factory. That populate-on-departure step never existed
--      in the supplier portal flow — shipments go straight from
--      factory_orders → freight_shipments without touching the legacy
--      transit columns. Result: the RPC's GREATEST(0 - N, 0) clamps to
--      0, the decrement is a no-op, and the in-transit half of the
--      lifecycle is untracked by the audit trail.
--
--      The frontend has already been switched to derive In Transit from
--      freight_shipments directly (via inventory-aggregates.ts in the
--      Step 1 rollout). So this RPC no longer needs to touch the legacy
--      transit columns at all. We rewrite it to simply increment
--      warehouse_raw for each freight_line_item and write a clean
--      audit row — the freight_shipments.status transition to
--      'delivered' is the authoritative "arrived" signal.
--
--   B. rpc_advance_factory_order_stage is a dead RPC from migration 010.
--      Designed to move units between nancy_ordered → nancy_finished
--      (legacy denormalized columns on inventory_levels). Nothing in
--      src/ calls it; its role is replaced by rpc_supplier_advance_factory_order
--      (migration 021) and rpc_supplier_report_item_finished (030).
--      Keeping it around invites accidental use of the legacy columns.
--
-- Neither change touches migration-014's multi-location layer — the
-- freight delivery path assumes the single default location, same as
-- before. If multi-location becomes real, this RPC needs a location
-- parameter; parked as a follow-up.
--
-- Signatures:
--   rpc_apply_freight_delivery(UUID, UUID) — UNCHANGED, CREATE OR REPLACE fine
--   rpc_advance_factory_order_stage(...)   — DROPPED entirely
-- =============================================================

-- -------------------------------------------------------------
-- A. Modernize rpc_apply_freight_delivery
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION rpc_apply_freight_delivery(
  p_shipment_id UUID,
  p_actor_id UUID
) RETURNS JSONB AS $$
DECLARE
  v_shipment freight_shipments%ROWTYPE;
  v_li RECORD;
  v_moved_count INTEGER := 0;
BEGIN
  SELECT * INTO v_shipment FROM freight_shipments WHERE id = p_shipment_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'shipment not found');
  END IF;
  IF v_shipment.status = 'delivered' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'shipment already delivered');
  END IF;

  -- --------------------------------------------------------------
  -- Protected section: any exception rolls back the whole delivery
  -- (inventory increments + audit rows + status flip) so partial
  -- deliveries never materialize. Same belt-and-suspenders pattern
  -- we added to rpc_log_task_completion in migration 038.
  -- --------------------------------------------------------------
  BEGIN
    FOR v_li IN
      SELECT * FROM freight_line_items WHERE freight_shipment_id = p_shipment_id
    LOOP
      -- Lock the inventory row so the concurrent delivery + task-log
      -- writers can't race on warehouse_raw.
      PERFORM 1 FROM inventory_levels WHERE sku_id = v_li.sku_id FOR UPDATE;

      -- Straight increment — no legacy transit column to decrement.
      -- The in-transit half of the lifecycle lives in freight_shipments
      -- (status in {pending, on_the_water, …}); once status flips to
      -- 'delivered' below, the UI treats those units as warehouse-resident.
      UPDATE inventory_levels
         SET warehouse_raw = warehouse_raw + v_li.quantity
       WHERE sku_id = v_li.sku_id;

      -- Audit row. movement_kind = 'net_change' because there's no
      -- inventory-side source bucket being drained — the units physically
      -- came from the carrier. (Using 'category_move' would fail the
      -- chk_move_fields_consistent CHECK since from_field must be NULL.)
      INSERT INTO inventory_transactions (
        sku_id, transaction_type, quantity, field_affected,
        movement_kind, from_field, to_field,
        reference_id, reference_type, notes, performed_by
      ) VALUES (
        v_li.sku_id, 'freight_delivered', v_li.quantity, 'warehouse_raw',
        'net_change', NULL, 'warehouse_raw',
        p_shipment_id, 'freight_shipment',
        format('%s delivered: %s units landed', v_shipment.shipment_number, v_li.quantity),
        p_actor_id
      );
      v_moved_count := v_moved_count + 1;
    END LOOP;

    UPDATE freight_shipments
       SET status = 'delivered',
           actual_arrival_date = COALESCE(actual_arrival_date, CURRENT_DATE)
     WHERE id = p_shipment_id;

    RETURN jsonb_build_object('ok', true, 'line_items_processed', v_moved_count);

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

GRANT EXECUTE ON FUNCTION rpc_apply_freight_delivery(UUID, UUID) TO authenticated;

-- -------------------------------------------------------------
-- B. Drop dead rpc_advance_factory_order_stage
-- -------------------------------------------------------------
-- Signature from migration 010: (UUID, TEXT, TEXT, INTEGER, UUID, TEXT)
DROP FUNCTION IF EXISTS rpc_advance_factory_order_stage(
  UUID, TEXT, TEXT, INTEGER, UUID, TEXT
);

-- Sanity: the live supplier-portal advance RPC should still exist after
-- this migration. If it's gone, we've dropped the wrong function and
-- the whole supplier flow is broken.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'rpc_supplier_advance_factory_order'
  ) THEN
    RAISE EXCEPTION 'rpc_supplier_advance_factory_order missing — migration 039 may have dropped the wrong function';
  END IF;
END$$;
