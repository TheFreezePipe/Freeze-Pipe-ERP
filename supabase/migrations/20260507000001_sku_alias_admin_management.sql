-- =============================================================
-- Migration: ShipStation SKU alias self-service management
-- =============================================================
-- The original `shipstation_sku_handling` table (migration
-- 20260505000001) was internal-only — admins triaged unresolved
-- codes through the queue page and the helper RPCs, with no read
-- path back to the table from PostgREST.
--
-- This migration opens up read-by-sku for admins/managers so we
-- can render aliases on the SKU detail page, and adds a counterpart
-- "unregister" RPC so the same UI can remove an alias when the
-- product code stops needing it.
--
-- Reads stay tightly scoped: admin/manager only, and the SELECT
-- policy uses `auth.uid()` against profiles (same shape as every
-- other admin-gated policy in this schema).
-- =============================================================

-- -------------------------------------------------------------
-- A. SELECT policy on shipstation_sku_handling for admin/manager
-- -------------------------------------------------------------
-- Note: writes still go through SECURITY DEFINER RPCs
-- (rpc_shipstation_register_sku_alias /
--  rpc_shipstation_register_non_inventory_sku /
--  rpc_shipstation_unregister_sku_alias). RLS only matters for
-- direct SELECTs from PostgREST, which is what the new UI needs.
DROP POLICY IF EXISTS "shipstation_sku_handling_select_admin"
  ON public.shipstation_sku_handling;

CREATE POLICY "shipstation_sku_handling_select_admin"
  ON public.shipstation_sku_handling
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
       WHERE p.id = auth.uid()
         AND p.role IN ('admin', 'manager')
         AND p.is_active = true
    )
  );

-- -------------------------------------------------------------
-- B. rpc_shipstation_unregister_sku_alias
-- -------------------------------------------------------------
-- Removes an alias entry and resets any matching shipstation_order_items
-- back to sku_id = NULL so they re-block. The next reconciliation pass
-- will surface the code in the unresolved-queue again, where the operator
-- can decide whether it should map to a different SKU or be marked
-- non-inventory.
--
-- Admin-only. Manager intentionally NOT allowed: removing an alias has
-- the side effect of un-applying inventory deductions on any order that
-- referenced it, which is the kind of thing we want a single accountable
-- role behind.
CREATE OR REPLACE FUNCTION public.rpc_shipstation_unregister_sku_alias(
  p_sku_code TEXT
) RETURNS JSONB AS $$
DECLARE
  v_actor       UUID := auth.uid();
  v_role        TEXT;
  v_existing    public.shipstation_sku_handling%ROWTYPE;
  v_reset_rows  INT;
BEGIN
  SELECT role INTO v_role FROM public.profiles WHERE id = v_actor;
  IF v_role IS DISTINCT FROM 'admin' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'admin role required');
  END IF;

  SELECT * INTO v_existing
    FROM public.shipstation_sku_handling
   WHERE sku_code = p_sku_code;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'sku_code not found in handling table');
  END IF;
  IF v_existing.is_non_inventory THEN
    -- Don't quietly nuke a non-inventory entry through the alias path.
    -- If the operator wants to retract a non-inventory designation,
    -- they should call the explicit rpc for that (or we add one later).
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'this code is registered as non-inventory, not an alias'
    );
  END IF;

  DELETE FROM public.shipstation_sku_handling WHERE sku_code = p_sku_code;

  -- Reset any items currently pinned to the removed alias's resolved sku
  -- back to NULL so they re-block. We can't tell after the fact which
  -- items were resolved *through* this alias vs. matched directly on the
  -- product_skus.sku, so we only reset items whose sku_code matches AND
  -- whose current sku_id matches the alias's resolved sku.
  UPDATE public.shipstation_order_items
     SET sku_id = NULL
   WHERE lower(sku_code) = lower(p_sku_code)
     AND sku_id = v_existing.resolved_sku_id;
  GET DIAGNOSTICS v_reset_rows = ROW_COUNT;

  -- Reopen any orders we just un-resolved so the next reconcile pass
  -- picks them back up. Clear the applied_at flag so the apply RPC
  -- will run again on a future trigger; the apply RPC is idempotent
  -- enough that re-running is safe (it short-circuits when applied_at
  -- is set, and we only clear orders that were resolved through this
  -- alias's items).
  UPDATE public.shipstation_orders o
     SET inventory_applied_at = NULL,
         inventory_apply_error = format('alias %s removed; re-triage required', p_sku_code)
   WHERE o.id IN (
     SELECT DISTINCT i.shipstation_order_id
       FROM public.shipstation_order_items i
      WHERE lower(i.sku_code) = lower(p_sku_code)
        AND i.sku_id IS NULL
   );

  RETURN jsonb_build_object(
    'ok', true,
    'sku_code', p_sku_code,
    'items_reset', v_reset_rows
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.rpc_shipstation_unregister_sku_alias TO authenticated;

-- -------------------------------------------------------------
-- C. Allow managers (not just admins) to register aliases
-- -------------------------------------------------------------
-- The original register RPC required `admin`. Per the new UI flow,
-- managers should be able to register aliases since they're the ones
-- watching the unresolved queue day-to-day. We keep `admin`-only on
-- the *unregister* path because removing an alias is destructive
-- (un-applies inventory deductions on linked orders).
CREATE OR REPLACE FUNCTION public.rpc_shipstation_register_sku_alias(
  p_sku_code        TEXT,
  p_resolved_sku_id UUID,
  p_notes           TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
  v_actor        UUID := auth.uid();
  v_role         TEXT;
  v_updated_rows INT;
BEGIN
  SELECT role INTO v_role FROM public.profiles WHERE id = v_actor;
  IF v_role NOT IN ('admin', 'manager') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'admin or manager role required');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.product_skus WHERE id = p_resolved_sku_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'p_resolved_sku_id not found in product_skus');
  END IF;

  INSERT INTO public.shipstation_sku_handling (
    sku_code, resolved_sku_id, is_non_inventory, added_by, notes
  ) VALUES (
    p_sku_code, p_resolved_sku_id, false, v_actor, p_notes
  )
  ON CONFLICT (sku_code) DO UPDATE
    SET resolved_sku_id  = p_resolved_sku_id,
        is_non_inventory = false,
        added_by         = v_actor,
        added_at         = now(),
        notes            = COALESCE(EXCLUDED.notes, public.shipstation_sku_handling.notes);

  UPDATE public.shipstation_order_items
     SET sku_id = p_resolved_sku_id
   WHERE sku_id IS NULL AND lower(sku_code) = lower(p_sku_code);
  GET DIAGNOSTICS v_updated_rows = ROW_COUNT;

  RETURN jsonb_build_object(
    'ok', true,
    'sku_code', p_sku_code,
    'kind', 'alias',
    'resolved_sku_id', p_resolved_sku_id,
    'existing_items_updated', v_updated_rows
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.rpc_shipstation_register_sku_alias TO authenticated;
