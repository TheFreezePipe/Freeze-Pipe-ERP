-- =============================================================
-- Migration: Carton labels as a pair of 4x6 labels (Phase 1, labels)
-- =============================================================
-- Design: docs/design/WAREHOUSE_MODULE_PHASE0_1.md §5.5 (LPN label,
-- "Carton label format, owner decisions 2026-10-28"); §4.3 (wh_printers).
--
-- Finding: the payload builder hard-codes the carton label size (4x2 for
-- lpn and lpn_rts, 3x1 otherwise) and _wh_queue_print_job hard-codes the
-- stock it routes to (white_4x2, green_4x2, white_3x1). The owner moved
-- carton labels to a pair of identical 4x6 labels per carton, printed by
-- one command, with the 4x2 layout kept as a setting for stock on hand.
-- wh_settings.labels.lpn exists but nothing reads it, and its validator
-- accepts any "NxM".
-- Decision:
--   * wh_printers.label_stock CHECK gains white_4x6 and green_4x6
--     (dropped and re-added); rpc_wh_save_printer accepts them. The
--     function is re-issued from the live body with only the stock list
--     and its message changed.
--   * rpc_wh_set_setting, key 'labels': lpn is '4x2' or '4x6'; location
--     is '3x1'; dpi 203 | 300 | 600 as before. Re-issued from the live
--     body with only that branch changed. Staging stays on 4x2 until the
--     owner switches it in Settings.
--   * _wh_label_payload gains p_copies integer DEFAULT NULL. size for lpn
--     and lpn_rts is wh_settings.labels.lpn ('4x2' when unset or not one
--     of the two sizes), else '3x1'. The payload gains copies: p_copies
--     when given (at least 1), else 2 for a 4x6 carton label, else 1. The
--     3-argument function is dropped first (a signature cannot change in
--     place); it stays private.
--   * _wh_queue_print_job gains p_copies integer DEFAULT NULL (the
--     6-argument function is dropped first). It reads the labels setting
--     once; the job's stock is 'white_' || size for lpn, 'green_' || size
--     for lpn_rts, white_3x1 otherwise, so a 4x6 carton job routes to a
--     station printer stocked white_4x6 and, without one, falls back to
--     the browser with "This station has no white 4x6 printer; print from
--     this browser." Routing and messages are otherwise unchanged; the
--     RTS relabel and the LPN receipt, which call it with five arguments,
--     are unaffected.
--   * rpc_wh_request_labels gains p_copies integer DEFAULT NULL, 1-5 when
--     given (invalid_copies otherwise), which overrides the copies the
--     server would choose (Reprint one). The 5-argument function is
--     dropped first so PostgREST sees one signature; callers passing
--     named arguments are unaffected. Same grants as before.
--
-- Smoke after deploy (a validation envelope passes; a relation error fails):
--   SELECT public.rpc_wh_save_printer('{"code":"SMOKE-1","transport":"browser","label_stock":"white_4x8"}'::jsonb);  -- {ok:false, error:'invalid_label_stock'}
--   SELECT public.rpc_wh_set_setting('labels', '{"lpn":"4x8"}'::jsonb);                                   -- {ok:false, error:'invalid_value'}
--   SELECT public._wh_label_payload('lpn', ARRAY[gen_random_uuid()], false);                            -- {labels:[], size:'4x2', copies:1}
--   SELECT public.rpc_wh_request_labels('lpn', ARRAY[gen_random_uuid()], 'desktop', NULL, NULL, 9);     -- {ok:false, error:'invalid_copies'}
--   SELECT public.rpc_wh_request_labels('lpn', ARRAY[gen_random_uuid()], 'desktop', NULL, NULL, 1);     -- {ok:false, error:'items_not_found'}
--   _wh_queue_print_job writes a job row, so it is smoked in a block that raises its result (rolling the row back):
--   DO $$ BEGIN RAISE EXCEPTION 'SMOKE_OK %', public._wh_queue_print_job('location', ARRAY[gen_random_uuid()], 'desktop', NULL, NULL, 'browser', 1); END $$;  -- ERROR: SMOKE_OK {... "routed_by": "requested", "payload": {... "copies": 1}}
-- =============================================================

BEGIN;

