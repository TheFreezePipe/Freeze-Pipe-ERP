-- =============================================================
-- Migration: rpc_bulk_material_cycle_count
-- =============================================================
-- Bulk cycle-count flow for materials, mirroring rpc_bulk_cycle_count
-- on the SKU side. Validates the whole batch first (admin/manager,
-- material exists, no negative results), then applies all adjustments
-- + audit rows in one transaction. Validation-failed envelopes
-- guarantee no partial writes.
--
-- Payload shape:
--   p_adjustments: jsonb array of { material_id, delta }
--   p_reason:      "spillage" | "damage" | "receiving" | "recount" | "other"
--   p_notes:       optional free-form text (appended to each audit row)
--   p_actor_id:    UUID of the operator performing the count
--
-- All deltas are SIGNED (positive = stock arrived, negative = stock
-- went away). The UI sends new_count - current_count for each touched
-- material. Materials whose on-hand wasn't touched aren't included in
-- the array — same "only emit deltas for fields the operator actually
-- touched" rule we learned with the SKU cycle-count bug fix.
-- =============================================================

CREATE OR REPLACE FUNCTION public.rpc_bulk_material_cycle_count(
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
  v_material_id UUID;
  v_delta       NUMERIC(14, 4);
  v_material    public.materials%ROWTYPE;
  v_current     NUMERIC(14, 4);
  v_new         NUMERIC(14, 4);
  v_failures    JSONB := '[]'::JSONB;
  v_results     JSONB := '[]'::JSONB;
  v_applied     INTEGER := 0;
  v_role        TEXT;
BEGIN
  -- Authorize: admin or manager only.
  SELECT role INTO v_role FROM public.profiles WHERE id = p_actor_id;
  IF v_role IS NULL OR v_role NOT IN ('admin', 'manager') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'admin or manager role required');
  END IF;

  IF p_adjustments IS NULL OR jsonb_typeof(p_adjustments) <> 'array' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'p_adjustments must be a JSON array');
  END IF;
  IF jsonb_array_length(p_adjustments) = 0 THEN
    RETURN jsonb_build_object('ok', true, 'applied', 0, 'adjustments', '[]'::JSONB);
  END IF;

  -- Validation pass
  FOR v_adj IN SELECT * FROM jsonb_array_elements(p_adjustments) LOOP
    v_material_id := (v_adj->>'material_id')::UUID;
    v_delta       := (v_adj->>'delta')::NUMERIC;
    IF v_delta IS NULL OR v_delta = 0 THEN
      v_failures := v_failures || jsonb_build_object(
        'material_id', v_material_id, 'reason', 'delta_must_be_nonzero'
      );
      CONTINUE;
    END IF;
    SELECT * INTO v_material FROM public.materials WHERE id = v_material_id;
    IF NOT FOUND THEN
      v_failures := v_failures || jsonb_build_object(
        'material_id', v_material_id, 'reason', 'material_not_found'
      );
      CONTINUE;
    END IF;
    SELECT on_hand_qty INTO v_current
      FROM public.material_inventory_levels
     WHERE material_id = v_material_id;
    v_new := COALESCE(v_current, 0) + v_delta;
    IF v_new < 0 THEN
      v_failures := v_failures || jsonb_build_object(
        'material_id', v_material_id,
        'material_code', v_material.code,
        'delta', v_delta,
        'current', COALESCE(v_current, 0),
        'reason', 'would_go_negative'
      );
      CONTINUE;
    END IF;
  END LOOP;

  IF jsonb_array_length(v_failures) > 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'validation_failed', 'failures', v_failures);
  END IF;

  -- Apply pass
  FOR v_adj IN SELECT * FROM jsonb_array_elements(p_adjustments) LOOP
    v_material_id := (v_adj->>'material_id')::UUID;
    v_delta       := (v_adj->>'delta')::NUMERIC;
    IF v_delta = 0 THEN CONTINUE; END IF;
    SELECT * INTO v_material FROM public.materials WHERE id = v_material_id;
    PERFORM 1 FROM public.material_inventory_levels WHERE material_id = v_material_id FOR UPDATE;
    SELECT on_hand_qty INTO v_current
      FROM public.material_inventory_levels
     WHERE material_id = v_material_id;
    v_new := COALESCE(v_current, 0) + v_delta;

    -- Apply-time race guard.
    IF v_new < 0 THEN
      RAISE EXCEPTION 'rpc_bulk_material_cycle_count: material % would go negative on apply (concurrent write race?)', v_material.code;
    END IF;

    -- UPSERT so first-ever count on a brand-new material works even
    -- if the inventory_levels row was somehow missed at material creation.
    INSERT INTO public.material_inventory_levels (material_id, on_hand_qty, last_counted_at, last_counted_by)
    VALUES (v_material_id, v_new, now(), p_actor_id)
    ON CONFLICT (material_id) DO UPDATE
      SET on_hand_qty     = EXCLUDED.on_hand_qty,
          last_counted_at = EXCLUDED.last_counted_at,
          last_counted_by = EXCLUDED.last_counted_by;

    INSERT INTO public.material_transactions (
      material_id, transaction_type, quantity_change, reference_type, reference_id, notes, performed_by
    ) VALUES (
      v_material_id, 'cycle_count', v_delta, NULL, NULL,
      format('%s: %s%s %s (%s)%s',
        v_material.code,
        CASE WHEN v_delta > 0 THEN '+' ELSE '' END,
        v_delta,
        v_material.unit_of_measure,
        p_reason,
        CASE WHEN p_notes IS NOT NULL AND p_notes <> '' THEN ' — ' || p_notes ELSE '' END
      ),
      p_actor_id
    );

    v_results := v_results || jsonb_build_object(
      'material_id', v_material_id, 'delta', v_delta, 'new_value', v_new
    );
    v_applied := v_applied + 1;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'applied', v_applied, 'adjustments', v_results);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.rpc_bulk_material_cycle_count TO authenticated;
