-- =============================================================
-- PD board: auto-detect Ordered from the first factory-order line
-- =============================================================
-- Phase-1 shipped the manual link (rpc_pd_link_factory_order); the locked
-- design (§2.4.1) always intended Ordered to be DETECTED from the first
-- factory_order_items line on the card's promoted SKU. Built 2026-08-27
-- when the first real product (S04-BW20DNA / AS082726BW) hit the gap.
--
-- On a new order line: the one non-archived Ready-for-Confirmation card
-- whose promoted SKU matches and has no order yet gets linked + moved to
-- Ordered, freezing the same "promise" snapshot the manual RPC writes.
-- Cards already in Ordered (linked) never re-match, so restock POs on the
-- same SKU are ignored. SECURITY DEFINER: supplier-portal creates can't
-- write mkt_* tables. decided_by = the inserting session's user (may be
-- a supplier — the true actor), falling back to the system user.

CREATE OR REPLACE FUNCTION public.fn_pd_detect_order()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  p mkt_pd_projects%ROWTYPE;
BEGIN
  SELECT * INTO p FROM mkt_pd_projects
   WHERE linked_sku_id = NEW.sku_id
     AND linked_factory_order_id IS NULL
     AND archived_at IS NULL
     AND stage = 'ready_for_confirmation'
   ORDER BY created_at
   LIMIT 1
   FOR UPDATE;
  IF NOT FOUND THEN RETURN NEW; END IF;

  UPDATE mkt_pd_projects
     SET linked_factory_order_id = NEW.factory_order_id,
         stage = 'ordered', stage_entered_at = now(), ordered_at = now(), sort_index = 0,
         promise = jsonb_build_object(
           'target_launch_date', p.target_launch_date,
           'msrp', p.msrp, 'quoted_unit_cost', p.quoted_unit_cost,
           'moq_qty', p.moq_qty, 'ordered_at', now())
   WHERE id = p.id;

  INSERT INTO mkt_pd_stage_events (project_id, from_stage, to_stage, outcome, decided_by, meta)
  VALUES (p.id, p.stage, 'ordered', 'link_fo',
          COALESCE(auth.uid(), '00000000-0000-0000-0000-000000000001'::uuid),
          jsonb_build_object('factory_order_id', NEW.factory_order_id, 'auto', 'factory_order_line'));
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_pd_detect_order ON public.factory_order_items;
CREATE TRIGGER trg_pd_detect_order
AFTER INSERT ON public.factory_order_items
FOR EACH ROW EXECUTE FUNCTION public.fn_pd_detect_order();

-- Backfill: cards whose SKU was ordered before this trigger existed
-- (S04-BW20DNA / AS082726BW). Same writes, earliest non-canceled order.
DO $$
DECLARE
  p  mkt_pd_projects%ROWTYPE;
  fo record;
BEGIN
  FOR p IN
    SELECT * FROM mkt_pd_projects
     WHERE linked_sku_id IS NOT NULL AND linked_factory_order_id IS NULL
       AND archived_at IS NULL AND stage = 'ready_for_confirmation'
  LOOP
    SELECT o.id, foi.created_at INTO fo
      FROM factory_order_items foi
      JOIN factory_orders o ON o.id = foi.factory_order_id
     WHERE foi.sku_id = p.linked_sku_id AND o.status <> 'canceled'
     ORDER BY foi.created_at LIMIT 1;
    IF fo.id IS NULL THEN CONTINUE; END IF;

    UPDATE mkt_pd_projects
       SET linked_factory_order_id = fo.id,
           stage = 'ordered', stage_entered_at = now(), ordered_at = fo.created_at, sort_index = 0,
           promise = jsonb_build_object(
             'target_launch_date', p.target_launch_date,
             'msrp', p.msrp, 'quoted_unit_cost', p.quoted_unit_cost,
             'moq_qty', p.moq_qty, 'ordered_at', fo.created_at)
     WHERE id = p.id;

    INSERT INTO mkt_pd_stage_events (project_id, from_stage, to_stage, outcome, decided_by, meta)
    VALUES (p.id, p.stage, 'ordered', 'link_fo',
            '00000000-0000-0000-0000-000000000001'::uuid,
            jsonb_build_object('factory_order_id', fo.id, 'auto', 'factory_order_line', 'backfilled', true));
  END LOOP;
END $$;