-- -------------------------------------------------------------
-- A. wh_printers.label_stock: the 4x6 stocks
-- -------------------------------------------------------------
ALTER TABLE public.wh_printers DROP CONSTRAINT IF EXISTS chk_wh_printers_label_stock;
ALTER TABLE public.wh_printers ADD CONSTRAINT chk_wh_printers_label_stock
  CHECK (label_stock IN ('white_4x2', 'green_4x2', 'white_4x6', 'green_4x6', 'white_3x1'));

-- -------------------------------------------------------------
-- B. rpc_wh_save_printer: the live body, accepting the 4x6 stocks
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_wh_save_printer(p_printer jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r           jsonb := p_printer;
  v_p         public.wh_printers%ROWTYPE;
  v_found     boolean := false;
  v_code      text;
  v_name      text;
  v_transport text;
  v_address   text;
  v_stock     text;
  v_dpi       integer;
  v_station   uuid;
  v_agent     text;
  v_active    boolean;
  v_port      integer;
  v_created   boolean;
BEGIN
  IF public._wh_require_role(ARRAY['admin']) IS NULL THEN
    RETURN public._wh_err('forbidden', 'Registering printers needs an admin.');
  END IF;
  IF r IS NULL OR jsonb_typeof(r) <> 'object' THEN
    RETURN public._wh_err('invalid_payload', 'The printer must be a JSON object.');
  END IF;

  IF NULLIF(r->>'id', '') IS NOT NULL THEN
    IF (r->>'id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RETURN public._wh_err('invalid_payload', 'id must be a printer''s uuid.');
    END IF;
    SELECT * INTO v_p FROM public.wh_printers WHERE id = (r->>'id')::uuid FOR UPDATE;
    IF NOT FOUND THEN
      RETURN public._wh_err('printer_not_found', 'That printer does not exist.');
    END IF;
    v_found := true;
  ELSIF NULLIF(btrim(COALESCE(r->>'code', '')), '') IS NOT NULL THEN
    SELECT * INTO v_p FROM public.wh_printers WHERE upper(code) = upper(btrim(r->>'code')) FOR UPDATE;
    v_found := FOUND;
  ELSE
    RETURN public._wh_err('code_required', 'A printer needs a code, such as DOCK-1.');
  END IF;

  IF v_found AND r ? 'row_version' AND (r->>'row_version') IS DISTINCT FROM v_p.row_version::text THEN
    RETURN public._wh_err('stale', v_p.code || ' changed since it was loaded; reload it and try again.',
                          jsonb_build_object('printer', to_jsonb(v_p)));
  END IF;

  -- merge: an omitted field keeps its value on an edit
  v_code := upper(btrim(COALESCE(CASE WHEN r ? 'code' THEN r->>'code' END, v_p.code, '')));
  v_name := btrim(COALESCE(CASE WHEN r ? 'name' THEN NULLIF(btrim(r->>'name'), '') END, v_p.name, v_code));
  v_transport := lower(btrim(COALESCE(CASE WHEN r ? 'transport' THEN r->>'transport' END, v_p.transport, 'agent')));
  v_address := CASE WHEN r ? 'address' THEN NULLIF(btrim(r->>'address'), '') ELSE v_p.address END;
  v_stock := lower(btrim(COALESCE(CASE WHEN r ? 'label_stock' THEN r->>'label_stock' END, v_p.label_stock, '')));
  v_agent := CASE WHEN r ? 'agent_id' THEN NULLIF(btrim(r->>'agent_id'), '') ELSE v_p.agent_id END;

  IF v_code !~ '^[A-Z0-9][A-Z0-9_-]{0,39}$' THEN
    RETURN public._wh_err('invalid_code', 'A printer code is 1-40 letters, digits, - or _, such as DOCK-1.');
  END IF;
  IF length(v_name) > 100 THEN
    RETURN public._wh_err('invalid_payload', 'A printer name is at most 100 characters.');
  END IF;
  IF v_transport NOT IN ('agent', 'browser') THEN
    RETURN public._wh_err('invalid_transport', 'transport is agent (the print agent sends the label) or browser.');
  END IF;

  IF v_transport = 'browser' THEN
    IF r ? 'address' AND v_address IS NOT NULL THEN
      RETURN public._wh_err('invalid_address', 'A browser printer has no address; the page prints it.');
    END IF;
    v_address := NULL;
  ELSIF v_address IS NULL THEN
    RETURN public._wh_err('invalid_address', 'An agent printer needs an address: tcp://host:9100, share://HOST/Share or file://<directory>.');
  ELSIF v_address ~* '^tcp://[A-Za-z0-9.-]+(:[0-9]{1,5})?/?$' THEN
    v_port := NULLIF(substring(v_address FROM ':([0-9]{1,5})/?$'), '')::int;
    IF v_port IS NOT NULL AND (v_port < 1 OR v_port > 65535) THEN
      RETURN public._wh_err('invalid_address', 'Port ' || v_port || ' is out of range in ' || v_address || '.');
    END IF;
  ELSIF v_address ~* '^share://[A-Za-z0-9._-]+/[A-Za-z0-9 ._$-]+/?$' THEN
    NULL;
  ELSIF v_address ~* '^file://.+$' THEN
    NULL;
  ELSE
    RETURN public._wh_err('invalid_address', 'Unknown printer address "' || left(v_address, 80)
                          || '": use tcp://host:9100, share://HOST/Share or file://<directory>.');
  END IF;

  IF v_stock NOT IN ('white_4x2', 'green_4x2', 'white_4x6', 'green_4x6', 'white_3x1') THEN
    RETURN public._wh_err('invalid_label_stock', 'label_stock is white_4x2 or white_4x6 (cartons), green_4x2 or green_4x6 (RTS) or white_3x1 (locations and stations).');
  END IF;

  IF r ? 'dpi' THEN
    IF COALESCE(r->>'dpi', '') NOT IN ('203', '300', '600') THEN
      RETURN public._wh_err('invalid_dpi', 'dpi is 203, 300 or 600.');
    END IF;
    v_dpi := (r->>'dpi')::int;
  ELSE
    v_dpi := COALESCE(v_p.dpi, 203);
  END IF;

  IF r ? 'active' THEN
    IF jsonb_typeof(r->'active') <> 'boolean' THEN
      RETURN public._wh_err('invalid_payload', 'active must be true or false.');
    END IF;
    v_active := (r->>'active')::boolean;
  ELSE
    v_active := COALESCE(v_p.active, true);
  END IF;

  IF r ? 'station_location_id' THEN
    IF NULLIF(r->>'station_location_id', '') IS NULL THEN
      v_station := NULL;
    ELSIF (r->>'station_location_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RETURN public._wh_err('invalid_station', 'station_location_id must be a station''s uuid.');
    ELSE
      SELECT id INTO v_station FROM public.wh_locations
       WHERE id = (r->>'station_location_id')::uuid AND kind = 'station' AND active;
      IF v_station IS NULL THEN
        RETURN public._wh_err('invalid_station', 'That location is not an active station.');
      END IF;
    END IF;
  ELSIF r ? 'station_code' THEN
    IF NULLIF(btrim(COALESCE(r->>'station_code', '')), '') IS NULL THEN
      v_station := NULL;
    ELSE
      SELECT id INTO v_station FROM public.wh_locations
       WHERE site_location_id = public._default_location_id() AND upper(code) = upper(btrim(r->>'station_code'))
         AND kind = 'station' AND active;
      IF v_station IS NULL THEN
        RETURN public._wh_err('invalid_station', btrim(r->>'station_code') || ' is not an active station.');
      END IF;
    END IF;
  ELSE
    v_station := v_p.station_location_id;
  END IF;

  IF v_agent IS NOT NULL AND length(v_agent) > 100 THEN
    RETURN public._wh_err('invalid_payload', 'agent_id is at most 100 characters.');
  END IF;

  BEGIN
    IF v_found THEN
      UPDATE public.wh_printers
         SET code = v_code, name = v_name, station_location_id = v_station, transport = v_transport,
             address = v_address, label_stock = v_stock, dpi = v_dpi, agent_id = v_agent, active = v_active
       WHERE id = v_p.id
       RETURNING * INTO v_p;
      v_created := false;
    ELSE
      INSERT INTO public.wh_printers (code, name, station_location_id, transport, address, label_stock, dpi, agent_id, active)
      VALUES (v_code, v_name, v_station, v_transport, v_address, v_stock, v_dpi, v_agent, v_active)
      RETURNING * INTO v_p;
      v_created := true;
    END IF;
  EXCEPTION WHEN unique_violation THEN
    RETURN public._wh_err('code_taken', v_code || ' is already another printer''s code.');
  END;

  RETURN jsonb_build_object('ok', true, 'created', v_created, 'printer', to_jsonb(v_p));
END;
$$;

-- -------------------------------------------------------------
-- C. rpc_wh_set_setting: the live body; 'labels' takes the two carton sizes
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_wh_set_setting(p_key text, p_value jsonb)
RETURNS jsonb AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_role  text;
  v_mode  text;
  v_k     text;
  v_bad   text;
  v_el    jsonb;
BEGIN
  SELECT role INTO v_role FROM public.profiles WHERE id = v_actor AND is_active;
  IF v_role IS DISTINCT FROM 'admin' AND NOT public._wh_is_service_call() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'admin role required');
  END IF;

  IF p_key = 'cart_definitions' THEN
    IF p_value IS NULL OR jsonb_typeof(p_value) <> 'array' THEN
      RETURN jsonb_build_object('ok', false, 'error', 'invalid_value', 'message', 'cart_definitions must be a JSON array (invalid_value).');
    END IF;
    FOR v_el IN SELECT * FROM jsonb_array_elements(p_value) LOOP
      IF jsonb_typeof(v_el) <> 'object' OR jsonb_typeof(v_el->'code') <> 'string' OR jsonb_typeof(v_el->'slots') <> 'array'
         OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_el->'slots') s
                     WHERE jsonb_typeof(s) <> 'object' OR jsonb_typeof(s->'letter') <> 'string'
                        OR COALESCE(s->>'class', '') NOT IN ('S', 'M', 'L')) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_value',
          'message', 'Each cart needs a code and slots of {letter, class S|M|L, colour} (invalid_value).');
      END IF;
    END LOOP;
  ELSE
    IF p_value IS NULL OR jsonb_typeof(p_value) <> 'object' THEN
      RETURN jsonb_build_object('ok', false, 'error', 'value must be a JSON object');
    END IF;

    IF p_key = 'outbound' THEN
      v_mode := p_value->>'mode';
      IF v_mode IS NULL OR v_mode NOT IN ('live', 'practice', 'blocked') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'outbound.mode must be live, practice or blocked');
      END IF;
    ELSIF p_key = 'physical_layer' THEN
      FOREACH v_k IN ARRAY ARRAY['enabled', 'mint_lpns'] LOOP
        IF p_value ? v_k AND jsonb_typeof(p_value->v_k) <> 'boolean' THEN
          RETURN jsonb_build_object('ok', false, 'error', 'physical_layer.' || v_k || ' must be boolean');
        END IF;
      END LOOP;
      IF p_value ? 'live_since' AND jsonb_typeof(p_value->'live_since') <> 'null' THEN
        BEGIN
          PERFORM (p_value->>'live_since')::timestamptz;
        EXCEPTION WHEN OTHERS THEN
          RETURN jsonb_build_object('ok', false, 'error', 'invalid_value', 'message', 'physical_layer.live_since must be null or a timestamp (invalid_value).');
        END;
      END IF;
    ELSIF p_key = 'scan_rules' THEN
      FOREACH v_k IN ARRAY ARRAY['require_location_scan', 'location_scan_every_stop', 'confirm_putaway_location'] LOOP
        IF p_value ? v_k AND jsonb_typeof(p_value->v_k) <> 'boolean' THEN
          RETURN jsonb_build_object('ok', false, 'error', 'scan_rules.' || v_k || ' must be boolean');
        END IF;
      END LOOP;
    ELSIF p_key = 'putaway' THEN
      IF p_value ? 'breakdown_location_code' AND jsonb_typeof(p_value->'breakdown_location_code') <> 'null'
         AND NOT EXISTS (SELECT 1 FROM public.wh_locations WHERE code = p_value->>'breakdown_location_code' AND active AND kind <> 'virtual') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_value',
          'message', 'putaway.breakdown_location_code must name an active location (invalid_value).');
      END IF;
      IF p_value ? 'max_suggestions' AND (jsonb_typeof(p_value->'max_suggestions') <> 'number'
           OR (p_value->>'max_suggestions')::numeric NOT BETWEEN 1 AND 10) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_value', 'message', 'putaway.max_suggestions must be 1-10 (invalid_value).');
      END IF;
    ELSIF p_key = 'count_schedule' THEN
      SELECT string_agg(k, ', ') INTO v_bad
        FROM unnest(ARRAY['A_days', 'B_days', 'C_days', 'daily_cap']) AS k
       WHERE p_value ? k AND (jsonb_typeof(p_value->k) <> 'number' OR (p_value->>k)::numeric NOT BETWEEN 1 AND 500
                              OR (p_value->>k)::numeric <> trunc((p_value->>k)::numeric));
      IF v_bad IS NOT NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_value', 'message', 'count_schedule ' || v_bad || ' must be whole numbers 1-500 (invalid_value).');
      END IF;
    ELSIF p_key = 'reconcile' THEN
      IF p_value ? 'create_counts' AND jsonb_typeof(p_value->'create_counts') <> 'boolean' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'reconcile.create_counts must be boolean');
      END IF;
      IF p_value ? 'max_counts_per_sku' AND (jsonb_typeof(p_value->'max_counts_per_sku') <> 'number'
           OR (p_value->>'max_counts_per_sku')::numeric NOT BETWEEN 0 AND 20) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_value', 'message', 'reconcile.max_counts_per_sku must be 0-20 (invalid_value).');
      END IF;
    ELSIF p_key = 'labels' THEN
      IF (p_value ? 'lpn' AND COALESCE(p_value->>'lpn', '') NOT IN ('4x2', '4x6'))
         OR (p_value ? 'location' AND COALESCE(p_value->>'location', '') <> '3x1')
         OR (p_value ? 'dpi' AND COALESCE(p_value->>'dpi', '') NOT IN ('203', '300', '600')) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_value', 'message', 'labels.lpn is "4x2" or "4x6" and labels.location is "3x1"; dpi is 203, 300 or 600 (invalid_value).');
      END IF;
    ELSIF p_key = 'rts' THEN
      FOREACH v_k IN ARRAY ARRAY['require_relabel', 'allow_no_parent'] LOOP
        IF p_value ? v_k AND jsonb_typeof(p_value->v_k) <> 'boolean' THEN
          RETURN jsonb_build_object('ok', false, 'error', 'rts.' || v_k || ' must be boolean');
        END IF;
      END LOOP;
    ELSIF p_key = 'printing' THEN
      IF p_value ? 'require_station' AND jsonb_typeof(p_value->'require_station') <> 'boolean' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'printing.require_station must be boolean');
      END IF;
      IF (p_value ? 'claim_timeout_s' AND (jsonb_typeof(p_value->'claim_timeout_s') <> 'number'
            OR (p_value->>'claim_timeout_s')::numeric NOT BETWEEN 10 AND 3600))
         OR (p_value ? 'max_attempts' AND (jsonb_typeof(p_value->'max_attempts') <> 'number'
            OR (p_value->>'max_attempts')::numeric NOT BETWEEN 1 AND 10)) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_value',
          'message', 'printing.claim_timeout_s must be 10-3600 and max_attempts 1-10 (invalid_value).');
      END IF;
    ELSE
      RETURN jsonb_build_object('ok', false, 'error', 'unknown setting key: ' || p_key);
    END IF;
  END IF;

  INSERT INTO public.wh_settings (key, value, updated_by)
  VALUES (p_key, p_value, v_actor)
  ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by;

  RETURN jsonb_build_object('ok', true, 'key', p_key, 'value', p_value);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- -------------------------------------------------------------
