-- =============================================================
-- Migration 050: rpc_bulk_cycle_count
-- =============================================================
-- The InventoryDashboard "save edit mode" submits N cycle-count
-- adjustments at once (one per changed bucket × SKU). The previous
-- client-side hook looped over the per-row `rpc_cycle_count` RPC,
-- which is NOT atomic: if adjustment 4-of-6 failed (e.g. would-go-
-- negative), adjustments 1-3 had already committed and 5-6 never
-- ran. The dashboard surfaced "N failed" but the user had no way to
-- tell which deltas landed; re-saving would double-apply the
-- successful ones.
--
-- This migration adds a server-side bulk variant. Approach:
--   1. Accept the entire batch in a single JSONB payload.
--   2. Two-phase: validate every adjustment first (SKU exists,
--      field is a valid bucket, delta non-zero, resulting value
--      non-negative). If any validation fails, abort with an
--      itemized error envelope — nothing has been written yet.
--   3. Apply every adjustment in the same transaction, emitting an
--      audit row per adjustment. The function runs in a single
--      Postgres transaction by definition, so any RAISE EXCEPTION
--      inside rolls back the entire batch.
--
-- Returns a JSONB envelope:
--   { ok: true,
--     applied: <count>,
--     adjustments: [{ sku_id, field, delta, new_value }, ...] }
--
-- Or on validation failure (no writes performed):
--   { ok: false,
--     error: 'validation_failed',
--     failures: [{ sku_id, field, reason, ... }, ...] }
--
-- Authorization: same as rpc_cycle_count — the function is
-- SECURITY DEFINER + GRANT EXECUTE TO authenticated. Callers pass
-- their own auth.uid() in p_actor_id; we trust it because RLS on
-- inventory_transactions enforces actor identity downstream.
-- =============================================================

CREATE OR REPLACE FUNCTION rpc_bulk_cycle_count(
  p_adjustments JSONB,   -- array of { sku_id, field, delta }
  p_reason      TEXT,
  p_notes       TEXT,
  p_actor_id    UUID
) RETURNS JSONB AS $$
DECLARE
  v_adj         JSONB;
  v_sku_id      UUID;
  v_field       TEXT;
  v_delta       INTEGER;
  v_sku         product_skus%ROWTYPE;
  v_current     INTEGER;
  v_new         INTEGER;
  v_failures    JSONB := '[]'::JSONB;
  v_results     JSONB := '[]'::JSONB;
  v_applied     INTEGER := 0;
