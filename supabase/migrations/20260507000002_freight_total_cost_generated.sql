-- =============================================================
-- Migration: Convert freight_shipments.total_cost to a generated column
-- =============================================================
-- Background: total_cost was previously a free-form numeric column kept
-- in sync with `freight_cost + insurance_cost + duties_cost` by the
-- supplier-portal RPC and warned-on-drift via a trigger. This worked
-- when the only writers were the RPCs that knew the formula, but two
-- code paths bypassed it:
--
--   1. The admin "New Shipment" form wrote the freight charge into
--      total_cost (instead of freight_cost), making total_cost equal
--      to just freight while ignoring insurance + duties.
--   2. The new admin inline-edit on the freight detail page (added
--      yesterday) writes only freight_cost via a generic update, so
--      total_cost stayed at its prior value — visibly stale on the
--      cost-per-unit chart at the bottom of the freight dashboard.
--
-- Fix: make total_cost a Postgres GENERATED ALWAYS column. The DB
-- itself computes it on every read; nobody can set it directly.
-- The drift trigger and its function become redundant and are dropped.
-- The supplier-portal RPC is updated to remove the now-pointless
-- total_cost CASE expression.
--
-- Backfill ordering:
--   1. Recover any freight value sitting in total_cost but missing
--      from freight_cost (this catches the admin-created shipments,
--      including the recent #418).
--   2. Drop the trigger BEFORE the column (trigger fn references it).
--   3. Drop the column (CHECK chk_freight_total_nonneg is removed
--      automatically since it depends only on this column).
--   4. Re-add as a STORED generated column.
--   5. Re-add the non-negative CHECK explicitly so it shows up in
--      schema dumps (otherwise readers might think the column is
--      unbounded).
-- =============================================================

-- 1. Backfill freight_cost from total_cost where freight_cost is the
--    one that's missing. This catches the admin "New Shipment" form
--    legacy: it wrote freight charges into total_cost. We only copy
--    when freight_cost is null AND insurance/duties are zero or null
--    — so we don't accidentally treat a true "freight + ins + duties"
--    sum as if it were just freight. (In practice all current rows
--    have ins=0/duties=0, but the guard keeps this safe to re-run.)
UPDATE public.freight_shipments
   SET freight_cost = total_cost
 WHERE freight_cost IS NULL
   AND total_cost IS NOT NULL
   AND total_cost > 0
   AND COALESCE(insurance_cost, 0) = 0
   AND COALESCE(duties_cost, 0) = 0;

-- 2. Drop trigger + function. They warn about drift between total_cost
--    and (freight + ins + duties); drift becomes physically impossible
--    once total_cost is computed.
DROP TRIGGER IF EXISTS trg_warn_freight_total_drift ON public.freight_shipments;
DROP FUNCTION IF EXISTS public.warn_freight_total_drift();

-- 3. Drop the existing total_cost column. Postgres will automatically
--    drop the chk_freight_total_nonneg CHECK constraint as a dependency.
ALTER TABLE public.freight_shipments DROP COLUMN total_cost;

-- 4. Re-add as a generated column. Stored (not virtual) so the value
--    is persisted on disk — query plans that filter or sort on it
--    don't have to recompute. NUMERIC(14,4) matches the precision
--    used elsewhere in the schema for money columns.
ALTER TABLE public.freight_shipments
  ADD COLUMN total_cost NUMERIC(14,4)
  GENERATED ALWAYS AS (
    COALESCE(freight_cost, 0) + COALESCE(insurance_cost, 0) + COALESCE(duties_cost, 0)
  ) STORED;

-- 5. Re-add the non-negative invariant. The component columns each
--    have their own non-neg CHECKs so total_cost can never be negative
--    in practice, but keeping this constraint here makes the schema
--    self-documenting (and catches any future loosening of those).
ALTER TABLE public.freight_shipments
  ADD CONSTRAINT chk_freight_total_nonneg CHECK (total_cost >= 0);

-- 6. Rewrite the supplier-portal tracking RPC. The total_cost CASE
--    branch is dropped — the DB computes total_cost automatically now,
--    and trying to set it explicitly would error out (generated
--    columns reject INSERT/UPDATE values). Body otherwise unchanged.
CREATE OR REPLACE FUNCTION public.rpc_supplier_update_shipment_tracking(
  p_shipment_id uuid,
  p_expected_version integer,
  p_tracking_number text DEFAULT NULL::text,
  p_carrier text DEFAULT NULL::text,
  p_eta date DEFAULT NULL::date,
  p_ship_date date DEFAULT NULL::date,
  p_freight_cost numeric DEFAULT NULL::numeric,
  p_clear_tracking_number boolean DEFAULT false,
  p_clear_carrier boolean DEFAULT false,
  p_clear_eta boolean DEFAULT false,
  p_clear_ship_date boolean DEFAULT false,
  p_clear_freight_cost boolean DEFAULT false
) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_supplier_id UUID := jwt_supplier_id();
  v_row freight_shipments%ROWTYPE;
  v_prev_tracking TEXT;
  v_prev_carrier TEXT;
  v_prev_eta DATE;
  v_prev_ship_date DATE;
  v_prev_freight_cost NUMERIC;
  v_prev_status TEXT;
  v_final_tracking TEXT;
  v_final_carrier TEXT;
  v_new_status TEXT;
BEGIN
  IF v_supplier_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_a_supplier');
  END IF;

  SELECT * INTO v_row FROM freight_shipments WHERE id = p_shipment_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  IF v_row.origin_supplier_id IS DISTINCT FROM v_supplier_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_your_shipment');
  END IF;

  IF v_row.row_version != p_expected_version THEN
    RETURN jsonb_build_object(
      'ok', false, 'error', 'version_conflict',
      'current_version', v_row.row_version
    );
  END IF;

  IF v_row.status NOT IN ('pending', 'on_the_water') THEN
    RETURN jsonb_build_object(
      'ok', false, 'error', 'shipment_not_editable',
      'current_status', v_row.status
    );
  END IF;

  IF p_freight_cost IS NOT NULL AND p_freight_cost < 0 THEN
    RETURN jsonb_build_object(
      'ok', false, 'error', 'invalid_freight_cost',
      'freight_cost', p_freight_cost
    );
  END IF;

  v_prev_tracking := v_row.tracking_number;
  v_prev_carrier := v_row.carrier_name;
  v_prev_eta := v_row.eta;
  v_prev_ship_date := v_row.ship_date;
  v_prev_freight_cost := v_row.freight_cost;
  v_prev_status := v_row.status;

  v_final_tracking := CASE
    WHEN p_clear_tracking_number THEN NULL
    WHEN p_tracking_number IS NOT NULL THEN NULLIF(trim(p_tracking_number), '')
    ELSE v_row.tracking_number
  END;
  v_final_carrier := CASE
    WHEN p_clear_carrier THEN NULL
    WHEN p_carrier IS NOT NULL THEN NULLIF(trim(p_carrier), '')
    ELSE v_row.carrier_name
  END;

  IF v_row.status = 'pending'
     AND v_final_tracking IS NOT NULL
     AND v_final_carrier IS NOT NULL THEN
    v_new_status := 'on_the_water';
  ELSE
    v_new_status := v_row.status;
  END IF;

  UPDATE freight_shipments
     SET tracking_number = v_final_tracking,
         carrier_name = v_final_carrier,
         eta = CASE
           WHEN p_clear_eta THEN NULL
           WHEN p_eta IS NOT NULL THEN p_eta
           ELSE eta
         END,
         ship_date = CASE
           WHEN p_clear_ship_date THEN NULL
           WHEN p_ship_date IS NOT NULL THEN p_ship_date
           ELSE ship_date
         END,
         freight_cost = CASE
           WHEN p_clear_freight_cost THEN 0
           WHEN p_freight_cost IS NOT NULL THEN p_freight_cost
           ELSE freight_cost
         END,
         -- total_cost is a generated column now; it auto-recomputes
         -- when freight_cost (or insurance/duties) changes.
         status = v_new_status
   WHERE id = p_shipment_id;

  INSERT INTO audit_logs (actor_id, action, target_table, target_id, details)
  VALUES (
    auth.uid(),
    'freight_shipment.update_tracking',
    'freight_shipments',
    p_shipment_id,
    jsonb_build_object(
      'prev_tracking_number', v_prev_tracking,
      'prev_carrier_name', v_prev_carrier,
      'prev_eta', v_prev_eta,
      'prev_ship_date', v_prev_ship_date,
      'prev_freight_cost', v_prev_freight_cost,
      'prev_status', v_prev_status,
      'new_status', v_new_status,
      'auto_promoted', (v_prev_status = 'pending' AND v_new_status = 'on_the_water'),
      'new_tracking_number_requested', p_tracking_number,
      'new_carrier_requested', p_carrier,
      'new_eta_requested', p_eta,
      'new_ship_date_requested', p_ship_date,
      'new_freight_cost_requested', p_freight_cost,
      'clear_flags', jsonb_build_object(
        'tracking_number', p_clear_tracking_number,
        'carrier', p_clear_carrier,
        'eta', p_clear_eta,
        'ship_date', p_clear_ship_date,
        'freight_cost', p_clear_freight_cost
      )
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'status', v_new_status,
    'promoted', (v_prev_status = 'pending' AND v_new_status = 'on_the_water')
  );
END;
$$;
