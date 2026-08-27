-- =============================================================
-- PD board: archive the Ordered card when its product arrives
-- =============================================================
-- Owner decision 2026-08-27: an Ordered card's job ends when the goods
-- physically land — archive it so the Ordered lane doesn't accumulate.
-- "Arrived" = the first checked-in units of the card's promoted SKU
-- (rpc_record_freight_receipt increments freight_line_items.quantity_received;
-- that is the canonical arrival signal under carton-native receiving).
--
-- Restocks can't re-match: only stage='ordered' cards archive, once.
-- The card and its full history stay queryable (archived_at filter);
-- the future outcomes block reads it by id. SECURITY DEFINER because
-- receiving runs as admin/manager, who can write mkt_* anyway — but the
-- archive must not depend on the actor.

CREATE OR REPLACE FUNCTION public.fn_pd_archive_on_arrival()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  p mkt_pd_projects%ROWTYPE;
BEGIN
  IF NEW.sku_id IS NULL THEN RETURN NEW; END IF;
  IF COALESCE(NEW.quantity_received, 0) <= COALESCE(OLD.quantity_received, 0) THEN RETURN NEW; END IF;

  SELECT * INTO p FROM mkt_pd_projects
   WHERE linked_sku_id = NEW.sku_id
     AND stage = 'ordered'
     AND archived_at IS NULL
   ORDER BY created_at
   LIMIT 1
   FOR UPDATE;
  IF NOT FOUND THEN RETURN NEW; END IF;

  UPDATE mkt_pd_projects
     SET archived_at = now(), archive_reason = 'arrived'
   WHERE id = p.id;

  INSERT INTO mkt_pd_stage_events (project_id, from_stage, to_stage, outcome, reason, decided_by, meta)
  VALUES (p.id, 'ordered', NULL, 'archive', 'arrived',
          COALESCE(auth.uid(), '00000000-0000-0000-0000-000000000001'::uuid),
          jsonb_build_object('auto', 'arrival', 'freight_line_id', NEW.id,
                             'freight_shipment_id', NEW.freight_shipment_id));
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_pd_archive_on_arrival ON public.freight_line_items;
CREATE TRIGGER trg_pd_archive_on_arrival
AFTER UPDATE OF quantity_received ON public.freight_line_items
FOR EACH ROW EXECUTE FUNCTION public.fn_pd_archive_on_arrival();
