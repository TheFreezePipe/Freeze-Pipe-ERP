-- =============================================================
-- Migration: factory order manual progress + auto-complete
-- =============================================================
-- Adds admin control over per-line progress and auto-closes orders.
--
-- Two senses of "finished" are kept distinct:
--   * quantity_finished (existing) — units the factory has completed but
--     NOT yet shipped. Still counts toward on-order.
--   * order status 'shipped' — terminal "complete/fulfilled": every unit
--     has left (via freight or recorded manually). Excluded from on-order.
--
-- New: quantity_shipped_manual — units shipped OUTSIDE the system (e.g.
-- pre-go-live), so corrections don't need a fake freight record. On-order
-- nets these out (handled client-side in inventory-aggregates).
--
-- Auto-complete: when every line is fully covered
-- (freight_shipped + manual_shipped + breakage >= ordered) and all line
-- costs are set, the order flips to 'shipped' with a shipped_at stamp —
-- driven automatically as freight is added (the 99% path) and on manual
-- progress edits (the correction path). shipped_at anchors the list's
-- "hide completed after a few days" behavior.
-- =============================================================

ALTER TABLE public.factory_order_items
  ADD COLUMN IF NOT EXISTS quantity_shipped_manual integer NOT NULL DEFAULT 0;

ALTER TABLE public.factory_order_items
  DROP CONSTRAINT IF EXISTS chk_foi_manual_shipped_bounds;
ALTER TABLE public.factory_order_items
  ADD CONSTRAINT chk_foi_manual_shipped_bounds
  CHECK (quantity_shipped_manual >= 0 AND quantity_shipped_manual <= quantity_ordered);

ALTER TABLE public.factory_orders
  ADD COLUMN IF NOT EXISTS shipped_at timestamptz;