BEGIN
  IF p_adjustments IS NULL OR jsonb_typeof(p_adjustments) <> 'array' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'p_adjustments must be a JSON array'
    );
  END IF;

  IF jsonb_array_length(p_adjustments) = 0 THEN
    RETURN jsonb_build_object('ok', true, 'applied', 0, 'adjustments', '[]'::JSONB);
  END IF;

  -- ----- Phase 1: validate every adjustment, collecting failures
  FOR v_adj IN SELECT * FROM jsonb_array_elements(p_adjustments) LOOP
    v_sku_id := (v_adj->>'sku_id')::UUID;
    v_field  := v_adj->>'field';
    v_delta  := (v_adj->>'delta')::INTEGER;

    IF v_delta IS NULL OR v_delta = 0 THEN
      v_failures := v_failures || jsonb_build_object(
        'sku_id', v_sku_id, 'field', v_field,
        'reason', 'delta_must_be_nonzero'
      );
      CONTINUE;
    END IF;

    IF v_field NOT IN (
      'warehouse_raw', 'warehouse_in_production', 'warehouse_finished', 'warehouse_other'
    ) THEN
      v_failures := v_failures || jsonb_build_object(
        'sku_id', v_sku_id, 'field', v_field,
        'reason', 'invalid_field'
      );
      CONTINUE;
    END IF;

    SELECT * INTO v_sku FROM product_skus WHERE id = v_sku_id;
    IF NOT FOUND THEN
      v_failures := v_failures || jsonb_build_object(
        'sku_id', v_sku_id, 'field', v_field,
        'reason', 'sku_not_found'
      );
      CONTINUE;
    END IF;

    EXECUTE format('SELECT %I FROM inventory_levels WHERE sku_id = $1', v_field)
      INTO v_current USING v_sku_id;
    v_new := COALESCE(v_current, 0) + v_delta;

    IF v_new < 0 THEN
      v_failures := v_failures || jsonb_build_object(
        'sku_id', v_sku_id, 'field', v_field, 'delta', v_delta,
        'current', COALESCE(v_current, 0),
        'reason', 'would_go_negative'
      );
      CONTINUE;
    END IF;
  END LOOP;

  -- If any validation failed, refuse the whole batch. Operators get
  -- one clear "fix these N issues then retry" surface instead of a
  -- partial commit they can't reason about.
  IF jsonb_array_length(v_failures) > 0 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'validation_failed',
      'failures', v_failures
    );
  END IF;

  -- ----- Phase 2: apply. Lock each row first, then UPDATE + audit.
  -- Re-walk the original input array so we apply in submission order.
  -- (Recomputing v_new here is necessary because Phase 1's v_new is a
  -- single scalar — it held only the last adjustment's projected
  -- value.)
  FOR v_adj IN SELECT * FROM jsonb_array_elements(p_adjustments) LOOP
    v_sku_id := (v_adj->>'sku_id')::UUID;
    v_field  := v_adj->>'field';
    v_delta  := (v_adj->>'delta')::INTEGER;
    IF v_delta = 0 THEN CONTINUE; END IF;

    SELECT * INTO v_sku FROM product_skus WHERE id = v_sku_id;
    PERFORM 1 FROM inventory_levels WHERE sku_id = v_sku_id FOR UPDATE;

    EXECUTE format('SELECT %I FROM inventory_levels WHERE sku_id = $1', v_field)
      INTO v_current USING v_sku_id;
    v_new := COALESCE(v_current, 0) + v_delta;

    -- Defensive re-check. Concurrent writes between phase 1 and phase
    -- 2 could push the bucket below zero even though phase 1 cleared.
    -- If that happens, raise — the entire batch rolls back.
    IF v_new < 0 THEN
      RAISE EXCEPTION
        'rpc_bulk_cycle_count: SKU % field % would go negative on apply (concurrent write race?)',
        v_sku.sku, v_field;
    END IF;

    EXECUTE format('UPDATE inventory_levels SET %I = $1 WHERE sku_id = $2', v_field)
      USING v_new, v_sku_id;

    INSERT INTO inventory_transactions (
      sku_id, transaction_type, quantity, field_affected,
      movement_kind, notes, performed_by
    ) VALUES (
      v_sku_id, 'cycle_count', v_delta, v_field,
      'net_change',
      format('%s: %s%s on %s (%s)%s',
        v_sku.sku,
        CASE WHEN v_delta > 0 THEN '+' ELSE '' END,
        v_delta,
        v_field,
        p_reason,
        CASE WHEN p_notes IS NOT NULL THEN ' — ' || p_notes ELSE '' END
      ),
      p_actor_id
    );

    v_results := v_results || jsonb_build_object(
      'sku_id', v_sku_id, 'field', v_field,
      'delta', v_delta, 'new_value', v_new
    );
    v_applied := v_applied + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'applied', v_applied,
    'adjustments', v_results
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION rpc_bulk_cycle_count(JSONB, TEXT, TEXT, UUID) TO authenticated;

COMMENT ON FUNCTION rpc_bulk_cycle_count IS
  'Atomic batch variant of rpc_cycle_count. Validates every adjustment first; if any fails, the whole batch is rejected without writes. On apply, all adjustments + their audit rows commit together in one transaction, so partial-failure split-state is impossible. Used by InventoryDashboard edit-mode save.';

-- Sanity guard: function landed and is properly hardened.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'rpc_bulk_cycle_count'
      AND p.prosecdef = true
      AND 'search_path=public' = ANY(p.proconfig)
  ) THEN
    RAISE EXCEPTION 'Migration 050: rpc_bulk_cycle_count failed to land or is not hardened';
  END IF;
END$$;
