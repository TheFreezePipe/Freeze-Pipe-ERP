-- =============================================================
-- Migration: Warehouse Phase 1 RPCs — scan, putaway, moves, cartons
--            through manufacturing, counts, write-offs, labels and
--            stations, opening stock, overview (Phase 1, slice 1)
-- =============================================================
-- Design: docs/design/WAREHOUSE_MODULE_PHASE0_1.md §5.1-§5.5, §5.7,
-- §9.4 (wh_location_summary), §9.6 step 4 (import).
--
-- Finding: the floor needs one-scan RPCs that move stock through the
-- single writer (_wh_post_movement), keep cartons addressed through
-- manufacturing, and route labels to the printer at the worker's
-- station. Phase 0's role gates compared current_user with 'postgres',
-- which is always true inside a SECURITY DEFINER function (verified on
-- staging 2026-10-22: a supplier could run rpc_wh_import_sku_master).
-- Decision:
--   * Envelope {ok:true,...} / {ok:false, error, message}; messages name
--     the carton and location codes. Roles via _wh_require_role, actor
--     via _wh_actor (auth.uid(); p_actor_id only from service_role or
--     the postgres session, for smoke tests).
--   * Phone RPCs take p_client_event_id: a repeat returns the stored
--     first result with duplicate:true (wh_client_events), serialised
--     by an advisory lock on the event id. Only ok results are stored.
--   * rpc_wh_resolve_scan keeps its Phase 0 signature and gtin/sku
--     answers, and adds: '%'-prefixed ERP labels → location | station |
--     container (a voided parent resolves to its green child with the
--     relabel message), '%Z' → practice (resolved normally only while
--     outbound mode is 'practice', deviation: staging practice labels
--     must work on the practice floor), ^#^HEX^ → shipstation_order, and
--     unprefixed location/carton codes when nothing else matched.
--   * _wh_suggest_putaway follows §5.4; for RTS cartons (origin 'rts')
--     the SKU's pick face comes first when it has room (§5.7 step 5).
--   * rpc_wh_approve_variance applies the variance as a delta to the bin
--     (robust to movements after the count); accept and write_off write
--     inventory_transactions through _wh_ledger_post, the same shape as
--     rpc_cycle_count / rpc_bulk_cycle_count (lock the levels row, EXECUTE
--     the bucket update, insert the ledger row; the hash-chain trigger
--     chains it). Non-finished buckets floor at zero as today.
--   * write_off only for lines counted short; a carton counted here but
--     booked elsewhere is moved here before the difference is applied.
--   * Printing (§5.5): target = named printer, else the caller's live
--     station printer whose label_stock fits (green_4x2 for lpn_rts),
--     else the browser. outbound 'practice' forces the browser with %Z
--     barcodes; 'blocked' refuses rpc_wh_request_labels, while jobs that
--     other RPCs queue (the RTS relabel) are stored as status 'blocked'.
--     A failed agent print returns to the queue until
--     printing.max_attempts.
--   * rpc_wh_claim_print_jobs / rpc_wh_agent_heartbeat: only a profile
--     with is_print_agent, or service_role. FOR UPDATE SKIP LOCKED; a
--     claim older than printing.claim_timeout_s is released first.
--   * rpc_wh_rts_relabel is dormant ({ok:true, dormant:true}) until
--     physical_layer.live_since has passed.
--   * rpc_wh_import_stock: dry run first; applying refuses while any row
--     is rejected; C-OB-nnnn sealed cartons plus one open carton (or
--     loose units with "loose": true), opening_balance movements, no
--     ledger row.
--   * The Phase 0 RPCs rpc_wh_import_sku_master, rpc_wh_barcode_coverage
--     and rpc_wh_baseline_kpis are re-issued with the same bodies and
--     the corrected guard (section Z), a deviation outside the slice
--     because the old guard let any signed-in user through.
--
-- Smoke after deploy (random ids return *_not_found; a relation error fails):
--   SELECT public.rpc_wh_resolve_scan('%02-01-2');                                  -- {ok:true, kind:'unknown'|'location'}
--   SELECT public.rpc_wh_resolve_scan('102696441041');                              -- {ok:true, kind:'gtin',...}
--   SELECT public.rpc_wh_suggest_putaway(gen_random_uuid(), '{}');                  -- container_not_found
--   SELECT public.rpc_wh_putaway_container(gen_random_uuid(), gen_random_uuid());   -- container_not_found
--   SELECT public.rpc_wh_move_stock((SELECT id FROM product_skus LIMIT 1), 1, (SELECT id FROM wh_locations WHERE code='IN-01'), (SELECT id FROM wh_locations WHERE code='SPARES-01')); -- insufficient
--   SELECT public.rpc_wh_open_container(gen_random_uuid());                         -- container_not_found
--   SELECT public.rpc_wh_take_to_line(gen_random_uuid());                           -- container_not_found
--   SELECT public.rpc_wh_rts_relabel(gen_random_uuid(), '[{"qty":1}]');             -- {ok:true, dormant:true}
--   SELECT public.rpc_wh_record_count(gen_random_uuid(), '[]');                     -- location_not_found
--   SELECT public.rpc_wh_approve_variance(gen_random_uuid(), '[]');                 -- task_not_found
--   SELECT public.rpc_wh_create_count(ARRAY[gen_random_uuid()]);                    -- {ok:true, missing:[...]}
--   SELECT public.rpc_wh_write_off(gen_random_uuid(), gen_random_uuid(), NULL, 1, 'smoke'); -- sku_not_found
--   SELECT public.rpc_wh_request_labels('location', ARRAY[gen_random_uuid()], 'desktop'); -- items_not_found
--   SELECT public.rpc_wh_mark_printed(gen_random_uuid(), 'printed');                -- job_not_found
--   SELECT public.rpc_wh_start_station('%NOPE');                                    -- not_a_station
--   SELECT public.rpc_wh_end_station();                                             -- {ok:true, ended:null}
--   SELECT public.rpc_wh_claim_print_jobs(ARRAY[gen_random_uuid()], 'smoke');       -- {ok:true, jobs:[]}
--   SELECT public.rpc_wh_agent_heartbeat('smoke', ARRAY[gen_random_uuid()]);        -- {ok:true, printers:0}
--   SELECT public.rpc_wh_import_stock('[]'::jsonb, true);                           -- {ok:true, dry_run:true, rows:0}
--   SELECT public.rpc_wh_overview();                                                -- {ok:true,...}
--   SELECT count(*) FROM public.wh_location_summary;                                -- >= 17
--   SELECT public.rpc_wh_import_sku_master('[]'::jsonb, true);                      -- {ok:true,...}
--   SELECT public.rpc_wh_barcode_coverage();                                        -- {ok:true,...}
--   SELECT public.rpc_wh_baseline_kpis(current_date - 14, current_date);            -- {ok:true,...}
-- =============================================================

BEGIN;

-- =============================================================
-- A. Small helpers (not executable by clients)
-- =============================================================
CREATE OR REPLACE FUNCTION public._wh_loc_id(p_code text)
RETURNS uuid
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT id FROM public.wh_locations WHERE site_location_id = public._default_location_id() AND code = p_code;
$$;

CREATE OR REPLACE FUNCTION public._wh_live()
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT COALESCE((SELECT (s.value->>'live_since')::timestamptz <= now()
                     FROM public.wh_settings s
                    WHERE s.key = 'physical_layer' AND s.value->>'live_since' IS NOT NULL), false);
$$;

CREATE OR REPLACE FUNCTION public._wh_outbound_mode()
RETURNS text
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT COALESCE((SELECT value->>'mode' FROM public.wh_settings WHERE key = 'outbound'), 'blocked');
$$;

CREATE OR REPLACE FUNCTION public._wh_first_name(p_profile uuid)
RETURNS text
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT NULLIF(split_part(btrim(full_name), ' ', 1), '') FROM public.profiles WHERE id = p_profile;
$$;

