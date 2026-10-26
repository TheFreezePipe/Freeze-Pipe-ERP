-- =============================================================
-- Migration: Receiving mints carton license plates (Phase 1, slice 3C)
-- =============================================================
-- Design: docs/design/WAREHOUSE_MODULE_PHASE0_1.md §5.4 (receiving),
-- §5.5 (LPN label), §7 (desktop at the dock), §10 (tests).
--
-- Finding: rpc_record_freight_receipt (20260722000001) turns carton taps
-- into units by cumulative rounding, credits one bucket per SKU through
-- _freight_credit_units, and the cartons then dissolve;
-- rpc_apply_freight_delivery (20260908000001) receives whatever remains
-- as unit entries. The physical layer (20261022000002-4) needs every
-- carton checked in to exist as a wh_containers row at IN-01 with a label
-- and a putaway task, and the receipt's ledger credit must not be
-- mirrored a second time once the ledger mirror (a later slice) exists.
-- The receipt RPC also trusted p_actor_id: any signed-in caller could
-- pass the system actor and skip the admin/manager check.
--
-- Decision:
--   * rpc_record_freight_receipt is re-issued with the same signature and
--     the same return keys (ok, units_credited, credited, fully_received),
--     plus lpns, voided, print_job_id, print and putaway_tasks. Every
--     existing behaviour is kept: cumulative rounding per group, line
--     allocation (fill in creation order, drain in reverse, overage on the
--     last line), _freight_credit_units (unchanged), one freight_receipts
--     row per entry, the arrival date, the fully-received transition, unit
--     mode and corrections. With wh_settings.physical_layer.mint_lpns off
--     nothing else happens (no wh_* row is written).
--   * Actor: public._wh_actor(p_actor_id), i.e. auth.uid() for signed-in
--     callers and p_actor_id only from service_role or the postgres
--     session (design §5.1); the admin/manager check then applies to that
--     actor. Callers that pass their own id (the hooks) see no change.
--   * mint_lpns on, carton entry +n on group G from r0 to r1: cartons
--     r0+1..r1 are minted. Carton k holds, per SKU row of the group,
--     round(U·k/M) − round(U·(k−1)/M), the RPC's own rounding, so the
--     cartons sum exactly to the units credited
--     (src/lib/warehouse/carton-split.ts is the TypeScript twin).
--     Code C-<shipment number reduced to [A-Za-z0-9], upper-cased>-<nnn>,
--     n counting across the shipment ("carton n of N"); a number freed by
--     a void is reused, and because a voided carton keeps its code the
--     re-issued one gets a letter (C-466-040B). Without a shipment number
--     the prefix is S + six hex digits of the shipment id. Single-SKU
--     groups set sku_id; mixed groups leave it null; source freight,
--     state sealed (a carton the rounding leaves empty is minted 'empty',
--     labelled, with no task). Balances land at IN-01 in the bucket
--     _freight_credit_units chooses (_freight_lpn_bucket mirrors it)
--     through _wh_post_movement as `receive` movements referencing the
--     freight_receipts row.
--   * One open putaway wh_moves row per carton (origin receipt, from IN-01,
--     source_type 'freight_shipment' so the shipment page lists them) with
--     the suggestion and reason from _wh_suggest_putaway; one wh_print_jobs
--     row of kind lpn per call, routed by _wh_queue_print_job exactly as
--     rpc_wh_request_labels routes (the caller's station printer, else the
--     browser; blocked outbound stores it blocked).
--   * Corrections, carton entry −n: the group's n newest cartons that are
--     still sealed and full (or minted empty), wherever they are, are
--     voided: their balances are reversed with `void_receipt` movements,
--     state void, their open putaway cancelled. Per slot r0..r1+1 a carton
--     whose contents equal that slot's split is preferred, so the physical
--     reversal equals the ledger's; when only a carton with other contents
--     is left (the rounding gives 12/13 splits), the difference per SKU is
--     posted at UNLOCATED, the home of unexplained physical differences,
--     so physical and ledger totals stay equal. No candidate: the call
--     fails with lpn_in_use, "Every carton from this group has been opened
--     or split; count the location instead.", and changes nothing.
--   * Unit mode (line entries, no carton plan) credits loose units at
--     IN-01 with one open putaway task per SKU and bucket for the shipment
--     (later receipts add to it) and no labels. A negative entry takes the
--     units back from IN-01 and shrinks the task; units already put away
--     fail with units_put_away.
--   * wh.mirror_skip is set to 'on' (set_config, transaction-local) around
--     the ledger credits while minting is on and restored afterwards, so
--     the ledger mirror (§5.6, later slice) skips receipts that already
--     have their physical twin.
--   * rpc_apply_freight_delivery (same signature and keys, plus
--     print_job_id and lpns_minted): with mint_lpns on, a carton-planned
--     shipment's remaining cartons go through the carton path so they get
--     LPNs, then any line still short is received as loose units. With
--     mint_lpns off it is the 20260908000001 body unchanged.
--   * _wh_label_payload (20261022000004) is re-issued with one change:
--     carton_of is the shipment's planned carton count (the carton plan),
--     not the cartons minted so far, so the first label of a 40-carton
--     shipment reads "carton 1 of 40", not "carton 1 of 1".
--   * Grants: anon loses EXECUTE on the two receipt RPCs; anon and
--     authenticated lose EXECUTE on _freight_credit_units (a SECURITY
--     DEFINER ledger writer that clients never call); the new helpers are
--     private.
--
-- Smoke after deploy (random ids return a not-found envelope; a relation error fails):
--   SELECT public.rpc_record_freight_receipt(gen_random_uuid(), '[{"carton_group_id":"00000000-0000-0000-0000-000000000000","cartons":1}]'::jsonb, '00000000-0000-0000-0000-000000000001');  -- shipment_not_found
--   SELECT public.rpc_apply_freight_delivery(gen_random_uuid(), '00000000-0000-0000-0000-000000000001');  -- shipment not found
--   SELECT public._freight_lpn_bucket((SELECT id FROM public.product_skus WHERE category = 'non_fillable' LIMIT 1), false);  -- finished
--   SELECT public._freight_mint_cartons(gen_random_uuid(), gen_random_uuid(), 0, 1, NULL, gen_random_uuid(), '00000000-0000-0000-0000-000000000001', public._wh_loc_id('IN-01'));  -- {lpns:[]}
--   SELECT public._freight_void_cartons(gen_random_uuid(), 1, 0, '[]'::jsonb, NULL, gen_random_uuid(), '00000000-0000-0000-0000-000000000001');  -- {voided:[]}
--   SELECT public._freight_receive_loose(gen_random_uuid(), gen_random_uuid(), 'raw', 0, NULL, gen_random_uuid(), '00000000-0000-0000-0000-000000000001', public._wh_loc_id('IN-01'));  -- null
--   SELECT public._wh_label_payload('lpn', ARRAY[gen_random_uuid()], false);  -- {labels:[]}
--   SELECT jsonb_build_object('mint_lpns', public._wh_setting('physical_layer')->'mint_lpns');  -- current flag
-- =============================================================

