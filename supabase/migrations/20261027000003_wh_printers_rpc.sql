-- =============================================================
-- Migration: Printer registration RPCs and a browser target for label
--            requests (Phase 1, slice 4E)
-- =============================================================
-- Design: docs/design/WAREHOUSE_MODULE_PHASE0_1.md §4.3 (wh_printers),
-- §5.5 (print queue, "Print from browser"); tools/print-agent/README.md
-- (printer addresses).
--
-- Finding: slice 3 shipped the print agent but no printer RPC:
-- wh_printers has no client write policy, so Settings › Warehouse builds
-- an INSERT for the database owner to paste. And a worker in a station
-- session cannot ask for a label from the browser: rpc_wh_request_labels
-- always routes to the station printer when one fits, so "Print from
-- browser" after a failed agent print has no way to say so.
-- Decision:
--   * rpc_wh_save_printer(p_printer jsonb), admin: creates or edits one
--     printer, found by id, else by code (case-insensitive). Fields: code
--     (A-Z, 0-9, - and _, upper-cased), name, transport agent | browser,
--     address, label_stock white_4x2 | green_4x2 | white_3x1, dpi 203 |
--     300 | 600, station (station_location_id, or station_code; null or ''
--     = shared; must be an active station location), agent_id, active.
--     Omitted fields keep their value on an edit. An agent printer needs
--     an address the agent can parse: tcp://host[:port] (port 1-65535,
--     9100 when omitted), share://HOST/ShareName or file://<directory>;
--     a browser printer has none. Sending row_version that is not the
--     current one returns `stale` with the current row (the
--     rpc_wh_save_location convention). Errors: forbidden,
--     invalid_payload, code_required, invalid_code, printer_not_found,
--     invalid_transport, invalid_address, invalid_label_stock,
--     invalid_dpi, invalid_station, code_taken, stale.
--   * rpc_wh_delete_printer(p_id uuid), admin: refuses with
--     printer_has_jobs while the printer has queued or claimed jobs,
--     otherwise deactivates it (print jobs keep their printer_id, so the
--     row stays). Returns the row and already_inactive.
--   * rpc_wh_request_labels gains p_target text DEFAULT NULL: 'browser'
--     forces the browser path even with a station session or a named
--     printer (routed_by 'requested'); 'station' or null is today's
--     routing; anything else is invalid_target. Same return shape. The
--     4-argument function is dropped first so PostgREST sees one
--     signature; callers passing named arguments are unaffected.
--   * _wh_queue_print_job gains the same p_target (DEFAULT NULL), so the
--     RTS relabel and the LPN receipt, which call it with five arguments,
--     route exactly as before. Re-issued from the live staging body with
--     only that branch added.
--
-- Smoke after deploy (a validation envelope passes; a relation error fails):
--   SELECT public.rpc_wh_save_printer('{"code":"SMOKE-1","transport":"agent","address":"lpt1","label_stock":"white_4x2"}'::jsonb);  -- {ok:false, error:'invalid_address'}
--   SELECT public.rpc_wh_save_printer(jsonb_build_object('id', gen_random_uuid()));                       -- {ok:false, error:'printer_not_found'}
--   SELECT public.rpc_wh_delete_printer(gen_random_uuid());                                              -- {ok:false, error:'printer_not_found'}
--   SELECT public.rpc_wh_request_labels('location', ARRAY[gen_random_uuid()], 'desktop', NULL, 'browser'); -- {ok:false, error:'items_not_found'}
--   SELECT public.rpc_wh_request_labels('location', ARRAY[gen_random_uuid()], 'desktop', NULL, 'nope');    -- {ok:false, error:'invalid_target'}
-- =============================================================

BEGIN;

-- -------------------------------------------------------------
-- A. rpc_wh_save_printer
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

  IF v_stock NOT IN ('white_4x2', 'green_4x2', 'white_3x1') THEN
    RETURN public._wh_err('invalid_label_stock', 'label_stock is white_4x2 (cartons), green_4x2 (RTS) or white_3x1 (locations and stations).');
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
-- B. rpc_wh_delete_printer: deactivate unless jobs are waiting
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_wh_delete_printer(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_p    public.wh_printers%ROWTYPE;
  v_jobs integer;
  v_was  boolean;
BEGIN
  IF public._wh_require_role(ARRAY['admin']) IS NULL THEN
    RETURN public._wh_err('forbidden', 'Removing printers needs an admin.');
  END IF;
  SELECT * INTO v_p FROM public.wh_printers WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN public._wh_err('printer_not_found', 'That printer does not exist.');
  END IF;
  SELECT count(*) INTO v_jobs FROM public.wh_print_jobs WHERE printer_id = p_id AND status IN ('queued', 'claimed');
  IF v_jobs > 0 THEN
    RETURN public._wh_err('printer_has_jobs',
                          v_p.code || ' still has ' || v_jobs || ' label job' || CASE WHEN v_jobs = 1 THEN '' ELSE 's' END
                          || ' queued or printing; let them finish or cancel them first.',
                          jsonb_build_object('jobs', v_jobs));
  END IF;
  v_was := v_p.active;
  IF v_was THEN
    UPDATE public.wh_printers SET active = false WHERE id = p_id RETURNING * INTO v_p;
  END IF;
  RETURN jsonb_build_object('ok', true, 'printer', to_jsonb(v_p), 'deactivated', true, 'already_inactive', NOT v_was);
END;
$$;

-- -------------------------------------------------------------
-- C. _wh_queue_print_job: the live body plus p_target = 'browser'
-- -------------------------------------------------------------
DROP FUNCTION IF EXISTS public._wh_queue_print_job(text, uuid[], text, uuid, uuid);

CREATE OR REPLACE FUNCTION public._wh_queue_print_job(
  p_kind text, p_ids uuid[], p_from text, p_printer_id uuid, p_actor uuid, p_target text DEFAULT NULL)
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
-- D. rpc_wh_request_labels(..., p_target)
-- -------------------------------------------------------------
DROP FUNCTION IF EXISTS public.rpc_wh_request_labels(text, uuid[], text, uuid);

CREATE OR REPLACE FUNCTION public.rpc_wh_request_labels(
  p_kind text, p_ids uuid[], p_from text, p_printer_id uuid DEFAULT NULL, p_target text DEFAULT NULL)
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
  RETURN public._wh_queue_print_job(p_kind, p_ids, p_from, p_printer_id, v_actor, p_target);
END;
$$;

-- -------------------------------------------------------------
-- E. Grants
-- -------------------------------------------------------------
REVOKE ALL ON FUNCTION public._wh_queue_print_job(text, uuid[], text, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rpc_wh_request_labels(text, uuid[], text, uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rpc_wh_save_printer(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rpc_wh_delete_printer(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_wh_request_labels(text, uuid[], text, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_wh_save_printer(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_wh_delete_printer(uuid) TO authenticated;

COMMIT;