CREATE OR REPLACE FUNCTION public._wh_loc_json(p_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object('id', l.id, 'code', l.code, 'name', l.name, 'kind', l.kind, 'zone', l.zone,
                            'pickable', l.pickable, 'is_overflow', l.is_overflow, 'active', l.active)
    FROM public.wh_locations l WHERE l.id = p_id;
$$;

CREATE OR REPLACE FUNCTION public._wh_ctr_json(p_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object('id', c.id, 'code', c.code, 'sku_id', c.sku_id, 'sku', ps.sku, 'product_name', ps.product_name,
                            'qty', c.qty, 'qty_initial', c.qty_initial, 'state', c.state, 'label_stock', c.label_stock,
                            'location_id', c.location_id, 'location_code', l.code, 'parent_container_id', c.parent_container_id,
                            'superseded_by', c.superseded_by, 'finished_by', c.finished_by, 'finished_at', c.finished_at)
    FROM public.wh_containers c
    LEFT JOIN public.product_skus ps ON ps.id = c.sku_id
    LEFT JOIN public.wh_locations l ON l.id = c.location_id
   WHERE c.id = p_id;
$$;

CREATE OR REPLACE FUNCTION public._wh_is_print_agent()
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT public._wh_is_service_call()
      OR EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_active AND is_print_agent);
$$;

-- Idempotency: replay the stored first result of a phone call.
CREATE OR REPLACE FUNCTION public._wh_event_replay(p_event uuid, p_rpc text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_row public.wh_client_events%ROWTYPE;
BEGIN
  IF p_event IS NULL THEN
    RETURN NULL;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('wh_client_event:' || p_event::text, 0));
  SELECT * INTO v_row FROM public.wh_client_events WHERE client_event_id = p_event;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF v_row.rpc <> p_rpc THEN
    RETURN public._wh_err('client_event_reused', 'This scan was already recorded by ' || v_row.rpc || '; send a new client_event_id.');
  END IF;
  RETURN v_row.result || jsonb_build_object('duplicate', true);
END;
$$;

CREATE OR REPLACE FUNCTION public._wh_event_store(p_event uuid, p_rpc text, p_actor uuid, p_result jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF p_event IS NOT NULL AND COALESCE((p_result->>'ok')::boolean, false) THEN
    INSERT INTO public.wh_client_events (client_event_id, rpc, actor_id, result)
    VALUES (p_event, p_rpc, p_actor, p_result)
    ON CONFLICT (client_event_id) DO NOTHING;
  END IF;
  RETURN p_result;
END;
$$;

-- -------------------------------------------------------------
-- Ledger path: inventory_levels + inventory_transactions, the shape
-- rpc_cycle_count / rpc_bulk_cycle_count use. Types:
--   wh_count_adjust  net_change, p_qty signed
--   wh_write_off     write_off, p_qty = units removed, stored positive
--   wh_bucket_move   category_move p_bucket → p_to_bucket, p_qty > 0
-- Non-finished buckets floor at zero (the CHECKs on inventory_levels);
-- the applied amount comes back in `delta` / `moved` with `clamped`.
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._wh_ledger_post(
  p_sku uuid, p_type text, p_bucket text, p_to_bucket text, p_qty integer,
  p_ref_type text, p_ref_id uuid, p_actor uuid, p_note text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_field text := 'warehouse_' || p_bucket;
  v_to    text := CASE WHEN p_to_bucket IS NOT NULL THEN 'warehouse_' || p_to_bucket END;
  v_sku   text;
  v_cur   integer;
  v_qty   integer := p_qty;
  v_tx    uuid;
BEGIN
  IF p_type NOT IN ('wh_count_adjust', 'wh_write_off', 'wh_bucket_move') THEN
    RAISE EXCEPTION '_wh_ledger_post: unknown type %', p_type;
  END IF;
  IF p_bucket NOT IN ('raw', 'prefilled_raw', 'in_production', 'finished', 'other') THEN
    RAISE EXCEPTION '_wh_ledger_post: unknown bucket %', p_bucket;
  END IF;
  SELECT sku INTO v_sku FROM public.product_skus WHERE id = p_sku;

  PERFORM 1 FROM public.inventory_levels WHERE sku_id = p_sku FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO public.inventory_levels (sku_id, location_id) VALUES (p_sku, public._default_location_id())
    ON CONFLICT DO NOTHING;
    PERFORM 1 FROM public.inventory_levels WHERE sku_id = p_sku FOR UPDATE;
  END IF;
  EXECUTE format('SELECT COALESCE(%I, 0) FROM public.inventory_levels WHERE sku_id = $1', v_field) INTO v_cur USING p_sku;

  IF p_type = 'wh_count_adjust' THEN
    IF v_field <> 'warehouse_finished' AND v_cur + v_qty < 0 THEN
      v_qty := -v_cur;
    END IF;
    IF v_qty = 0 THEN
      RETURN jsonb_build_object('tx_id', NULL, 'delta', 0, 'requested', p_qty, 'clamped', p_qty <> 0);
    END IF;
    EXECUTE format('UPDATE public.inventory_levels SET %I = COALESCE(%I, 0) + $1 WHERE sku_id = $2', v_field, v_field)
      USING v_qty, p_sku;
    INSERT INTO public.inventory_transactions (sku_id, transaction_type, quantity, field_affected, movement_kind,
                                               reference_id, reference_type, notes, performed_by)
    VALUES (p_sku, p_type, v_qty, v_field, 'net_change', p_ref_id, p_ref_type,
            format('%s: %s%s on %s (%s)', v_sku, CASE WHEN v_qty > 0 THEN '+' ELSE '' END, v_qty, v_field, COALESCE(p_note, 'warehouse count')),
            p_actor)
    RETURNING id INTO v_tx;
    RETURN jsonb_build_object('tx_id', v_tx, 'delta', v_qty, 'requested', p_qty, 'clamped', v_qty <> p_qty);

  ELSIF p_type = 'wh_write_off' THEN
    IF p_qty IS NULL OR p_qty <= 0 THEN
      RAISE EXCEPTION '_wh_ledger_post: write-off quantity must be positive';
    END IF;
    IF v_field <> 'warehouse_finished' THEN
      v_qty := LEAST(p_qty, GREATEST(v_cur, 0));
    END IF;
    IF v_qty = 0 THEN
      RETURN jsonb_build_object('tx_id', NULL, 'delta', 0, 'requested', -p_qty, 'clamped', true);
    END IF;
    EXECUTE format('UPDATE public.inventory_levels SET %I = COALESCE(%I, 0) - $1 WHERE sku_id = $2', v_field, v_field)
      USING v_qty, p_sku;
    INSERT INTO public.inventory_transactions (sku_id, transaction_type, quantity, field_affected, movement_kind,
                                               from_field, to_field, reference_id, reference_type, notes, performed_by)
    VALUES (p_sku, p_type, v_qty, v_field, 'write_off', v_field, NULL, p_ref_id, p_ref_type,
            format('%s: write-off of %s units from %s (%s)', v_sku, v_qty, v_field, COALESCE(p_note, 'warehouse write-off')),
            p_actor)
    RETURNING id INTO v_tx;
    RETURN jsonb_build_object('tx_id', v_tx, 'delta', -v_qty, 'requested', -p_qty, 'clamped', v_qty <> p_qty);

  ELSE
    IF p_qty IS NULL OR p_qty <= 0 OR v_to IS NULL OR v_to = v_field THEN
      RAISE EXCEPTION '_wh_ledger_post: a bucket move needs a positive quantity and two different buckets';
    END IF;
    IF v_field <> 'warehouse_finished' THEN
      v_qty := LEAST(p_qty, GREATEST(v_cur, 0));
    END IF;
    IF v_qty = 0 THEN
      RETURN jsonb_build_object('tx_id', NULL, 'delta', 0, 'moved', 0, 'requested', p_qty, 'clamped', true);
    END IF;
    EXECUTE format('UPDATE public.inventory_levels SET %I = COALESCE(%I, 0) - $1, %I = COALESCE(%I, 0) + $1 WHERE sku_id = $2',
                   v_field, v_field, v_to, v_to)
      USING v_qty, p_sku;
    INSERT INTO public.inventory_transactions (sku_id, transaction_type, quantity, field_affected, movement_kind,
                                               from_field, to_field, reference_id, reference_type, notes, performed_by)
    VALUES (p_sku, p_type, v_qty, v_to, 'category_move', v_field, v_to, p_ref_id, p_ref_type,
            format('%s: %s units %s → %s (%s)', v_sku, v_qty, v_field, v_to, COALESCE(p_note, 'warehouse bucket lock')),
            p_actor)
    RETURNING id INTO v_tx;
    RETURN jsonb_build_object('tx_id', v_tx, 'delta', 0, 'moved', v_qty, 'requested', p_qty, 'clamped', v_qty <> p_qty);
  END IF;
END;
$$;

-- A balance move that honours the destination's bucket_lock: the units
-- change bucket on the way (movement to_bucket) and a wh_bucket_move
-- ledger row moves the SKU total between the levels columns.
CREATE OR REPLACE FUNCTION public._wh_move_balance(
  p_group uuid, p_type text, p_sku uuid, p_bucket text, p_qty integer,
  p_from_loc uuid, p_from_ctr uuid, p_to_loc uuid, p_to_ctr uuid,
  p_actor uuid, p_ref_type text, p_ref_id uuid, p_note text, p_event uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_lock text;
  v_code text;
  v_led  jsonb;
  v_tx   uuid;
  v_mv   uuid;
BEGIN
  SELECT bucket_lock, code INTO v_lock, v_code FROM public.wh_locations WHERE id = p_to_loc;
  IF v_lock IS NOT NULL AND v_lock <> p_bucket THEN
    v_led := public._wh_ledger_post(p_sku, 'wh_bucket_move', p_bucket, v_lock, p_qty, 'wh_movement', p_group, p_actor,
                                    'bucket lock at ' || v_code);
    v_tx := NULLIF(v_led->>'tx_id', '')::uuid;
  ELSE
    v_lock := NULL;
  END IF;
  v_mv := public._wh_post_movement(p_group, p_type, p_sku, p_bucket, p_qty, p_from_loc, p_from_ctr, p_to_loc, p_to_ctr,
                                   v_lock, p_actor, p_ref_type, p_ref_id, p_note, p_event, v_tx);
  RETURN jsonb_build_object('movement_id', v_mv, 'to_bucket', COALESCE(v_lock, p_bucket), 'ledger_tx_id', v_tx);
END;
$$;

-- A location is full once its live cartons plus open putaways pointed
-- at it reach capacity_cartons.
CREATE OR REPLACE FUNCTION public._wh_loc_full(p_location_id uuid)
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT COALESCE(l.capacity_cartons IS NOT NULL AND (
           (SELECT count(*) FROM public.wh_containers c WHERE c.location_id = l.id AND c.state IN ('sealed', 'open'))
         + (SELECT count(*) FROM public.wh_moves m
             WHERE m.suggested_location_id = l.id AND m.kind = 'putaway' AND m.status IN ('open', 'in_progress'))
         ) >= l.capacity_cartons, false)
    FROM public.wh_locations l WHERE l.id = p_location_id;
$$;

-- -------------------------------------------------------------
-- _wh_suggest_putaway (§5.4): first match wins; a candidate is skipped
-- if excluded, inactive, virtual, bucket-locked to another bucket or
-- full. Returns {location_id, code, reason}.
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._wh_suggest_putaway(
  p_container_id uuid, p_exclude uuid[] DEFAULT '{}', p_sku_id uuid DEFAULT NULL,
  p_bucket text DEFAULT NULL, p_origin text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE
SET search_path = public
AS $$
DECLARE
  v_ctr     public.wh_containers%ROWTYPE;
  v_sku     uuid := p_sku_id;
  v_bucket  text := p_bucket;
  v_excl    uuid[] := COALESCE(p_exclude, '{}');
  v_face    public.wh_locations%ROWTYPE;
  v_anchor  public.wh_locations%ROWTYPE;
  v_zone    text;
  v_id      uuid;
  v_code    text;
  v_break   text;
BEGIN
  IF p_container_id IS NOT NULL THEN
    SELECT * INTO v_ctr FROM public.wh_containers WHERE id = p_container_id;
    IF FOUND THEN
      v_sku := COALESCE(v_ctr.sku_id, v_sku);
      IF v_ctr.location_id IS NOT NULL THEN
        v_excl := v_excl || v_ctr.location_id;
      END IF;
      IF v_bucket IS NULL THEN
        SELECT b.bucket INTO v_bucket FROM public.wh_inventory_balances b
         WHERE b.container_id = p_container_id AND b.on_hand > 0
         GROUP BY b.bucket ORDER BY sum(b.on_hand) DESC LIMIT 1;
      END IF;
    END IF;
  END IF;
  v_bucket := COALESCE(v_bucket, 'finished');

  -- 1. mixed carton → the break-down shelf
  IF v_ctr.id IS NOT NULL AND v_ctr.sku_id IS NULL THEN
    v_break := public._wh_setting('putaway')->>'breakdown_location_code';
    IF v_break IS NOT NULL THEN
      SELECT l.id, l.code INTO v_id, v_code FROM public.wh_locations l
       WHERE l.site_location_id = public._default_location_id() AND l.code = v_break
         AND l.active AND l.kind NOT IN ('virtual', 'station') AND NOT (l.id = ANY (v_excl))
         AND NOT public._wh_loc_full(l.id);
      IF v_id IS NOT NULL THEN
        RETURN jsonb_build_object('location_id', v_id, 'code', v_code, 'reason', 'breakdown_shelf');
      END IF;
    END IF;
  END IF;

  -- the SKU's pick face: a pickable location holding an open carton or loose units of it
  IF v_sku IS NOT NULL THEN
    SELECT l.* INTO v_face FROM public.wh_locations l
      JOIN public.wh_inventory_balances b ON b.location_id = l.id
      LEFT JOIN public.wh_containers c ON c.id = b.container_id
     WHERE l.pickable AND l.active AND b.sku_id = v_sku AND b.bucket = v_bucket AND b.on_hand > 0
       AND (b.container_id IS NULL OR c.state = 'open')
     ORDER BY l.pick_sequence NULLS LAST, l.code
     LIMIT 1;
  END IF;
  v_anchor := v_face;
  IF v_anchor.id IS NULL AND v_sku IS NOT NULL THEN
    SELECT l.* INTO v_anchor FROM public.wh_locations l
      JOIN public.wh_inventory_balances b ON b.location_id = l.id
     WHERE l.pickable AND l.active AND b.sku_id = v_sku
     ORDER BY b.last_movement_at DESC NULLS LAST, l.pick_sequence NULLS LAST
     LIMIT 1;
  END IF;
  IF v_anchor.id IS NULL THEN
    SELECT * INTO v_anchor FROM public.wh_locations
     WHERE site_location_id = public._default_location_id() AND code = 'IN-01';
  END IF;

  -- RTS cartons: the SKU's pick face first when it has room (§5.7 step 5)
  IF p_origin = 'rts' AND v_face.id IS NOT NULL AND NOT (v_face.id = ANY (v_excl))
     AND (v_face.bucket_lock IS NULL OR v_face.bucket_lock = v_bucket) AND NOT public._wh_loc_full(v_face.id) THEN
    RETURN jsonb_build_object('location_id', v_face.id, 'code', v_face.code, 'reason', 'same_sku_face');
  END IF;

  IF v_sku IS NOT NULL THEN
    -- 2. same-SKU reserve: non-pickable or overflow holding sealed cartons of the SKU and bucket
    SELECT l.id, l.code INTO v_id, v_code FROM public.wh_locations l
     WHERE l.active AND l.kind = 'bay_level' AND (NOT l.pickable OR l.is_overflow)
       AND NOT (l.id = ANY (v_excl)) AND (l.bucket_lock IS NULL OR l.bucket_lock = v_bucket)
       AND EXISTS (SELECT 1 FROM public.wh_containers c
                     JOIN public.wh_inventory_balances b ON b.container_id = c.id AND b.location_id = l.id
                    WHERE c.location_id = l.id AND c.state = 'sealed' AND b.sku_id = v_sku
                      AND b.bucket = v_bucket AND b.on_hand > 0)
       AND NOT public._wh_loc_full(l.id)
     ORDER BY abs(COALESCE(l.pick_sequence, 999999) - COALESCE(v_anchor.pick_sequence, 0)), l.code
     LIMIT 1;
    IF v_id IS NOT NULL THEN
      RETURN jsonb_build_object('location_id', v_id, 'code', v_code, 'reason', 'same_sku_reserve');
    END IF;

    -- 3. same-SKU face, when no pickable location holds an open carton or loose units
    IF v_face.id IS NULL THEN
      SELECT l.id, l.code INTO v_id, v_code FROM public.wh_locations l
        JOIN public.wh_inventory_balances b ON b.location_id = l.id AND b.sku_id = v_sku
       WHERE l.pickable AND l.active AND NOT (l.id = ANY (v_excl))
         AND (l.bucket_lock IS NULL OR l.bucket_lock = v_bucket) AND NOT public._wh_loc_full(l.id)
       ORDER BY b.last_movement_at DESC NULLS LAST, l.pick_sequence NULLS LAST
       LIMIT 1;
      IF v_id IS NOT NULL THEN
        RETURN jsonb_build_object('location_id', v_id, 'code', v_code, 'reason', 'same_sku_face');
      END IF;
    END IF;
  END IF;

  -- 4. nearest empty location in the bucket's default zone (RTS: overflow first)
  v_zone := CASE v_bucket WHEN 'raw' THEN 'RAW' WHEN 'prefilled_raw' THEN 'RAW' WHEN 'finished' THEN 'RTS'
                          WHEN 'in_production' THEN 'WIP' ELSE 'MISC' END;
  SELECT l.id, l.code INTO v_id, v_code FROM public.wh_locations l
   WHERE l.active AND l.kind = 'bay_level' AND l.zone = v_zone
     AND NOT (l.id = ANY (v_excl)) AND (l.bucket_lock IS NULL OR l.bucket_lock = v_bucket)
     AND NOT public._wh_location_has_stock(l.id)
     AND NOT EXISTS (SELECT 1 FROM public.wh_moves m
                      WHERE m.suggested_location_id = l.id AND m.kind = 'putaway' AND m.status IN ('open', 'in_progress'))
   ORDER BY CASE WHEN v_zone = 'RTS' AND l.is_overflow THEN 0 ELSE 1 END,
            CASE WHEN l.x_mm IS NOT NULL AND v_anchor.x_mm IS NOT NULL
                 THEN sqrt(power(l.x_mm - v_anchor.x_mm, 2) + power(COALESCE(l.y_mm, 0) - COALESCE(v_anchor.y_mm, 0), 2))
                 ELSE 1e9 + abs(COALESCE(l.pick_sequence, 999999) - COALESCE(v_anchor.pick_sequence, 0)) END,
            l.code
   LIMIT 1;
  IF v_id IS NOT NULL THEN
    RETURN jsonb_build_object('location_id', v_id, 'code', v_code, 'reason', 'nearest_empty');
  END IF;

  -- 5. nearest empty storable location anywhere (zones are defaults)
  SELECT l.id, l.code INTO v_id, v_code FROM public.wh_locations l
   WHERE l.active AND l.kind = 'bay_level'
     AND NOT (l.id = ANY (v_excl)) AND (l.bucket_lock IS NULL OR l.bucket_lock = v_bucket)
     AND NOT public._wh_location_has_stock(l.id)
     AND NOT EXISTS (SELECT 1 FROM public.wh_moves m
                      WHERE m.suggested_location_id = l.id AND m.kind = 'putaway' AND m.status IN ('open', 'in_progress'))
   ORDER BY CASE WHEN l.x_mm IS NOT NULL AND v_anchor.x_mm IS NOT NULL
                 THEN sqrt(power(l.x_mm - v_anchor.x_mm, 2) + power(COALESCE(l.y_mm, 0) - COALESCE(v_anchor.y_mm, 0), 2))
                 ELSE 1e9 + abs(COALESCE(l.pick_sequence, 999999) - COALESCE(v_anchor.pick_sequence, 0)) END,
            l.code
   LIMIT 1;
  IF v_id IS NOT NULL THEN
    RETURN jsonb_build_object('location_id', v_id, 'code', v_code, 'reason', 'other_zone_empty');
  END IF;

  -- 6. none: the receiver scans any location
  RETURN jsonb_build_object('location_id', NULL, 'code', NULL, 'reason', 'none');
END;
$$;

-- -------------------------------------------------------------
-- Label payloads (rendered by src/lib/warehouse/labels.ts or the agent)
-- -------------------------------------------------------------
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
        SELECT count(*) AS n FROM public.wh_containers c4
         WHERE c.freight_shipment_id IS NOT NULL AND c4.freight_shipment_id = c.freight_shipment_id) so ON true
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
-- Print queue (§5.5). Target: the named printer; else the caller's
-- live station printer whose label stock fits; else the browser.
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._wh_queue_print_job(p_kind text, p_ids uuid[], p_from text, p_printer_id uuid, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_mode     text := public._wh_outbound_mode();
  v_stock    text := CASE p_kind WHEN 'lpn' THEN 'white_4x2' WHEN 'lpn_rts' THEN 'green_4x2' ELSE 'white_3x1' END;
  v_require  boolean := COALESCE((public._wh_setting('printing')->>'require_station')::boolean, true);
  v_printer  public.wh_printers%ROWTYPE;
  v_station  uuid;
  v_reason   text;
  v_target   text;
  v_status   text := 'queued';
  v_msg      text;
  v_payload  jsonb;
  v_job      uuid;
BEGIN
  SELECT station_location_id INTO v_station FROM public.wh_station_sessions
   WHERE profile_id = p_actor AND ended_at IS NULL;

  IF p_printer_id IS NOT NULL THEN
    SELECT * INTO v_printer FROM public.wh_printers WHERE id = p_printer_id AND active;
    IF NOT FOUND THEN
      RETURN public._wh_err('printer_not_found', 'That printer does not exist or is inactive.');
    END IF;
    v_reason := 'named';
  ELSIF v_station IS NOT NULL THEN
    SELECT * INTO v_printer FROM public.wh_printers
     WHERE station_location_id = v_station AND active AND label_stock = v_stock
     ORDER BY (transport = 'agent') DESC, last_seen_at DESC NULLS LAST, code
     LIMIT 1;
    v_reason := CASE WHEN v_printer.id IS NOT NULL THEN 'station' ELSE 'no_matching_printer' END;
  ELSE
    v_reason := 'no_station';
  END IF;
  v_target := CASE WHEN v_printer.id IS NOT NULL AND v_printer.transport = 'agent' THEN 'printer' ELSE 'browser' END;

  IF v_mode = 'blocked' THEN
    v_status := 'blocked';
    v_target := 'none';
    v_msg := 'Printing is blocked on this environment (outbound mode is blocked).';
  ELSIF v_mode = 'practice' AND v_target = 'printer' THEN
    v_target := 'browser';
    v_reason := 'practice';
    v_msg := 'Practice mode prints from the browser, with a PRACTICE band.';
  ELSIF v_target = 'browser' AND v_reason = 'no_station' AND v_require THEN
    v_msg := 'No station session; print from this browser or scan a station label first.';
  ELSIF v_target = 'browser' AND v_reason = 'no_matching_printer' THEN
    v_msg := 'This station has no ' || replace(v_stock, '_', ' ') || ' printer; print from this browser.';
  END IF;

  v_payload := public._wh_label_payload(p_kind, p_ids, v_mode = 'practice');
  INSERT INTO public.wh_print_jobs (kind, item_ids, payload, printer_id, station_location_id, status, requested_by, requested_from)
  VALUES (p_kind, p_ids, v_payload,
          CASE WHEN v_target = 'printer' THEN v_printer.id
               WHEN v_target = 'browser' AND v_printer.transport = 'browser' THEN v_printer.id END,
          v_station, v_status, p_actor, p_from)
  RETURNING id INTO v_job;

  RETURN jsonb_build_object('ok', true, 'job_id', v_job, 'status', v_status, 'target', v_target, 'routed_by', v_reason,
                            'printer', CASE WHEN v_target = 'printer'
                                            THEN jsonb_build_object('id', v_printer.id, 'code', v_printer.code, 'name', v_printer.name) END,
                            'station_location_id', v_station, 'message', v_msg, 'payload', v_payload);
END;
$$;

-- -------------------------------------------------------------
-- ERP label lookup: '%'-stripped code → location | station | container.
-- A voided parent resolves to its live green child.
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._wh_resolve_code(p_code text)
RETURNS jsonb
LANGUAGE plpgsql STABLE
SET search_path = public
AS $$
DECLARE
  v_code    text := upper(btrim(COALESCE(p_code, '')));
  v_ctr     public.wh_containers%ROWTYPE;
  v_loc     public.wh_locations%ROWTYPE;
  v_scanned text;
  v_hops    int := 0;
  v_extra   jsonb := '{}'::jsonb;
BEGIN
  IF v_code = '' THEN
    RETURN NULL;
  END IF;
  IF v_code ~ '^C-' THEN
    SELECT * INTO v_ctr FROM public.wh_containers WHERE upper(code) = v_code;
    IF NOT FOUND THEN
      RETURN NULL;
    END IF;
    v_scanned := v_ctr.code;
    WHILE v_ctr.state = 'void' AND v_ctr.superseded_by IS NOT NULL AND v_hops < 10 LOOP
      SELECT * INTO v_ctr FROM public.wh_containers WHERE id = v_ctr.superseded_by;
      v_hops := v_hops + 1;
    END LOOP;
    IF v_hops > 0 THEN
      v_extra := jsonb_build_object(
        'scanned_code', v_scanned, 'superseded', true,
        'message', format('%s was RTS''d as %s by %s on %s; use the green label.',
                          v_scanned, v_ctr.code, COALESCE(public._wh_first_name(v_ctr.finished_by), 'the line'),
                          to_char(v_ctr.finished_at AT TIME ZONE 'America/New_York', 'Mon FMDD, FMHH12:MI AM')));
    END IF;
    RETURN jsonb_build_object(
             'ok', true, 'kind', 'container', 'id', v_ctr.id, 'code', v_ctr.code,
             'label', COALESCE((SELECT ps.sku FROM public.product_skus ps WHERE ps.id = v_ctr.sku_id), 'MIXED') || ' × ' || v_ctr.qty,
             'match', public._wh_ctr_json(v_ctr.id), 'candidates', '[]'::jsonb) || v_extra;
  END IF;
  IF v_code ~ '^T-' THEN
    RETURN NULL;  -- totes arrive in Phase 2
  END IF;
  SELECT * INTO v_loc FROM public.wh_locations
   WHERE site_location_id = public._default_location_id() AND code = v_code;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  RETURN jsonb_build_object(
           'ok', true, 'kind', CASE WHEN v_loc.kind = 'station' THEN 'station' ELSE 'location' END,
           'id', v_loc.id, 'code', v_loc.code,
           'label', CASE WHEN v_loc.kind = 'bay_level'
                         THEN 'Face ' || v_loc.face || ' · Bay ' || lpad(v_loc.bay::text, 2, '0') || ' · Level ' || v_loc.level
                              || CASE WHEN v_loc.is_overflow THEN ' · Overflow' ELSE '' END
                         ELSE COALESCE(v_loc.name, v_loc.code) END,
           'match', public._wh_loc_json(v_loc.id) || jsonb_build_object('last_counted_at', v_loc.last_counted_at),
           'candidates', '[]'::jsonb);
END;
$$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public._wh_loc_id(text)', 'public._wh_live()', 'public._wh_outbound_mode()', 'public._wh_first_name(uuid)',
    'public._wh_loc_json(uuid)', 'public._wh_ctr_json(uuid)', 'public._wh_is_print_agent()',
    'public._wh_event_replay(uuid, text)', 'public._wh_event_store(uuid, text, uuid, jsonb)',
    'public._wh_ledger_post(uuid, text, text, text, integer, text, uuid, uuid, text)',
    'public._wh_move_balance(uuid, text, uuid, text, integer, uuid, uuid, uuid, uuid, uuid, text, uuid, text, uuid)',
    'public._wh_loc_full(uuid)', 'public._wh_suggest_putaway(uuid, uuid[], uuid, text, text)',
    'public._wh_label_payload(text, uuid[], boolean)', 'public._wh_queue_print_job(text, uuid[], text, uuid, uuid)',
    'public._wh_resolve_code(text)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
  END LOOP;
END $$;

-- =============================================================
-- B. rpc_wh_resolve_scan(p_scan) — Phase 0 signature, superset (§5.2)
-- =============================================================
CREATE OR REPLACE FUNCTION public.rpc_wh_resolve_scan(p_scan text)
RETURNS jsonb AS $$
DECLARE
  v_cands    text[];
  v_match    jsonb;
  v_scan     text := btrim(COALESCE(p_scan, ''));
  v_body     text;
  v_practice boolean := false;
  v_res      jsonb;
  v_order    public.shipstation_orders%ROWTYPE;
  v_order_id bigint;
BEGIN
  IF public._wh_require_role(ARRAY['admin', 'manager', 'user']) IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'internal role required');
  END IF;
  IF v_scan = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'empty scan');
  END IF;

  -- ERP labels: '%' + code ('%Z' marks a practice label)
  IF left(v_scan, 1) = '%' THEN
    v_body := upper(substr(v_scan, 2));
    IF left(v_body, 1) = 'Z' THEN
      IF public._wh_outbound_mode() <> 'practice' THEN
        RETURN jsonb_build_object('ok', true, 'kind', 'practice', 'id', NULL, 'code', substr(v_body, 2), 'label', 'Practice label',
                                  'match', NULL, 'candidates', '[]'::jsonb,
                                  'message', 'This is a practice label from staging; it does not belong to this warehouse.');
      END IF;
      v_body := substr(v_body, 2);
      v_practice := true;
    END IF;
    v_res := public._wh_resolve_code(v_body);
    IF v_res IS NULL THEN
      v_res := jsonb_build_object('ok', true, 'kind', 'unknown', 'id', NULL, 'code', v_body, 'label', NULL,
                                  'match', NULL, 'candidates', '[]'::jsonb,
                                  'message', v_body || ' is not a known location or carton.');
    END IF;
    IF v_practice THEN
      v_res := v_res || jsonb_build_object('practice', true);
    END IF;
    RETURN v_res;
  END IF;

  -- ShipStation packing slip: ^#^HEX^ carries the orderId
  IF v_scan ~ '^\^#\^[0-9A-F]{1,15}\^$' THEN
    v_order_id := ('x' || lpad(substring(v_scan FROM '^\^#\^([0-9A-F]+)\^$'), 16, '0'))::bit(64)::bigint;
    SELECT * INTO v_order FROM public.shipstation_orders WHERE shipstation_order_id = v_order_id LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object('ok', true, 'kind', 'shipstation_order', 'id', v_order.id, 'code', v_order.order_number,
                                'label', 'Order ' || v_order.order_number || ' · ' || v_order.order_status,
                                'match', jsonb_build_object('id', v_order.id, 'order_number', v_order.order_number,
                                                           'order_status', v_order.order_status,
                                                           'shipstation_order_id', v_order.shipstation_order_id),
                                'candidates', '[]'::jsonb);
    END IF;
    RETURN jsonb_build_object('ok', true, 'kind', 'shipstation_order', 'id', NULL, 'code', v_order_id::text, 'label', NULL,
                              'match', NULL, 'candidates', '[]'::jsonb,
                              'message', 'Order ' || v_order_id || ' is not in the ERP yet.');
  END IF;

  -- Phase 0: barcode shapes
  v_cands := public.fn_gtin_candidates(v_scan);
  IF cardinality(v_cands) > 0 THEN
    SELECT jsonb_build_object(
             'sku_id', ps.id, 'sku', ps.sku, 'product_name', ps.product_name,
             'display_category', ps.display_category, 'is_active', ps.is_active,
             'code', b.code, 'symbology', b.symbology)
      INTO v_match
      FROM public.sku_barcodes b
      JOIN public.product_skus ps ON ps.id = b.sku_id
     WHERE b.code = ANY (v_cands)
     ORDER BY array_position(v_cands, b.code)
     LIMIT 1;
    IF v_match IS NOT NULL THEN
      RETURN jsonb_build_object('ok', true, 'kind', 'gtin', 'match', v_match, 'candidates', to_jsonb(v_cands),
                                'id', v_match->>'sku_id', 'code', v_match->>'sku', 'label', v_match->>'product_name');
    END IF;
    v_res := public._wh_resolve_code(v_scan);
    IF v_res IS NOT NULL THEN
      RETURN v_res;
    END IF;
    RETURN jsonb_build_object('ok', true, 'kind', 'gtin', 'match', NULL, 'candidates', to_jsonb(v_cands));
  END IF;

  -- Phase 0: the SKU code itself
  SELECT jsonb_build_object(
           'sku_id', ps.id, 'sku', ps.sku, 'product_name', ps.product_name,
           'display_category', ps.display_category, 'is_active', ps.is_active,
           'code', NULL, 'symbology', NULL)
    INTO v_match
    FROM public.product_skus ps
   WHERE lower(ps.sku) = lower(v_scan)
   LIMIT 1;
  IF v_match IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'kind', 'sku', 'match', v_match, 'candidates', '[]'::jsonb,
                              'id', v_match->>'sku_id', 'code', v_match->>'sku', 'label', v_match->>'product_name');
  END IF;
  -- typed location or carton codes without the '%'
  v_res := public._wh_resolve_code(v_scan);
  IF v_res IS NOT NULL THEN
    RETURN v_res;
  END IF;
  RETURN jsonb_build_object('ok', true, 'kind', 'sku', 'match', NULL, 'candidates', '[]'::jsonb);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- =============================================================
-- C. Putaway
-- =============================================================
CREATE OR REPLACE FUNCTION public.rpc_wh_suggest_putaway(p_container_id uuid, p_exclude uuid[] DEFAULT '{}')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ctr  public.wh_containers%ROWTYPE;
  v_sug  jsonb;
  v_move uuid;
BEGIN
  IF public._wh_require_role(ARRAY['admin', 'manager', 'user']) IS NULL THEN
    RETURN public._wh_err('forbidden', 'Putaway suggestions need an internal account.');
  END IF;
  SELECT * INTO v_ctr FROM public.wh_containers WHERE id = p_container_id;
  IF NOT FOUND THEN
    RETURN public._wh_err('container_not_found', 'That carton does not exist.');
  END IF;
  IF v_ctr.state IN ('void', 'empty') THEN
    RETURN public._wh_err('container_' || v_ctr.state, v_ctr.code || ' is ' || v_ctr.state || '; nothing to put away.');
  END IF;
  v_sug := public._wh_suggest_putaway(v_ctr.id, COALESCE(p_exclude, '{}'));

  UPDATE public.wh_moves
     SET suggested_location_id = (v_sug->>'location_id')::uuid, suggestion_reason = v_sug->>'reason'
   WHERE container_id = v_ctr.id AND kind = 'putaway' AND status IN ('open', 'in_progress')
   RETURNING id INTO v_move;

  RETURN jsonb_build_object('ok', true, 'container', public._wh_ctr_json(v_ctr.id), 'suggestion', v_sug, 'move_id', v_move);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_wh_putaway_container(
  p_container_id uuid, p_location_id uuid, p_move_id uuid DEFAULT NULL,
  p_client_event_id uuid DEFAULT NULL, p_actor_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor    uuid;
  v_rep      jsonb;
  v_ctr      public.wh_containers%ROWTYPE;
  v_to       public.wh_locations%ROWTYPE;
  v_move     public.wh_moves%ROWTYPE;
  v_from     uuid;
  v_group    uuid := gen_random_uuid();
  v_bal      record;
  v_first    boolean := true;
  v_units    integer := 0;
  v_followed boolean;
  v_cartons  integer;
  v_next     jsonb;
  v_res      jsonb;
BEGIN
  IF public._wh_require_role(ARRAY['admin', 'manager', 'user']) IS NULL THEN
    RETURN public._wh_err('forbidden', 'Putaway needs an internal account.');
  END IF;
  v_actor := public._wh_actor(p_actor_id);
  v_rep := public._wh_event_replay(p_client_event_id, 'rpc_wh_putaway_container');
  IF v_rep IS NOT NULL THEN
    RETURN v_rep;
  END IF;

  SELECT * INTO v_ctr FROM public.wh_containers WHERE id = p_container_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN public._wh_err('container_not_found', 'That carton does not exist.');
  END IF;
  IF v_ctr.state = 'void' THEN
    RETURN public._wh_err('container_void', v_ctr.code || ' was voided'
      || COALESCE(' and replaced by ' || (SELECT code FROM public.wh_containers WHERE id = v_ctr.superseded_by), '')
      || '; scan its current label.');
  END IF;
  IF v_ctr.state = 'empty' THEN
    RETURN public._wh_err('container_empty', v_ctr.code || ' is empty; there is nothing to put away.');
  END IF;

  SELECT * INTO v_to FROM public.wh_locations WHERE id = p_location_id;
  IF NOT FOUND THEN
    RETURN public._wh_err('location_not_found', 'That location does not exist.');
  END IF;
  IF NOT v_to.active THEN
    RETURN public._wh_err('location_inactive', v_to.code || ' is inactive.');
  END IF;
  IF v_to.kind IN ('virtual', 'station') THEN
    RETURN public._wh_err('location_not_storable', v_to.code || ' cannot hold stock.');
  END IF;
  IF v_ctr.location_id = v_to.id THEN
    RETURN public._wh_err('already_there', v_ctr.code || ' is already in ' || v_to.code || '.');
  END IF;

  IF p_move_id IS NOT NULL THEN
    SELECT * INTO v_move FROM public.wh_moves WHERE id = p_move_id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN public._wh_err('move_not_found', 'That putaway task does not exist.');
    END IF;
    IF v_move.status NOT IN ('open', 'in_progress') THEN
      RETURN public._wh_err('move_closed', 'That putaway task is already ' || v_move.status || '.');
    END IF;
  ELSE
    SELECT * INTO v_move FROM public.wh_moves
     WHERE container_id = v_ctr.id AND kind = 'putaway' AND status IN ('open', 'in_progress')
     FOR UPDATE;
  END IF;

  v_from := v_ctr.location_id;
  FOR v_bal IN
    SELECT * FROM public.wh_inventory_balances
     WHERE container_id = v_ctr.id AND location_id = v_from AND on_hand > 0
     ORDER BY id
  LOOP
    PERFORM public._wh_move_balance(v_group, 'putaway', v_bal.sku_id, v_bal.bucket, v_bal.on_hand,
                                    v_from, v_ctr.id, v_to.id, v_ctr.id, v_actor,
                                    CASE WHEN v_move.id IS NOT NULL THEN 'wh_move' END, v_move.id, NULL,
                                    CASE WHEN v_first THEN p_client_event_id END);
    v_first := false;
    v_units := v_units + v_bal.on_hand;
  END LOOP;
  IF v_units = 0 THEN
    RETURN public._wh_err('container_empty', v_ctr.code || ' holds no stock; count it instead.');
  END IF;

  IF v_move.id IS NOT NULL THEN
    v_followed := v_move.suggested_location_id IS NOT NULL AND v_move.suggested_location_id = v_to.id;
    UPDATE public.wh_moves
       SET status = 'done', to_location_id = v_to.id, followed_suggestion = v_followed,
           completed_by = v_actor, completed_at = now(), started_at = COALESCE(started_at, now()),
           movement_group_id = v_group
     WHERE id = v_move.id;
  END IF;

  SELECT jsonb_build_object('move_id', m.id, 'container_id', c.id, 'code', c.code, 'origin', m.origin,
                            'suggested', public._wh_loc_json(m.suggested_location_id))
    INTO v_next
    FROM public.wh_moves m JOIN public.wh_containers c ON c.id = m.container_id
   WHERE m.kind = 'putaway' AND m.status = 'open' AND m.container_id <> v_ctr.id
   ORDER BY m.created_at, m.id
   LIMIT 1;

  v_res := jsonb_build_object('ok', true, 'container', public._wh_ctr_json(v_ctr.id), 'from', public._wh_loc_json(v_from),
                              'to', public._wh_loc_json(v_to.id), 'units', v_units, 'followed_suggestion', v_followed,
                              'move_id', v_move.id, 'movement_group_id', v_group, 'next', v_next);

  IF v_to.capacity_cartons IS NOT NULL THEN
    SELECT count(*) INTO v_cartons FROM public.wh_containers WHERE location_id = v_to.id AND state IN ('sealed', 'open');
    IF v_cartons > v_to.capacity_cartons THEN
      v_res := v_res || jsonb_build_object('warning', 'over_capacity',
        'message', v_ctr.code || ' is in ' || v_to.code || ', which now holds ' || v_cartons
                   || ' cartons against a capacity of ' || v_to.capacity_cartons || '.');
    END IF;
  END IF;

  RETURN public._wh_event_store(p_client_event_id, 'rpc_wh_putaway_container', v_actor, v_res);
END;
$$;

-- =============================================================
-- D. Moves
-- =============================================================
CREATE OR REPLACE FUNCTION public.rpc_wh_move_stock(
  p_sku_id uuid, p_qty integer, p_from_location_id uuid, p_to_location_id uuid,
  p_from_container_id uuid DEFAULT NULL, p_to_container_id uuid DEFAULT NULL, p_bucket text DEFAULT NULL,
  p_move_id uuid DEFAULT NULL, p_client_event_id uuid DEFAULT NULL, p_actor_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor    uuid;
  v_rep      jsonb;
  v_sku      public.product_skus%ROWTYPE;
  v_from     public.wh_locations%ROWTYPE;
  v_to       public.wh_locations%ROWTYPE;
  v_fctr     public.wh_containers%ROWTYPE;
  v_tctr     public.wh_containers%ROWTYPE;
  v_move     public.wh_moves%ROWTYPE;
  v_buckets  text[];
  v_bucket   text := p_bucket;
  v_have     integer;
  v_neg      boolean;
  v_group    uuid := gen_random_uuid();
  v_mv       jsonb;
  v_res      jsonb;
BEGIN
  IF public._wh_require_role(ARRAY['admin', 'manager', 'user']) IS NULL THEN
    RETURN public._wh_err('forbidden', 'Moving stock needs an internal account.');
  END IF;
  v_actor := public._wh_actor(p_actor_id);
  v_rep := public._wh_event_replay(p_client_event_id, 'rpc_wh_move_stock');
  IF v_rep IS NOT NULL THEN
    RETURN v_rep;
  END IF;

  IF p_qty IS NULL OR p_qty <= 0 THEN
    RETURN public._wh_err('invalid_qty', 'Move at least one unit.');
  END IF;
  SELECT * INTO v_sku FROM public.product_skus WHERE id = p_sku_id;
  IF NOT FOUND THEN
    RETURN public._wh_err('sku_not_found', 'That product does not exist.');
  END IF;
  SELECT * INTO v_from FROM public.wh_locations WHERE id = p_from_location_id;
  SELECT * INTO v_to FROM public.wh_locations WHERE id = p_to_location_id;
  IF v_from.id IS NULL OR v_to.id IS NULL THEN
    RETURN public._wh_err('location_not_found', 'That location does not exist.');
  END IF;
  IF NOT v_to.active THEN
    RETURN public._wh_err('location_inactive', v_to.code || ' is inactive.');
  END IF;
  IF v_to.kind IN ('virtual', 'station') THEN
    RETURN public._wh_err('location_not_storable', v_to.code || ' cannot hold stock.');
  END IF;
  IF v_from.id = v_to.id AND p_from_container_id IS NOT DISTINCT FROM p_to_container_id THEN
    RETURN public._wh_err('same_location', 'The stock is already in ' || v_to.code || '.');
  END IF;

  IF p_from_container_id IS NOT NULL THEN
    SELECT * INTO v_fctr FROM public.wh_containers WHERE id = p_from_container_id;
    IF NOT FOUND THEN
      RETURN public._wh_err('container_not_found', 'That carton does not exist.');
    END IF;
    IF v_fctr.location_id IS DISTINCT FROM v_from.id THEN
      RETURN public._wh_err('container_elsewhere', v_fctr.code || ' is not in ' || v_from.code || '.');
    END IF;
  END IF;
  IF p_to_container_id IS NOT NULL THEN
    SELECT * INTO v_tctr FROM public.wh_containers WHERE id = p_to_container_id;
    IF NOT FOUND THEN
      RETURN public._wh_err('container_not_found', 'That carton does not exist.');
    END IF;
    IF v_tctr.state = 'void' THEN
      RETURN public._wh_err('container_void', v_tctr.code || ' was voided; use its current label.');
    END IF;
    IF v_tctr.state <> 'empty' AND v_tctr.location_id IS DISTINCT FROM v_to.id THEN
      RETURN public._wh_err('container_elsewhere', v_tctr.code || ' is not in ' || v_to.code || '.');
    END IF;
  END IF;

  IF v_bucket IS NULL THEN
    SELECT array_agg(DISTINCT bucket ORDER BY bucket) INTO v_buckets FROM public.wh_inventory_balances
     WHERE sku_id = p_sku_id AND location_id = v_from.id AND container_id IS NOT DISTINCT FROM p_from_container_id AND on_hand > 0;
    IF v_buckets IS NULL THEN
      RETURN public._wh_err('insufficient', v_from.code || ' holds no ' || v_sku.sku
                            || CASE WHEN v_fctr.id IS NOT NULL THEN ' in ' || v_fctr.code ELSE '' END || '.',
                            jsonb_build_object('available', 0));
    END IF;
    IF cardinality(v_buckets) > 1 THEN
      RETURN public._wh_err('ambiguous_bucket', v_from.code || ' holds ' || v_sku.sku || ' in more than one bucket ('
                            || array_to_string(v_buckets, ', ') || '); say which.', jsonb_build_object('buckets', to_jsonb(v_buckets)));
    END IF;
    v_bucket := v_buckets[1];
  ELSIF v_bucket NOT IN ('raw', 'prefilled_raw', 'in_production', 'finished', 'other') THEN
    RETURN public._wh_err('invalid_bucket', v_bucket || ' is not a stock bucket.');
  END IF;

  SELECT on_hand, allow_negative INTO v_have, v_neg FROM public.wh_inventory_balances
   WHERE sku_id = p_sku_id AND location_id = v_from.id AND container_id IS NOT DISTINCT FROM p_from_container_id AND bucket = v_bucket
   FOR UPDATE;
  IF NOT COALESCE(v_neg, v_from.allow_negative) AND COALESCE(v_have, 0) < p_qty THEN
    RETURN public._wh_err('insufficient', v_from.code || ' has ' || COALESCE(v_have, 0) || ' ' || v_sku.sku
                          || CASE WHEN v_fctr.id IS NOT NULL THEN ' in ' || v_fctr.code ELSE '' END
                          || ' available; ' || p_qty || ' requested.',
                          jsonb_build_object('available', COALESCE(v_have, 0)));
  END IF;

  IF p_move_id IS NOT NULL THEN
    SELECT * INTO v_move FROM public.wh_moves WHERE id = p_move_id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN public._wh_err('move_not_found', 'That move task does not exist.');
    END IF;
    IF v_move.status NOT IN ('open', 'in_progress') THEN
      RETURN public._wh_err('move_closed', 'That move task is already ' || v_move.status || '.');
    END IF;
  END IF;

  v_mv := public._wh_move_balance(v_group, 'move', p_sku_id, v_bucket, p_qty, v_from.id, p_from_container_id,
                                  v_to.id, p_to_container_id, v_actor,
                                  CASE WHEN v_move.id IS NOT NULL THEN 'wh_move' END, v_move.id, NULL, p_client_event_id);

  IF v_move.id IS NOT NULL THEN
    UPDATE public.wh_moves
       SET status = 'done', to_location_id = v_to.id,
           followed_suggestion = (suggested_location_id IS NOT NULL AND suggested_location_id = v_to.id),
           completed_by = v_actor, completed_at = now(), started_at = COALESCE(started_at, now()),
           movement_group_id = v_group
     WHERE id = v_move.id;
  END IF;

  v_res := jsonb_build_object('ok', true, 'sku_id', p_sku_id, 'sku', v_sku.sku, 'qty', p_qty,
                              'bucket', v_bucket, 'to_bucket', v_mv->>'to_bucket',
                              'from', public._wh_loc_json(v_from.id), 'to', public._wh_loc_json(v_to.id),
                              'from_container', CASE WHEN p_from_container_id IS NOT NULL THEN public._wh_ctr_json(p_from_container_id) END,
                              'to_container', CASE WHEN p_to_container_id IS NOT NULL THEN public._wh_ctr_json(p_to_container_id) END,
                              'available_after', COALESCE(v_have, 0) - p_qty,
                              'movement_group_id', v_group, 'move_id', v_move.id);
  RETURN public._wh_event_store(p_client_event_id, 'rpc_wh_move_stock', v_actor, v_res);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_wh_open_container(
  p_container_id uuid, p_to_location_id uuid DEFAULT NULL, p_unpack boolean DEFAULT false,
  p_client_event_id uuid DEFAULT NULL, p_actor_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor  uuid;
  v_rep    jsonb;
  v_ctr    public.wh_containers%ROWTYPE;
  v_to     public.wh_locations%ROWTYPE;
  v_from   uuid;
  v_target uuid;
  v_group  uuid := gen_random_uuid();
  v_bal    record;
  v_first  boolean := true;
  v_units  integer := 0;
  v_res    jsonb;
BEGIN
  IF public._wh_require_role(ARRAY['admin', 'manager', 'user']) IS NULL THEN
    RETURN public._wh_err('forbidden', 'Opening cartons needs an internal account.');
  END IF;
  v_actor := public._wh_actor(p_actor_id);
  v_rep := public._wh_event_replay(p_client_event_id, 'rpc_wh_open_container');
  IF v_rep IS NOT NULL THEN
    RETURN v_rep;
  END IF;

  SELECT * INTO v_ctr FROM public.wh_containers WHERE id = p_container_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN public._wh_err('container_not_found', 'That carton does not exist.');
  END IF;
  IF v_ctr.state IN ('void', 'empty') THEN
    RETURN public._wh_err('container_' || v_ctr.state, v_ctr.code || ' is ' || v_ctr.state || '.');
  END IF;
  v_from := v_ctr.location_id;
  v_target := COALESCE(p_to_location_id, v_from);

  IF p_to_location_id IS NOT NULL AND p_to_location_id <> v_from THEN
    SELECT * INTO v_to FROM public.wh_locations WHERE id = p_to_location_id;
    IF NOT FOUND THEN
      RETURN public._wh_err('location_not_found', 'That location does not exist.');
    END IF;
    IF NOT v_to.active THEN
      RETURN public._wh_err('location_inactive', v_to.code || ' is inactive.');
    END IF;
    IF v_to.kind IN ('virtual', 'station') THEN
      RETURN public._wh_err('location_not_storable', v_to.code || ' cannot hold stock.');
    END IF;
  ELSE
    SELECT * INTO v_to FROM public.wh_locations WHERE id = v_from;
  END IF;

  IF v_target <> v_from OR COALESCE(p_unpack, false) THEN
    FOR v_bal IN
      SELECT * FROM public.wh_inventory_balances
       WHERE container_id = v_ctr.id AND location_id = v_from AND on_hand > 0
       ORDER BY id
    LOOP
      PERFORM public._wh_move_balance(v_group, 'open_container', v_bal.sku_id, v_bal.bucket, v_bal.on_hand,
                                      v_from, v_ctr.id, v_target,
                                      CASE WHEN COALESCE(p_unpack, false) THEN NULL ELSE v_ctr.id END,
                                      v_actor, NULL, NULL,
                                      CASE WHEN COALESCE(p_unpack, false) THEN 'unpacked to loose' ELSE 'opened at ' || v_to.code END,
                                      CASE WHEN v_first THEN p_client_event_id END);
      v_first := false;
      v_units := v_units + v_bal.on_hand;
    END LOOP;
    -- the carton is opened or unpacked: any pending putaway for it is moot
    UPDATE public.wh_moves SET status = 'done', to_location_id = v_target, completed_by = v_actor, completed_at = now(),
                               followed_suggestion = (suggested_location_id IS NOT NULL AND suggested_location_id = v_target),
                               movement_group_id = v_group
     WHERE container_id = v_ctr.id AND kind = 'putaway' AND status IN ('open', 'in_progress');
  END IF;

  UPDATE public.wh_containers
     SET state = 'open', opened_at = COALESCE(opened_at, now())
   WHERE id = v_ctr.id AND state = 'sealed';

  v_res := jsonb_build_object('ok', true, 'container', public._wh_ctr_json(v_ctr.id),
                              'from', public._wh_loc_json(v_from), 'to', public._wh_loc_json(v_target),
                              'units_moved', v_units, 'unpacked', COALESCE(p_unpack, false),
                              'already_open', v_ctr.state = 'open' AND v_target = v_from AND NOT COALESCE(p_unpack, false),
                              'movement_group_id', CASE WHEN v_units > 0 THEN v_group END);
  IF p_to_location_id IS NOT NULL AND NOT v_to.pickable THEN
    v_res := v_res || jsonb_build_object('warning', 'not_pickable',
                                         'message', v_to.code || ' is not a pick face; pickers will not draw from it.');
  END IF;
  RETURN public._wh_event_store(p_client_event_id, 'rpc_wh_open_container', v_actor, v_res);
END;
$$;

-- =============================================================
-- E. Cartons through manufacturing (§5.7)
-- =============================================================
CREATE OR REPLACE FUNCTION public.rpc_wh_take_to_line(
  p_container_id uuid, p_client_event_id uuid DEFAULT NULL, p_actor_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid;
  v_rep   jsonb;
  v_ctr   public.wh_containers%ROWTYPE;
  v_mfg   uuid := public._wh_loc_id('MFG-LINE');
  v_from  uuid;
  v_group uuid := gen_random_uuid();
  v_bal   record;
  v_first boolean := true;
  v_units integer := 0;
  v_res   jsonb;
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

  v_res := jsonb_build_object('ok', true, 'container', public._wh_ctr_json(v_ctr.id), 'from', public._wh_loc_json(v_from),
                              'units', v_units, 'movement_group_id', v_group);
  RETURN public._wh_event_store(p_client_event_id, 'rpc_wh_take_to_line', v_actor, v_res);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_wh_rts_relabel(
  p_sku_id uuid, p_cartons jsonb, p_parent_container_id uuid DEFAULT NULL, p_task_log_id uuid DEFAULT NULL,
  p_client_event_id uuid DEFAULT NULL, p_actor_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor    uuid;
  v_rep      jsonb;
  v_mfg      uuid := public._wh_loc_id('MFG-LINE');
  v_sku      public.product_skus%ROWTYPE;
  v_parent   public.wh_containers%ROWTYPE;
  v_rts      jsonb := COALESCE(public._wh_setting('rts'), '{}'::jsonb);
  v_entry    jsonb;
  v_qty      integer;
  v_state    text;
  v_total    integer := 0;
  v_loose    integer := 0;
  v_have     integer;
  v_group    uuid := gen_random_uuid();
  v_n        integer;
  v_code     text;
  v_child    uuid;
  v_children uuid[] := '{}';
  v_out      jsonb := '[]'::jsonb;
  v_sug      jsonb;
  v_task     uuid;
  v_tasks    uuid[] := '{}';
  v_first    boolean := true;
  v_job      jsonb;
  v_rem      jsonb;
  v_face_loc uuid;
  v_face_ctr uuid;
  v_mv       jsonb;
  v_left     integer;
  v_ref_type text := CASE WHEN p_task_log_id IS NOT NULL THEN 'task_log' END;
  v_res      jsonb;
BEGIN
  IF public._wh_require_role(ARRAY['admin', 'manager', 'user']) IS NULL THEN
    RETURN public._wh_err('forbidden', 'RTS relabelling needs an internal account.');
  END IF;
  v_actor := public._wh_actor(p_actor_id);
  IF NOT public._wh_live() THEN
    RETURN jsonb_build_object('ok', true, 'dormant', true);
  END IF;
  v_rep := public._wh_event_replay(p_client_event_id, 'rpc_wh_rts_relabel');
  IF v_rep IS NOT NULL THEN
    RETURN v_rep;
  END IF;

  IF p_cartons IS NULL OR jsonb_typeof(p_cartons) <> 'array' OR jsonb_array_length(p_cartons) = 0 THEN
    RETURN public._wh_err('invalid_cartons', 'List at least one carton: [{qty, state}] plus an optional {qty, loose: true}.');
  END IF;
  FOR v_entry IN SELECT * FROM jsonb_array_elements(p_cartons) LOOP
    IF jsonb_typeof(v_entry) <> 'object' OR COALESCE(v_entry->>'qty', '') !~ '^[0-9]{1,7}$' OR (v_entry->>'qty')::int <= 0 THEN
      RETURN public._wh_err('invalid_cartons', 'Every carton needs a positive whole quantity.');
    END IF;
    IF COALESCE((v_entry->>'loose')::boolean, false) THEN
      v_loose := v_loose + (v_entry->>'qty')::int;
    ELSIF COALESCE(v_entry->>'state', 'sealed') NOT IN ('sealed', 'open') THEN
      RETURN public._wh_err('invalid_cartons', 'A carton is sealed or open.');
    END IF;
    v_total := v_total + (v_entry->>'qty')::int;
  END LOOP;

  SELECT * INTO v_sku FROM public.product_skus WHERE id = p_sku_id;
  IF NOT FOUND THEN
    RETURN public._wh_err('sku_not_found', 'That product does not exist.');
  END IF;
  IF v_mfg IS NULL THEN
    RETURN public._wh_err('mfg_line_missing', 'The MFG-LINE location is missing; an admin must restore it.');
  END IF;
  IF p_parent_container_id IS NOT NULL THEN
    SELECT * INTO v_parent FROM public.wh_containers WHERE id = p_parent_container_id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN public._wh_err('parent_not_found', 'The scanned carton does not exist.');
    END IF;
    IF v_parent.state = 'void' THEN
      RETURN public._wh_err('parent_void', v_parent.code || ' was already relabelled'
        || COALESCE(' as ' || (SELECT code FROM public.wh_containers WHERE id = v_parent.superseded_by), '') || '.');
    END IF;
    IF v_parent.sku_id IS NOT NULL AND v_parent.sku_id <> p_sku_id THEN
      RETURN public._wh_err('parent_sku_mismatch', v_parent.code || ' held '
        || (SELECT sku FROM public.product_skus WHERE id = v_parent.sku_id) || ', not ' || v_sku.sku || '.');
    END IF;
  ELSIF NOT COALESCE((v_rts->>'allow_no_parent')::boolean, true) THEN
    RETURN public._wh_err('parent_required', 'Scan the carton the batch came from before relabelling.');
  END IF;
  IF p_task_log_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.task_logs WHERE id = p_task_log_id) THEN
    RETURN public._wh_err('task_log_not_found', 'That task log does not exist.');
  END IF;

  -- (1) loose finished units at the line must cover the cartons
  SELECT on_hand INTO v_have FROM public.wh_inventory_balances
   WHERE sku_id = p_sku_id AND location_id = v_mfg AND container_id IS NULL AND bucket = 'finished'
   FOR UPDATE;
  v_have := COALESCE(v_have, 0);
  IF v_have < v_total THEN
    RETURN public._wh_err('insufficient_at_line',
      format('MFG-LINE holds %s loose finished %s; the cartons need %s (%s short). Log the RTS task first.',
             v_have, v_sku.sku, v_total, v_total - v_have),
      jsonb_build_object('available', v_have, 'needed', v_total));
  END IF;

  -- (2) mint green children, (3) relabel movements, (5) putaway tasks
  FOR v_entry IN SELECT * FROM jsonb_array_elements(p_cartons) LOOP
    CONTINUE WHEN COALESCE((v_entry->>'loose')::boolean, false);
    v_qty := (v_entry->>'qty')::int;
    v_state := COALESCE(v_entry->>'state', 'sealed');
    IF v_parent.id IS NOT NULL THEN
      SELECT count(*) + 1 INTO v_n FROM public.wh_containers WHERE parent_container_id = v_parent.id;
      v_code := v_parent.code || 'R' || v_n;
      WHILE EXISTS (SELECT 1 FROM public.wh_containers WHERE code = v_code) LOOP
        v_n := v_n + 1;
        v_code := v_parent.code || 'R' || v_n;
      END LOOP;
    ELSE
      PERFORM pg_advisory_xact_lock(hashtextextended('wh_container_code:C-MFG', 0));
      SELECT COALESCE(max(substring(code FROM '^C-MFG-([0-9]+)$')::int), 0) + 1 INTO v_n
        FROM public.wh_containers WHERE code ~ '^C-MFG-[0-9]+$';
      v_code := 'C-MFG-' || lpad(v_n::text, 4, '0');
    END IF;

    INSERT INTO public.wh_containers (code, sku_id, qty_initial, qty, state, location_id, source, label_stock,
                                      parent_container_id, finished_by, finished_at, opened_at, created_by)
    VALUES (v_code, p_sku_id, v_qty, 0, v_state, v_mfg, 'manufacturing', 'green',
            v_parent.id, v_actor, now(), CASE WHEN v_state = 'open' THEN now() END, v_actor)
    RETURNING id INTO v_child;

    PERFORM public._wh_post_movement(v_group, 'relabel', p_sku_id, 'finished', v_qty, v_mfg, NULL, v_mfg, v_child, NULL,
                                     v_actor, v_ref_type, p_task_log_id, 'RTS relabel',
                                     CASE WHEN v_first THEN p_client_event_id END);
    v_first := false;
    v_children := v_children || v_child;

    v_sug := public._wh_suggest_putaway(v_child, '{}', p_sku_id, 'finished', 'rts');
    INSERT INTO public.wh_moves (kind, origin, status, container_id, from_location_id, suggested_location_id, suggestion_reason,
                                 source_type, source_id, priority, created_by)
    VALUES ('putaway', 'rts', 'open', v_child, v_mfg, (v_sug->>'location_id')::uuid, v_sug->>'reason',
            CASE WHEN p_task_log_id IS NOT NULL THEN 'task_log' END, p_task_log_id, 1, v_actor)
    RETURNING id INTO v_task;
    v_tasks := v_tasks || v_task;

    v_out := v_out || jsonb_build_object('id', v_child, 'code', v_code, 'qty', v_qty, 'state', v_state,
                                         'suggested', v_sug, 'move_id', v_task);
  END LOOP;

  -- (4) the parent: void once drained, superseded by the first child; else open at the line
  IF v_parent.id IS NOT NULL THEN
    SELECT COALESCE(sum(on_hand), 0) INTO v_left FROM public.wh_inventory_balances WHERE container_id = v_parent.id;
    IF v_left <= 0 AND cardinality(v_children) > 0 THEN
      UPDATE public.wh_containers
         SET state = 'void', superseded_by = v_children[1], qty = 0,
             emptied_at = COALESCE(emptied_at, now())
       WHERE id = v_parent.id;
      UPDATE public.wh_moves SET status = 'cancelled', completed_by = v_actor, completed_at = now()
       WHERE container_id = v_parent.id AND kind = 'putaway' AND status IN ('open', 'in_progress');
    ELSIF v_left > 0 THEN
      UPDATE public.wh_containers SET state = 'open', opened_at = COALESCE(opened_at, now())
       WHERE id = v_parent.id AND state = 'sealed';
    END IF;
  END IF;

  -- (6) a loose remainder goes to the open carton (or loose units) at the SKU's pick face
  IF v_loose > 0 THEN
    SELECT l.id, c.id INTO v_face_loc, v_face_ctr
      FROM public.wh_containers c JOIN public.wh_locations l ON l.id = c.location_id
     WHERE c.sku_id = p_sku_id AND c.state = 'open' AND l.pickable AND l.active
       AND EXISTS (SELECT 1 FROM public.wh_inventory_balances b
                    WHERE b.container_id = c.id AND b.location_id = l.id AND b.bucket = 'finished')
     ORDER BY l.pick_sequence NULLS LAST, c.opened_at
     LIMIT 1;
    IF v_face_loc IS NULL THEN
      SELECT l.id INTO v_face_loc
        FROM public.wh_inventory_balances b JOIN public.wh_locations l ON l.id = b.location_id
       WHERE b.sku_id = p_sku_id AND b.container_id IS NULL AND b.bucket = 'finished' AND b.on_hand > 0
         AND l.pickable AND l.active
       ORDER BY l.pick_sequence NULLS LAST
       LIMIT 1;
    END IF;
    IF v_face_loc IS NOT NULL THEN
      v_mv := public.rpc_wh_move_stock(p_sku_id, v_loose, v_mfg, v_face_loc, NULL, v_face_ctr, 'finished',
                                       NULL, NULL, v_actor);
    END IF;
    IF v_face_loc IS NOT NULL AND COALESCE((v_mv->>'ok')::boolean, false) THEN
      v_rem := jsonb_build_object('qty', v_loose, 'to', v_mv->'to', 'container', v_mv->'to_container', 'left_at_line', false);
    ELSE
      v_sug := public._wh_suggest_putaway(NULL, '{}', p_sku_id, 'finished', 'rts');
      INSERT INTO public.wh_moves (kind, origin, status, sku_id, qty, bucket, from_location_id, suggested_location_id,
                                   suggestion_reason, source_type, source_id, priority, created_by)
      VALUES ('putaway', 'rts', 'open', p_sku_id, v_loose, 'finished', v_mfg, (v_sug->>'location_id')::uuid, v_sug->>'reason',
              CASE WHEN p_task_log_id IS NOT NULL THEN 'task_log' END, p_task_log_id, 1, v_actor)
      RETURNING id INTO v_task;
      v_tasks := v_tasks || v_task;
      v_rem := jsonb_build_object('qty', v_loose, 'left_at_line', true, 'move_id', v_task, 'suggested', v_sug);
    END IF;
  END IF;

  -- (7) one lpn_rts job for all children, to the caller's station printer
  IF cardinality(v_children) > 0 THEN
    v_job := public._wh_queue_print_job('lpn_rts', v_children, 'workspace', NULL, v_actor);
  END IF;

  v_res := jsonb_build_object('ok', true, 'containers', v_out,
                              'parent', CASE WHEN v_parent.id IS NOT NULL THEN public._wh_ctr_json(v_parent.id) END,
                              'remainder', v_rem,
                              'print_job_id', v_job->>'job_id',
                              'print', CASE WHEN v_job IS NOT NULL THEN v_job - 'payload' END,
                              'putaway_tasks', to_jsonb(v_tasks), 'movement_group_id', v_group);
  RETURN public._wh_event_store(p_client_event_id, 'rpc_wh_rts_relabel', v_actor, v_res);
END;
$$;

-- =============================================================
-- F. Counts (§5.3)
-- =============================================================
CREATE OR REPLACE FUNCTION public.rpc_wh_record_count(
  p_location_id uuid, p_lines jsonb, p_count_task_id uuid DEFAULT NULL, p_started_at timestamptz DEFAULT NULL,
  p_client_event_id uuid DEFAULT NULL, p_actor_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor   uuid;
  v_rep     jsonb;
  v_loc     public.wh_locations%ROWTYPE;
  v_task    public.wh_count_tasks%ROWTYPE;
  r         jsonb;
  v_sku     uuid;
  v_ctr     public.wh_containers%ROWTYPE;
  v_bucket  text;
  v_qty     integer;
  v_flag    text;
  v_else    boolean;
  v_status  text;
  v_moved   boolean := false;
  v_open    integer;
  v_lines   jsonb;
  v_res     jsonb;
BEGIN
  IF public._wh_require_role(ARRAY['admin', 'manager', 'user']) IS NULL THEN
    RETURN public._wh_err('forbidden', 'Counting needs an internal account.');
  END IF;
  v_actor := public._wh_actor(p_actor_id);
  v_rep := public._wh_event_replay(p_client_event_id, 'rpc_wh_record_count');
  IF v_rep IS NOT NULL THEN
    RETURN v_rep;
  END IF;

  SELECT * INTO v_loc FROM public.wh_locations WHERE id = p_location_id;
  IF NOT FOUND THEN
    RETURN public._wh_err('location_not_found', 'That location does not exist.');
  END IF;
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' THEN
    RETURN public._wh_err('invalid_lines', 'Send the counted lines as a JSON array.');
  END IF;

  IF p_count_task_id IS NOT NULL THEN
    SELECT * INTO v_task FROM public.wh_count_tasks WHERE id = p_count_task_id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN public._wh_err('task_not_found', 'That count task does not exist.');
    END IF;
    IF v_task.location_id <> v_loc.id THEN
      RETURN public._wh_err('task_location_mismatch', 'That count task is for another location, not ' || v_loc.code || '.');
    END IF;
    IF v_task.status NOT IN ('open', 'counting') THEN
      RETURN public._wh_err('task_not_open', 'The count of ' || v_loc.code || ' is already ' || v_task.status || '.');
    END IF;
  ELSE
    SELECT * INTO v_task FROM public.wh_count_tasks
     WHERE location_id = v_loc.id AND status IN ('open', 'counting') FOR UPDATE;
    IF NOT FOUND THEN
      INSERT INTO public.wh_count_tasks (kind, status, location_id, reason, due_date, created_by, started_at)
      VALUES ('ad_hoc', 'counting', v_loc.id, 'Ad hoc count', current_date, v_actor, COALESCE(p_started_at, now()))
      RETURNING * INTO v_task;
    END IF;
  END IF;

  DROP TABLE IF EXISTS pg_temp._wh_cnt;
  CREATE TEMP TABLE _wh_cnt (sku_id uuid, container_id uuid, bucket text, counted integer,
                             scan_value text, found_else boolean, label_flag text) ON COMMIT DROP;

  FOR r IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    IF jsonb_typeof(r) <> 'object' OR COALESCE(r->>'counted_qty', '') !~ '^[0-9]{1,7}$' THEN
      RETURN public._wh_err('invalid_lines', 'Every line needs counted_qty as a whole number of zero or more.');
    END IF;
    v_qty := (r->>'counted_qty')::int;
    v_flag := NULL;
    v_else := false;
    IF NULLIF(r->>'container_id', '') IS NOT NULL THEN
      SELECT * INTO v_ctr FROM public.wh_containers WHERE id = (r->>'container_id')::uuid;
      IF NOT FOUND THEN
        RETURN public._wh_err('container_not_found', 'A counted carton does not exist.');
      END IF;
      IF v_ctr.state = 'void' THEN
        RETURN public._wh_err('container_void', v_ctr.code || ' was relabelled'
          || COALESCE(' as ' || (SELECT code FROM public.wh_containers WHERE id = v_ctr.superseded_by), '')
          || '; scan the green label.');
      END IF;
      v_sku := COALESCE(NULLIF(r->>'sku_id', '')::uuid, v_ctr.sku_id);
      IF v_sku IS NULL THEN
        RETURN public._wh_err('sku_required', v_ctr.code || ' holds several products; count each one.');
      END IF;
      v_bucket := COALESCE(NULLIF(r->>'bucket', ''),
                           (SELECT b.bucket FROM public.wh_inventory_balances b
                             WHERE b.container_id = v_ctr.id AND b.sku_id = v_sku
                             ORDER BY (b.on_hand <> 0) DESC, b.on_hand DESC LIMIT 1),
                           v_loc.bucket_lock, v_loc.default_bucket, 'finished');
      v_else := v_ctr.location_id IS DISTINCT FROM v_loc.id;
      v_flag := CASE WHEN v_ctr.label_stock = 'white' AND v_loc.zone = 'RTS' THEN 'needs_green'
                     WHEN v_ctr.label_stock = 'green' AND v_loc.zone = 'RAW' THEN 'needs_white' END;
    ELSE
      v_sku := NULLIF(r->>'sku_id', '')::uuid;
      IF v_sku IS NULL OR NOT EXISTS (SELECT 1 FROM public.product_skus WHERE id = v_sku) THEN
        RETURN public._wh_err('sku_required', 'Every loose line needs a known product.');
      END IF;
      v_bucket := COALESCE(NULLIF(r->>'bucket', ''),
                           (SELECT b.bucket FROM public.wh_inventory_balances b
                             WHERE b.location_id = v_loc.id AND b.container_id IS NULL AND b.sku_id = v_sku
                             ORDER BY (b.on_hand <> 0) DESC, b.on_hand DESC LIMIT 1),
                           v_loc.bucket_lock, v_loc.default_bucket, 'finished');
    END IF;
    IF v_bucket NOT IN ('raw', 'prefilled_raw', 'in_production', 'finished', 'other') THEN
      RETURN public._wh_err('invalid_bucket', v_bucket || ' is not a stock bucket.');
    END IF;
    INSERT INTO _wh_cnt VALUES (v_sku, CASE WHEN NULLIF(r->>'container_id', '') IS NOT NULL THEN v_ctr.id END,
                                v_bucket, v_qty, r->>'scan_value', v_else, v_flag);
  END LOOP;

  -- snapshot expected at submit and merge: an expected item not scanned counts as zero
  INSERT INTO public.wh_count_lines (count_task_id, sku_id, container_id, bucket, expected_qty, counted_qty,
                                     found_container_elsewhere, label_flag, scan_value)
  SELECT v_task.id, COALESCE(c.sku_id, e.sku_id), COALESCE(c.container_id, e.container_id), COALESCE(c.bucket, e.bucket),
         COALESCE(e.on_hand, 0), COALESCE(c.counted, 0), COALESCE(c.found_else, false), c.label_flag, c.scan_value
    FROM (SELECT sku_id, container_id, bucket, sum(counted)::int AS counted, min(scan_value) AS scan_value,
                 bool_or(found_else) AS found_else, max(label_flag) AS label_flag
            FROM _wh_cnt GROUP BY sku_id, container_id, bucket) c
    FULL JOIN (SELECT sku_id, container_id, bucket, on_hand FROM public.wh_inventory_balances
                WHERE location_id = v_loc.id AND on_hand <> 0) e
      ON e.sku_id = c.sku_id
     AND COALESCE(e.container_id, '00000000-0000-0000-0000-000000000000'::uuid)
       = COALESCE(c.container_id, '00000000-0000-0000-0000-000000000000'::uuid)
     AND e.bucket = c.bucket;

  IF p_started_at IS NOT NULL THEN
    v_moved := EXISTS (SELECT 1 FROM public.wh_inventory_movements m
                        WHERE (m.from_location_id = v_loc.id OR m.to_location_id = v_loc.id) AND m.created_at > p_started_at);
  END IF;

  SELECT count(*) INTO v_open FROM public.wh_count_lines
   WHERE count_task_id = v_task.id AND (variance <> 0 OR found_container_elsewhere);
  v_status := CASE WHEN v_open = 0 THEN 'approved' ELSE 'submitted' END;

  UPDATE public.wh_count_tasks
     SET status = v_status, moved_during_count = v_moved,
         started_at = COALESCE(started_at, p_started_at, now()),
         submitted_by = v_actor, submitted_at = now(),
         approved_by = CASE WHEN v_status = 'approved' THEN v_actor END,
         approved_at = CASE WHEN v_status = 'approved' THEN now() END
   WHERE id = v_task.id;
  IF v_status = 'approved' THEN
    UPDATE public.wh_count_lines SET resolution = 'accept' WHERE count_task_id = v_task.id;
    UPDATE public.wh_locations SET last_counted_at = now() WHERE id = v_loc.id;
  END IF;

  -- never send expected quantities or variances back to the phone
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', l.id, 'sku_id', l.sku_id, 'container_id', l.container_id,
                                               'bucket', l.bucket, 'counted_qty', l.counted_qty, 'label_flag', l.label_flag)
                            ORDER BY l.created_at, l.id), '[]'::jsonb)
    INTO v_lines
    FROM public.wh_count_lines l WHERE l.count_task_id = v_task.id;

  v_res := jsonb_build_object('ok', true, 'count_task_id', v_task.id, 'status', v_status,
                              'location', public._wh_loc_json(v_loc.id), 'lines', v_lines);
  RETURN public._wh_event_store(p_client_event_id, 'rpc_wh_record_count', v_actor, v_res);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_wh_approve_variance(
  p_count_task_id uuid, p_decisions jsonb DEFAULT '[]'::jsonb, p_actor_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor     uuid;
  v_task      public.wh_count_tasks%ROWTYPE;
  v_loc       public.wh_locations%ROWTYPE;
  v_unloc     uuid := public._wh_loc_id('UNLOCATED');
  v_dec       jsonb := COALESCE(p_decisions, '[]'::jsonb);
  v_line      public.wh_count_lines%ROWTYPE;
  v_resl      text;
  v_group     uuid;
  v_diff      integer;
  v_moved     integer;
  v_have      integer;
  v_neg       boolean;
  v_led       jsonb;
  v_tx        uuid;
  v_else      record;
  v_adjusted  integer := 0;
  v_levels    integer := 0;
  v_recount   boolean := false;
  v_recount_id uuid;
  v_n         integer := 0;
BEGIN
  IF public._wh_require_role(ARRAY['admin', 'manager']) IS NULL THEN
    RETURN public._wh_err('forbidden', 'Approving count variances needs a manager or admin.');
  END IF;
  v_actor := public._wh_actor(p_actor_id);
  IF jsonb_typeof(v_dec) <> 'array' THEN
    RETURN public._wh_err('invalid_decisions', 'Decisions must be a JSON array of {line_id, resolution}.');
  END IF;

  SELECT * INTO v_task FROM public.wh_count_tasks WHERE id = p_count_task_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN public._wh_err('task_not_found', 'That count task does not exist.');
  END IF;
  SELECT * INTO v_loc FROM public.wh_locations WHERE id = v_task.location_id;
  IF v_task.status <> 'submitted' THEN
    RETURN public._wh_err('task_not_submitted', 'The count of ' || v_loc.code || ' is ' || v_task.status || ', not waiting for approval.');
  END IF;

  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_dec) d
              WHERE jsonb_typeof(d) <> 'object'
                 OR COALESCE(d->>'resolution', '') NOT IN ('accept', 'misplaced', 'write_off', 'recount')
                 OR COALESCE(d->>'line_id', '') !~ '^[0-9a-fA-F-]{36}$'
                 OR NOT EXISTS (SELECT 1 FROM public.wh_count_lines l
                                 WHERE l.id = (d->>'line_id')::uuid AND l.count_task_id = v_task.id)) THEN
    RETURN public._wh_err('invalid_decisions', 'Each decision needs a line of this count and a resolution: accept, misplaced, write_off or recount.');
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_dec) d
               JOIN public.wh_count_lines l ON l.id = (d->>'line_id')::uuid
              WHERE d->>'resolution' = 'write_off' AND (l.variance >= 0 OR l.found_container_elsewhere)) THEN
    RETURN public._wh_err('invalid_resolution', 'A write-off applies only to a line counted short at ' || v_loc.code || '.');
  END IF;

  FOR v_line IN SELECT * FROM public.wh_count_lines WHERE count_task_id = v_task.id ORDER BY created_at, id FOR UPDATE LOOP
    v_n := v_n + 1;
    v_resl := COALESCE((SELECT d->>'resolution' FROM jsonb_array_elements(v_dec) d
                         WHERE (d->>'line_id')::uuid = v_line.id LIMIT 1), 'accept');
    IF v_line.variance = 0 AND NOT v_line.found_container_elsewhere THEN
      UPDATE public.wh_count_lines SET resolution = 'accept' WHERE id = v_line.id;
      CONTINUE;
    END IF;
    IF v_resl = 'recount' THEN
      v_recount := true;
      UPDATE public.wh_count_lines SET resolution = 'recount' WHERE id = v_line.id;
      CONTINUE;
    END IF;

    v_group := gen_random_uuid();
    v_tx := NULL;
    v_diff := v_line.variance;

    -- a carton counted here but booked elsewhere moves here first
    IF v_line.found_container_elsewhere AND v_line.container_id IS NOT NULL THEN
      v_moved := 0;
      FOR v_else IN
        SELECT location_id, on_hand FROM public.wh_inventory_balances
         WHERE container_id = v_line.container_id AND sku_id = v_line.sku_id AND bucket = v_line.bucket
           AND location_id <> v_task.location_id AND on_hand > 0
      LOOP
        PERFORM public._wh_post_movement(v_group, 'move', v_line.sku_id, v_line.bucket, v_else.on_hand,
                                         v_else.location_id, v_line.container_id, v_task.location_id, v_line.container_id,
                                         NULL, v_actor, 'wh_count_task', v_task.id, 'found during the count of ' || v_loc.code);
        v_moved := v_moved + v_else.on_hand;
      END LOOP;
      v_diff := v_line.counted_qty - v_moved;
    END IF;

    -- a shortage can only take what is still there
    IF v_diff < 0 THEN
      SELECT on_hand, allow_negative INTO v_have, v_neg FROM public.wh_inventory_balances
       WHERE sku_id = v_line.sku_id AND location_id = v_task.location_id
         AND container_id IS NOT DISTINCT FROM v_line.container_id AND bucket = v_line.bucket;
      IF NOT COALESCE(v_neg, false) THEN
        v_diff := -LEAST(-v_diff, GREATEST(COALESCE(v_have, 0), 0));
      END IF;
    END IF;

    IF v_diff <> 0 THEN
      IF v_resl = 'misplaced' THEN
        IF v_diff > 0 THEN
          PERFORM public._wh_post_movement(v_group, 'count_adjust', v_line.sku_id, v_line.bucket, v_diff,
                                           v_unloc, NULL, v_task.location_id, v_line.container_id, NULL, v_actor,
                                           'wh_count_task', v_task.id, 'misplaced: found at ' || v_loc.code);
        ELSE
          PERFORM public._wh_post_movement(v_group, 'count_adjust', v_line.sku_id, v_line.bucket, -v_diff,
                                           v_task.location_id, v_line.container_id, v_unloc, NULL, NULL, v_actor,
                                           'wh_count_task', v_task.id, 'misplaced: missing from ' || v_loc.code);
        END IF;
      ELSIF v_resl = 'write_off' THEN
        v_led := public._wh_ledger_post(v_line.sku_id, 'wh_write_off', v_line.bucket, NULL, -v_diff,
                                        'wh_count_task', v_task.id, v_actor, 'count write-off at ' || v_loc.code);
        v_tx := NULLIF(v_led->>'tx_id', '')::uuid;
        v_levels := v_levels + (v_led->>'delta')::int;
        PERFORM public._wh_post_movement(v_group, 'write_off', v_line.sku_id, v_line.bucket, -v_diff,
                                         v_task.location_id, v_line.container_id, NULL, NULL, NULL, v_actor,
                                         'wh_count_task', v_task.id, 'count write-off at ' || v_loc.code, NULL, v_tx);
      ELSE
        v_led := public._wh_ledger_post(v_line.sku_id, 'wh_count_adjust', v_line.bucket, NULL, v_diff,
                                        'wh_count_task', v_task.id, v_actor, 'warehouse count at ' || v_loc.code);
        v_tx := NULLIF(v_led->>'tx_id', '')::uuid;
        v_levels := v_levels + (v_led->>'delta')::int;
        IF v_diff > 0 THEN
          PERFORM public._wh_post_movement(v_group, 'count_adjust', v_line.sku_id, v_line.bucket, v_diff,
                                           NULL, NULL, v_task.location_id, v_line.container_id, NULL, v_actor,
                                           'wh_count_task', v_task.id, 'count at ' || v_loc.code, NULL, v_tx);
        ELSE
          PERFORM public._wh_post_movement(v_group, 'count_adjust', v_line.sku_id, v_line.bucket, -v_diff,
                                           v_task.location_id, v_line.container_id, NULL, NULL, NULL, v_actor,
                                           'wh_count_task', v_task.id, 'count at ' || v_loc.code, NULL, v_tx);
        END IF;
      END IF;
      v_adjusted := v_adjusted + abs(v_diff);
    END IF;

    UPDATE public.wh_count_lines SET resolution = v_resl, movement_group_id = v_group, ledger_tx_id = v_tx
     WHERE id = v_line.id;
  END LOOP;

  IF v_recount THEN
    SELECT id INTO v_recount_id FROM public.wh_count_tasks
     WHERE location_id = v_task.location_id AND status IN ('open', 'counting');
    IF v_recount_id IS NULL THEN
      INSERT INTO public.wh_count_tasks (kind, status, location_id, sku_id, reason, due_date, source_type, source_id, created_by)
      VALUES ('variance_recount', 'open', v_task.location_id, v_task.sku_id, 'Recount of ' || v_loc.code, current_date,
              'wh_count_task', v_task.id, v_actor)
      RETURNING id INTO v_recount_id;
    END IF;
  END IF;

  UPDATE public.wh_count_tasks SET status = 'approved', approved_by = v_actor, approved_at = now() WHERE id = v_task.id;
  UPDATE public.wh_locations SET last_counted_at = now() WHERE id = v_task.location_id;

  RETURN jsonb_build_object('ok', true, 'count_task_id', v_task.id, 'lines', v_n,
                            'adjusted_units', v_adjusted, 'levels_delta', v_levels,
                            'recounts', CASE WHEN v_recount_id IS NOT NULL THEN jsonb_build_array(v_recount_id) ELSE '[]'::jsonb END);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_wh_create_count(p_location_ids uuid[], p_kind text DEFAULT 'ad_hoc', p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor    uuid;
  v_id       uuid;
  v_loc      public.wh_locations%ROWTYPE;
  v_existing uuid;
  v_new      uuid;
  v_created  uuid[] := '{}';
  v_had      uuid[] := '{}';
  v_missing  uuid[] := '{}';
BEGIN
  IF public._wh_require_role(ARRAY['admin', 'manager']) IS NULL THEN
    RETURN public._wh_err('forbidden', 'Creating counts needs a manager or admin.');
  END IF;
  v_actor := public._wh_actor(NULL);
  IF p_location_ids IS NULL OR cardinality(p_location_ids) = 0 OR cardinality(p_location_ids) > 500 THEN
    RETURN public._wh_err('invalid_locations', 'Pick between 1 and 500 locations to count.');
  END IF;
  IF COALESCE(p_kind, '') NOT IN ('scheduled', 'pick_triggered', 'reconcile', 'variance_recount', 'ad_hoc') THEN
    RETURN public._wh_err('invalid_kind', COALESCE(p_kind, 'null') || ' is not a count kind.');
  END IF;

  FOREACH v_id IN ARRAY p_location_ids LOOP
    SELECT * INTO v_loc FROM public.wh_locations WHERE id = v_id;
    IF NOT FOUND OR NOT v_loc.active OR v_loc.kind IN ('virtual', 'station') THEN
      v_missing := v_missing || v_id;
      CONTINUE;
    END IF;
    SELECT id INTO v_existing FROM public.wh_count_tasks WHERE location_id = v_id AND status IN ('open', 'counting');
    IF v_existing IS NOT NULL THEN
      v_had := v_had || v_existing;
      CONTINUE;
    END IF;
    INSERT INTO public.wh_count_tasks (kind, status, location_id, reason, due_date, created_by)
    VALUES (p_kind, 'open', v_id, NULLIF(btrim(COALESCE(p_reason, '')), ''), current_date, v_actor)
    RETURNING id INTO v_new;
    v_created := v_created || v_new;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'created', to_jsonb(v_created), 'existing', to_jsonb(v_had), 'missing', to_jsonb(v_missing));
END;
$$;

-- =============================================================
-- G. Write-off (damaged = write-off: bin and ledger together)
-- =============================================================
CREATE OR REPLACE FUNCTION public.rpc_wh_write_off(
  p_sku_id uuid, p_location_id uuid, p_container_id uuid, p_qty integer, p_reason text,
  p_client_event_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor   uuid;
  v_rep     jsonb;
  v_sku     public.product_skus%ROWTYPE;
  v_loc     public.wh_locations%ROWTYPE;
  v_ctr     public.wh_containers%ROWTYPE;
  v_buckets text[];
  v_bucket  text;
  v_have    integer;
  v_neg     boolean;
  v_group   uuid := gen_random_uuid();
  v_led     jsonb;
  v_tx      uuid;
  v_res     jsonb;
BEGIN
  IF public._wh_require_role(ARRAY['admin', 'manager', 'user']) IS NULL THEN
    RETURN public._wh_err('forbidden', 'Write-offs need an internal account.');
  END IF;
  v_actor := public._wh_actor(NULL);
  v_rep := public._wh_event_replay(p_client_event_id, 'rpc_wh_write_off');
  IF v_rep IS NOT NULL THEN
    RETURN v_rep;
  END IF;

  SELECT * INTO v_sku FROM public.product_skus WHERE id = p_sku_id;
  IF NOT FOUND THEN
    RETURN public._wh_err('sku_not_found', 'That product does not exist.');
  END IF;
  SELECT * INTO v_loc FROM public.wh_locations WHERE id = p_location_id;
  IF NOT FOUND THEN
    RETURN public._wh_err('location_not_found', 'That location does not exist.');
  END IF;
  IF p_qty IS NULL OR p_qty <= 0 THEN
    RETURN public._wh_err('invalid_qty', 'Write off at least one unit.');
  END IF;
  IF NULLIF(btrim(COALESCE(p_reason, '')), '') IS NULL THEN
    RETURN public._wh_err('reason_required', 'Say why the units are written off.');
  END IF;
  IF p_container_id IS NOT NULL THEN
    SELECT * INTO v_ctr FROM public.wh_containers WHERE id = p_container_id;
    IF NOT FOUND THEN
      RETURN public._wh_err('container_not_found', 'That carton does not exist.');
    END IF;
    IF v_ctr.location_id IS DISTINCT FROM v_loc.id THEN
      RETURN public._wh_err('container_elsewhere', v_ctr.code || ' is not in ' || v_loc.code || '.');
    END IF;
  END IF;

  SELECT array_agg(DISTINCT bucket ORDER BY bucket) INTO v_buckets FROM public.wh_inventory_balances
   WHERE sku_id = p_sku_id AND location_id = v_loc.id AND container_id IS NOT DISTINCT FROM p_container_id AND on_hand > 0;
  IF v_buckets IS NULL THEN
    RETURN public._wh_err('insufficient', v_loc.code || ' holds no ' || v_sku.sku
                          || CASE WHEN v_ctr.id IS NOT NULL THEN ' in ' || v_ctr.code ELSE '' END || '.',
                          jsonb_build_object('available', 0));
  END IF;
  IF cardinality(v_buckets) > 1 THEN
    RETURN public._wh_err('ambiguous_bucket', v_loc.code || ' holds ' || v_sku.sku || ' in more than one bucket ('
                          || array_to_string(v_buckets, ', ') || '); count the location instead.',
                          jsonb_build_object('buckets', to_jsonb(v_buckets)));
  END IF;
  v_bucket := v_buckets[1];
  SELECT on_hand, allow_negative INTO v_have, v_neg FROM public.wh_inventory_balances
   WHERE sku_id = p_sku_id AND location_id = v_loc.id AND container_id IS NOT DISTINCT FROM p_container_id AND bucket = v_bucket
   FOR UPDATE;
  IF NOT v_neg AND v_have < p_qty THEN
    RETURN public._wh_err('insufficient', v_loc.code || ' has ' || v_have || ' ' || v_sku.sku || '; '
                          || p_qty || ' cannot be written off.', jsonb_build_object('available', v_have));
  END IF;

  v_led := public._wh_ledger_post(p_sku_id, 'wh_write_off', v_bucket, NULL, p_qty, 'wh_movement', v_group, v_actor,
                                  btrim(p_reason) || ' at ' || v_loc.code);
  v_tx := NULLIF(v_led->>'tx_id', '')::uuid;
  PERFORM public._wh_post_movement(v_group, 'write_off', p_sku_id, v_bucket, p_qty, v_loc.id, p_container_id, NULL, NULL,
                                   NULL, v_actor, NULL, NULL, btrim(p_reason), p_client_event_id, v_tx);

  v_res := jsonb_build_object('ok', true, 'sku_id', p_sku_id, 'sku', v_sku.sku, 'qty', p_qty, 'bucket', v_bucket,
                              'location', public._wh_loc_json(v_loc.id),
                              'container', CASE WHEN p_container_id IS NOT NULL THEN public._wh_ctr_json(p_container_id) END,
                              'ledger_tx_id', v_tx, 'levels_delta', (v_led->>'delta')::int, 'movement_group_id', v_group);
  RETURN public._wh_event_store(p_client_event_id, 'rpc_wh_write_off', v_actor, v_res);
END;
$$;

-- =============================================================
-- H. Labels, stations, the print agent (§5.5)
-- =============================================================
CREATE OR REPLACE FUNCTION public.rpc_wh_request_labels(p_kind text, p_ids uuid[], p_from text, p_printer_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor   uuid;
  v_missing integer;
BEGIN
  IF public._wh_require_role(ARRAY['admin', 'manager', 'user']) IS NULL THEN
    RETURN public._wh_err('forbidden', 'Printing labels needs an internal account.');
  END IF;
  v_actor := public._wh_actor(NULL);
  IF COALESCE(p_kind, '') NOT IN ('lpn', 'lpn_rts', 'location', 'station') THEN
    RETURN public._wh_err('invalid_kind', COALESCE(p_kind, 'null') || ' is not a label kind (lpn, lpn_rts, location, station).');
  END IF;
  IF p_ids IS NULL OR cardinality(p_ids) = 0 OR cardinality(p_ids) > 500 THEN
    RETURN public._wh_err('invalid_items', 'Ask for between 1 and 500 labels.');
  END IF;
  IF p_from IS NOT NULL AND p_from NOT IN ('dock', 'phone', 'desktop', 'workspace') THEN
    RETURN public._wh_err('invalid_from', p_from || ' is not a requesting place (dock, phone, desktop, workspace).');
  END IF;
  IF p_kind IN ('lpn', 'lpn_rts') THEN
    SELECT count(*) INTO v_missing FROM unnest(p_ids) AS i(id)
     WHERE NOT EXISTS (SELECT 1 FROM public.wh_containers c WHERE c.id = i.id);
  ELSE
    SELECT count(*) INTO v_missing FROM unnest(p_ids) AS i(id)
     WHERE NOT EXISTS (SELECT 1 FROM public.wh_locations l
                        WHERE l.id = i.id AND (p_kind = 'location' OR l.kind = 'station'));
  END IF;
  IF v_missing > 0 THEN
    RETURN public._wh_err('items_not_found', v_missing || ' of the requested '
                          || CASE WHEN p_kind IN ('lpn', 'lpn_rts') THEN 'cartons' WHEN p_kind = 'station' THEN 'stations' ELSE 'locations' END
                          || ' do not exist.');
  END IF;
  IF public._wh_outbound_mode() = 'blocked' THEN
    RETURN public._wh_err('outbound_blocked', 'Printing is blocked on this environment (outbound mode is blocked).');
  END IF;
  RETURN public._wh_queue_print_job(p_kind, p_ids, p_from, p_printer_id, v_actor);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_wh_mark_printed(p_job_id uuid, p_status text DEFAULT 'printed', p_error text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job    public.wh_print_jobs%ROWTYPE;
  v_max    integer := COALESCE((public._wh_setting('printing')->>'max_attempts')::int, 3);
  v_status text;
BEGIN
  IF public._wh_require_role(ARRAY['admin', 'manager', 'user']) IS NULL AND NOT public._wh_is_print_agent() THEN
    RETURN public._wh_err('forbidden', 'Marking labels printed needs an internal account or the print agent.');
  END IF;
  IF COALESCE(p_status, '') NOT IN ('printed', 'failed', 'cancelled') THEN
    RETURN public._wh_err('invalid_status', COALESCE(p_status, 'null') || ' is not printed, failed or cancelled.');
  END IF;
  SELECT * INTO v_job FROM public.wh_print_jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN public._wh_err('job_not_found', 'That print job does not exist.');
  END IF;
  IF v_job.status IN ('printed', 'cancelled') THEN
    RETURN jsonb_build_object('ok', true, 'job_id', v_job.id, 'status', v_job.status, 'unchanged', true);
  END IF;

  IF p_status = 'printed' THEN
    v_status := 'printed';
    UPDATE public.wh_print_jobs SET status = 'printed', printed_at = now(), error = NULL WHERE id = v_job.id;
    IF v_job.kind IN ('lpn', 'lpn_rts') THEN
      UPDATE public.wh_containers SET printed_at = now(), print_count = print_count + 1 WHERE id = ANY (v_job.item_ids);
    ELSE
      UPDATE public.wh_locations SET label_printed_at = now() WHERE id = ANY (v_job.item_ids);
    END IF;
  ELSIF p_status = 'failed' THEN
    v_status := CASE WHEN v_job.printer_id IS NOT NULL AND v_job.attempts < v_max THEN 'queued' ELSE 'failed' END;
    UPDATE public.wh_print_jobs
       SET status = v_status, error = left(COALESCE(p_error, 'print failed'), 1000), claimed_by = NULL, claimed_at = NULL
     WHERE id = v_job.id;
  ELSE
    v_status := 'cancelled';
    UPDATE public.wh_print_jobs SET status = 'cancelled' WHERE id = v_job.id;
  END IF;
  RETURN jsonb_build_object('ok', true, 'job_id', v_job.id, 'status', v_status, 'attempts', v_job.attempts);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_wh_start_station(p_scan_value text, p_device_id text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid;
  v_code  text := upper(btrim(COALESCE(p_scan_value, '')));
  v_loc   public.wh_locations%ROWTYPE;
  v_cur   public.wh_station_sessions%ROWTYPE;
  v_new   public.wh_station_sessions%ROWTYPE;
  v_prev  uuid;
BEGIN
  IF public._wh_require_role(ARRAY['admin', 'manager', 'user']) IS NULL THEN
    RETURN public._wh_err('forbidden', 'Station sessions need an internal account.');
  END IF;
  v_actor := public._wh_actor(NULL);
  IF left(v_code, 1) = '%' THEN
    v_code := substr(v_code, 2);
  END IF;
  IF left(v_code, 1) = 'Z' THEN
    IF public._wh_outbound_mode() <> 'practice' THEN
      RETURN public._wh_err('practice_label', 'That is a practice station label from staging.');
    END IF;
    v_code := substr(v_code, 2);
  END IF;
  SELECT * INTO v_loc FROM public.wh_locations
   WHERE site_location_id = public._default_location_id() AND code = v_code;
  IF NOT FOUND OR v_loc.kind <> 'station' THEN
    RETURN public._wh_err('not_a_station', COALESCE(NULLIF(v_code, ''), 'That') || ' is not a station label.');
  END IF;
  IF NOT v_loc.active THEN
    RETURN public._wh_err('station_inactive', v_loc.code || ' is inactive.');
  END IF;

  SELECT * INTO v_cur FROM public.wh_station_sessions WHERE profile_id = v_actor AND ended_at IS NULL FOR UPDATE;
  IF FOUND AND v_cur.station_location_id = v_loc.id THEN
    UPDATE public.wh_station_sessions SET device_id = COALESCE(p_device_id, device_id) WHERE id = v_cur.id
    RETURNING * INTO v_new;
    RETURN jsonb_build_object('ok', true, 'unchanged', true, 'ended_previous', NULL,
      'session', jsonb_build_object('id', v_new.id, 'station_location_id', v_loc.id, 'code', v_loc.code, 'name', v_loc.name,
                                    'started_at', v_new.started_at, 'device_id', v_new.device_id),
      'printers', (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', p.id, 'code', p.code, 'name', p.name, 'label_stock', p.label_stock,
                                                                'transport', p.transport, 'last_seen_at', p.last_seen_at) ORDER BY p.code), '[]'::jsonb)
                     FROM public.wh_printers p WHERE p.station_location_id = v_loc.id AND p.active));
  END IF;
  IF FOUND THEN
    UPDATE public.wh_station_sessions SET ended_at = now() WHERE id = v_cur.id;
    v_prev := v_cur.id;
  END IF;

  INSERT INTO public.wh_station_sessions (profile_id, station_location_id, device_id)
  VALUES (v_actor, v_loc.id, left(p_device_id, 100))
  RETURNING * INTO v_new;

  RETURN jsonb_build_object('ok', true, 'unchanged', false, 'ended_previous', v_prev,
    'session', jsonb_build_object('id', v_new.id, 'station_location_id', v_loc.id, 'code', v_loc.code, 'name', v_loc.name,
                                  'started_at', v_new.started_at, 'device_id', v_new.device_id),
    'printers', (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', p.id, 'code', p.code, 'name', p.name, 'label_stock', p.label_stock,
                                                              'transport', p.transport, 'last_seen_at', p.last_seen_at) ORDER BY p.code), '[]'::jsonb)
                   FROM public.wh_printers p WHERE p.station_location_id = v_loc.id AND p.active));
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_wh_end_station()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid;
  v_id    uuid;