BEGIN;

-- -------------------------------------------------------------
-- A. Helpers (not executable by clients)
-- -------------------------------------------------------------

-- The bucket _freight_credit_units credits: non_fillable → finished;
-- fillable → prefilled_raw when the units arrived pre-filled, else raw.
CREATE OR REPLACE FUNCTION public._freight_lpn_bucket(p_sku_id uuid, p_pre_filled boolean)
RETURNS text
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT CASE
           WHEN (SELECT ps.category FROM public.product_skus ps WHERE ps.id = p_sku_id) = 'non_fillable' THEN 'finished'
           WHEN p_pre_filled THEN 'prefilled_raw'
           ELSE 'raw'
         END;
$$;

-- Mint cartons r0+1..r1 of one carton group at IN-01, each with its
-- receive movements and an open putaway task.
-- Returns {lpns: [...], ids: [uuid], tasks: [uuid]}.
CREATE OR REPLACE FUNCTION public._freight_mint_cartons(
  p_shipment_id uuid, p_carton_group_id uuid, p_r0 integer, p_r1 integer,
  p_receipt_id uuid, p_mv_group uuid, p_actor uuid, p_in01 uuid)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_number  text;
  v_prefix  text;
  v_m       integer;
  v_skus    uuid[];
  v_totals  integer[];
  v_prefill boolean[];
  v_n_skus  integer;
  v_single  uuid;
  v_used    integer[];
  v_seq     integer := 0;
  v_k       integer;
  v_i       integer;
  v_q       integer;
  v_units   integer;
  v_base    text;
  v_code    text;
  v_sfx     integer;
  v_ctr     uuid;
  v_sug     jsonb;
  v_task    uuid;
  v_lpns    jsonb := '[]'::jsonb;
  v_ids     uuid[] := '{}';
  v_tasks   uuid[] := '{}';
BEGIN
  SELECT g.carton_qty, fs.shipment_number INTO v_m, v_number
    FROM public.freight_carton_groups g
    JOIN public.freight_shipments fs ON fs.id = g.freight_shipment_id
   WHERE g.id = p_carton_group_id AND g.freight_shipment_id = p_shipment_id;
  IF v_m IS NULL OR v_m <= 0 OR p_r1 <= p_r0 THEN
    RETURN jsonb_build_object('lpns', '[]'::jsonb, 'ids', '[]'::jsonb, 'tasks', '[]'::jsonb);
  END IF;
  IF p_in01 IS NULL THEN
    RAISE EXCEPTION '_freight_mint_cartons: IN-01 is missing';
  END IF;

  SELECT array_agg(gs.sku_id ORDER BY gs.created_at, gs.id),
         array_agg(gs.units_total ORDER BY gs.created_at, gs.id),
         array_agg(gs.pre_filled ORDER BY gs.created_at, gs.id),
         count(DISTINCT gs.sku_id)
    INTO v_skus, v_totals, v_prefill, v_n_skus
    FROM public.freight_carton_group_skus gs
   WHERE gs.carton_group_id = p_carton_group_id;
  v_single := CASE WHEN v_n_skus = 1 THEN v_skus[1] END;

  v_prefix := 'C-' || COALESCE(NULLIF(upper(regexp_replace(COALESCE(v_number, ''), '[^A-Za-z0-9]', '', 'g')), ''),
                               'S' || upper(left(replace(p_shipment_id::text, '-', ''), 6))) || '-';
  PERFORM pg_advisory_xact_lock(hashtextextended('wh_container_code:' || v_prefix, 0));

  -- carton numbers live on this shipment (a void frees its number)
  SELECT COALESCE(array_agg(c.carton_seq), '{}') INTO v_used
    FROM public.wh_containers c
   WHERE c.freight_shipment_id = p_shipment_id AND c.state <> 'void' AND c.carton_seq IS NOT NULL;

  FOR v_k IN (p_r0 + 1) .. p_r1 LOOP
    v_seq := v_seq + 1;
    WHILE v_seq = ANY (v_used) LOOP
      v_seq := v_seq + 1;
    END LOOP;
    v_used := v_used || v_seq;
    v_base := v_prefix || lpad(v_seq::text, GREATEST(3, length(v_seq::text)), '0');
    v_code := v_base;
    v_sfx := 1;
    WHILE EXISTS (SELECT 1 FROM public.wh_containers WHERE upper(code) = upper(v_code)) LOOP
      v_sfx := v_sfx + 1;
      v_code := v_base || CASE WHEN v_sfx <= 26 THEN chr(64 + v_sfx) ELSE 'X' || v_sfx::text END;
    END LOOP;

    v_units := 0;
    FOR v_i IN 1 .. COALESCE(array_length(v_skus, 1), 0) LOOP
      v_units := v_units + round(v_totals[v_i]::numeric * v_k / v_m)::int
                         - round(v_totals[v_i]::numeric * (v_k - 1) / v_m)::int;
    END LOOP;

    INSERT INTO public.wh_containers (code, sku_id, qty_initial, qty, state, location_id, source,
                                      freight_shipment_id, carton_group_id, freight_receipt_id, carton_seq,
                                      created_by, emptied_at)
    VALUES (v_code, v_single, v_units, 0, CASE WHEN v_units > 0 THEN 'sealed' ELSE 'empty' END, p_in01, 'freight',
            p_shipment_id, p_carton_group_id, p_receipt_id, v_seq,
            p_actor, CASE WHEN v_units > 0 THEN NULL ELSE now() END)
    RETURNING id INTO v_ctr;

    FOR v_i IN 1 .. COALESCE(array_length(v_skus, 1), 0) LOOP
      v_q := round(v_totals[v_i]::numeric * v_k / v_m)::int - round(v_totals[v_i]::numeric * (v_k - 1) / v_m)::int;
      CONTINUE WHEN v_q <= 0;
      PERFORM public._wh_post_movement(p_mv_group, 'receive', v_skus[v_i],
                                       public._freight_lpn_bucket(v_skus[v_i], v_prefill[v_i]), v_q,
                                       NULL, NULL, p_in01, v_ctr, NULL, p_actor, 'freight_receipt', p_receipt_id,
                                       'Freight ' || COALESCE(v_number, '') || ' check-in, carton ' || v_seq);
    END LOOP;

    v_sug := NULL;
    v_task := NULL;
    IF v_units > 0 THEN
      v_sug := public._wh_suggest_putaway(v_ctr, '{}', NULL, NULL, 'receipt');
      INSERT INTO public.wh_moves (kind, origin, status, container_id, from_location_id, suggested_location_id,
                                   suggestion_reason, source_type, source_id, created_by)
      VALUES ('putaway', 'receipt', 'open', v_ctr, p_in01, (v_sug->>'location_id')::uuid, v_sug->>'reason',
              'freight_shipment', p_shipment_id, p_actor)
      RETURNING id INTO v_task;
      v_tasks := v_tasks || v_task;
    END IF;
    v_ids := v_ids || v_ctr;

    v_lpns := v_lpns || jsonb_build_object(
      'id', v_ctr, 'code', v_code, 'carton_seq', v_seq, 'carton_group_id', p_carton_group_id,
      'sku_id', v_single, 'qty', v_units, 'state', CASE WHEN v_units > 0 THEN 'sealed' ELSE 'empty' END,
      'contents', (SELECT COALESCE(jsonb_agg(jsonb_build_object('sku_id', b.sku_id, 'sku', ps.sku, 'qty', b.on_hand,
                                                                'bucket', b.bucket) ORDER BY ps.sku, b.bucket), '[]'::jsonb)
                     FROM public.wh_inventory_balances b JOIN public.product_skus ps ON ps.id = b.sku_id
                    WHERE b.container_id = v_ctr AND b.on_hand > 0),
      'suggested', v_sug, 'move_id', v_task);
  END LOOP;

  RETURN jsonb_build_object('lpns', v_lpns, 'ids', to_jsonb(v_ids), 'tasks', to_jsonb(v_tasks));
