-- =============================================================
-- PD board: "Arrived" means the whole factory order landed
-- =============================================================
-- Owner rule, 2026-09-30:
--   "A product moves to Arrived only when its factory order has fully
--    landed, or the factory has shipped everything it is going to ship and
--    it has all been received. Samples do not count."
--
-- INCIDENT. 20260827000005 archived the Ordered card for a SKU the moment
-- ANY quantity of that SKU was checked in. On 2026-09-22 air shipment
-- AIR-266 delivered 2 sample units each of S04-NB2 and S04-NB6 against
-- 200-unit factory orders (YX-2026082802). Both cards ("Q4 Studio - NB2",
-- "Q4 Studio - NB6") were filed as arrived and vanished from the PD board
-- with 198 units each still at the factory. AIR-268 (2 x S04-BW20DNA) was
-- about to do the same to "Q4 Studio - BW20DNA" (300 ordered on AS082726BW,
-- the only line on that order; the real units are on sea freight 485 and
-- 486; attached to the "Northern Lights Studio drop" launch).
--
-- RULE AS BUILT. The evaluation lives in fn_pd_evaluate_arrival(sku,
-- shipment, line, via). It runs for the Ordered, unarchived card whose
-- linked_sku_id is that SKU (mkt_pd_projects_linked_sku_unique: at most one
-- card per SKU) from three places, all of which can only ever ARCHIVE:
--   * the freight_line_items trigger, on an increase of quantity_received
--     (via 'receipt');
--   * the promote branch of _recompute_factory_order_status, for every SKU
--     on the order that just became 'shipped' (via 'factory_order_shipped':
--     covers an order that completes AFTER the last box was checked in, e.g.
--     a sibling SKU's freight being booked, or a breakage write-off);
--   * the end of rpc_close_freight_short, for the SKUs whose lines were
--     shrunk or removed (via 'close_short': closing a shipment short is the
--     only receipt-confirmation that never raises quantity_received).
--
--  INBOUND (both branches): the SKU still has a freight line - sourced from
--  the order or not - with quantity_received < quantity on a shipment whose
--  receipt_confirmed_at is NULL. Nothing is filed while that is true, so a
--  sample never files a card whose real units are on the water, however the
--  order was squared.
--
--  A. Card HAS a linked factory order.
--     items     = factory_order_items for that SKU on the linked order, plus
--                 on any order whose parent_factory_order_id is the linked one.
--     threshold = sum(quantity_ordered - quantity_consumed_by_parent)
--                 (component units built into the parent never ship as freight)
--     received  = sum(quantity_received) over freight lines whose
--                 source_factory_order_item_id is one of those items.
--     Archive as arrived when either
--       (1) FULLY LANDED: threshold > 0 and received >= threshold; or
--       (2) FACTORY DONE, ALL RECEIVED: every one of those factory orders is
--           done - status 'shipped', or _factory_order_fully_shipped() true
--           (same coverage test without the unit_cost gate that keeps an
--           uncosted order out of 'shipped') - and not canceled; no item of
--           the SKU carries quantity_shipped_manual (units declared shipped
--           outside the freight system can never be verified as received,
--           so those cards wait for the manual Mark arrived); there is at
--           least one sourced freight line, every sourced freight line has
--           quantity_received >= quantity, and nothing is INBOUND.
--     If the linked order carries no line for the SKU at all the card is
--     left alone (nothing to measure against; safest is not to hide it).
--     Freight lines for the SKU that are NOT sourced from the order's items
--     never count towards "received", but they DO count as inbound.
--
--  B. Card has NO linked factory order (no order size to measure against).
--     Only on a receipt: archive when the line being checked in is now fully
--     received (quantity_received >= quantity) and nothing is INBOUND. So a
--     sample box that lands while the real shipment is already booked does
--     not archive the card, and a partial check-in never does. The two
--     re-evaluation hooks skip these cards (no line is being received).
--     (Residual, by design of having no order to compare to: a sample that
--     is fully received when no other shipment of the SKU exists yet would
--     archive. Today no Ordered card is without a factory order.)
--
-- The archive only ever writes archived_at + archive_reason. It never
-- touches linked_launch_id, target_launch_date or launch_date_override.
-- Every archive writes one mkt_pd_stage_events row (outcome 'archive',
-- reason 'arrived', meta auto='arrival', via, rule, received, threshold,
-- factory_order_id, and freight_line_id / freight_shipment_id when the
-- trigger is the caller).
--
-- Not auto-filed (stays Ordered until Mark arrived, migration B): a card
-- whose order was squared with quantity_shipped_manual (the BW64P shape,
-- 127 manual on AS032126BW), and a short-shipped order whose missing units
-- are written off as manual after the last check-in. Failing towards
-- "still on the board" is the safe direction: the incident was the
-- opposite.
--
-- Also widens the stage-event outcome CHECK with 'restore' (putting a
-- wrongly archived card back on the board), keeping every existing value.
--
-- LOCKING: the CLI applies this file in one transaction. CREATE OR REPLACE
-- only - owner, SECURITY DEFINER, search_path and grants of the three
-- replaced functions and the existing trigger (trg_pd_archive_on_arrival,
-- AFTER UPDATE OF quantity_received, FOR EACH ROW) are untouched; no
-- trigger DDL. _recompute_factory_order_status and rpc_close_freight_short
-- are the live bodies verbatim plus the hook at the end. Every call into
-- the evaluator (trigger, promote hook, close-short hook) sits in its own
-- exception block: a PD-board failure is written to audit_logs as
-- 'pd.arrival_eval_failed' and never blocks a check-in, a factory-order
-- status change or a close-short. lock_timeout
-- makes the brief constraint swap fail fast instead of queueing behind live
-- traffic.

SET LOCAL lock_timeout = '5s';

-- ------------------------------------------------------------
-- 1. Shared evaluator (internal: only callable by the SECURITY DEFINER
--    functions below; never exposed to anon/authenticated).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_pd_evaluate_arrival(
  p_sku_id      uuid,
  p_shipment_id uuid,
  p_line_id     uuid,
  p_via         text DEFAULT 'receipt')
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  p             mkt_pd_projects%ROWTYPE;
  l             freight_line_items%ROWTYPE;
  v_item_ids    uuid[];
  v_threshold   bigint;
  v_manual      bigint;
  v_received    bigint;
  v_lines       int;
  v_short       int;
  v_all_done    boolean;
  v_inbound     int;
  v_rule        text;
  v_archived    int := 0;
BEGIN
  IF p_sku_id IS NULL THEN RETURN 0; END IF;

  -- INBOUND: any line of this SKU, sourced or not, still short on a shipment
  -- that has not been receipt-confirmed. (In an AFTER trigger the line being
  -- received is already updated, so a partial carton counts as inbound.)
  SELECT count(*) INTO v_inbound
    FROM freight_line_items fl
    JOIN freight_shipments fs ON fs.id = fl.freight_shipment_id
   WHERE fl.sku_id = p_sku_id
     AND fl.quantity_received < fl.quantity
     AND fs.receipt_confirmed_at IS NULL;

  FOR p IN
    SELECT * FROM mkt_pd_projects
     WHERE linked_sku_id = p_sku_id
       AND stage = 'ordered'
       AND archived_at IS NULL
     ORDER BY created_at
     FOR UPDATE
  LOOP
    v_rule := NULL;
    v_threshold := NULL;
    v_received := NULL;

    IF p.linked_factory_order_id IS NOT NULL THEN
      -- A. measure against the factory order (and its child orders)
      SELECT array_agg(i.id),
             COALESCE(SUM(GREATEST(i.quantity_ordered - COALESCE(i.quantity_consumed_by_parent, 0), 0)), 0),
             COALESCE(SUM(COALESCE(i.quantity_shipped_manual, 0)), 0),
             COALESCE(bool_and(fo.status <> 'canceled'
                               AND (fo.status = 'shipped' OR public._factory_order_fully_shipped(fo.id))), false)
        INTO v_item_ids, v_threshold, v_manual, v_all_done
        FROM factory_order_items i
        JOIN factory_orders fo ON fo.id = i.factory_order_id
       WHERE i.sku_id = p_sku_id
         AND (fo.id = p.linked_factory_order_id
              OR fo.parent_factory_order_id = p.linked_factory_order_id);

      IF v_item_ids IS NULL THEN
        CONTINUE;  -- order has no line for this SKU: nothing to measure
      END IF;

      SELECT COALESCE(SUM(fl.quantity_received), 0),
             count(*),
             count(*) FILTER (WHERE fl.quantity_received < fl.quantity)
        INTO v_received, v_lines, v_short
        FROM freight_line_items fl
       WHERE fl.source_factory_order_item_id = ANY (v_item_ids);

      IF v_threshold > 0 AND v_received >= v_threshold THEN
        v_rule := 'fully_landed';
      ELSIF v_all_done AND v_manual = 0 AND v_lines > 0 AND v_short = 0 AND v_inbound = 0 THEN
        v_rule := 'factory_done_all_received';
      END IF;
    ELSE
      -- B. no factory order: only on a receipt, only a complete line, with
      --    nothing else inbound.
      IF p_line_id IS NOT NULL THEN
        SELECT * INTO l FROM freight_line_items WHERE id = p_line_id;
        IF FOUND AND l.sku_id = p_sku_id
           AND l.quantity_received >= l.quantity
           AND v_inbound = 0 THEN
          v_rule := 'no_order_line_complete';
        END IF;
      END IF;
    END IF;

    IF v_rule IS NULL THEN CONTINUE; END IF;

    -- Only the archive columns: launch link / dates / override stay as they are.
    UPDATE mkt_pd_projects
       SET archived_at = now(), archive_reason = 'arrived'
     WHERE id = p.id;

    INSERT INTO mkt_pd_stage_events (project_id, from_stage, to_stage, outcome, reason, decided_by, meta)
    VALUES (p.id, 'ordered', NULL, 'archive', 'arrived',
            COALESCE(auth.uid(), '00000000-0000-0000-0000-000000000001'::uuid),
            jsonb_strip_nulls(jsonb_build_object(
              'auto', 'arrival',
              'via', p_via,
              'freight_line_id', p_line_id,
              'freight_shipment_id', p_shipment_id,
              'factory_order_id', p.linked_factory_order_id,
              'rule', v_rule,
              'received', v_received,
              'threshold', v_threshold)));
    v_archived := v_archived + 1;
  END LOOP;

  RETURN v_archived;
END $$;

REVOKE ALL ON FUNCTION public.fn_pd_evaluate_arrival(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 2. Receipt trigger: thin wrapper (trigger definition untouched).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_pd_archive_on_arrival()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.sku_id IS NULL THEN RETURN NEW; END IF;
  IF COALESCE(NEW.quantity_received, 0) <= COALESCE(OLD.quantity_received, 0) THEN RETURN NEW; END IF;

  -- Isolated: a PD-board failure is logged and never blocks a check-in.
  BEGIN
    PERFORM public.fn_pd_evaluate_arrival(NEW.sku_id, NEW.freight_shipment_id, NEW.id, 'receipt');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO audit_logs (actor_id, action, target_table, target_id, details)
    VALUES (COALESCE(auth.uid(), '00000000-0000-0000-0000-000000000001'::uuid),
            'pd.arrival_eval_failed', 'freight_line_items', NEW.id,
            jsonb_build_object('sku_id', NEW.sku_id, 'via', 'receipt', 'error', SQLERRM));
  END;
  RETURN NEW;
END $$;

-- ------------------------------------------------------------
-- 3. Factory order promote hook (live body verbatim + hook).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._recompute_factory_order_status(p_order_id uuid, p_actor uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_status       text;
  v_missing_cost int;
  v_sku          uuid;
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

  -- PD board: the order is done, so a card whose units all landed earlier
  -- (nothing raised quantity_received since) can now be filed as arrived.
  -- Isolated: a PD-board failure never undoes the status change above.
  FOR v_sku IN
    SELECT DISTINCT sku_id FROM factory_order_items
     WHERE factory_order_id = p_order_id AND sku_id IS NOT NULL
  LOOP
    BEGIN
      PERFORM public.fn_pd_evaluate_arrival(v_sku, NULL, NULL, 'factory_order_shipped');
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO audit_logs (actor_id, action, target_table, target_id, details)
      VALUES (p_actor, 'pd.arrival_eval_failed', 'factory_orders', p_order_id,
              jsonb_build_object('sku_id', v_sku, 'via', 'factory_order_shipped', 'error', SQLERRM));
    END;
  END LOOP;
END;
$function$;

-- ------------------------------------------------------------
-- 4. Close-short hook (live body verbatim + hook).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_close_freight_short(p_shipment_id uuid, p_reason text, p_actor_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_shipment freight_shipments%ROWTYPE;
  v_caller text;
  v_li RECORD;
  v_short int;
  v_short_total int := 0;
  v_variances int := 0;
  v_fo uuid;
  v_fo_status text;
  v_reopened int := 0;
  v_affected_fos uuid[] := '{}';
  v_skus uuid[] := '{}';
  v_sku uuid;
BEGIN
  SELECT role INTO v_caller FROM profiles WHERE id = p_actor_id AND is_active;
  IF v_caller IS NULL OR v_caller NOT IN ('admin','manager') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'admin_or_manager_required');
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'reason_required');
  END IF;

  SELECT * INTO v_shipment FROM freight_shipments WHERE id = p_shipment_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'shipment_not_found');
  END IF;
  IF v_shipment.receipt_confirmed_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'already_confirmed');
  END IF;

  FOR v_li IN
    SELECT * FROM freight_line_items
    WHERE freight_shipment_id = p_shipment_id AND sku_id IS NOT NULL
    ORDER BY created_at
  LOOP
    v_short := v_li.quantity - v_li.quantity_received;
    IF v_short <= 0 THEN CONTINUE; END IF;
    v_short_total := v_short_total + v_short;
    IF NOT (v_li.sku_id = ANY(v_skus)) THEN
      v_skus := v_skus || v_li.sku_id;
    END IF;

    IF v_li.source_factory_order_item_id IS NOT NULL THEN
      SELECT factory_order_id INTO v_fo FROM factory_order_items WHERE id = v_li.source_factory_order_item_id;
      IF v_fo IS NOT NULL AND NOT (v_fo = ANY(v_affected_fos)) THEN
        v_affected_fos := v_affected_fos || v_fo;
      END IF;
    END IF;

    -- Formal shortage record when the shipment has a portal supplier;
    -- always an audit log either way.
    IF v_shipment.origin_supplier_id IS NOT NULL THEN
      INSERT INTO shipment_variances (
        freight_line_item_id, shipment_id, sku_id, origin_supplier_id,
        declared_quantity, received_quantity, variance_quantity,
        variance_type, status, notes, created_by
      ) VALUES (
        v_li.id, p_shipment_id, v_li.sku_id, v_shipment.origin_supplier_id,
        v_li.quantity, v_li.quantity_received, v_short,
        'shortage', 'open',
        format('Closed short: %s — %s of %s units never arrived', p_reason, v_short, v_li.quantity),
        p_actor_id
      );
      v_variances := v_variances + 1;
    END IF;

    INSERT INTO audit_logs (actor_id, action, target_table, target_id, details)
    VALUES (p_actor_id, 'freight.closed_short_line', 'freight_line_items', v_li.id,
            jsonb_build_object('shipment', v_shipment.shipment_number, 'sku_id', v_li.sku_id,
                               'declared', v_li.quantity, 'received', v_li.quantity_received,
                               'short', v_short, 'reason', p_reason));

    -- Shrink the line to what physically arrived so on-order netting
    -- automatically restores the missing units. Fully-missing lines are
    -- deleted (quantity CHECK > 0); trg_freight_line_recompute_fo fires
    -- and keeps FO consumption math in sync.
    IF v_li.quantity_received = 0 THEN
      DELETE FROM freight_line_items WHERE id = v_li.id;
    ELSE
      UPDATE freight_line_items
         SET quantity = quantity_received,
             quantity_prefilled = LEAST(COALESCE(quantity_prefilled,0), quantity_received)
       WHERE id = v_li.id;
    END IF;
  END LOOP;

  -- Reopen factory orders that auto-completed on the now-reduced coverage.
  FOREACH v_fo IN ARRAY v_affected_fos LOOP
    SELECT status INTO v_fo_status FROM factory_orders WHERE id = v_fo;
    IF v_fo_status = 'shipped' AND NOT _factory_order_fully_shipped(v_fo) THEN
      UPDATE factory_orders SET status = 'in_production', shipped_at = NULL WHERE id = v_fo;
      INSERT INTO audit_logs (actor_id, action, target_table, target_id, details)
      VALUES (p_actor_id, 'factory_order.reopened_short_shipment', 'factory_orders', v_fo,
              jsonb_build_object('from', 'shipped', 'to', 'in_production',
                                 'reason', format('shipment %s closed short', v_shipment.shipment_number)));
      v_reopened := v_reopened + 1;
    END IF;
  END LOOP;

  UPDATE freight_shipments
     SET status = 'delivered',
         actual_arrival_date = COALESCE(actual_arrival_date, CURRENT_DATE),
         receipt_confirmed_at = now(),
         receipt_confirmed_by = p_actor_id,
         closed_short_at = now(),
         closed_short_reason = trim(p_reason)
   WHERE id = p_shipment_id;

  -- PD board: this shipment is no longer inbound and no receipt fired for the
  -- shrunk lines, so re-evaluate their SKUs. Isolated: a PD-board failure
  -- never undoes the close-short.
  FOREACH v_sku IN ARRAY v_skus LOOP
    BEGIN
      PERFORM public.fn_pd_evaluate_arrival(v_sku, p_shipment_id, NULL, 'close_short');
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO audit_logs (actor_id, action, target_table, target_id, details)
      VALUES (p_actor_id, 'pd.arrival_eval_failed', 'freight_shipments', p_shipment_id,
              jsonb_build_object('sku_id', v_sku, 'via', 'close_short', 'error', SQLERRM));
    END;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'units_short', v_short_total,
                            'variances_created', v_variances, 'factory_orders_reopened', v_reopened);
END;
$function$;

-- ------------------------------------------------------------
-- 5. Outcome vocabulary: every existing value + 'restore'.
-- ------------------------------------------------------------
ALTER TABLE public.mkt_pd_stage_events DROP CONSTRAINT IF EXISTS mkt_pd_stage_events_outcome_check;
ALTER TABLE public.mkt_pd_stage_events ADD CONSTRAINT mkt_pd_stage_events_outcome_check
  CHECK (outcome = ANY (ARRAY['advance'::text, 'recycle'::text, 'kill'::text, 'revive'::text,
                              'archive'::text, 'link_fo'::text, 'launch_moved'::text, 'restore'::text]));