BEGIN
  IF public._wh_require_role(ARRAY['admin', 'manager', 'user']) IS NULL THEN
    RETURN public._wh_err('forbidden', 'Station sessions need an internal account.');
  END IF;
  v_actor := public._wh_actor(NULL);
  UPDATE public.wh_station_sessions SET ended_at = now()
   WHERE profile_id = v_actor AND ended_at IS NULL
   RETURNING id INTO v_id;
  RETURN jsonb_build_object('ok', true, 'ended', v_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_wh_claim_print_jobs(p_printer_ids uuid[], p_agent_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_timeout  integer := COALESCE((public._wh_setting('printing')->>'claim_timeout_s')::int, 60);
  v_max      integer := COALESCE((public._wh_setting('printing')->>'max_attempts')::int, 3);
  v_released integer;
  v_jobs     jsonb;
BEGIN
  IF NOT public._wh_is_print_agent() THEN
    RETURN public._wh_err('forbidden', 'Only the print agent can claim print jobs.');
  END IF;
  IF NULLIF(btrim(COALESCE(p_agent_id, '')), '') IS NULL THEN
    RETURN public._wh_err('agent_required', 'The print agent must name itself (agent_id).');
  END IF;
  IF p_printer_ids IS NULL OR cardinality(p_printer_ids) = 0 THEN
    RETURN jsonb_build_object('ok', true, 'jobs', '[]'::jsonb, 'released', 0);
  END IF;

  -- release claims that timed out, so another agent (or a retry) can print them
  UPDATE public.wh_print_jobs SET status = 'queued', claimed_by = NULL, claimed_at = NULL
   WHERE status = 'claimed' AND claimed_at < now() - make_interval(secs => v_timeout);
  GET DIAGNOSTICS v_released = ROW_COUNT;

  UPDATE public.wh_print_jobs SET status = 'failed', error = COALESCE(error, 'gave up after ' || attempts || ' attempts')
   WHERE status = 'queued' AND printer_id = ANY (p_printer_ids) AND attempts >= v_max;

  WITH c AS (
    SELECT id FROM public.wh_print_jobs
     WHERE status = 'queued' AND printer_id = ANY (p_printer_ids)
     ORDER BY created_at, id
     LIMIT 20
     FOR UPDATE SKIP LOCKED
  ), u AS (
    UPDATE public.wh_print_jobs j
       SET status = 'claimed', claimed_by = btrim(p_agent_id), claimed_at = now(), attempts = j.attempts + 1
      FROM c WHERE j.id = c.id
    RETURNING j.id, j.kind, j.printer_id, j.payload, j.item_ids, j.attempts, j.created_at
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', u.id, 'kind', u.kind, 'printer_id', u.printer_id, 'payload', u.payload,
                                               'item_ids', to_jsonb(u.item_ids), 'attempts', u.attempts) ORDER BY u.created_at, u.id),
                  '[]'::jsonb)
    INTO v_jobs FROM u;

  UPDATE public.wh_printers SET last_seen_at = now() WHERE id = ANY (p_printer_ids);

  RETURN jsonb_build_object('ok', true, 'jobs', v_jobs, 'released', v_released);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_wh_agent_heartbeat(p_agent_id text, p_printer_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_n      integer;
  v_queued integer;
BEGIN
  IF NOT public._wh_is_print_agent() THEN
    RETURN public._wh_err('forbidden', 'Only the print agent can send heartbeats.');
  END IF;
  IF NULLIF(btrim(COALESCE(p_agent_id, '')), '') IS NULL THEN
    RETURN public._wh_err('agent_required', 'The print agent must name itself (agent_id).');
  END IF;
  UPDATE public.wh_printers
     SET last_seen_at = now(), agent_id = COALESCE(agent_id, btrim(p_agent_id))
   WHERE id = ANY (COALESCE(p_printer_ids, '{}')) AND active;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  SELECT count(*) INTO v_queued FROM public.wh_print_jobs
   WHERE status = 'queued' AND printer_id = ANY (COALESCE(p_printer_ids, '{}'));
  RETURN jsonb_build_object('ok', true, 'printers', v_n, 'queued', v_queued, 'at', now());
END;
$$;

-- =============================================================
-- I. Opening stock import (§9.6 step 4)
-- rows: [{sku, location, sealed_cartons, open_units, units_per_carton,
--         bucket?, loose?}] — workbook "Stock placement" columns.
-- =============================================================
CREATE OR REPLACE FUNCTION public.rpc_wh_import_stock(p_rows jsonb, p_dry_run boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor   uuid;
  r         jsonb;
  n         integer := 0;
  v_sku     public.product_skus%ROWTYPE;
  v_loc     public.wh_locations%ROWTYPE;
  v_sealed  integer;
  v_open    integer;
  v_upc     integer;
  v_bucket  text;
  v_loose   boolean;
  v_ok      jsonb := '[]'::jsonb;
  v_bad     jsonb := '[]'::jsonb;
  v_cartons integer := 0;
  v_units   integer := 0;
  v_group   uuid := gen_random_uuid();
  v_seq     integer;
  v_first   text;
  v_last    text;
  v_ctr     uuid;
  v_code    text;
  i         integer;
  x         jsonb;
BEGIN
  IF public._wh_require_role(ARRAY['admin']) IS NULL THEN
    RETURN public._wh_err('forbidden', 'Importing stock needs an admin.');
  END IF;
  v_actor := public._wh_actor(NULL);
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RETURN public._wh_err('invalid_rows', 'rows must be a JSON array.');
  END IF;

  FOR r IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    n := n + 1;
    IF jsonb_typeof(r) <> 'object' THEN
      v_bad := v_bad || jsonb_build_object('row', n, 'error', 'invalid_row');
      CONTINUE;
    END IF;
    IF COALESCE(NULLIF(r->>'sealed_cartons', ''), '0') !~ '^[0-9]{1,6}$'
       OR COALESCE(NULLIF(COALESCE(r->>'open_units', r->>'units_in_open_carton'), ''), '0') !~ '^[0-9]{1,7}$'
       OR COALESCE(NULLIF(r->>'units_per_carton', ''), '0') !~ '^[0-9]{1,7}$' THEN
      v_bad := v_bad || jsonb_build_object('row', n, 'sku', r->>'sku', 'error', 'invalid_number');
      CONTINUE;
    END IF;
    v_sealed := COALESCE(NULLIF(r->>'sealed_cartons', ''), '0')::int;
    v_open := COALESCE(NULLIF(COALESCE(r->>'open_units', r->>'units_in_open_carton'), ''), '0')::int;
    v_loose := COALESCE((r->>'loose')::boolean, false);

    SELECT * INTO v_sku FROM public.product_skus WHERE lower(sku) = lower(btrim(COALESCE(r->>'sku', ''))) LIMIT 1;
    IF NOT FOUND THEN
      v_bad := v_bad || jsonb_build_object('row', n, 'sku', r->>'sku', 'error', 'unknown_sku');
      CONTINUE;
    END IF;
    SELECT * INTO v_loc FROM public.wh_locations
     WHERE site_location_id = public._default_location_id()
       AND code = upper(btrim(COALESCE(r->>'location', r->>'location_code', '')));
    IF NOT FOUND OR NOT v_loc.active OR v_loc.kind IN ('virtual', 'station') THEN
      v_bad := v_bad || jsonb_build_object('row', n, 'sku', v_sku.sku, 'location', COALESCE(r->>'location', r->>'location_code'),
                                           'error', 'unknown_location');
      CONTINUE;
    END IF;
    v_bucket := COALESCE(NULLIF(lower(btrim(COALESCE(r->>'bucket', ''))), ''), v_loc.bucket_lock,
                         CASE WHEN v_sku.category = 'non_fillable' THEN 'finished' END, v_loc.default_bucket);
    IF v_bucket IS NULL OR v_bucket NOT IN ('raw', 'prefilled_raw', 'in_production', 'finished', 'other') THEN
      v_bad := v_bad || jsonb_build_object('row', n, 'sku', v_sku.sku, 'location', v_loc.code, 'error', 'bucket_required');
      CONTINUE;
    END IF;
    v_upc := COALESCE(NULLIF(NULLIF(r->>'units_per_carton', ''), '0')::int, v_sku.standard_quantity_per_carton);
    IF v_sealed > 0 AND COALESCE(v_upc, 0) <= 0 THEN
      v_bad := v_bad || jsonb_build_object('row', n, 'sku', v_sku.sku, 'location', v_loc.code, 'error', 'units_per_carton_required');
      CONTINUE;
    END IF;
    IF v_sealed = 0 AND v_open = 0 THEN
      v_bad := v_bad || jsonb_build_object('row', n, 'sku', v_sku.sku, 'location', v_loc.code, 'error', 'nothing_to_import');
      CONTINUE;
    END IF;
    v_ok := v_ok || jsonb_build_object('row', n, 'sku_id', v_sku.id, 'sku', v_sku.sku, 'location_id', v_loc.id,
                                       'location', v_loc.code, 'bucket', v_bucket, 'sealed', v_sealed, 'upc', COALESCE(v_upc, 0),
                                       'open', v_open, 'loose', v_loose);
    v_cartons := v_cartons + v_sealed + CASE WHEN v_open > 0 AND NOT v_loose THEN 1 ELSE 0 END;
    v_units := v_units + v_sealed * COALESCE(v_upc, 0) + v_open;
  END LOOP;

  IF COALESCE(p_dry_run, true) THEN
    RETURN jsonb_build_object('ok', true, 'dry_run', true, 'rows', n, 'accepted', jsonb_array_length(v_ok),
                              'cartons', v_cartons, 'units', v_units, 'rejected', v_bad, 'preview', v_ok);
  END IF;
  IF jsonb_array_length(v_bad) > 0 THEN
    RETURN public._wh_err('rows_rejected', jsonb_array_length(v_bad) || ' of ' || n
                          || ' rows were rejected; fix them and run the dry run again. Nothing was imported.',
                          jsonb_build_object('rejected', v_bad));
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('wh_container_code:C-OB', 0));
  SELECT COALESCE(max(substring(code FROM '^C-OB-([0-9]+)$')::int), 0) INTO v_seq
    FROM public.wh_containers WHERE code ~ '^C-OB-[0-9]+$';

  FOR x IN SELECT * FROM jsonb_array_elements(v_ok) LOOP
    FOR i IN 1..(x->>'sealed')::int LOOP
      v_seq := v_seq + 1;
      v_code := 'C-OB-' || lpad(v_seq::text, 4, '0');
      INSERT INTO public.wh_containers (code, sku_id, qty_initial, qty, state, location_id, source, created_by)
      VALUES (v_code, (x->>'sku_id')::uuid, (x->>'upc')::int, 0, 'sealed', (x->>'location_id')::uuid, 'opening_balance', v_actor)
      RETURNING id INTO v_ctr;
      PERFORM public._wh_post_movement(v_group, 'opening_balance', (x->>'sku_id')::uuid, x->>'bucket', (x->>'upc')::int,
                                       NULL, NULL, (x->>'location_id')::uuid, v_ctr, NULL, v_actor, 'wh_import', NULL,
                                       'opening stock');
      v_first := COALESCE(v_first, v_code);
      v_last := v_code;
    END LOOP;
    IF (x->>'open')::int > 0 THEN
      IF (x->>'loose')::boolean THEN
        PERFORM public._wh_post_movement(v_group, 'opening_balance', (x->>'sku_id')::uuid, x->>'bucket', (x->>'open')::int,
                                         NULL, NULL, (x->>'location_id')::uuid, NULL, NULL, v_actor, 'wh_import', NULL,
                                         'opening stock (loose)');
      ELSE
        v_seq := v_seq + 1;
        v_code := 'C-OB-' || lpad(v_seq::text, 4, '0');
        INSERT INTO public.wh_containers (code, sku_id, qty_initial, qty, state, location_id, source, opened_at, created_by)
        VALUES (v_code, (x->>'sku_id')::uuid, (x->>'open')::int, 0, 'open', (x->>'location_id')::uuid, 'opening_balance', now(), v_actor)
        RETURNING id INTO v_ctr;
        PERFORM public._wh_post_movement(v_group, 'opening_balance', (x->>'sku_id')::uuid, x->>'bucket', (x->>'open')::int,
                                         NULL, NULL, (x->>'location_id')::uuid, v_ctr, NULL, v_actor, 'wh_import', NULL,
                                         'opening stock (open carton)');
        v_first := COALESCE(v_first, v_code);
        v_last := v_code;
      END IF;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'dry_run', false, 'rows', n, 'cartons', v_cartons, 'units', v_units,
                            'first_code', v_first, 'last_code', v_last, 'movement_group_id', v_group);