END;
$$;

-- Void the cartons of a negative carton entry from r0 down to r1.
-- p_reversed: [{sku_id, bucket, units}] the ledger actually reversed
-- (positive units). Cartons checked in before minting was switched on have
-- no LPN: they are the group's oldest, so a correction reaches them only
-- after every live LPN, and their share is reversed in the ledger alone.
-- Raises SQLSTATE WH001 (lpn_in_use) when too few LPN cartons are still
-- sealed and full. Returns {voided: [...], unlocated: [...]}.
CREATE OR REPLACE FUNCTION public._freight_void_cartons(
  p_carton_group_id uuid, p_r0 integer, p_r1 integer, p_reversed jsonb,
  p_receipt_id uuid, p_mv_group uuid, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_m        integer;
  v_j        integer;
  v_live     integer;
  v_low      integer;
  v_target   jsonb;
  v_pick     uuid;
  v_picked   uuid[] := '{}';
  v_c        public.wh_containers%ROWTYPE;
  v_bal      record;
  v_r        jsonb;
  v_held     jsonb := '{}'::jsonb;  -- "sku|bucket" → units drawn from the voided cartons
  v_rev      jsonb := '{}'::jsonb;  -- "sku|bucket" → units the ledger reversed
  v_key      text;
  v_diff     integer;
  v_unloc    uuid;
  v_loc_code text;
  v_voided   jsonb := '[]'::jsonb;
  v_unl_out  jsonb := '[]'::jsonb;
BEGIN
  SELECT carton_qty INTO v_m FROM public.freight_carton_groups WHERE id = p_carton_group_id;
  IF v_m IS NULL OR p_r0 <= p_r1 THEN
    RETURN jsonb_build_object('voided', '[]'::jsonb, 'unlocated', '[]'::jsonb);
  END IF;

  -- slots r0 .. v_low carry LPNs; v_low-1 .. r1+1 were checked in before minting
  SELECT count(*) INTO v_live FROM public.wh_containers
   WHERE carton_group_id = p_carton_group_id AND source = 'freight' AND state <> 'void';
  v_low := GREATEST(p_r0 - v_live + 1, p_r1 + 1);

  -- choose one carton per slot j = r0 .. v_low: the newest sealed-and-full
  -- carton of the group, preferring one whose contents equal slot j's split
  FOR v_j IN REVERSE p_r0 .. v_low LOOP
    SELECT COALESCE(jsonb_object_agg(s.k, s.q), '{}'::jsonb) INTO v_target
      FROM (SELECT gs.sku_id::text || '|' || public._freight_lpn_bucket(gs.sku_id, gs.pre_filled) AS k,
                   sum(round(gs.units_total::numeric * v_j / v_m)::int
                       - round(gs.units_total::numeric * (v_j - 1) / v_m)::int) AS q
              FROM public.freight_carton_group_skus gs
             WHERE gs.carton_group_id = p_carton_group_id
             GROUP BY 1) s
     WHERE s.q > 0;

    v_pick := NULL;
    SELECT c.id INTO v_pick
      FROM public.wh_containers c
     WHERE c.carton_group_id = p_carton_group_id AND c.source = 'freight' AND NOT (c.id = ANY (v_picked))
       AND ((c.state = 'sealed' AND c.qty = c.qty_initial AND c.qty > 0) OR (c.state = 'empty' AND c.qty_initial = 0))
     ORDER BY (SELECT COALESCE(jsonb_object_agg(x.k, x.q), '{}'::jsonb)
                 FROM (SELECT b.sku_id::text || '|' || b.bucket AS k, sum(b.on_hand) AS q
                         FROM public.wh_inventory_balances b
                        WHERE b.container_id = c.id AND b.on_hand > 0
                        GROUP BY 1) x) = v_target DESC,
              c.created_at DESC, c.carton_seq DESC NULLS LAST, c.code DESC
     LIMIT 1;
    IF v_pick IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'WH001', MESSAGE = CASE
        WHEN cardinality(v_picked) = 0
          THEN 'Every carton from this group has been opened or split; count the location instead.'
        ELSE format('Only %s carton(s) from this group are still sealed and full; the others have been opened or split. Count the location instead.',
                    cardinality(v_picked)) END;
    END IF;
    v_picked := v_picked || v_pick;
  END LOOP;

  FOREACH v_pick IN ARRAY v_picked LOOP
    SELECT * INTO v_c FROM public.wh_containers WHERE id = v_pick FOR UPDATE;
    IF NOT ((v_c.state = 'sealed' AND v_c.qty = v_c.qty_initial AND v_c.qty > 0) OR (v_c.state = 'empty' AND v_c.qty_initial = 0)) THEN
      RAISE EXCEPTION USING ERRCODE = 'WH001',
        MESSAGE = v_c.code || ' was opened while it was being voided; count the location instead.';
    END IF;
    SELECT code INTO v_loc_code FROM public.wh_locations WHERE id = v_c.location_id;
    FOR v_bal IN
      SELECT * FROM public.wh_inventory_balances WHERE container_id = v_c.id AND on_hand > 0 ORDER BY id
    LOOP
      PERFORM public._wh_post_movement(p_mv_group, 'void_receipt', v_bal.sku_id, v_bal.bucket, v_bal.on_hand,
                                       v_bal.location_id, v_c.id, NULL, NULL, NULL, p_actor, 'freight_receipt', p_receipt_id,
                                       'Void ' || v_c.code);
      v_key := v_bal.sku_id::text || '|' || v_bal.bucket;
      v_held := v_held || jsonb_build_object(v_key, COALESCE((v_held->>v_key)::int, 0) + v_bal.on_hand);
    END LOOP;
    UPDATE public.wh_containers
       SET state = 'void', qty = 0, emptied_at = COALESCE(emptied_at, now())
     WHERE id = v_c.id;
    UPDATE public.wh_moves
       SET status = 'cancelled', completed_by = p_actor, completed_at = now()
     WHERE container_id = v_c.id AND kind = 'putaway' AND status IN ('open', 'in_progress');
    v_voided := v_voided || jsonb_build_object('id', v_c.id, 'code', v_c.code, 'carton_seq', v_c.carton_seq,
                                               'qty', v_c.qty_initial, 'location_code', v_loc_code);
  END LOOP;

  -- keep physical equal to the ledger: a split the cartons did not match is posted at UNLOCATED
  FOR v_r IN SELECT * FROM jsonb_array_elements(COALESCE(p_reversed, '[]'::jsonb)) LOOP
    v_key := (v_r->>'sku_id') || '|' || (v_r->>'bucket');
    v_rev := v_rev || jsonb_build_object(v_key, COALESCE((v_rev->>v_key)::int, 0) + (v_r->>'units')::int);
  END LOOP;
  -- the slots below v_low never had a physical twin: the ledger alone reverses them
  IF v_low > p_r1 + 1 THEN
    FOR v_r IN
      SELECT jsonb_build_object('k', gs.sku_id::text || '|' || public._freight_lpn_bucket(gs.sku_id, gs.pre_filled),
                                'q', sum(round(gs.units_total::numeric * (v_low - 1) / v_m)::int
                                         - round(gs.units_total::numeric * p_r1 / v_m)::int))
        FROM public.freight_carton_group_skus gs
       WHERE gs.carton_group_id = p_carton_group_id
       GROUP BY gs.sku_id, public._freight_lpn_bucket(gs.sku_id, gs.pre_filled)
    LOOP
      v_key := v_r->>'k';
      v_rev := v_rev || jsonb_build_object(v_key, GREATEST(COALESCE((v_rev->>v_key)::int, 0) - (v_r->>'q')::int, 0));
    END LOOP;
  END IF;
  FOR v_key IN SELECT k FROM jsonb_object_keys(v_held) AS k UNION SELECT k FROM jsonb_object_keys(v_rev) AS k ORDER BY 1 LOOP
    v_diff := COALESCE((v_held->>v_key)::int, 0) - COALESCE((v_rev->>v_key)::int, 0);
    CONTINUE WHEN v_diff = 0;
    IF v_unloc IS NULL THEN
      v_unloc := public._wh_loc_id('UNLOCATED');
      IF v_unloc IS NULL THEN
        RAISE EXCEPTION '_freight_void_cartons: the UNLOCATED location is missing';
      END IF;
    END IF;
    IF v_diff > 0 THEN
      -- the cartons held more than the ledger reversed: the books still count these units
      PERFORM public._wh_post_movement(p_mv_group, 'void_receipt', split_part(v_key, '|', 1)::uuid, split_part(v_key, '|', 2),
                                       v_diff, NULL, NULL, v_unloc, NULL, NULL, p_actor, 'freight_receipt', p_receipt_id,
                                       'Void: the cartons held more than the receipt reversed');
    ELSE
      PERFORM public._wh_post_movement(p_mv_group, 'void_receipt', split_part(v_key, '|', 1)::uuid, split_part(v_key, '|', 2),
                                       -v_diff, v_unloc, NULL, NULL, NULL, NULL, p_actor, 'freight_receipt', p_receipt_id,
                                       'Void: the receipt reversed more than the cartons held');
    END IF;
    v_unl_out := v_unl_out || jsonb_build_object('sku_id', split_part(v_key, '|', 1), 'bucket', split_part(v_key, '|', 2),
                                                 'units', v_diff);
  END LOOP;

  RETURN jsonb_build_object('voided', v_voided, 'unlocated', v_unl_out);
END;
$$;

-- Unit mode: loose units in or out of IN-01 and the shipment's one open
-- loose putaway per SKU and bucket. Raises SQLSTATE WH002
-- (units_put_away) when a correction asks for more than IN-01 still holds.
-- Returns the putaway task id (null for a correction or zero units).
CREATE OR REPLACE FUNCTION public._freight_receive_loose(
  p_shipment_id uuid, p_sku_id uuid, p_bucket text, p_units integer,
  p_receipt_id uuid, p_mv_group uuid, p_actor uuid, p_in01 uuid)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_task uuid;
  v_qty  integer;
  v_have integer;
  v_sug  jsonb;
BEGIN
  IF COALESCE(p_units, 0) = 0 THEN
    RETURN NULL;
  END IF;
  IF p_in01 IS NULL THEN
    RAISE EXCEPTION '_freight_receive_loose: IN-01 is missing';
  END IF;

  SELECT id, qty INTO v_task, v_qty FROM public.wh_moves
   WHERE kind = 'putaway' AND origin = 'receipt' AND status = 'open' AND container_id IS NULL
     AND sku_id = p_sku_id AND bucket = p_bucket AND from_location_id = p_in01
     AND source_type = 'freight_shipment' AND source_id = p_shipment_id
   ORDER BY created_at, id
   LIMIT 1
   FOR UPDATE;

  IF p_units > 0 THEN
    PERFORM public._wh_post_movement(p_mv_group, 'receive', p_sku_id, p_bucket, p_units, NULL, NULL, p_in01, NULL, NULL,
                                     p_actor, 'freight_receipt', p_receipt_id, 'Freight check-in (loose units)');
    IF v_task IS NOT NULL THEN
      UPDATE public.wh_moves SET qty = qty + p_units WHERE id = v_task;
    ELSE
      v_sug := public._wh_suggest_putaway(NULL, '{}', p_sku_id, p_bucket, 'receipt');
      INSERT INTO public.wh_moves (kind, origin, status, sku_id, qty, bucket, from_location_id, suggested_location_id,
                                   suggestion_reason, source_type, source_id, created_by)
      VALUES ('putaway', 'receipt', 'open', p_sku_id, p_units, p_bucket, p_in01, (v_sug->>'location_id')::uuid,
              v_sug->>'reason', 'freight_shipment', p_shipment_id, p_actor)
      RETURNING id INTO v_task;
    END IF;
    RETURN v_task;
  END IF;

  SELECT on_hand INTO v_have FROM public.wh_inventory_balances
   WHERE sku_id = p_sku_id AND location_id = p_in01 AND container_id IS NULL AND bucket = p_bucket
   FOR UPDATE;
  IF COALESCE(v_have, 0) < -p_units THEN
    RAISE EXCEPTION USING ERRCODE = 'WH002', MESSAGE = format(
      'Only %s %s are still loose at IN-01; the rest were put away. Count the location instead.',
      COALESCE(v_have, 0), COALESCE((SELECT sku FROM public.product_skus WHERE id = p_sku_id), 'units'));
  END IF;
  PERFORM public._wh_post_movement(p_mv_group, 'void_receipt', p_sku_id, p_bucket, -p_units, p_in01, NULL, NULL, NULL, NULL,
                                   p_actor, 'freight_receipt', p_receipt_id, 'Freight check-in corrected (loose units)');
  IF v_task IS NOT NULL THEN
    IF v_qty + p_units > 0 THEN
      UPDATE public.wh_moves SET qty = qty + p_units WHERE id = v_task;
    ELSE
      UPDATE public.wh_moves SET status = 'cancelled', completed_by = p_actor, completed_at = now() WHERE id = v_task;
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

-- -------------------------------------------------------------
-- B. rpc_record_freight_receipt — same signature and return keys
-- -------------------------------------------------------------
-- p_entries: jsonb array. Two entry shapes, mixable:
--   {"carton_group_id": uuid, "cartons": int}   (negative = correction)
--   {"line_item_id": uuid, "units": int}        (negative = correction)
-- Carton math: cumulative rounding so per-SKU credits sum exactly to
-- units_total when the last carton is tapped: cum(r) = round(U*r/M).
CREATE OR REPLACE FUNCTION public.rpc_record_freight_receipt(
  p_shipment_id uuid,
  p_entries jsonb,
  p_actor_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_shipment    freight_shipments%ROWTYPE;
  v_caller      text;
  v_entry       jsonb;
  v_group       freight_carton_groups%ROWTYPE;
  v_gs          RECORD;
  v_li          freight_line_items%ROWTYPE;
  v_cartons     int;
  v_units       int;
  v_r0          int;
  v_r1          int;
  v_delta       int;
  v_remaining   int;
  v_cap         int;
  v_take        int;
  v_pref_delta  int;
  v_raw_delta   int;
  v_credited    jsonb := '[]'::jsonb;
  v_total_units int := 0;
  v_fully       boolean;
  -- physical layer (slice 3C)
  v_actor       uuid := public._wh_actor(p_actor_id);
  v_mint        boolean := COALESCE((public._wh_setting('physical_layer')->>'mint_lpns')::boolean, false);
  v_in01        uuid;
  v_receipt     uuid;
  v_mv_group    uuid := gen_random_uuid();
  v_reversed    jsonb;
  v_out         jsonb;
  v_lpns        jsonb := '[]'::jsonb;
  v_voided      jsonb := '[]'::jsonb;
  v_unlocated   jsonb := '[]'::jsonb;
  v_ctr_ids     uuid[] := '{}';
  v_tasks       uuid[] := '{}';
  v_task        uuid;
  v_job         jsonb;
  v_skip_prev   text;
BEGIN
  IF v_actor IS DISTINCT FROM '00000000-0000-0000-0000-000000000001'::uuid THEN
    SELECT role INTO v_caller FROM profiles WHERE id = v_actor AND is_active;
    IF v_caller IS NULL OR v_caller NOT IN ('admin','manager') THEN
      RETURN jsonb_build_object('ok', false, 'error', 'admin_or_manager_required',
        'message', 'Only admin or manager users may record freight receipts');
    END IF;
  END IF;

  SELECT * INTO v_shipment FROM freight_shipments WHERE id = p_shipment_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'shipment_not_found');
  END IF;
  IF v_shipment.receipt_confirmed_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'already_confirmed',
      'message', 'Shipment is fully received/closed — use a cycle count for corrections');
  END IF;
  IF p_entries IS NULL OR jsonb_typeof(p_entries) <> 'array' OR jsonb_array_length(p_entries) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_entries');
  END IF;
  IF v_mint THEN
    v_in01 := public._wh_loc_id('IN-01');
    IF v_in01 IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'error', 'in01_missing',
        'message', 'The IN-01 receiving location is missing; an admin must restore it before cartons can be checked in.');
    END IF;
  END IF;

  -- A failed correction (lpn_in_use, units_put_away) rolls back the whole
  -- call to this savepoint and returns its envelope.
  BEGIN
    IF v_mint THEN
      v_skip_prev := current_setting('wh.mirror_skip', true);
      PERFORM set_config('wh.mirror_skip', 'on', true);
    END IF;

    FOR v_entry IN SELECT * FROM jsonb_array_elements(p_entries) LOOP

      IF v_entry ? 'carton_group_id' THEN
        -- ================= carton mode =================
        v_cartons := COALESCE((v_entry->>'cartons')::int, 0);
        IF v_cartons = 0 THEN CONTINUE; END IF;
        SELECT * INTO v_group FROM freight_carton_groups
         WHERE id = (v_entry->>'carton_group_id')::uuid AND freight_shipment_id = p_shipment_id
         FOR UPDATE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'carton group % not on shipment', v_entry->>'carton_group_id';
        END IF;
        v_r0 := v_group.received_cartons;
        v_r1 := LEAST(GREATEST(v_r0 + v_cartons, 0), v_group.carton_qty);
        IF v_r1 = v_r0 THEN CONTINUE; END IF;

        UPDATE freight_carton_groups
           SET received_cartons = v_r1, updated_at = now()
         WHERE id = v_group.id;

        INSERT INTO freight_receipts (freight_shipment_id, carton_group_id, cartons, units, received_by, note)
        VALUES (p_shipment_id, v_group.id, v_r1 - v_r0, 0, v_actor, v_entry->>'note')
        RETURNING id INTO v_receipt;

        -- Per-SKU unit delta via cumulative rounding, allocated across that
        -- SKU's line items (fill in creation order; drain in reverse).
        v_reversed := '[]'::jsonb;
        FOR v_gs IN
          SELECT sku_id, units_total, pre_filled FROM freight_carton_group_skus
          WHERE carton_group_id = v_group.id
        LOOP
          v_delta := round(v_gs.units_total::numeric * v_r1 / v_group.carton_qty)::int
                   - round(v_gs.units_total::numeric * v_r0 / v_group.carton_qty)::int;
          IF v_delta = 0 THEN CONTINUE; END IF;
          v_remaining := v_delta;

          IF v_delta > 0 THEN
            FOR v_li IN
              SELECT * FROM freight_line_items
              WHERE freight_shipment_id = p_shipment_id AND sku_id = v_gs.sku_id
              ORDER BY created_at
            LOOP
              EXIT WHEN v_remaining = 0;
              v_cap := GREATEST(v_li.quantity - v_li.quantity_received, 0);
              v_take := LEAST(v_cap, v_remaining);
              IF v_take > 0 THEN
                UPDATE freight_line_items SET quantity_received = quantity_received + v_take
                 WHERE id = v_li.id;
                v_remaining := v_remaining - v_take;
              END IF;
            END LOOP;
            IF v_remaining > 0 THEN
              -- overage beyond declared: park on the last line of the SKU
              UPDATE freight_line_items SET quantity_received = quantity_received + v_remaining
               WHERE id = (SELECT id FROM freight_line_items
                            WHERE freight_shipment_id = p_shipment_id AND sku_id = v_gs.sku_id
                            ORDER BY created_at DESC LIMIT 1);
              v_remaining := 0;
            END IF;
          ELSE
            FOR v_li IN
              SELECT * FROM freight_line_items
              WHERE freight_shipment_id = p_shipment_id AND sku_id = v_gs.sku_id
              ORDER BY created_at DESC
            LOOP
              EXIT WHEN v_remaining = 0;
              v_take := LEAST(v_li.quantity_received, -v_remaining);
              IF v_take > 0 THEN
                UPDATE freight_line_items SET quantity_received = quantity_received - v_take
                 WHERE id = v_li.id;
                v_remaining := v_remaining + v_take;
              END IF;
            END LOOP;
            v_delta := v_delta - v_remaining;  -- what we actually reversed
            v_remaining := 0;
          END IF;

          PERFORM _freight_credit_units(p_shipment_id, v_shipment.shipment_number,
                                        v_gs.sku_id, v_delta, v_gs.pre_filled, v_actor);
          v_total_units := v_total_units + v_delta;
          v_credited := v_credited || jsonb_build_object('sku_id', v_gs.sku_id, 'units', v_delta);
          IF v_mint AND v_delta < 0 THEN
            v_reversed := v_reversed || jsonb_build_object(
              'sku_id', v_gs.sku_id, 'bucket', public._freight_lpn_bucket(v_gs.sku_id, v_gs.pre_filled), 'units', -v_delta);
          END IF;
        END LOOP;

        IF v_mint THEN
          IF v_r1 > v_r0 THEN
            v_out := public._freight_mint_cartons(p_shipment_id, v_group.id, v_r0, v_r1, v_receipt, v_mv_group, v_actor, v_in01);
            v_lpns := v_lpns || (v_out->'lpns');
            v_ctr_ids := v_ctr_ids || ARRAY(SELECT x::uuid FROM jsonb_array_elements_text(v_out->'ids') AS x);
            v_tasks := v_tasks || ARRAY(SELECT x::uuid FROM jsonb_array_elements_text(v_out->'tasks') AS x);
          ELSE
            v_out := public._freight_void_cartons(v_group.id, v_r0, v_r1, v_reversed, v_receipt, v_mv_group, v_actor);
            v_voided := v_voided || (v_out->'voided');
            v_unlocated := v_unlocated || (v_out->'unlocated');
          END IF;
        END IF;

      ELSIF v_entry ? 'line_item_id' THEN
        -- ================= unit mode (legacy shipments) =================
        v_units := COALESCE((v_entry->>'units')::int, 0);
        IF v_units = 0 THEN CONTINUE; END IF;
        SELECT * INTO v_li FROM freight_line_items
         WHERE id = (v_entry->>'line_item_id')::uuid AND freight_shipment_id = p_shipment_id
         FOR UPDATE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'line item % not on shipment', v_entry->>'line_item_id';
        END IF;
        IF v_li.sku_id IS NULL THEN
          RAISE EXCEPTION 'non-catalog lines cannot be received into inventory';
        END IF;
        v_r0 := v_li.quantity_received;
        v_r1 := GREATEST(v_r0 + v_units, 0);
        IF v_r1 = v_r0 THEN CONTINUE; END IF;

        UPDATE freight_line_items SET quantity_received = v_r1 WHERE id = v_li.id;

        -- prefilled share follows the line's declared ratio via cum-rounding
        v_pref_delta :=
          round(LEAST(COALESCE(v_li.quantity_prefilled,0), v_li.quantity)::numeric
                * LEAST(v_r1, v_li.quantity) / GREATEST(v_li.quantity,1))::int
        - round(LEAST(COALESCE(v_li.quantity_prefilled,0), v_li.quantity)::numeric
                * LEAST(v_r0, v_li.quantity) / GREATEST(v_li.quantity,1))::int;
        v_raw_delta := (v_r1 - v_r0) - v_pref_delta;

        INSERT INTO freight_receipts (freight_shipment_id, sku_id, units, received_by, note)
        VALUES (p_shipment_id, v_li.sku_id, v_r1 - v_r0, v_actor, v_entry->>'note')
        RETURNING id INTO v_receipt;

        IF v_pref_delta <> 0 THEN
          PERFORM _freight_credit_units(p_shipment_id, v_shipment.shipment_number,
                                        v_li.sku_id, v_pref_delta, true, v_actor);
        END IF;
        IF v_raw_delta <> 0 THEN
          PERFORM _freight_credit_units(p_shipment_id, v_shipment.shipment_number,
                                        v_li.sku_id, v_raw_delta, false, v_actor);
        END IF;
        v_total_units := v_total_units + (v_r1 - v_r0);
        v_credited := v_credited || jsonb_build_object('sku_id', v_li.sku_id, 'units', v_r1 - v_r0);

        IF v_mint THEN
          v_task := public._freight_receive_loose(p_shipment_id, v_li.sku_id, public._freight_lpn_bucket(v_li.sku_id, true),
                                                  v_pref_delta, v_receipt, v_mv_group, v_actor, v_in01);
          IF v_task IS NOT NULL AND NOT (v_task = ANY (v_tasks)) THEN
            v_tasks := v_tasks || v_task;
          END IF;
          v_task := public._freight_receive_loose(p_shipment_id, v_li.sku_id, public._freight_lpn_bucket(v_li.sku_id, false),
                                                  v_raw_delta, v_receipt, v_mv_group, v_actor, v_in01);
          IF v_task IS NOT NULL AND NOT (v_task = ANY (v_tasks)) THEN
            v_tasks := v_tasks || v_task;
          END IF;
        END IF;
      ELSE
        RAISE EXCEPTION 'entry must have carton_group_id or line_item_id';
      END IF;
    END LOOP;

    IF v_mint THEN
      PERFORM set_config('wh.mirror_skip', COALESCE(v_skip_prev, ''), true);
    END IF;

    IF v_total_units > 0 THEN
      UPDATE freight_shipments
         SET actual_arrival_date = COALESCE(actual_arrival_date, CURRENT_DATE)
       WHERE id = p_shipment_id;
    END IF;

    -- Fully received? (catalog lines only; non-catalog never blocks)
    SELECT NOT EXISTS (
      SELECT 1 FROM freight_line_items
      WHERE freight_shipment_id = p_shipment_id AND sku_id IS NOT NULL
        AND quantity_received < quantity
    ) INTO v_fully;

    IF v_fully THEN
      UPDATE freight_shipments
         SET status = 'delivered',
             receipt_confirmed_at = now(),
             receipt_confirmed_by = v_actor
       WHERE id = p_shipment_id;
    END IF;

    -- one label job per call for every carton minted by it
    IF cardinality(v_ctr_ids) > 0 THEN
      v_job := public._wh_queue_print_job('lpn', v_ctr_ids, 'dock', NULL, v_actor);
    END IF;

    RETURN jsonb_build_object('ok', true, 'units_credited', v_total_units,
                              'credited', v_credited, 'fully_received', v_fully,
                              'lpns', v_lpns, 'voided', v_voided, 'unlocated', v_unlocated,
                              'print_job_id', v_job->>'job_id', 'print', v_job - 'payload',
                              'putaway_tasks', to_jsonb(v_tasks));
  EXCEPTION
    WHEN SQLSTATE 'WH001' THEN
      RETURN jsonb_build_object('ok', false, 'error', 'lpn_in_use', 'message', SQLERRM);
    WHEN SQLSTATE 'WH002' THEN
      RETURN jsonb_build_object('ok', false, 'error', 'units_put_away', 'message', SQLERRM);
  END;
