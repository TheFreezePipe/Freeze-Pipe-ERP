-- =============================================================
-- Migration: Next carton (FIFO) and the carton passport (Phase 1, slice 6)
-- =============================================================
-- Design: docs/design/WAREHOUSE_MODULE_PHASE0_1.md §5.8 (owner decisions
-- 2026-10-28); docs/design/INVENTORY_MODULE_IA.md (passport row: a page
-- at /inventory/cartons/:code, not a navigation item).
--
-- Finding: the line pulls whichever carton is nearest, so an older
-- factory order can sit behind a newer one for months, and nothing tells
-- the floor which carton should go next. The batch of a carton (its
-- factory order) is only reachable through the shipment's lines, and no
-- page shows one carton's whole life from factory order to the line.
-- Decision:
--   * freight_carton_groups.factory_order_item_id (nullable, ON DELETE
--     SET NULL). _wh_resolve_group_fo_item(group): the group's single
--     SKU, and exactly one line of that SKU on the group's shipment
--     carrying a source_factory_order_item_id; anything else (two SKUs,
--     two lines of the SKU, a line without a source) is NULL. An AFTER
--     INSERT trigger on freight_carton_group_skus stamps the group while
--     the column is NULL; when an insert makes the group mixed it clears
--     the stamp (a mixed carton has no single batch). Backfilled once.
--   * _wh_next_carton(sku) → NextCarton jsonb or NULL. Candidates: the
--     SKU's own cartons (mixed cartons have sku_id NULL), sealed or open,
--     holding raw or prefilled_raw units at their location, not at
--     MFG-LINE and not at a virtual or station location (a carton booked
--     to UNLOCATED cannot be found, so it is not suggested). Order: open
--     first; then factory_orders.order_date (unresolved cartons last);
--     then the shipment's actual_arrival_date; then check-in
--     (wh_containers.created_at); then pick_sequence and code. reason is
--     open_carton | oldest_batch | oldest_received (the fallback: no
--     factory order date). rpc_wh_next_cartons(sku_ids[]) (internal,
--     up to 200 ids, unknown ids → null).
--   * rpc_wh_take_to_line gains p_fifo_override text DEFAULT NULL (the
--     3-argument function is dropped first so PostgREST sees one
--     signature; same grants). After the existing checks: an override
--     other than buried | damaged | closer | other (case-insensitive) is
--     invalid_override. FIFO applies to a single-SKU carton holding raw
--     or prefilled_raw units; when the suggestion is another carton and no
--     override is given it returns fifo_suggests with {suggested,
--     scanned} and changes nothing ("<scanned> is newer; <suggested> in
--     <location> is older.", or "... is sealed; ... is already open." when
--     the open-carton rule picked it). With an override it proceeds as
--     before and writes one wh_fifo_deviations row. The success result
--     gains fifo {followed, suggested_code, override}.
--   * wh_fifo_deviations: append-only log (block_wh_mutation), internal
--     read, writes only through the RPC.
--   * rpc_wh_fifo_compliance(p_days 1-3650, default 30), admin/manager:
--     pulls = take-to-line movement groups (type move into MFG-LINE with
--     the carton travelling, raw or prefilled_raw, single-SKU carton) in
--     the window; deviations by reason in the window; followed = pulls −
--     deviations.
--   * rpc_wh_carton_passport(code), internal, STABLE: case-insensitive
--     code (a scanned '%' or '%Z' prefix is ignored). The batch resolves
--     through the carton, else its nearest ancestor with a carton group
--     or shipment (RTS children inherit their parent's batch). Batch
--     cartons are those of every group stamped with the same factory
--     order item, else of the carton's group, else the carton alone;
--     siblings exclude the carton and its ancestors. summary counts
--     cartons (received and short from the groups' plan, short only
--     once the shipment has landed; finished = relabelled or emptied at
--     the line) and broken_units = the item's quantity_breakage. The
--     timeline adds ancestors' movements and tasks to a child's (detail
--     names the ancestor), uses the carton's own receipt when it has one
--     (else the group's), skips `receive` movements when a receipt is
--     shown, and orders ties by source (batch, receipt, movements by seq,
--     tasks, labels, counts) because one RPC writes its rows at one now().
--     legs are days to one decimal (dock to shelf in whole minutes) from
--     the timeline: order date, first 'finished' status, ship date,
--     arrival, check-in, the first putaway before the line, the first
--     pull, the first relabel after it.
--   * Indexes: wh_inventory_movements (from_container_id) and
--     (to_container_id), wh_count_lines (container_id), wh_moves
--     (container_id), wh_print_jobs GIN (item_ids),
--     freight_carton_groups (factory_order_item_id).
--
-- Smoke after deploy (a validation envelope passes; a relation error fails):
--   SELECT public._wh_resolve_group_fo_item(gen_random_uuid());                          -- null
--   SELECT public._wh_next_carton(gen_random_uuid());                                    -- null
--   SELECT public.rpc_wh_next_cartons(ARRAY[gen_random_uuid()]);                         -- {ok:true, next:{<id>: null}}
--   SELECT public.rpc_wh_next_cartons((SELECT array_agg(id) FROM public.product_skus));  -- {ok:false, error:'too_many'} once there are > 200 SKUs
--   SELECT public.rpc_wh_take_to_line(gen_random_uuid());                                -- {ok:false, error:'container_not_found'}
--   SELECT public.rpc_wh_take_to_line(gen_random_uuid(), NULL, NULL, 'buried');          -- {ok:false, error:'container_not_found'}
--   SELECT public.rpc_wh_fifo_compliance(0);                                             -- {ok:false, error:'invalid_days'}
--   SELECT public.rpc_wh_fifo_compliance();                                              -- {ok:true, pulls, followed, deviations}
--   SELECT public.rpc_wh_carton_passport('C-NOPE-0');                                    -- {ok:false, error:'carton_not_found'}
--   SELECT public.rpc_wh_carton_passport((SELECT lower(code) FROM public.wh_containers LIMIT 1));  -- {ok:true, carton, batch, timeline, legs}
--   SELECT count(*) FROM pg_proc WHERE proname = 'rpc_wh_take_to_line';                   -- 1
--   SELECT count(*) FROM public.freight_carton_groups WHERE factory_order_item_id IS NOT NULL;  -- the backfill
-- =============================================================

BEGIN;

-- -------------------------------------------------------------
-- A. The carton group carries its batch
-- -------------------------------------------------------------
ALTER TABLE public.freight_carton_groups
  ADD COLUMN IF NOT EXISTS factory_order_item_id uuid NULL REFERENCES public.factory_order_items(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS freight_carton_groups_fo_item_idx
  ON public.freight_carton_groups (factory_order_item_id) WHERE factory_order_item_id IS NOT NULL;
COMMENT ON COLUMN public.freight_carton_groups.factory_order_item_id IS
  'The factory order item the group''s cartons came from: stamped by trg_wh_stamp_carton_group when the group has one SKU and the shipment has exactly one line of it with a source; NULL when ambiguous (FIFO then falls back to check-in date).';

CREATE OR REPLACE FUNCTION public._wh_resolve_group_fo_item(p_group_id uuid)
RETURNS uuid
LANGUAGE sql STABLE
SET search_path = public
AS $$
  WITH g AS (
    SELECT g.freight_shipment_id, (array_agg(DISTINCT s.sku_id))[1] AS sku_id, count(DISTINCT s.sku_id) AS n
      FROM public.freight_carton_groups g
      JOIN public.freight_carton_group_skus s ON s.carton_group_id = g.id
     WHERE g.id = p_group_id
     GROUP BY g.freight_shipment_id
  ), li AS (
    SELECT li.source_factory_order_item_id AS foi
      FROM g
      JOIN public.freight_line_items li ON li.freight_shipment_id = g.freight_shipment_id AND li.sku_id = g.sku_id
     WHERE g.n = 1
  )
  SELECT CASE WHEN count(*) = 1 AND count(foi) = 1 THEN (array_agg(foi))[1] END FROM li;
$$;

CREATE OR REPLACE FUNCTION public.trg_wh_stamp_carton_group()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_foi uuid;
BEGIN
  v_foi := public._wh_resolve_group_fo_item(NEW.carton_group_id);
  IF v_foi IS NOT NULL THEN
    UPDATE public.freight_carton_groups SET factory_order_item_id = v_foi
     WHERE id = NEW.carton_group_id AND factory_order_item_id IS NULL;
  ELSIF (SELECT count(DISTINCT sku_id) FROM public.freight_carton_group_skus
          WHERE carton_group_id = NEW.carton_group_id) > 1 THEN
    -- a second SKU makes the group mixed: its cartons have no single batch
    UPDATE public.freight_carton_groups SET factory_order_item_id = NULL
     WHERE id = NEW.carton_group_id AND factory_order_item_id IS NOT NULL;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_wh_stamp_carton_group ON public.freight_carton_group_skus;
CREATE TRIGGER trg_wh_stamp_carton_group
  AFTER INSERT ON public.freight_carton_group_skus
  FOR EACH ROW EXECUTE FUNCTION public.trg_wh_stamp_carton_group();

-- one-time backfill
UPDATE public.freight_carton_groups g
   SET factory_order_item_id = r.foi
  FROM (SELECT id, public._wh_resolve_group_fo_item(id) AS foi FROM public.freight_carton_groups) r
 WHERE r.id = g.id AND g.factory_order_item_id IS NULL AND r.foi IS NOT NULL;

-- -------------------------------------------------------------
-- B. Indexes for the passport and FIFO reads
-- -------------------------------------------------------------
CREATE INDEX IF NOT EXISTS wh_movements_from_container_idx ON public.wh_inventory_movements (from_container_id);
CREATE INDEX IF NOT EXISTS wh_movements_to_container_idx ON public.wh_inventory_movements (to_container_id);
CREATE INDEX IF NOT EXISTS wh_count_lines_container_idx ON public.wh_count_lines (container_id);
CREATE INDEX IF NOT EXISTS wh_moves_container_idx ON public.wh_moves (container_id);
CREATE INDEX IF NOT EXISTS wh_print_jobs_item_ids_gin ON public.wh_print_jobs USING gin (item_ids);

-- -------------------------------------------------------------
-- C. Next carton (FIFO)
-- -------------------------------------------------------------
-- One carton in the NextCarton shape (reason as given; qty and bucket are
-- its raw / prefilled_raw units at its location).
CREATE OR REPLACE FUNCTION public._wh_fifo_carton_json(p_container_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
           'container_id', c.id, 'code', c.code, 'state', c.state,
           'qty', COALESCE(rb.qty, 0), 'bucket', rb.bucket,
           'location_id', c.location_id, 'location_code', l.code,
           'factory_order_id', fo.id, 'factory_order_number', fo.order_number, 'order_date', fo.order_date,
           'shipment_id', fs.id, 'shipment_number', fs.shipment_number,
           'received_at', COALESCE(fr.received_at, c.created_at),
           'reason', p_reason)
    FROM public.wh_containers c
    LEFT JOIN public.wh_locations l ON l.id = c.location_id
    LEFT JOIN public.freight_carton_groups g ON g.id = c.carton_group_id
    LEFT JOIN public.factory_order_items foi ON foi.id = g.factory_order_item_id
    LEFT JOIN public.factory_orders fo ON fo.id = foi.factory_order_id
    LEFT JOIN public.freight_shipments fs ON fs.id = COALESCE(c.freight_shipment_id, g.freight_shipment_id)
    LEFT JOIN public.freight_receipts fr ON fr.id = c.freight_receipt_id
    LEFT JOIN LATERAL (
      SELECT sum(b.on_hand)::int AS qty,
             (array_agg(b.bucket ORDER BY b.on_hand DESC, b.bucket))[1] AS bucket
        FROM public.wh_inventory_balances b
       WHERE b.container_id = c.id AND b.location_id = c.location_id
         AND b.bucket IN ('raw', 'prefilled_raw') AND b.on_hand > 0) rb ON true
   WHERE c.id = p_container_id;
$$;

CREATE OR REPLACE FUNCTION public._wh_next_carton(p_sku_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT public._wh_fifo_carton_json(x.id,
           CASE WHEN x.state = 'open' THEN 'open_carton'
                WHEN x.order_date IS NOT NULL THEN 'oldest_batch'
                ELSE 'oldest_received' END)
    FROM (
      SELECT c.id, c.state, fo.order_date
        FROM public.wh_containers c
        JOIN public.wh_locations l ON l.id = c.location_id
        LEFT JOIN public.freight_carton_groups g ON g.id = c.carton_group_id
        LEFT JOIN public.factory_order_items foi ON foi.id = g.factory_order_item_id
        LEFT JOIN public.factory_orders fo ON fo.id = foi.factory_order_id
        LEFT JOIN public.freight_shipments fs ON fs.id = COALESCE(c.freight_shipment_id, g.freight_shipment_id)
       WHERE c.sku_id = p_sku_id
         AND c.state IN ('sealed', 'open')
         AND l.id IS DISTINCT FROM (SELECT public._wh_loc_id('MFG-LINE'))
         AND l.kind NOT IN ('virtual', 'station')
         AND EXISTS (SELECT 1 FROM public.wh_inventory_balances b
                      WHERE b.container_id = c.id AND b.location_id = c.location_id
                        AND b.bucket IN ('raw', 'prefilled_raw') AND b.on_hand > 0)
       ORDER BY (c.state = 'open') DESC,
                fo.order_date ASC NULLS LAST,
                fs.actual_arrival_date ASC NULLS LAST,
                c.created_at ASC,
                l.pick_sequence ASC NULLS LAST,
                l.code, c.code
       LIMIT 1) x;
$$;

CREATE OR REPLACE FUNCTION public.rpc_wh_next_cartons(p_sku_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_next jsonb;
BEGIN
  IF public._wh_require_role(ARRAY['admin', 'manager', 'user']) IS NULL THEN
    RETURN public._wh_err('forbidden', 'The next carton needs an internal account.');
  END IF;
  IF COALESCE(cardinality(p_sku_ids), 0) > 200 THEN
    RETURN public._wh_err('too_many', 'Ask for at most 200 SKUs at a time.');
  END IF;
  SELECT COALESCE(jsonb_object_agg(s.id::text, public._wh_next_carton(s.id)), '{}'::jsonb)
    INTO v_next
    FROM (SELECT DISTINCT u.id FROM unnest(COALESCE(p_sku_ids, '{}'::uuid[])) AS u(id) WHERE u.id IS NOT NULL) s;
  RETURN jsonb_build_object('ok', true, 'next', v_next);
END;
$$;

-- -------------------------------------------------------------
-- D. wh_fifo_deviations
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.wh_fifo_deviations (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku_id                  uuid NOT NULL REFERENCES public.product_skus(id),
  container_id            uuid NOT NULL REFERENCES public.wh_containers(id),
  suggested_container_id  uuid REFERENCES public.wh_containers(id),
  reason                  text NOT NULL,
  actor_id                uuid REFERENCES public.profiles(id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_wh_fifo_deviations_reason CHECK (reason IN ('buried', 'damaged', 'closer', 'other'))
);

CREATE INDEX IF NOT EXISTS wh_fifo_deviations_created_idx ON public.wh_fifo_deviations (created_at);
CREATE INDEX IF NOT EXISTS wh_fifo_deviations_container_idx ON public.wh_fifo_deviations (container_id);

DROP TRIGGER IF EXISTS trg_block_wh_fifo_deviations_mutation ON public.wh_fifo_deviations;
CREATE TRIGGER trg_block_wh_fifo_deviations_mutation
  BEFORE UPDATE OR DELETE ON public.wh_fifo_deviations
  FOR EACH ROW EXECUTE FUNCTION public.block_wh_mutation();

ALTER TABLE public.wh_fifo_deviations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS wh_fifo_deviations_select_internal ON public.wh_fifo_deviations;
CREATE POLICY wh_fifo_deviations_select_internal ON public.wh_fifo_deviations
  FOR SELECT TO authenticated USING (public.jwt_is_internal());
REVOKE ALL ON TABLE public.wh_fifo_deviations FROM anon, authenticated;
GRANT SELECT ON TABLE public.wh_fifo_deviations TO authenticated;
GRANT ALL ON TABLE public.wh_fifo_deviations TO service_role;

-- -------------------------------------------------------------
-- E. rpc_wh_take_to_line with p_fifo_override
-- -------------------------------------------------------------
DROP FUNCTION IF EXISTS public.rpc_wh_take_to_line(uuid, uuid, uuid);

CREATE OR REPLACE FUNCTION public.rpc_wh_take_to_line(
  p_container_id uuid, p_client_event_id uuid DEFAULT NULL, p_actor_id uuid DEFAULT NULL,
  p_fifo_override text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor    uuid;
  v_rep      jsonb;
  v_ctr      public.wh_containers%ROWTYPE;
  v_mfg      uuid := public._wh_loc_id('MFG-LINE');
  v_from     uuid;
  v_group    uuid := gen_random_uuid();
  v_bal      record;
  v_first    boolean := true;
  v_units    integer := 0;
  v_override text := lower(btrim(p_fifo_override));
  v_sug      jsonb;
  v_sug_id   uuid;
  v_scanned  jsonb;
  v_deviate  boolean := false;
  v_res      jsonb;
BEGIN
  IF public._wh_require_role(ARRAY['admin', 'manager', 'user']) IS NULL THEN
    RETURN public._wh_err('forbidden', 'Taking cartons to the line needs an internal account.');
  END IF;
  v_actor := public._wh_actor(p_actor_id);
  v_rep := public._wh_event_replay(p_client_event_id, 'rpc_wh_take_to_line');
  IF v_rep IS NOT NULL THEN
    RETURN v_rep;
  END IF;
  IF v_mfg IS NULL THEN
    RETURN public._wh_err('mfg_line_missing', 'The MFG-LINE location is missing; an admin must restore it.');
  END IF;

  SELECT * INTO v_ctr FROM public.wh_containers WHERE id = p_container_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN public._wh_err('container_not_found', 'That carton does not exist.');
  END IF;
  IF v_ctr.state = 'void' THEN
    RETURN public._wh_err('container_void', v_ctr.code || ' was voided'
      || COALESCE(' and replaced by ' || (SELECT code FROM public.wh_containers WHERE id = v_ctr.superseded_by), '') || '.');
  END IF;
  IF v_ctr.state = 'empty' THEN
    RETURN public._wh_err('container_empty', v_ctr.code || ' is empty.');
  END IF;
  IF v_ctr.location_id = v_mfg THEN
    RETURN public._wh_err('already_at_line', v_ctr.code || ' is already at the manufacturing line.');
  END IF;
  IF p_fifo_override IS NOT NULL AND v_override NOT IN ('buried', 'damaged', 'closer', 'other') THEN
    RETURN public._wh_err('invalid_override', 'The reason for taking another carton is buried, damaged, closer or other.');
  END IF;

  -- FIFO is a suggestion, never a block (§5.8): a single-SKU raw carton
  -- that is not the suggested one needs a reason
  IF v_ctr.sku_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM public.wh_inventory_balances b
        WHERE b.container_id = v_ctr.id AND b.location_id = v_ctr.location_id
          AND b.bucket IN ('raw', 'prefilled_raw') AND b.on_hand > 0) THEN
    v_sug := public._wh_next_carton(v_ctr.sku_id);
    v_sug_id := (v_sug->>'container_id')::uuid;
  END IF;
  IF v_sug_id IS NOT NULL AND v_sug_id <> v_ctr.id THEN
    IF p_fifo_override IS NULL THEN
      v_scanned := public._wh_fifo_carton_json(v_ctr.id);
      RETURN public._wh_err('fifo_suggests',
        CASE WHEN v_sug->>'reason' = 'open_carton' AND v_ctr.state = 'sealed'
             THEN v_ctr.code || ' is sealed; ' || (v_sug->>'code') || ' in '
                  || COALESCE(v_sug->>'location_code', 'storage') || ' is already open.'
             ELSE v_ctr.code || ' is newer; ' || (v_sug->>'code') || ' in '
                  || COALESCE(v_sug->>'location_code', 'storage') || ' is older.' END,
        jsonb_build_object(
          'suggested', v_sug,
          'scanned', jsonb_build_object('code', v_ctr.code,
                                        'factory_order_number', v_scanned->'factory_order_number',
                                        'order_date', v_scanned->'order_date',
                                        'received_at', v_scanned->'received_at',
                                        'location_code', v_scanned->'location_code')));
    END IF;
    v_deviate := true;
  END IF;

  v_from := v_ctr.location_id;
  FOR v_bal IN
    SELECT * FROM public.wh_inventory_balances
     WHERE container_id = v_ctr.id AND location_id = v_from AND on_hand > 0
     ORDER BY id
  LOOP
    PERFORM public._wh_post_movement(v_group, 'move', v_bal.sku_id, v_bal.bucket, v_bal.on_hand,
                                     v_from, v_ctr.id, v_mfg, v_ctr.id, NULL, v_actor, NULL, NULL,
                                     'taken to the line', CASE WHEN v_first THEN p_client_event_id END);
    v_first := false;
    v_units := v_units + v_bal.on_hand;
  END LOOP;
  IF v_units = 0 THEN
    RETURN public._wh_err('container_empty', v_ctr.code || ' holds no stock.');
  END IF;

  -- a carton that goes straight to the line no longer needs its putaway
  UPDATE public.wh_moves SET status = 'cancelled', completed_by = v_actor, completed_at = now()
   WHERE container_id = v_ctr.id AND kind = 'putaway' AND status IN ('open', 'in_progress');

  IF v_deviate THEN
    INSERT INTO public.wh_fifo_deviations (sku_id, container_id, suggested_container_id, reason, actor_id)
    VALUES (v_ctr.sku_id, v_ctr.id, v_sug_id, v_override, v_actor);
  END IF;

  v_res := jsonb_build_object('ok', true, 'container', public._wh_ctr_json(v_ctr.id), 'from', public._wh_loc_json(v_from),
                              'units', v_units, 'movement_group_id', v_group,
                              'fifo', jsonb_build_object('followed', NOT v_deviate,
                                                         'suggested_code', v_sug->>'code',
                                                         'override', CASE WHEN v_deviate THEN v_override END));
  RETURN public._wh_event_store(p_client_event_id, 'rpc_wh_take_to_line', v_actor, v_res);
END;
$$;

-- -------------------------------------------------------------
-- F. rpc_wh_fifo_compliance
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_wh_fifo_compliance(p_days integer DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_since timestamptz;
  v_mfg   uuid := public._wh_loc_id('MFG-LINE');
  v_pulls integer;
  v_dev   jsonb;
  v_total integer;
BEGIN
  IF public._wh_require_role(ARRAY['admin', 'manager']) IS NULL THEN
    RETURN public._wh_err('forbidden', 'FIFO compliance needs an admin or a manager.');
  END IF;
  IF p_days IS NULL OR p_days < 1 OR p_days > 3650 THEN
    RETURN public._wh_err('invalid_days', 'The window is 1 to 3650 days.');
  END IF;
  v_since := now() - make_interval(days => p_days);

  SELECT count(DISTINCT m.movement_group_id)::int INTO v_pulls
    FROM public.wh_inventory_movements m
    JOIN public.wh_containers c ON c.id = m.to_container_id
   WHERE m.type = 'move' AND m.to_location_id = v_mfg AND m.created_at >= v_since
     AND m.from_container_id = m.to_container_id
     AND m.bucket IN ('raw', 'prefilled_raw') AND c.sku_id IS NOT NULL;

  SELECT jsonb_build_object('buried', count(*) FILTER (WHERE reason = 'buried'),
                            'damaged', count(*) FILTER (WHERE reason = 'damaged'),
                            'closer', count(*) FILTER (WHERE reason = 'closer'),
                            'other', count(*) FILTER (WHERE reason = 'other')),
         count(*)::int
    INTO v_dev, v_total
    FROM public.wh_fifo_deviations
   WHERE created_at >= v_since;

  RETURN jsonb_build_object('ok', true, 'days', p_days, 'since', v_since, 'pulls', v_pulls,
                            'followed', GREATEST(v_pulls - v_total, 0), 'deviations', v_dev);
END;
$$;

-- -------------------------------------------------------------
-- G. rpc_wh_carton_passport
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_wh_carton_passport(p_code text)
RETURNS jsonb
LANGUAGE plpgsql STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_code      text := upper(btrim(COALESCE(p_code, '')));
  v_mfg       uuid := public._wh_loc_id('MFG-LINE');
  v_ctr       public.wh_containers%ROWTYPE;
  v_src       public.wh_containers%ROWTYPE;
  v_chain     uuid[];
  v_children  uuid[];
  v_group     public.freight_carton_groups%ROWTYPE;
  v_foi       public.factory_order_items%ROWTYPE;
  v_fo        public.factory_orders%ROWTYPE;
  v_ship      public.freight_shipments%ROWTYPE;
  v_supplier  text;
  v_set       uuid[];
  v_groups    uuid[];
  v_receipt   boolean;
  v_carton    jsonb;
  v_batch     jsonb;
  v_summary   jsonb;
  v_siblings  jsonb;
  v_sib_total integer;
  v_timeline  jsonb;
  v_t_order   timestamptz;
  v_t_fin     timestamptz;
  v_t_ship    timestamptz;
  v_t_arr     timestamptz;
  v_t_in      timestamptz;
  v_t_shelf   timestamptz;
  v_t_line    timestamptz;
  v_t_rts     timestamptz;
BEGIN
  IF public._wh_require_role(ARRAY['admin', 'manager', 'user']) IS NULL THEN
    RETURN public._wh_err('forbidden', 'The carton passport needs an internal account.');
  END IF;
  -- a scanned label carries '%' (or '%Z' on practice labels)
  IF left(v_code, 2) = '%Z' THEN
    v_code := substr(v_code, 3);
  ELSIF left(v_code, 1) = '%' THEN
    v_code := substr(v_code, 2);
  END IF;
  SELECT * INTO v_ctr FROM public.wh_containers WHERE upper(code) = v_code;
  IF NOT FOUND THEN
    RETURN public._wh_err('carton_not_found', 'No carton has the code ' || COALESCE(NULLIF(btrim(p_code), ''), '(blank)') || '.');
  END IF;

  -- the carton and its ancestors, nearest first
  WITH RECURSIVE a(id, parent, depth) AS (
    SELECT c.id, c.parent_container_id, 0 FROM public.wh_containers c WHERE c.id = v_ctr.id
    UNION ALL
    SELECT c.id, c.parent_container_id, a.depth + 1
      FROM public.wh_containers c JOIN a ON c.id = a.parent
     WHERE a.depth < 10)
  SELECT array_agg(id ORDER BY depth) INTO v_chain FROM a;
  SELECT COALESCE(array_agg(id ORDER BY code), '{}') INTO v_children
    FROM public.wh_containers WHERE parent_container_id = v_ctr.id;

  -- the batch source: the nearest of them with a carton group or shipment, else the eldest
  SELECT c.* INTO v_src
    FROM unnest(v_chain) WITH ORDINALITY AS u(id, n)
    JOIN public.wh_containers c ON c.id = u.id
   ORDER BY (c.carton_group_id IS NOT NULL OR c.freight_shipment_id IS NOT NULL) DESC,
            CASE WHEN c.carton_group_id IS NOT NULL OR c.freight_shipment_id IS NOT NULL THEN u.n ELSE -u.n END
   LIMIT 1;
  IF v_src.carton_group_id IS NOT NULL THEN
    SELECT * INTO v_group FROM public.freight_carton_groups WHERE id = v_src.carton_group_id;
  END IF;
  IF v_group.factory_order_item_id IS NOT NULL THEN
    SELECT * INTO v_foi FROM public.factory_order_items WHERE id = v_group.factory_order_item_id;
    SELECT * INTO v_fo FROM public.factory_orders WHERE id = v_foi.factory_order_id;
    SELECT name INTO v_supplier FROM public.suppliers WHERE id = v_fo.supplier_id;
  END IF;
  IF COALESCE(v_src.freight_shipment_id, v_group.freight_shipment_id) IS NOT NULL THEN
    SELECT * INTO v_ship FROM public.freight_shipments WHERE id = COALESCE(v_src.freight_shipment_id, v_group.freight_shipment_id);
  END IF;

  -- the batch's cartons and groups
  IF v_foi.id IS NOT NULL THEN
    SELECT COALESCE(array_agg(id), '{}') INTO v_groups FROM public.freight_carton_groups WHERE factory_order_item_id = v_foi.id;
    SELECT COALESCE(array_agg(c.id), '{}') INTO v_set FROM public.wh_containers c WHERE c.carton_group_id = ANY (v_groups);
  ELSIF v_group.id IS NOT NULL THEN
    v_groups := ARRAY[v_group.id];
    SELECT COALESCE(array_agg(c.id), '{}') INTO v_set FROM public.wh_containers c WHERE c.carton_group_id = v_group.id;
  ELSE
    v_groups := '{}';
    v_set := ARRAY[v_src.id];
  END IF;

  -- ---- carton ----
  SELECT jsonb_build_object(
           'id', c.id, 'code', c.code, 'sku_id', c.sku_id, 'sku', ps.sku, 'product_name', ps.product_name,
           'state', c.state, 'qty', c.qty, 'qty_initial', c.qty_initial,
           'bucket', COALESCE(
             (SELECT b.bucket FROM public.wh_inventory_balances b
               WHERE b.container_id = c.id AND b.on_hand > 0
               GROUP BY b.bucket ORDER BY sum(b.on_hand) DESC, b.bucket LIMIT 1),
             (SELECT COALESCE(m.to_bucket, m.bucket) FROM public.wh_inventory_movements m
               WHERE m.to_container_id = c.id ORDER BY m.seq DESC LIMIT 1),
             (SELECT m.bucket FROM public.wh_inventory_movements m
               WHERE m.from_container_id = c.id ORDER BY m.seq DESC LIMIT 1)),
           'label_stock', c.label_stock, 'location_id', c.location_id, 'location_code', l.code,
           'created_at', c.created_at, 'opened_at', c.opened_at, 'finished_at', c.finished_at,
           'finished_by_name', (SELECT NULLIF(btrim(p.full_name), '') FROM public.profiles p WHERE p.id = c.finished_by),
           'parent', (SELECT jsonb_build_object('id', pc.id, 'code', pc.code, 'state', pc.state)
                        FROM public.wh_containers pc WHERE pc.id = c.parent_container_id),
           'children', (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', k.id, 'code', k.code, 'state', k.state,
                                                                      'qty', k.qty, 'location_code', kl.code)
                                                   ORDER BY k.code), '[]'::jsonb)
                          FROM public.wh_containers k LEFT JOIN public.wh_locations kl ON kl.id = k.location_id
                         WHERE k.parent_container_id = c.id),
           'superseded_by', (SELECT jsonb_build_object('id', sc.id, 'code', sc.code)
                               FROM public.wh_containers sc WHERE sc.id = c.superseded_by),
           'carton_seq', c.carton_seq,
           'carton_of', CASE WHEN c.freight_shipment_id IS NOT NULL THEN GREATEST(
                          COALESCE((SELECT sum(g4.carton_qty)::int FROM public.freight_carton_groups g4
                                     WHERE g4.freight_shipment_id = c.freight_shipment_id), 0),
                          (SELECT count(*)::int FROM public.wh_containers c4
                            WHERE c4.freight_shipment_id = c.freight_shipment_id AND c4.state <> 'void')) END)
    INTO v_carton
    FROM public.wh_containers c
    LEFT JOIN public.product_skus ps ON ps.id = c.sku_id
    LEFT JOIN public.wh_locations l ON l.id = c.location_id
   WHERE c.id = v_ctr.id;

  -- ---- batch ----
  SELECT jsonb_build_object(
           'cartons_received', CASE WHEN cardinality(v_groups) > 0
                                    THEN (SELECT COALESCE(sum(g.received_cartons), 0)::int FROM public.freight_carton_groups g WHERE g.id = ANY (v_groups))
                                    ELSE cardinality(v_set) END,
           'cartons_short', (SELECT COALESCE(sum(GREATEST(g.carton_qty - g.received_cartons, 0)), 0)::int
                               FROM public.freight_carton_groups g JOIN public.freight_shipments fs ON fs.id = g.freight_shipment_id
                              WHERE g.id = ANY (v_groups) AND (fs.actual_arrival_date IS NOT NULL OR fs.status = 'delivered')),
           'finished', count(*) FILTER (WHERE (c.state = 'void' AND c.superseded_by IS NOT NULL)
                                           OR (c.state = 'empty' AND c.location_id = v_mfg)),
           'raw_on_shelf', count(*) FILTER (WHERE c.state IN ('sealed', 'open') AND c.location_id IS DISTINCT FROM v_mfg
                                               AND EXISTS (SELECT 1 FROM public.wh_inventory_balances b
                                                            WHERE b.container_id = c.id AND b.location_id = c.location_id
                                                              AND b.bucket IN ('raw', 'prefilled_raw') AND b.on_hand > 0)),
           'at_the_line', count(*) FILTER (WHERE c.state IN ('sealed', 'open') AND c.location_id = v_mfg),
           'broken_units', COALESCE(v_foi.quantity_breakage, 0))
    INTO v_summary
    FROM public.wh_containers c
   WHERE c.id = ANY (v_set);

  SELECT count(*)::int INTO v_sib_total
    FROM public.wh_containers c WHERE c.id = ANY (v_set) AND NOT (c.id = ANY (v_chain));
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', s.id, 'code', s.code, 'state', s.state, 'qty', s.qty,
                                               'location_code', s.location_code, 'since', s.since)
                            ORDER BY s.created_at DESC, s.code DESC), '[]'::jsonb)
    INTO v_siblings
    FROM (SELECT c.id, c.code, c.state, c.qty, c.created_at, l.code AS location_code,
                 COALESCE((SELECT max(m.created_at) FROM public.wh_inventory_movements m
                            WHERE m.from_container_id = c.id OR m.to_container_id = c.id), c.created_at) AS since
            FROM public.wh_containers c
            LEFT JOIN public.wh_locations l ON l.id = c.location_id
           WHERE c.id = ANY (v_set) AND NOT (c.id = ANY (v_chain))
           ORDER BY c.created_at DESC, c.code DESC
           LIMIT 50) s;

  v_batch := jsonb_build_object(
    'factory_order', CASE WHEN v_fo.id IS NOT NULL THEN jsonb_build_object(
                       'id', v_fo.id, 'order_number', v_fo.order_number, 'supplier_name', v_supplier,
                       'order_date', v_fo.order_date, 'expected_completion', v_fo.expected_completion, 'status', v_fo.status) END,
    'item', CASE WHEN v_foi.id IS NOT NULL THEN jsonb_build_object(
              'quantity_ordered', v_foi.quantity_ordered, 'quantity_finished', v_foi.quantity_finished,
              'consolidator_confirmed_quantity', v_foi.consolidator_confirmed_quantity,
              'quantity_breakage', v_foi.quantity_breakage) END,
    'shipment', CASE WHEN v_ship.id IS NOT NULL THEN jsonb_build_object(
                  'id', v_ship.id, 'shipment_number', v_ship.shipment_number, 'ship_date', v_ship.ship_date,
                  'eta', v_ship.eta, 'actual_arrival_date', v_ship.actual_arrival_date, 'status', v_ship.status) END,
    'summary', v_summary,
    'siblings', v_siblings,
    'siblings_total', v_sib_total);

  -- ---- timeline ----
  -- the carton's own receipt when it has one, else the group's receipts
  v_receipt := v_src.freight_receipt_id IS NOT NULL
               OR (v_group.id IS NOT NULL AND EXISTS (SELECT 1 FROM public.freight_receipts fr
                                                       WHERE fr.freight_shipment_id = v_group.freight_shipment_id
                                                         AND fr.carton_group_id = v_group.id));
  WITH codes AS (
    SELECT c.id, c.code, c.parent_container_id, (c.id <> v_ctr.id) AS ancestor
      FROM public.wh_containers c WHERE c.id = ANY (v_chain)
  ), mv AS (
    -- one entry per movement group, type and direction for the carton (or an ancestor)
    SELECT m.movement_group_id, m.type, min(m.seq) AS seq, min(m.created_at) AS at, sum(m.qty)::int AS qty,
           m.from_location_id, m.to_location_id, m.from_container_id, m.to_container_id, m.actor_id,
           (array_agg(m.bucket ORDER BY m.seq))[1] AS bucket,
           (array_agg(COALESCE(m.to_bucket, m.bucket) ORDER BY m.seq))[1] AS to_bucket
      FROM public.wh_inventory_movements m
     WHERE m.from_container_id = ANY (v_chain) OR m.to_container_id = ANY (v_chain)
     GROUP BY m.movement_group_id, m.type, m.from_location_id, m.to_location_id, m.from_container_id, m.to_container_id, m.actor_id
  ), mv2 AS (
    SELECT mv.*, cc.code AS ctr_code, cc.ancestor, cc.parent_container_id AS ctr_parent,
           (mv.to_container_id = cc.id) AS inbound, (mv.from_container_id = cc.id AND mv.to_container_id = cc.id) AS travels,
           fl.code AS from_code, tl.code AS to_code
      FROM mv
      JOIN codes cc ON cc.id = COALESCE(CASE WHEN mv.to_container_id = ANY (v_chain) THEN mv.to_container_id END, mv.from_container_id)
      LEFT JOIN public.wh_locations fl ON fl.id = mv.from_location_id
      LEFT JOIN public.wh_locations tl ON tl.id = mv.to_location_id
  ), ev AS (
    -- batch: the factory order and its status changes
    SELECT v_fo.order_date::timestamptz AS at, 0 AS rk, 0::bigint AS sq, 'ordered' AS kind,
           'Ordered · ' || COALESCE(v_fo.order_number, 'factory order') AS title, v_supplier AS detail,
           NULL::text AS actor_name, 'order' AS mark
     WHERE v_fo.id IS NOT NULL AND v_fo.order_date IS NOT NULL
    UNION ALL
    SELECT a.created_at, 1, 0, 'factory',
           upper(left(COALESCE(a.details->>'to', 'canceled'), 1))
             || replace(substr(COALESCE(a.details->>'to', 'canceled'), 2), '_', ' '),
           concat_ws(' · ', 'Factory order ' || COALESCE(v_fo.order_number, ''),
                     CASE WHEN a.action LIKE 'factory_order.auto%' THEN 'set automatically' END),
           (SELECT NULLIF(btrim(p.full_name), '') FROM public.profiles p WHERE p.id = a.actor_id),
           CASE WHEN a.details->>'to' = 'finished' THEN 'finished' END
      FROM public.audit_logs a
     WHERE v_fo.id IS NOT NULL AND a.target_table = 'factory_orders' AND a.target_id = v_fo.id
       AND (a.details ? 'to' OR a.action = 'factory_order.cancel')
    -- batch: the shipment
    UNION ALL
    SELECT v_ship.ship_date::timestamptz, 2, 0, 'shipped', 'Shipped · ' || v_ship.shipment_number,
           concat_ws(' · ', CASE v_ship.freight_type WHEN 'sea' THEN 'Sea' WHEN 'air' THEN 'Air' ELSE v_ship.freight_type END,
                     v_ship.carrier_name), NULL, 'shipped'
     WHERE v_ship.id IS NOT NULL AND v_ship.ship_date IS NOT NULL
    UNION ALL
    SELECT COALESCE(v_ship.status_overridden_at, v_ship.updated_at), 3, 0, 'shipped', 'Cleared customs',
           v_ship.shipment_number, NULL, NULL
     WHERE v_ship.id IS NOT NULL AND v_ship.status = 'cleared_customs'
    UNION ALL
    SELECT v_ship.actual_arrival_date::timestamptz, 4, 0, 'delivered', 'Delivered', v_ship.shipment_number, NULL, 'arrived'
     WHERE v_ship.id IS NOT NULL AND v_ship.actual_arrival_date IS NOT NULL
    -- check-in
    UNION ALL
    SELECT fr.received_at, 5, 0, 'checked_in',
           CASE WHEN COALESCE(fr.cartons, 0) < 0 OR fr.units < 0 THEN 'Check-in corrected' ELSE 'Checked in' END,
           concat_ws(' · ', v_ship.shipment_number,
                     CASE WHEN fr.cartons IS NOT NULL THEN fr.cartons || CASE WHEN abs(fr.cartons) = 1 THEN ' carton' ELSE ' cartons' END END,
                     CASE WHEN fr.units <> 0 THEN fr.units || ' units' END),
           (SELECT NULLIF(btrim(p.full_name), '') FROM public.profiles p WHERE p.id = fr.received_by),
           CASE WHEN COALESCE(fr.cartons, 0) >= 0 AND fr.units >= 0 THEN 'checkin' END
      FROM public.freight_receipts fr
     WHERE (v_src.freight_receipt_id IS NOT NULL AND fr.id = v_src.freight_receipt_id)
        OR (v_src.freight_receipt_id IS NULL AND v_group.id IS NOT NULL
            AND fr.freight_shipment_id = v_group.freight_shipment_id AND fr.carton_group_id = v_group.id)
    -- movements of the carton (and of its ancestors, for an RTS child)
    UNION ALL
    SELECT x.at, 6, x.seq, x.kind, x.title,
           concat_ws(' · ', CASE WHEN x.ancestor THEN x.ctr_code END, x.detail),
           (SELECT NULLIF(btrim(p.full_name), '') FROM public.profiles p WHERE p.id = x.actor_id),
           x.mark
      FROM (
        SELECT mv2.at, mv2.seq, mv2.ancestor, mv2.ctr_code, mv2.actor_id,
               CASE
                 WHEN mv2.type IN ('receive', 'opening_balance') THEN 'checked_in'
                 WHEN mv2.type = 'putaway' THEN 'putaway'
                 WHEN mv2.type = 'move' AND mv2.travels AND mv2.to_location_id = v_mfg THEN 'pulled'
                 WHEN mv2.type = 'move' THEN 'moved'
                 WHEN mv2.type = 'open_container' THEN 'opened'
                 WHEN mv2.type = 'relabel' THEN 'relabel'
                 WHEN mv2.type = 'count_adjust' THEN 'count'
                 ELSE 'other' END AS kind,
               CASE
                 WHEN mv2.type = 'receive' THEN 'Checked in'
                 WHEN mv2.type = 'opening_balance' THEN 'Opening stock'
                 WHEN mv2.type = 'putaway' THEN 'Put away · ' || COALESCE(mv2.to_code, '?')
                 WHEN mv2.type = 'move' AND mv2.travels AND mv2.to_location_id = v_mfg THEN 'Pulled to the line'
                 WHEN mv2.type = 'move' THEN 'Moved · ' || COALESCE(mv2.to_code, '?')
                 WHEN mv2.type = 'open_container' THEN 'Opened'
                 WHEN mv2.type = 'relabel' AND mv2.ctr_parent IS NOT NULL
                   THEN 'Relabelled from · ' || COALESCE((SELECT pc.code FROM public.wh_containers pc WHERE pc.id = mv2.ctr_parent), '?')
                 WHEN mv2.type = 'relabel' THEN 'Packed at RTS'
                 WHEN mv2.type = 'count_adjust' THEN 'Count adjustment'
                 WHEN mv2.type IN ('bucket_convert', 'mfg_mirror')
                      AND v_mfg IN (mv2.from_location_id, mv2.to_location_id) THEN 'Manufacturing step'
                 WHEN mv2.type IN ('bucket_convert', 'mfg_mirror') THEN 'Stock converted'
                 WHEN mv2.type = 'write_off' THEN 'Written off'
                 WHEN mv2.type = 'void_receipt' THEN 'Check-in reversed'
                 WHEN mv2.type = 'ship_settle' THEN 'Shipped to customers'
                 WHEN mv2.type = 'ledger_mirror' THEN 'Stock Levels adjustment'
                 ELSE upper(left(mv2.type, 1)) || replace(substr(mv2.type, 2), '_', ' ') END AS title,
               CASE
                 WHEN mv2.type IN ('receive', 'opening_balance') THEN mv2.qty || ' units at ' || COALESCE(mv2.to_code, '?')
                 WHEN mv2.type = 'putaway' THEN mv2.qty || ' units from ' || COALESCE(mv2.from_code, '?')
                 WHEN mv2.type = 'move' AND mv2.travels THEN 'from ' || COALESCE(mv2.from_code, '?')
                 WHEN mv2.type = 'move' AND mv2.inbound THEN mv2.qty || ' units in from ' || COALESCE(mv2.from_code, '?')
                 WHEN mv2.type = 'move' THEN mv2.qty || ' units taken out'
                 WHEN mv2.type = 'open_container' THEN 'at ' || COALESCE(mv2.to_code, '?')
                 WHEN mv2.type = 'count_adjust' THEN CASE WHEN mv2.inbound THEN '+' ELSE '-' END || mv2.qty || ' units'
                 WHEN mv2.type IN ('bucket_convert', 'mfg_mirror')
                   THEN mv2.qty || ' ' || replace(mv2.bucket, '_', ' ') || ' → ' || replace(mv2.to_bucket, '_', ' ')
                 ELSE mv2.qty || ' units' END AS detail,
               CASE
                 WHEN mv2.type IN ('receive', 'opening_balance') THEN 'checkin'
                 WHEN mv2.type = 'putaway' THEN 'shelf'
                 WHEN mv2.type = 'move' AND mv2.travels AND mv2.to_location_id = v_mfg THEN 'line'
                 WHEN mv2.type = 'relabel' AND NOT mv2.ancestor THEN 'rts'
                 END AS mark
          FROM mv2
         WHERE NOT (mv2.type = 'receive' AND v_receipt)) x
    -- the carton's children: relabelled into them
    UNION ALL
    SELECT r.at, 6, r.seq, 'relabel', 'Relabelled · ' || r.code, r.qty || ' units',
           (SELECT NULLIF(btrim(p.full_name), '') FROM public.profiles p WHERE p.id = r.actor_id), 'rts'
      FROM (SELECT k.code, min(m.created_at) AS at, min(m.seq) AS seq, sum(m.qty)::int AS qty,
                   (array_agg(m.actor_id ORDER BY m.seq))[1] AS actor_id
              FROM public.wh_inventory_movements m
              JOIN public.wh_containers k ON k.id = m.to_container_id
             WHERE m.to_container_id = ANY (v_children) AND m.type = 'relabel'
             GROUP BY k.id, k.code) r
    -- opened in place (no movement at that moment)
    UNION ALL
    SELECT v_ctr.opened_at, 6, 9223372036854775807, 'opened', 'Opened', 'at ' || COALESCE(l.code, '?'), NULL, NULL
      FROM (SELECT 1) one LEFT JOIN public.wh_locations l ON l.id = v_ctr.location_id
     WHERE v_ctr.opened_at IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.wh_inventory_movements m
                        WHERE (m.from_container_id = v_ctr.id OR m.to_container_id = v_ctr.id)
                          AND (m.type = 'open_container' OR m.created_at = v_ctr.opened_at))
    -- tasks: opened, and cancelled (a completed task shows as its movement)
    UNION ALL
    SELECT t.created_at, 7, 0, 'other',
           initcap(t.kind) || ' task opened',
           concat_ws(' · ', CASE WHEN t.container_id <> v_ctr.id THEN (SELECT code FROM public.wh_containers WHERE id = t.container_id) END,
                     'to ' || sl.code),
           (SELECT NULLIF(btrim(p.full_name), '') FROM public.profiles p WHERE p.id = t.created_by), NULL
      FROM public.wh_moves t LEFT JOIN public.wh_locations sl ON sl.id = t.suggested_location_id
     WHERE t.container_id = ANY (v_chain)
    UNION ALL
    SELECT t.completed_at, 10, 0, 'other', initcap(t.kind) || ' task cancelled',
           CASE WHEN t.container_id <> v_ctr.id THEN (SELECT code FROM public.wh_containers WHERE id = t.container_id) END,
           (SELECT NULLIF(btrim(p.full_name), '') FROM public.profiles p WHERE p.id = t.completed_by), NULL
      FROM public.wh_moves t
     WHERE t.container_id = ANY (v_chain) AND t.status = 'cancelled' AND t.completed_at IS NOT NULL
    -- labels
    UNION ALL
    SELECT COALESCE(j.printed_at, j.created_at), 8, 0, 'labels',
           CASE WHEN j.status = 'printed' THEN 'Labels printed' ELSE 'Labels ' || j.status END || ' · '
             || CASE j.kind WHEN 'lpn' THEN 'carton' WHEN 'lpn_rts' THEN 'green carton' ELSE j.kind END,
           concat_ws(' · ', CASE WHEN NOT (v_ctr.id = ANY (j.item_ids)) THEN
                              (SELECT code FROM public.wh_containers WHERE id = ANY (j.item_ids) AND id = ANY (v_chain) LIMIT 1) END,
                     COALESCE(pr.code, CASE WHEN j.status = 'blocked' THEN 'outbound blocked' ELSE 'browser' END)),
           (SELECT NULLIF(btrim(p.full_name), '') FROM public.profiles p WHERE p.id = j.requested_by), NULL
      FROM public.wh_print_jobs j LEFT JOIN public.wh_printers pr ON pr.id = j.printer_id
     WHERE j.item_ids && v_chain AND j.kind IN ('lpn', 'lpn_rts')
    -- counts
    UNION ALL
    SELECT COALESCE(t.submitted_at, cl.created_at), 9, 0, 'count',
           'Counted · ' || cl.counted_qty || ' of ' || cl.expected_qty,
           concat_ws(' · ', CASE WHEN cl.container_id <> v_ctr.id THEN (SELECT code FROM public.wh_containers WHERE id = cl.container_id) END,
                     tl.code,
                     CASE t.status WHEN 'approved' THEN 'approved' WHEN 'submitted' THEN 'awaiting approval' ELSE t.status END),
           (SELECT NULLIF(btrim(p.full_name), '') FROM public.profiles p WHERE p.id = t.submitted_by), NULL
      FROM public.wh_count_lines cl
      JOIN public.wh_count_tasks t ON t.id = cl.count_task_id
      LEFT JOIN public.wh_locations tl ON tl.id = t.location_id
     WHERE cl.container_id = ANY (v_chain)
  ), line AS (
    SELECT min(at) AS t FROM ev WHERE mark = 'line'
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object('at', ev.at, 'kind', ev.kind, 'title', ev.title, 'detail', NULLIF(ev.detail, ''),
                                               'actor_name', ev.actor_name)
                            ORDER BY ev.at, ev.rk, ev.sq, ev.title), '[]'::jsonb),
         min(ev.at) FILTER (WHERE ev.mark = 'order'),
         min(ev.at) FILTER (WHERE ev.mark = 'finished'),
         min(ev.at) FILTER (WHERE ev.mark = 'shipped'),
         min(ev.at) FILTER (WHERE ev.mark = 'arrived'),
         min(ev.at) FILTER (WHERE ev.mark = 'checkin'),
         min(ev.at) FILTER (WHERE ev.mark = 'shelf' AND (line.t IS NULL OR ev.at <= line.t)),
         min(line.t),
         min(ev.at) FILTER (WHERE ev.mark = 'rts' AND (line.t IS NULL OR ev.at >= line.t))
    INTO v_timeline, v_t_order, v_t_fin, v_t_ship, v_t_arr, v_t_in, v_t_shelf, v_t_line, v_t_rts
    FROM ev CROSS JOIN line
   WHERE ev.at IS NOT NULL;

  RETURN jsonb_build_object(
    'ok', true,
    'carton', v_carton,
    'batch', v_batch,
    'timeline', COALESCE(v_timeline, '[]'::jsonb),
    'legs', jsonb_build_object(
      'order_to_finished_days', round((extract(epoch FROM v_t_fin - v_t_order) / 86400.0)::numeric, 1),
      'finished_to_shipped_days', round((extract(epoch FROM v_t_ship - v_t_fin) / 86400.0)::numeric, 1),
      'water_days', round((extract(epoch FROM v_t_arr - v_t_ship) / 86400.0)::numeric, 1),
      'arrival_to_checkin_days', round((extract(epoch FROM v_t_in - v_t_arr) / 86400.0)::numeric, 1),
      'checkin_to_shelf_minutes', round((extract(epoch FROM v_t_shelf - v_t_in) / 60.0)::numeric),
      'shelf_to_line_days', round((extract(epoch FROM v_t_line - v_t_shelf) / 86400.0)::numeric, 1),
      'line_to_rts_days', round((extract(epoch FROM v_t_rts - v_t_line) / 86400.0)::numeric, 1)));
END;
$$;

-- -------------------------------------------------------------
-- H. Grants
-- -------------------------------------------------------------
REVOKE ALL ON FUNCTION public._wh_resolve_group_fo_item(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_wh_stamp_carton_group() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._wh_fifo_carton_json(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._wh_next_carton(uuid) FROM PUBLIC, anon, authenticated;
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.rpc_wh_take_to_line(uuid, uuid, uuid, text)',
    'public.rpc_wh_next_cartons(uuid[])',
    'public.rpc_wh_fifo_compliance(integer)',
    'public.rpc_wh_carton_passport(text)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f);
  END LOOP;
END $$;

COMMIT;