-- D. _wh_label_payload(..., p_copies): size from the setting, copies
-- -------------------------------------------------------------
DROP FUNCTION IF EXISTS public._wh_label_payload(text, uuid[], boolean);

CREATE OR REPLACE FUNCTION public._wh_label_payload(
  p_kind text, p_ids uuid[], p_practice boolean, p_copies integer DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE
SET search_path = public
AS $$
DECLARE
  v_pre    text := CASE WHEN p_practice THEN '%Z' ELSE '%' END;
  v_labels jsonb;
  v_lpn    text := public._wh_setting('labels')->>'lpn';
  v_size   text;
  v_copies integer;
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
  -- carton labels follow wh_settings.labels.lpn (4x2 unless it says 4x6); a
  -- 4x6 carton label prints as an identical pair unless the caller says otherwise
  v_size := CASE WHEN p_kind IN ('lpn', 'lpn_rts')
                 THEN CASE WHEN v_lpn IN ('4x2', '4x6') THEN v_lpn ELSE '4x2' END
                 ELSE '3x1' END;
  v_copies := CASE WHEN p_copies IS NOT NULL THEN GREATEST(p_copies, 1)
                   WHEN v_size = '4x6' THEN 2
                   ELSE 1 END;
  RETURN jsonb_build_object('kind', p_kind, 'practice', p_practice, 'size', v_size, 'copies', v_copies,
                            'labels', v_labels);
END;
$$;

-- -------------------------------------------------------------
-- E. _wh_queue_print_job(..., p_copies): stock from the label size
-- -------------------------------------------------------------
DROP FUNCTION IF EXISTS public._wh_queue_print_job(text, uuid[], text, uuid, uuid, text);

CREATE OR REPLACE FUNCTION public._wh_queue_print_job(
  p_kind text, p_ids uuid[], p_from text, p_printer_id uuid, p_actor uuid, p_target text DEFAULT NULL,
  p_copies integer DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_mode     text := public._wh_outbound_mode();
  v_lpn      text := public._wh_setting('labels')->>'lpn';
  v_size     text;
  v_stock    text;
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
  -- the stock follows the carton label size: white_<size> for lpn, green_<size> for lpn_rts
  v_size := CASE WHEN v_lpn IN ('4x2', '4x6') THEN v_lpn ELSE '4x2' END;
  v_stock := CASE p_kind WHEN 'lpn' THEN 'white_' || v_size WHEN 'lpn_rts' THEN 'green_' || v_size ELSE 'white_3x1' END;

  SELECT station_location_id INTO v_station FROM public.wh_station_sessions
   WHERE profile_id = p_actor AND ended_at IS NULL;

  IF p_target = 'browser' THEN
    v_reason := 'requested';   -- the caller asked for the browser: no printer, whatever the session says
  ELSIF p_printer_id IS NOT NULL THEN
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

  v_payload := public._wh_label_payload(p_kind, p_ids, v_mode = 'practice', p_copies);
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
-- F. rpc_wh_request_labels(..., p_copies)
-- -------------------------------------------------------------
DROP FUNCTION IF EXISTS public.rpc_wh_request_labels(text, uuid[], text, uuid, text);

CREATE OR REPLACE FUNCTION public.rpc_wh_request_labels(
  p_kind text, p_ids uuid[], p_from text, p_printer_id uuid DEFAULT NULL, p_target text DEFAULT NULL,
  p_copies integer DEFAULT NULL)
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
  IF p_target IS NOT NULL AND p_target NOT IN ('browser', 'station') THEN
    RETURN public._wh_err('invalid_target', p_target || ' is not a print target (browser or station).');
  END IF;
  IF p_copies IS NOT NULL AND (p_copies < 1 OR p_copies > 5) THEN
    RETURN public._wh_err('invalid_copies', 'Ask for 1 to 5 copies of each label, not ' || p_copies || '.');
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
  RETURN public._wh_queue_print_job(p_kind, p_ids, p_from, p_printer_id, v_actor, p_target, p_copies);
END;
$$;

-- -------------------------------------------------------------
-- G. Grants (re-created functions start from the schema defaults)
-- -------------------------------------------------------------
REVOKE ALL ON FUNCTION public._wh_label_payload(text, uuid[], boolean, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._wh_queue_print_job(text, uuid[], text, uuid, uuid, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rpc_wh_request_labels(text, uuid[], text, uuid, text, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rpc_wh_save_printer(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rpc_wh_set_setting(text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_wh_request_labels(text, uuid[], text, uuid, text, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_wh_save_printer(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_wh_set_setting(text, jsonb) TO authenticated;

COMMIT;