END;
$$;

-- -------------------------------------------------------------
-- C. rpc_apply_freight_delivery — receive-all through the carton path
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_apply_freight_delivery(p_shipment_id uuid, p_actor_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_shipment freight_shipments%ROWTYPE;
  v_entries jsonb;
  v_result jsonb;
  v_lines int;
  v_non_catalog int;
  v_mint boolean := COALESCE((public._wh_setting('physical_layer')->>'mint_lpns')::boolean, false);
  v_cartons jsonb;
  v_lpn_result jsonb;
BEGIN
  SELECT * INTO v_shipment FROM freight_shipments WHERE id = p_shipment_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'shipment not found');
  END IF;
  IF v_shipment.receipt_confirmed_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'already_confirmed', true,
                              'confirmed_at', v_shipment.receipt_confirmed_at);
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('line_item_id', id, 'units', quantity - quantity_received)), '[]'::jsonb),
         count(*)
    INTO v_entries, v_lines
    FROM freight_line_items
   WHERE freight_shipment_id = p_shipment_id AND sku_id IS NOT NULL
     AND quantity_received < quantity;

  SELECT count(*) INTO v_non_catalog
    FROM freight_line_items
   WHERE freight_shipment_id = p_shipment_id AND sku_id IS NULL;

  IF v_lines = 0 THEN
    -- nothing left to credit; just stamp confirmation (and square the carton plan)
    UPDATE freight_carton_groups
       SET received_cartons = carton_qty, updated_at = now()
     WHERE freight_shipment_id = p_shipment_id AND received_cartons < carton_qty;
    UPDATE freight_shipments
       SET status = 'delivered',
           actual_arrival_date = COALESCE(actual_arrival_date, CURRENT_DATE),
           receipt_confirmed_at = now(), receipt_confirmed_by = p_actor_id
     WHERE id = p_shipment_id;
    RETURN jsonb_build_object('ok', true, 'line_items_processed', 0,
                              'non_catalog_skipped', v_non_catalog, 'confirmed_at', now());
  END IF;

  IF v_mint THEN
    -- LPNs need carton entries: the remaining cartons of the plan first...
    SELECT COALESCE(jsonb_agg(jsonb_build_object('carton_group_id', id, 'cartons', carton_qty - received_cartons)
                              ORDER BY sort_order, created_at, id), '[]'::jsonb)
      INTO v_cartons
      FROM freight_carton_groups
     WHERE freight_shipment_id = p_shipment_id AND received_cartons < carton_qty;
    IF jsonb_array_length(v_cartons) > 0 THEN
      v_lpn_result := rpc_record_freight_receipt(p_shipment_id, v_cartons, p_actor_id);
      IF NOT COALESCE((v_lpn_result->>'ok')::boolean, false) THEN
        RETURN v_lpn_result;
      END IF;
      -- ...then any line still short (units outside the carton plan) as loose units
      SELECT COALESCE(jsonb_agg(jsonb_build_object('line_item_id', id, 'units', quantity - quantity_received)), '[]'::jsonb)
        INTO v_entries
        FROM freight_line_items
       WHERE freight_shipment_id = p_shipment_id AND sku_id IS NOT NULL
         AND quantity_received < quantity;
    END IF;
  END IF;

  IF jsonb_array_length(v_entries) > 0 THEN
    v_result := rpc_record_freight_receipt(p_shipment_id, v_entries, p_actor_id);
    IF NOT COALESCE((v_result->>'ok')::boolean, false) THEN
      RETURN v_result;
    END IF;
  END IF;
  -- Receive-all credits by line; keep the carton plan consistent so
  -- carton counts never read 0 on a fully received shipment.
  UPDATE freight_carton_groups
     SET received_cartons = carton_qty, updated_at = now()
   WHERE freight_shipment_id = p_shipment_id AND received_cartons < carton_qty;
  RETURN jsonb_build_object('ok', true, 'line_items_processed', v_lines,
                            'non_catalog_skipped', v_non_catalog, 'confirmed_at', now(),
                            'print_job_id', v_lpn_result->>'print_job_id',
                            'lpns_minted', COALESCE(jsonb_array_length(v_lpn_result->'lpns'), 0));