END;
$$;

-- =============================================================
-- J. Overview KPI band and the location summary view
-- =============================================================
CREATE OR REPLACE FUNCTION public.rpc_wh_overview()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_unloc uuid := public._wh_loc_id('UNLOCATED');
  v_mfg   uuid := public._wh_loc_id('MFG-LINE');
BEGIN
  IF public._wh_require_role(ARRAY['admin', 'manager']) IS NULL THEN
    RETURN public._wh_err('forbidden', 'The warehouse overview needs a manager or admin.');
  END IF;
  RETURN jsonb_build_object(
    'ok', true,
    'physical_layer_live', public._wh_live(),
    'putaways_open', (SELECT count(*) FROM public.wh_moves WHERE kind = 'putaway' AND status IN ('open', 'in_progress')),
    'putaways_over_24h', (SELECT count(*) FROM public.wh_moves
                           WHERE kind = 'putaway' AND status IN ('open', 'in_progress') AND created_at < now() - interval '24 hours'),
    'rts_unplaced', (SELECT count(*) FROM public.wh_moves
                      WHERE kind = 'putaway' AND origin = 'rts' AND status IN ('open', 'in_progress')),
    'counts_due', (SELECT count(*) FROM public.wh_count_tasks
                    WHERE status IN ('open', 'counting') AND (due_date IS NULL OR due_date <= current_date)),
    'variances', (SELECT count(*) FROM public.wh_count_tasks WHERE status = 'submitted'),
    'unlocated_units', (SELECT COALESCE(sum(on_hand), 0) FROM public.wh_inventory_balances WHERE location_id = v_unloc),
    'mfg_line_units', (SELECT COALESCE(sum(on_hand), 0) FROM public.wh_inventory_balances WHERE location_id = v_mfg),
    'mfg_line_negative_units', (SELECT COALESCE(sum(on_hand), 0) FROM public.wh_inventory_balances WHERE location_id = v_mfg AND on_hand < 0),
    'cartons', (SELECT count(*) FROM public.wh_containers WHERE state IN ('sealed', 'open')),
    'locations', jsonb_build_object(
      'racks', (SELECT count(*) FROM public.wh_racks WHERE active),
      'rack_locations', (SELECT count(*) FROM public.wh_locations WHERE active AND kind = 'bay_level'),
      'named', (SELECT count(*) FROM public.wh_locations WHERE active AND kind <> 'bay_level'),
      'labels_verified', (SELECT count(*) FROM public.wh_locations WHERE active AND label_verified_at IS NOT NULL)),
    'print', jsonb_build_object(
      'queued', (SELECT count(*) FROM public.wh_print_jobs WHERE status IN ('queued', 'claimed')),
      'failed', (SELECT count(*) FROM public.wh_print_jobs WHERE status = 'failed'),
      'printers', (SELECT count(*) FROM public.wh_printers WHERE active)),
    'last_reconcile', (SELECT to_jsonb(r) FROM public.wh_reconcile_runs r ORDER BY r.run_at DESC LIMIT 1)
  );
