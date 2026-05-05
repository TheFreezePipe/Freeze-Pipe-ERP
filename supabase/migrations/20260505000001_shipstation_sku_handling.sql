-- =============================================================
-- Migration: ShipStation SKU handling (alias / non-inventory)
-- =============================================================
-- Adds a triage table so operators can classify ShipStation
-- SKU codes that don't directly match a product_skus row.
--
-- Resolution order (applied at items-insertion time):
--   1. Empty / NULL sku_code  → silently skip (auto, no entry needed)
--   2. shipstation_sku_handling.is_non_inventory = true → skip
--   3. shipstation_sku_handling.resolved_sku_id IS NOT NULL → use that
--   4. case-insensitive match on product_skus.sku → use that
--   5. otherwise → leave items.sku_id = NULL → blocks order in queue
--
-- The queue (`shipstation_unresolved_skus_pending`) is the alert
-- mechanism for net-new SKU codes that haven't been triaged yet.
-- =============================================================

-- -------------------------------------------------------------
-- A. The handling table
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.shipstation_sku_handling (
  sku_code         TEXT PRIMARY KEY,
  resolved_sku_id  UUID REFERENCES public.product_skus(id) ON DELETE RESTRICT,
  is_non_inventory BOOLEAN NOT NULL DEFAULT false,
  added_by         UUID REFERENCES public.profiles(id),
  added_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes            TEXT,
  CONSTRAINT exactly_one_decision CHECK (
    (resolved_sku_id IS NOT NULL)::int + (is_non_inventory)::int = 1
  )
);

CREATE INDEX IF NOT EXISTS idx_ssh_resolved_sku_id
  ON public.shipstation_sku_handling(resolved_sku_id)
  WHERE resolved_sku_id IS NOT NULL;

ALTER TABLE public.shipstation_sku_handling ENABLE ROW LEVEL SECURITY;

-- Internal-only writes; reads also internal-only (no anon/authenticated grants).
-- The RPCs that consume this table are SECURITY DEFINER, so they bypass RLS.
-- Operator UI calls helper RPCs (below) rather than touching this table directly.

-- -------------------------------------------------------------
-- B. Helper: register a SKU code as non-inventory (discount, fee, tip)
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_shipstation_register_non_inventory_sku(
  p_sku_code TEXT,
  p_notes    TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
  v_actor UUID := auth.uid();
  v_role  TEXT;
BEGIN
  SELECT role INTO v_role FROM public.profiles WHERE id = v_actor;
  IF v_role IS DISTINCT FROM 'admin' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'admin role required');
  END IF;

  INSERT INTO public.shipstation_sku_handling (
    sku_code, is_non_inventory, added_by, notes
  ) VALUES (
    p_sku_code, true, v_actor, p_notes
  )
  ON CONFLICT (sku_code) DO UPDATE
    SET is_non_inventory = true,
        resolved_sku_id  = NULL,
        added_by         = v_actor,
        added_at         = now(),
        notes            = COALESCE(EXCLUDED.notes, public.shipstation_sku_handling.notes);

  RETURN jsonb_build_object('ok', true, 'sku_code', p_sku_code, 'kind', 'non_inventory');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.rpc_shipstation_register_non_inventory_sku TO authenticated;

-- -------------------------------------------------------------
-- C. Helper: register a SKU code as alias to an existing product
-- -------------------------------------------------------------
-- Also retroactively updates any existing shipstation_order_items
-- with this sku_code so previously-blocked orders unblock.
CREATE OR REPLACE FUNCTION public.rpc_shipstation_register_sku_alias(
  p_sku_code        TEXT,
  p_resolved_sku_id UUID,
  p_notes           TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
  v_actor       UUID := auth.uid();
  v_role        TEXT;
  v_updated_rows INT;
BEGIN
  SELECT role INTO v_role FROM public.profiles WHERE id = v_actor;
  IF v_role IS DISTINCT FROM 'admin' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'admin role required');
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

  -- Retroactively update any items already inserted with NULL sku_id
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

-- -------------------------------------------------------------
-- D. Updated apply-sale RPC: consults handling table for non-inventory
-- -------------------------------------------------------------
-- Replaces the version from migration 012. New behavior:
--   * sku_id IS NULL AND sku_code IN handling(non_inventory) → silent skip
--   * sku_id IS NULL otherwise                                → unresolved (blocks)
-- All other behavior preserved (inventory deduction, oversell detection,
-- audit transactions, applied flag).
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
      CONTINUE;
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

-- -------------------------------------------------------------
-- E. Pending-queue view: only truly-undecided codes (excludes
--    aliased + non-inventory). This is what operators triage.
-- -------------------------------------------------------------
CREATE OR REPLACE VIEW public.shipstation_unresolved_skus_pending AS
SELECT
  i.sku_code,
  COUNT(*)                AS line_item_count,
  SUM(i.quantity)         AS total_units,
  COUNT(DISTINCT o.id)    AS distinct_orders,
  MIN(o.order_date)       AS first_seen,
  MAX(o.order_date)       AS last_seen
FROM public.shipstation_order_items i
JOIN public.shipstation_orders o ON o.id = i.shipstation_order_id
WHERE i.sku_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.shipstation_sku_handling h
     WHERE h.sku_code = i.sku_code  -- excludes both aliases and non-inventory
  )
GROUP BY i.sku_code
ORDER BY COUNT(*) DESC;

COMMENT ON VIEW public.shipstation_unresolved_skus_pending IS
  'SKU codes that have appeared in ShipStation orders, are not in product_skus, and have no entry in shipstation_sku_handling. Triage these by calling rpc_shipstation_register_sku_alias or rpc_shipstation_register_non_inventory_sku.';