END;
$function$;

-- -------------------------------------------------------------
-- D. _wh_label_payload — carton_of is the shipment's carton plan
-- -------------------------------------------------------------
-- 20261022000004's body with one change: carton_of counted the cartons
-- minted so far, so a first check-in printed "carton 1 of 1". It is now
-- the larger of the planned cartons and the live cartons on the shipment.
CREATE OR REPLACE FUNCTION public._wh_label_payload(p_kind text, p_ids uuid[], p_practice boolean)
RETURNS jsonb
LANGUAGE plpgsql STABLE
SET search_path = public
AS $$
DECLARE
  v_pre    text := CASE WHEN p_practice THEN '%Z' ELSE '%' END;
  v_labels jsonb;
BEGIN
  IF p_kind IN ('lpn', 'lpn_rts') THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'id', c.id, 'code', c.code, 'barcode', v_pre || c.code,
             'sku', ps.sku, 'product_name', ps.product_name,
             'contents', CASE WHEN c.sku_id IS NULL THEN 'MIXED ' || COALESCE(mx.txt, '') ELSE ps.sku END,
             'qty', CASE WHEN c.qty > 0 THEN c.qty ELSE c.qty_initial END,
             'bucket', bk.bucket, 'label_stock', c.label_stock,
             'shipment', fs.shipment_number, 'carton_seq', c.carton_seq, 'carton_of', so.n,
             'worker', public._wh_first_name(c.finished_by), 'finished_at', c.finished_at,
             'suggested', sl.code, 'from_code', pc.code,
             'date', to_char(COALESCE(c.finished_at, c.created_at) AT TIME ZONE 'America/New_York', 'YYYY-MM-DD'))
           ORDER BY array_position(p_ids, c.id)), '[]'::jsonb)
      INTO v_labels
      FROM public.wh_containers c
      LEFT JOIN public.product_skus ps ON ps.id = c.sku_id
      LEFT JOIN public.freight_shipments fs ON fs.id = c.freight_shipment_id
      LEFT JOIN public.wh_containers pc ON pc.id = c.parent_container_id
      LEFT JOIN LATERAL (
        SELECT string_agg(s2.sku || '×' || b2.on_hand, ' + ' ORDER BY s2.sku) AS txt
          FROM public.wh_inventory_balances b2 JOIN public.product_skus s2 ON s2.id = b2.sku_id
         WHERE b2.container_id = c.id AND b2.on_hand > 0) mx ON true
      LEFT JOIN LATERAL (
        SELECT b3.bucket FROM public.wh_inventory_balances b3
         WHERE b3.container_id = c.id AND b3.on_hand > 0
         GROUP BY b3.bucket ORDER BY sum(b3.on_hand) DESC LIMIT 1) bk ON true
      LEFT JOIN LATERAL (
        SELECT CASE WHEN c.freight_shipment_id IS NULL THEN 0
                    ELSE GREATEST(
                           COALESCE((SELECT sum(g4.carton_qty)::int FROM public.freight_carton_groups g4
                                      WHERE g4.freight_shipment_id = c.freight_shipment_id), 0),
                           (SELECT count(*)::int FROM public.wh_containers c4
                             WHERE c4.freight_shipment_id = c.freight_shipment_id AND c4.state <> 'void'))
               END AS n) so ON true
      LEFT JOIN LATERAL (
        SELECT l5.code FROM public.wh_moves m5 JOIN public.wh_locations l5 ON l5.id = m5.suggested_location_id
         WHERE m5.container_id = c.id AND m5.kind = 'putaway' AND m5.status IN ('open', 'in_progress')
         ORDER BY m5.created_at DESC LIMIT 1) sl ON true
     WHERE c.id = ANY (p_ids);
  ELSE
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'id', l.id, 'code', l.code, 'barcode', v_pre || l.code, 'name', l.name, 'kind', l.kind,
             'words', CASE WHEN l.kind = 'bay_level'
                           THEN 'Face ' || l.face || ' · Bay ' || lpad(l.bay::text, 2, '0') || ' · Level ' || l.level
                           ELSE COALESCE(l.name, l.code) END,
             'overflow', l.is_overflow)
           ORDER BY array_position(p_ids, l.id)), '[]'::jsonb)
      INTO v_labels
      FROM public.wh_locations l
     WHERE l.id = ANY (p_ids);
  END IF;
  RETURN jsonb_build_object('kind', p_kind, 'practice', p_practice,
                            'size', CASE WHEN p_kind IN ('lpn', 'lpn_rts') THEN '4x2' ELSE '3x1' END,
                            'labels', v_labels);
END;
$$;

-- -------------------------------------------------------------
-- E. Grants
-- -------------------------------------------------------------
REVOKE ALL ON FUNCTION public._freight_lpn_bucket(uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._freight_mint_cartons(uuid, uuid, integer, integer, uuid, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._freight_void_cartons(uuid, integer, integer, jsonb, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._freight_receive_loose(uuid, uuid, text, integer, uuid, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._wh_label_payload(text, uuid[], boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._freight_credit_units(uuid, text, uuid, int, boolean, uuid) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.rpc_record_freight_receipt(uuid, jsonb, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_record_freight_receipt(uuid, jsonb, uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.rpc_apply_freight_delivery(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_apply_freight_delivery(uuid, uuid) TO authenticated, service_role;

COMMIT;