END;
$$;

CREATE OR REPLACE VIEW public.wh_location_summary
WITH (security_invoker = true) AS
SELECT l.id,
       l.site_location_id,
       l.code,
       l.name,
       l.kind,
       l.zone,
       l.rack_id,
       r.code AS rack_code,
       l.face_id,
       l.face,
       f.walk_pass,
       f.walk_dir,
       l.bay,
       l.level,
       l.pickable,
       l.is_overflow,
       l.allow_negative,
       l.default_bucket,
       l.bucket_lock,
       l.pick_sequence,
       l.capacity_cartons,
       l.active,
       l.last_counted_at,
       l.label_printed_at,
       l.label_verified_at,
       l.x_mm,
       l.y_mm,
       l.z_mm,
       COALESCE(c.cartons, 0)::integer AS cartons,
       COALESCE(b.units, 0)::integer AS units,
       COALESCE(b.units_raw, 0)::integer AS units_raw,
       COALESCE(b.units_prefilled_raw, 0)::integer AS units_prefilled_raw,
       COALESCE(b.units_in_production, 0)::integer AS units_in_production,
       COALESCE(b.units_finished, 0)::integer AS units_finished,
       COALESCE(b.units_other, 0)::integer AS units_other,
       COALESCE(b.sku_count, 0)::integer AS sku_count,
       b.last_movement_at,
       COALESCE(b.contents, '[]'::jsonb) AS contents
  FROM public.wh_locations l
  LEFT JOIN public.wh_racks r ON r.id = l.rack_id
  LEFT JOIN public.wh_rack_faces f ON f.id = l.face_id
  LEFT JOIN LATERAL (
    SELECT count(*) AS cartons FROM public.wh_containers cc
     WHERE cc.location_id = l.id AND cc.state IN ('sealed', 'open')) c ON true
  LEFT JOIN LATERAL (
    SELECT sum(bb.on_hand) AS units,
           sum(bb.on_hand) FILTER (WHERE bb.bucket = 'raw') AS units_raw,
           sum(bb.on_hand) FILTER (WHERE bb.bucket = 'prefilled_raw') AS units_prefilled_raw,
           sum(bb.on_hand) FILTER (WHERE bb.bucket = 'in_production') AS units_in_production,
           sum(bb.on_hand) FILTER (WHERE bb.bucket = 'finished') AS units_finished,
           sum(bb.on_hand) FILTER (WHERE bb.bucket = 'other') AS units_other,
           count(DISTINCT bb.sku_id) FILTER (WHERE bb.on_hand <> 0) AS sku_count,
           max(bb.last_movement_at) AS last_movement_at,
           jsonb_agg(jsonb_build_object('container_id', bb.container_id, 'code', ct.code, 'sku_id', bb.sku_id, 'sku', ps.sku,
                                        'qty', bb.on_hand, 'bucket', bb.bucket, 'state', ct.state, 'label_stock', ct.label_stock)
                     ORDER BY ct.code NULLS LAST, ps.sku) FILTER (WHERE bb.on_hand <> 0) AS contents
      FROM public.wh_inventory_balances bb
      JOIN public.product_skus ps ON ps.id = bb.sku_id
      LEFT JOIN public.wh_containers ct ON ct.id = bb.container_id
     WHERE bb.location_id = l.id) b ON true;

