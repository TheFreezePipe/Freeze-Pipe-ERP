-- ============================================================================
-- Factory orders: auto-REOPEN when shipped coverage disappears
-- ============================================================================
-- _recompute_factory_order_status only ever promoted (…→shipped). If the
-- coverage that justified the promotion goes away — a freight line briefly
-- attributed then re-pointed, an attribution undone — the order stayed
-- 'shipped' forever with zero coverage. Bit YX-2026072902 on 2026-07-29:
-- auto-completed at creation, freight later detached, stuck 'shipped' →
-- its 100 HT-5 vanished from Stock Levels (shipped orders are excluded
-- from on-order) while the card rendered them "finished at factory".
--
-- Fix: a demote branch mirroring the close-short reopen — shipped orders
-- that are no longer fully covered revert to in_production (shipped_at
-- cleared, audit-logged). Manually advancing an order is unaffected; the
-- demote only fires from the same recompute paths that auto-promote.

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

  -- Demote branch: auto-completed coverage evaporated → reopen.
  IF v_status = 'shipped' THEN
    IF NOT public._factory_order_fully_shipped(p_order_id) THEN
      UPDATE factory_orders SET status = 'in_production', shipped_at = NULL
       WHERE id = p_order_id;
      INSERT INTO audit_logs (actor_id, action, target_table, target_id, details)
      VALUES (p_actor, 'factory_order.auto_reopened', 'factory_orders', p_order_id,
              jsonb_build_object('from', 'shipped', 'to', 'in_production',
                                 'reason', 'shipped_coverage_lost'));
    END IF;
    RETURN;
  END IF;

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