-- True when the order has lines and every line is fully accounted for
-- (freight-shipped + manual-shipped + breakage >= ordered).
CREATE OR REPLACE FUNCTION public._factory_order_fully_shipped(p_order_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (SELECT 1 FROM factory_order_items WHERE factory_order_id = p_order_id)
     AND NOT EXISTS (
       SELECT 1 FROM factory_order_items foi
        WHERE foi.factory_order_id = p_order_id
          AND (
            COALESCE((SELECT SUM(fl.quantity) FROM freight_line_items fl
                       WHERE fl.source_factory_order_item_id = foi.id), 0)
            + foi.quantity_shipped_manual
            + foi.quantity_breakage
          ) < foi.quantity_ordered
     );
$function$;

-- Flip a pre-shipped order to 'shipped' when fully covered. Skips silently
-- if not covered, already shipped/canceled, or any line lacks a unit cost
-- (the shipped-cost trigger would otherwise raise — and this runs inside
-- the freight trigger, which must never fail an inventory operation).
CREATE OR REPLACE FUNCTION public._recompute_factory_order_status(p_order_id uuid, p_actor uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_status       text;
  v_missing_cost int;
BEGIN
  SELECT status INTO v_status FROM factory_orders WHERE id = p_order_id;
  IF v_status IS NULL OR v_status NOT IN ('ordered', 'in_production', 'finished') THEN
    RETURN;
  END IF;
  IF NOT public._factory_order_fully_shipped(p_order_id) THEN
    RETURN;
  END IF;
  SELECT count(*) INTO v_missing_cost
    FROM factory_order_items WHERE factory_order_id = p_order_id AND unit_cost = 0;
  IF v_missing_cost > 0 THEN
    RETURN;
  END IF;

  UPDATE factory_orders
     SET status = 'shipped', shipped_at = now()
   WHERE id = p_order_id;

  INSERT INTO audit_logs (actor_id, action, target_table, target_id, details)
  VALUES (p_actor, 'factory_order.auto_completed', 'factory_orders', p_order_id,
          jsonb_build_object('from', v_status, 'to', 'shipped', 'reason', 'fully_shipped'));
END;
$function$;

-- Freight changes can complete an order. Recompute the affected order(s).
CREATE OR REPLACE FUNCTION public.trg_freight_line_recompute_fo()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_new_order uuid;
  v_old_order uuid;
BEGIN
  IF TG_OP <> 'DELETE' AND NEW.source_factory_order_item_id IS NOT NULL THEN
    SELECT factory_order_id INTO v_new_order FROM factory_order_items WHERE id = NEW.source_factory_order_item_id;
  END IF;
  IF TG_OP <> 'INSERT' AND OLD.source_factory_order_item_id IS NOT NULL THEN
    SELECT factory_order_id INTO v_old_order FROM factory_order_items WHERE id = OLD.source_factory_order_item_id;
  END IF;

  IF v_new_order IS NOT NULL THEN
    BEGIN PERFORM public._recompute_factory_order_status(v_new_order, '00000000-0000-0000-0000-000000000001'::uuid);
    EXCEPTION WHEN OTHERS THEN NULL; END;
  END IF;
  IF v_old_order IS NOT NULL AND v_old_order IS DISTINCT FROM v_new_order THEN
    BEGIN PERFORM public._recompute_factory_order_status(v_old_order, '00000000-0000-0000-0000-000000000001'::uuid);
    EXCEPTION WHEN OTHERS THEN NULL; END;
  END IF;
  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS freight_line_recompute_fo ON public.freight_line_items;
CREATE TRIGGER freight_line_recompute_fo
AFTER INSERT OR UPDATE OR DELETE ON public.freight_line_items
FOR EACH ROW EXECUTE FUNCTION public.trg_freight_line_recompute_fo();

-- Admin/manager per-line progress editor: set quantity_finished and/or
-- quantity_shipped_manual per line, then recompute completion. Optimistic
-- version guard on the order; audited.
CREATE OR REPLACE FUNCTION public.rpc_admin_set_factory_order_progress(
  p_order_id uuid,
  p_expected_version integer,
  p_line_ops jsonb
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor        uuid := auth.uid();
  v_role         text;
  v_order        factory_orders%ROWTYPE;
  v_op           jsonb;
  v_line         factory_order_items%ROWTYPE;
  v_line_id      uuid;
  v_freight      int;
  v_new_finished int;
  v_new_manual   int;
  v_new_version  int;
  v_new_status   text;
BEGIN
  SELECT role INTO v_role FROM profiles WHERE id = v_actor;
  IF v_role IS NULL OR v_role NOT IN ('admin', 'manager') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'admin or manager role required');
  END IF;

  SELECT * INTO v_order FROM factory_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'order not found');
  END IF;
  IF v_order.row_version <> p_expected_version THEN
    RETURN jsonb_build_object('ok', false, 'error', 'version_conflict', 'current_version', v_order.row_version);
  END IF;
  IF v_order.status = 'canceled' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'cannot edit progress on a canceled order');
  END IF;

  FOR v_op IN SELECT * FROM jsonb_array_elements(COALESCE(p_line_ops, '[]'::jsonb))
  LOOP
    v_line_id := (v_op ->> 'line_id')::uuid;
    SELECT * INTO v_line FROM factory_order_items
     WHERE id = v_line_id AND factory_order_id = p_order_id;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'error', format('line %s is not on this order', v_line_id));
    END IF;

    v_new_finished := CASE WHEN v_op ? 'quantity_finished'
                           THEN (v_op ->> 'quantity_finished')::int
                           ELSE v_line.quantity_finished END;
    v_new_manual   := CASE WHEN v_op ? 'quantity_shipped_manual'
                           THEN (v_op ->> 'quantity_shipped_manual')::int
                           ELSE v_line.quantity_shipped_manual END;

    IF v_new_finished < 0 OR v_new_finished > v_line.quantity_ordered THEN
      RETURN jsonb_build_object('ok', false, 'error',
        format('finished must be between 0 and %s', v_line.quantity_ordered));
    END IF;
    IF v_new_manual < 0 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'manually-shipped cannot be negative');
    END IF;

    v_freight := COALESCE((SELECT SUM(fl.quantity) FROM freight_line_items fl
                            WHERE fl.source_factory_order_item_id = v_line.id), 0);
    IF v_freight + v_new_manual > v_line.quantity_ordered THEN
      RETURN jsonb_build_object('ok', false, 'error',
        format('freight-shipped (%s) + manual (%s) exceeds ordered (%s)',
               v_freight, v_new_manual, v_line.quantity_ordered));
    END IF;

    UPDATE factory_order_items
       SET quantity_finished = v_new_finished,
           quantity_shipped_manual = v_new_manual
     WHERE id = v_line_id;
  END LOOP;

  -- May flip the order to 'shipped'.
  PERFORM public._recompute_factory_order_status(p_order_id, v_actor);

  -- Bump the order's version so the UI's optimistic concurrency stays
  -- coherent even when only line rows changed.
  UPDATE factory_orders SET updated_at = now() WHERE id = p_order_id;

  INSERT INTO audit_logs (actor_id, action, target_table, target_id, details)
  VALUES (v_actor, 'factory_order.admin_progress', 'factory_orders', p_order_id,
          jsonb_build_object('line_ops', p_line_ops));

  SELECT row_version, status INTO v_new_version, v_new_status
    FROM factory_orders WHERE id = p_order_id;
  RETURN jsonb_build_object('ok', true, 'new_version', v_new_version, 'status', v_new_status);
END;
$function$;

REVOKE ALL ON FUNCTION public.rpc_admin_set_factory_order_progress(uuid, integer, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_admin_set_factory_order_progress(uuid, integer, jsonb) TO authenticated;

-- Backfill: auto-complete any existing order that is already fully shipped
-- (e.g. As050926BW-R: 255/255 via freight). Costs-missing orders are left.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT id FROM factory_orders WHERE status IN ('ordered','in_production','finished')
  LOOP
    PERFORM public._recompute_factory_order_status(r.id, '00000000-0000-0000-0000-000000000001'::uuid);
  END LOOP;
END $$;
