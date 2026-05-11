-- =============================================================
-- Migration: rpc_bulk_cycle_count — accept warehouse_prefilled_raw
-- =============================================================
-- Background: the warehouse_prefilled_raw bucket was added in
-- 20260506000002_warehouse_prefilled_raw_bucket.sql but
-- rpc_bulk_cycle_count's field allow-list was never updated to match.
-- Any cycle count touching prefilled-raw values fails validation with
-- "invalid_field" — and since the RPC validates all-or-nothing, a
-- single prefilled-raw edit anywhere in a large batch sinks the whole
-- save.
--
-- This rewrites the RPC body to include warehouse_prefilled_raw. No
-- other behavior changes; the apply-phase EXECUTE format() already
-- handles any column name passed validation, so the loop body needs
-- no modification.
-- =============================================================

CREATE OR REPLACE FUNCTION public.rpc_bulk_cycle_count(
  p_adjustments JSONB,
  p_reason TEXT,
  p_notes TEXT,
  p_actor_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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
    RETURN jsonb_build_object('ok', false, 'error', 'p_adjustments must be a JSON array');
  END IF;
  IF jsonb_array_length(p_adjustments) = 0 THEN
    RETURN jsonb_build_object('ok', true, 'applied', 0, 'adjustments', '[]'::JSONB);
  END IF;

  -- Validation pass — collect failures, return if any
  FOR v_adj IN SELECT * FROM jsonb_array_elements(p_adjustments) LOOP
    v_sku_id := (v_adj->>'sku_id')::UUID;
    v_field  := v_adj->>'field';
    v_delta  := (v_adj->>'delta')::INTEGER;
    IF v_delta IS NULL OR v_delta = 0 THEN
      v_failures := v_failures || jsonb_build_object('sku_id', v_sku_id, 'field', v_field, 'reason', 'delta_must_be_nonzero');
      CONTINUE;
    END IF;
    -- prefilled_raw added here. Same shape as the other buckets;
    -- non-negative check below catches the chk_inv_*_nonneg constraints
    -- before the apply phase would otherwise crash the transaction.
    IF v_field NOT IN (
      'warehouse_raw',
      'warehouse_prefilled_raw',
      'warehouse_in_production',
      'warehouse_finished',
      'warehouse_other'
    ) THEN
      v_failures := v_failures || jsonb_build_object('sku_id', v_sku_id, 'field', v_field, 'reason', 'invalid_field');
      CONTINUE;
    END IF;
    SELECT * INTO v_sku FROM product_skus WHERE id = v_sku_id;
    IF NOT FOUND THEN
      v_failures := v_failures || jsonb_build_object('sku_id', v_sku_id, 'field', v_field, 'reason', 'sku_not_found');
      CONTINUE;
    END IF;
    EXECUTE format('SELECT %I FROM inventory_levels WHERE sku_id = $1', v_field)
      INTO v_current USING v_sku_id;
    v_new := COALESCE(v_current, 0) + v_delta;
    IF v_new < 0 THEN
      v_failures := v_failures || jsonb_build_object(
        'sku_id', v_sku_id, 'field', v_field, 'delta', v_delta,
        'current', COALESCE(v_current, 0), 'reason', 'would_go_negative'
      );
      CONTINUE;
    END IF;
  END LOOP;

  IF jsonb_array_length(v_failures) > 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'validation_failed', 'failures', v_failures);
  END IF;

  -- Apply pass — all adjustments validated, commit them.
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
    IF v_new < 0 THEN
      RAISE EXCEPTION 'rpc_bulk_cycle_count: SKU % field % would go negative on apply (concurrent write race?)',
        v_sku.sku, v_field;
    END IF;
    EXECUTE format('UPDATE inventory_levels SET %I = $1 WHERE sku_id = $2', v_field)
      USING v_new, v_sku_id;
    INSERT INTO inventory_transactions (
      sku_id, transaction_type, quantity, field_affected,
      movement_kind, notes, performed_by
    ) VALUES (
      v_sku_id, 'cycle_count', v_delta, v_field, 'net_change',
      format('%s: %s%s on %s (%s)%s',
        v_sku.sku,
        CASE WHEN v_delta > 0 THEN '+' ELSE '' END,
        v_delta, v_field, p_reason,
        CASE WHEN p_notes IS NOT NULL THEN ' — ' || p_notes ELSE '' END
      ),
      p_actor_id
    );
    v_results := v_results || jsonb_build_object('sku_id', v_sku_id, 'field', v_field, 'delta', v_delta, 'new_value', v_new);
    v_applied := v_applied + 1;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'applied', v_applied, 'adjustments', v_results);
END;
$function$;
