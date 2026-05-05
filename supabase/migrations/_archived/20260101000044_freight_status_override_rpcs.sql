-- =============================================================
-- Migration 044: freight status override RPCs
-- =============================================================
-- Migration 026 introduced `audit_logs` as the canonical home for
-- workflow events (status changes, manual overrides, cancellations).
-- Inventory-domain events stay in `inventory_transactions`. Manual
-- freight status overrides are workflow events (no inventory moves) —
-- they should write audit_logs.
--
-- The current frontend (`src/lib/tracking/manual-status.ts`) does two
-- things that this RPC fixes:
--
--   1. Direct UPDATE on freight_shipments without row_version check —
--      lost-update race if two admins override concurrently.
--   2. Writes one audit row per SKU on the shipment to
--      inventory_transactions. That puts what's clearly a workflow
--      event into the inventory-audit stream and inflates row counts
--      (a 5-SKU shipment generates 5 identical audit rows).
--
-- This migration adds two RPCs:
--
--   rpc_apply_freight_status_override(shipment_id, new_status, actor_id,
--                                     expected_version, reason?)
--      → row_version-gated UPDATE
--      → single audit_logs entry with action='freight.status_override'
--      → refuses delivery transitions (those go through
--        rpc_apply_freight_delivery, which moves inventory)
--
--   rpc_clear_freight_status_override(shipment_id, actor_id, expected_version)
--      → clears status_overridden_at (carrier tracking resumes)
--      → single audit_logs entry with action='freight.status_override_cleared'
--
-- Both functions check the caller is internal (admin/manager/user) via
-- jwt_is_internal(). Both are SECURITY DEFINER with SET search_path = public.
-- =============================================================

-- -------------------------------------------------------------
-- A. rpc_apply_freight_status_override
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION rpc_apply_freight_status_override(
  p_shipment_id UUID,
  p_new_status TEXT,
  p_actor_id UUID,
  p_expected_version INTEGER,
  p_reason TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_shipment freight_shipments%ROWTYPE;
  v_prev_status TEXT;
BEGIN
  IF NOT jwt_is_internal() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;

  IF p_new_status NOT IN (
    'pending', 'on_the_water', 'high_risk', 'cleared_customs', 'tracking', 'delivered'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_status', 'status', p_new_status);
  END IF;

  -- Delivery is its own RPC — it has to move units from in-flight to
  -- the warehouse. Refuse here so the caller picks the right path.
  IF p_new_status = 'delivered' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'use_delivery_rpc',
      'hint', 'call rpc_apply_freight_delivery for delivered transitions'
    );
  END IF;

  SELECT * INTO v_shipment FROM freight_shipments WHERE id = p_shipment_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  IF v_shipment.row_version != p_expected_version THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'version_conflict',
      'current_version', v_shipment.row_version
    );
  END IF;

  v_prev_status := v_shipment.status;

  UPDATE freight_shipments
     SET status = p_new_status,
         status_overridden_at = now(),
         status_overridden_by = p_actor_id
   WHERE id = p_shipment_id;

  INSERT INTO audit_logs (actor_id, action, target_table, target_id, details)
  VALUES (
    p_actor_id,
    'freight.status_override',
    'freight_shipments',
    p_shipment_id,
    jsonb_build_object(
      'shipment_number', v_shipment.shipment_number,
      'prev_status', v_prev_status,
      'new_status', p_new_status,
      'reason', p_reason
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'prev_status', v_prev_status,
    'new_status', p_new_status
  );
END;
$$;

GRANT EXECUTE ON FUNCTION rpc_apply_freight_status_override(UUID, TEXT, UUID, INTEGER, TEXT) TO authenticated;

-- -------------------------------------------------------------
-- B. rpc_clear_freight_status_override
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION rpc_clear_freight_status_override(
  p_shipment_id UUID,
  p_actor_id UUID,
  p_expected_version INTEGER
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_shipment freight_shipments%ROWTYPE;
BEGIN
  IF NOT jwt_is_internal() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;

  SELECT * INTO v_shipment FROM freight_shipments WHERE id = p_shipment_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  IF v_shipment.row_version != p_expected_version THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'version_conflict',
      'current_version', v_shipment.row_version
    );
  END IF;

  IF v_shipment.status_overridden_at IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'noop', true);
  END IF;

  UPDATE freight_shipments
     SET status_overridden_at = NULL,
         status_overridden_by = NULL
   WHERE id = p_shipment_id;

  INSERT INTO audit_logs (actor_id, action, target_table, target_id, details)
  VALUES (
    p_actor_id,
    'freight.status_override_cleared',
    'freight_shipments',
    p_shipment_id,
    jsonb_build_object(
      'shipment_number', v_shipment.shipment_number,
      'status_at_clear', v_shipment.status
    )
  );

  RETURN jsonb_build_object('ok', true);
END;
$$;

GRANT EXECUTE ON FUNCTION rpc_clear_freight_status_override(UUID, UUID, INTEGER) TO authenticated;

-- -------------------------------------------------------------
-- C. Sanity guards
-- -------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'rpc_apply_freight_status_override'
      AND 'search_path=public' = ANY(p.proconfig)
  ) THEN
    RAISE EXCEPTION 'rpc_apply_freight_status_override missing search_path hardening';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'rpc_clear_freight_status_override'
      AND 'search_path=public' = ANY(p.proconfig)
  ) THEN
    RAISE EXCEPTION 'rpc_clear_freight_status_override missing search_path hardening';
  END IF;
END$$;