REVOKE ALL ON public.wh_location_summary FROM anon;
GRANT SELECT ON public.wh_location_summary TO authenticated, service_role;

-- =============================================================
-- K. Grants for the RPCs
-- =============================================================
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.rpc_wh_resolve_scan(text)',
    'public.rpc_wh_suggest_putaway(uuid, uuid[])',
    'public.rpc_wh_putaway_container(uuid, uuid, uuid, uuid, uuid)',
    'public.rpc_wh_move_stock(uuid, integer, uuid, uuid, uuid, uuid, text, uuid, uuid, uuid)',
    'public.rpc_wh_open_container(uuid, uuid, boolean, uuid, uuid)',
    'public.rpc_wh_take_to_line(uuid, uuid, uuid)',
    'public.rpc_wh_rts_relabel(uuid, jsonb, uuid, uuid, uuid, uuid)',
    'public.rpc_wh_record_count(uuid, jsonb, uuid, timestamptz, uuid, uuid)',
    'public.rpc_wh_approve_variance(uuid, jsonb, uuid)',
    'public.rpc_wh_create_count(uuid[], text, text)',
    'public.rpc_wh_write_off(uuid, uuid, uuid, integer, text, uuid)',
    'public.rpc_wh_request_labels(text, uuid[], text, uuid)',
    'public.rpc_wh_mark_printed(uuid, text, text)',
    'public.rpc_wh_start_station(text, text)',
    'public.rpc_wh_end_station()',
    'public.rpc_wh_import_stock(jsonb, boolean)',
    'public.rpc_wh_overview()'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f);
  END LOOP;
  FOREACH f IN ARRAY ARRAY[
    'public.rpc_wh_claim_print_jobs(uuid[], text)',
    'public.rpc_wh_agent_heartbeat(text, uuid[])'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', f);
  END LOOP;
END $$;

-- =============================================================
-- Z. Phase 0 RPCs re-issued with the corrected guard. Bodies are
--    20261021000002's, with `current_user <> 'postgres'` replaced by
--    `NOT public._wh_is_service_call()`.
-- =============================================================
CREATE OR REPLACE FUNCTION public.rpc_wh_import_sku_master(p_rows jsonb, p_dry_run boolean DEFAULT true)
RETURNS jsonb AS $$
DECLARE
  v_actor     uuid := auth.uid();
  v_role      text;
  r           jsonb;
  v_sku       text;
  v_sku_id    uuid;
  v_code      text;
  v_sym       text;
  v_other     text;
  v_has_prim  boolean;
  v_len       numeric; v_wid numeric; v_hgt numeric;
  n_rows      int := 0;
  n_codes     int := 0;
  n_dims      int := 0;
  v_unknown   text[] := '{}';
  v_conflicts jsonb := '[]'::jsonb;
  v_bad       jsonb := '[]'::jsonb;
BEGIN
  SELECT role INTO v_role FROM public.profiles WHERE id = v_actor AND is_active;
  IF v_role IS DISTINCT FROM 'admin' AND NOT public._wh_is_service_call() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'admin role required');
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'rows must be a JSON array');
  END IF;

  FOR r IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    n_rows := n_rows + 1;
    v_sku := btrim(r->>'sku');
    IF v_sku IS NULL OR v_sku = '' THEN
      v_bad := v_bad || jsonb_build_object('row', n_rows, 'error', 'missing sku');
      CONTINUE;
    END IF;

    SELECT id INTO v_sku_id FROM public.product_skus WHERE lower(sku) = lower(v_sku) LIMIT 1;
    IF v_sku_id IS NULL THEN
      v_unknown := v_unknown || v_sku;
      CONTINUE;
    END IF;

    -- barcode
    v_code := NULLIF(regexp_replace(COALESCE(r->>'upc_gtin12', ''), '[^0-9]', '', 'g'), '');
    IF v_code IS NULL AND COALESCE(r->>'upc_raw', '') <> '' THEN
      v_code := public.fn_gtin_normalize(r->>'upc_raw');
    END IF;
    IF v_code IS NOT NULL THEN
      v_sym := COALESCE(NULLIF(r->>'upc_symbology', ''),
                        CASE WHEN length(COALESCE(r->>'upc_raw', '')) IN (6,7,8) THEN 'upce'
                             WHEN length(v_code) = 13 THEN 'ean13'
                             WHEN length(v_code) = 8  THEN 'ean8'
                             ELSE 'upca' END);
      IF v_sym NOT IN ('upca','upce','ean13','ean8','other') THEN v_sym := 'other'; END IF;

      SELECT ps.sku INTO v_other
        FROM public.sku_barcodes b JOIN public.product_skus ps ON ps.id = b.sku_id
       WHERE b.code = v_code AND b.sku_id <> v_sku_id;
      IF v_other IS NOT NULL THEN
        v_conflicts := v_conflicts || jsonb_build_object('sku', v_sku, 'code', v_code, 'already_on', v_other);
      ELSE
        n_codes := n_codes + 1;
        IF NOT p_dry_run THEN
          SELECT EXISTS (SELECT 1 FROM public.sku_barcodes WHERE sku_id = v_sku_id AND is_primary) INTO v_has_prim;
          INSERT INTO public.sku_barcodes (sku_id, code, code_raw, symbology, source, is_primary, created_by)
          VALUES (v_sku_id, v_code, NULLIF(r->>'upc_raw', ''), v_sym, 'catalog_csv', NOT v_has_prim, v_actor)
          ON CONFLICT (code) DO NOTHING;
          UPDATE public.product_skus
             SET upc_code = v_code
           WHERE id = v_sku_id AND (upc_code IS NULL OR upc_code = '' OR NOT v_has_prim);
        END IF;
      END IF;
    END IF;

    -- box dimensions (all three or none)
    v_len := NULLIF(r->>'box_length_in', '')::numeric;
    v_wid := NULLIF(r->>'box_width_in',  '')::numeric;
    v_hgt := NULLIF(r->>'box_height_in', '')::numeric;
    IF v_len IS NOT NULL AND v_wid IS NOT NULL AND v_hgt IS NOT NULL THEN
      IF v_len <= 0 OR v_wid <= 0 OR v_hgt <= 0 THEN
        v_bad := v_bad || jsonb_build_object('row', n_rows, 'sku', v_sku, 'error', 'box dimensions must be positive');
      ELSE
        n_dims := n_dims + 1;
        IF NOT p_dry_run THEN
          UPDATE public.product_skus
             SET box_length_in = v_len, box_width_in = v_wid, box_height_in = v_hgt
           WHERE id = v_sku_id;
        END IF;
      END IF;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'dry_run', p_dry_run,
    'rows', n_rows,
    'codes_loaded', n_codes,
    'dims_loaded', n_dims,
    'unknown_skus', to_jsonb(v_unknown),
    'conflicts', v_conflicts,
    'rejected', v_bad
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.rpc_wh_import_sku_master(jsonb, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_wh_import_sku_master(jsonb, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.rpc_wh_barcode_coverage()
RETURNS jsonb AS $$
DECLARE
  v_role text;
BEGIN
  SELECT role INTO v_role FROM public.profiles WHERE id = auth.uid() AND is_active;
  IF (v_role IS NULL OR v_role = 'supplier') AND NOT public._wh_is_service_call() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'internal role required');
  END IF;
  RETURN jsonb_build_object(
    'ok', true,
    'with_code', (SELECT count(DISTINCT b.sku_id) FROM public.sku_barcodes b JOIN public.product_skus ps ON ps.id = b.sku_id WHERE ps.is_active),
    'active_total', (SELECT count(*) FROM public.product_skus WHERE is_active),
    'missing', (SELECT COALESCE(jsonb_agg(ps.sku ORDER BY ps.display_category, ps.sku), '[]'::jsonb)
                  FROM public.product_skus ps
                 WHERE ps.is_active AND NOT EXISTS (SELECT 1 FROM public.sku_barcodes b WHERE b.sku_id = ps.id))
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.rpc_wh_barcode_coverage() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_wh_barcode_coverage() TO authenticated;

CREATE OR REPLACE FUNCTION public.rpc_wh_baseline_kpis(p_from date, p_to date)
RETURNS jsonb AS $$
DECLARE
  v_role text;
  v_days jsonb;
  v_sum  jsonb;
BEGIN
  SELECT role INTO v_role FROM public.profiles WHERE id = auth.uid() AND is_active;
  IF (v_role IS NULL OR v_role = 'supplier') AND NOT public._wh_is_service_call() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'internal role required');
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 120 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'range must be 0-120 days');
  END IF;

  WITH shipped AS (
    SELECT o.id,
           public.fn_ss_et(o.ship_date)::date  AS ship_day,
           public.fn_ss_et(o.order_date)::date AS order_day,
           EXTRACT(HOUR FROM public.fn_ss_et(o.order_date)) AS order_hour,
           (public.fn_ss_et(o.ship_date)::date - public.fn_ss_et(o.order_date)::date) AS days_to_ship,
           (SELECT count(*) FROM public.shipstation_order_items i WHERE i.shipstation_order_id = o.id) AS lines
      FROM public.shipstation_orders o
     WHERE o.order_status = 'shipped'
       AND o.ship_date IS NOT NULL
       AND public.fn_ss_et(o.ship_date)::date BETWEEN p_from AND p_to
  ),
  morning AS (
    SELECT public.fn_ss_et(o.order_date)::date AS order_day,
           count(*) AS imported,
           count(*) FILTER (WHERE o.order_status = 'shipped' AND o.ship_date IS NOT NULL
                              AND public.fn_ss_et(o.ship_date)::date = public.fn_ss_et(o.order_date)::date) AS same_day
      FROM public.shipstation_orders o
     WHERE public.fn_ss_et(o.order_date)::date BETWEEN p_from AND p_to
       AND EXTRACT(HOUR FROM public.fn_ss_et(o.order_date)) < 14
       AND o.order_status IN ('shipped', 'awaiting_shipment', 'on_hold')
     GROUP BY 1
  ),
  per_day AS (
    SELECT s.ship_day,
           count(*) AS orders,
           sum(s.lines) AS lines,
           round((percentile_cont(0.5) WITHIN GROUP (ORDER BY s.days_to_ship))::numeric, 1) AS median_days_to_ship,
           m.imported, m.same_day
      FROM shipped s
      LEFT JOIN morning m ON m.order_day = s.ship_day
     GROUP BY s.ship_day, m.imported, m.same_day
  )
  SELECT jsonb_agg(jsonb_build_object(
           'ship_day', ship_day, 'orders', orders, 'lines', lines,
           'median_days_to_ship', median_days_to_ship,
           'same_day_share', CASE WHEN COALESCE(imported, 0) > 0 THEN round(same_day::numeric / imported, 3) ELSE NULL END
         ) ORDER BY ship_day),
         jsonb_build_object(
           'median_orders_per_day', percentile_cont(0.5) WITHIN GROUP (ORDER BY orders),
           'median_days_to_ship', percentile_cont(0.5) WITHIN GROUP (ORDER BY median_days_to_ship),
           'same_day_share', CASE WHEN sum(imported) > 0 THEN round(sum(same_day)::numeric / sum(imported), 3) ELSE NULL END,
           'ship_days', count(*)
         )
    INTO v_days, v_sum
    FROM per_day;

  RETURN jsonb_build_object('ok', true, 'from', p_from, 'to', p_to,
                            'days', COALESCE(v_days, '[]'::jsonb),
                            'summary', COALESCE(v_sum, '{}'::jsonb));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.rpc_wh_baseline_kpis(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_wh_baseline_kpis(date, date) TO authenticated;

COMMIT;
