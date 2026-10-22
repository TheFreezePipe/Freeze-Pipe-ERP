-- =============================================================
-- Migration: Warehouse tasks, printing, stations, settlement and
--            reconcile tables, settings (Phase 1, slice 1)
-- =============================================================
-- Design: docs/design/WAREHOUSE_MODULE_PHASE0_1.md §4.3 "Tasks" and
-- "Settings, printing, settlement, reconcile", §4.4, §5.5.
--
-- Finding: putaway, counts, the print queue and station sessions need
-- their own task tables; settlement and reconcile tables are created now
-- so later slices only add RPCs.
-- Decision:
--   * wh_moves (with `origin`, proposed in §4.3) plus a
--     followed_suggestion flag (deviation: §5.3 closes the task "with
--     whether the suggestion was followed", which needs a column).
--   * wh_count_tasks, wh_count_lines; lines carry a label_flag
--     ('needs_green' | 'needs_white', deviation: the §5.7 "wrong label
--     colour" flag needs a column).
--   * wh_printers, wh_print_jobs, wh_station_sessions (§5.5). A
--     printer's agent_id is text (the installed agent's name), because
--     several agents may sign in as one print-agent user.
--   * wh_order_settlements, wh_reconcile_runs, wh_reconcile_lines: tables
--     only; their RPCs are a later slice. Reconcile tables append-only.
--   * profiles.is_print_agent (default false) plus a trigger refusing a
--     change made by a client session, because "Users can update own
--     profile" would otherwise let anyone grant themselves the agent role.
--   * wh_settings: physical_layer and scan_rules merged with the Phase 0
--     seeds (no key lost, existing values win); new keys putaway,
--     count_schedule, reconcile, labels, rts, printing, cart_definitions.
--   * rpc_wh_set_setting re-issued: per-key validation for every key;
--     cart_definitions is an array; the postgres-session bypass for
--     smoke calls uses _wh_is_service_call().
--
-- cart_definitions (Phase 2 shape, seeded empty):
--   [{"code": "CART-1",
--     "slots": [{"letter": "A", "class": "S", "colour": "blue"}, ...]}]
--   The default cart has 18 slots A-R: A-L small (12 S), M-P medium
--   (4 M), Q-R large (2 L) — from the cart sizing note.
--
-- Smoke after deploy:
--   SELECT public.rpc_wh_set_setting('printing', '{"claim_timeout_s": 5}'::jsonb);   -- {ok:false, error:'invalid_value'}
--   SELECT public.rpc_wh_set_setting('outbound', '{"mode":"nope"}'::jsonb);         -- {ok:false,...}
--   SELECT count(*) FROM public.wh_settings;                                        -- 10 keys
-- =============================================================

BEGIN;

-- -------------------------------------------------------------
-- A. wh_moves (putaway / replenish / move tasks)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.wh_moves (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                   text NOT NULL,
  origin                 text NOT NULL DEFAULT 'manual',
  status                 text NOT NULL DEFAULT 'open',
  container_id           uuid REFERENCES public.wh_containers(id),
  sku_id                 uuid REFERENCES public.product_skus(id),
  qty                    integer,
  bucket                 text,
  from_location_id       uuid REFERENCES public.wh_locations(id),
  suggested_location_id  uuid REFERENCES public.wh_locations(id),
  suggestion_reason      text,
  to_location_id         uuid REFERENCES public.wh_locations(id),
  followed_suggestion    boolean,
  source_type            text,
  source_id              uuid,
  priority               smallint NOT NULL DEFAULT 0,
  assigned_to            uuid REFERENCES public.profiles(id),
  completed_by           uuid REFERENCES public.profiles(id),
  created_by             uuid REFERENCES public.profiles(id),
  started_at             timestamptz,
  completed_at           timestamptz,
  movement_group_id      uuid,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  row_version            integer NOT NULL DEFAULT 1,
  CONSTRAINT chk_wh_moves_kind CHECK (kind IN ('putaway', 'replenish', 'move')),
  CONSTRAINT chk_wh_moves_origin CHECK (origin IN ('receipt', 'rts', 'manual', 'reconcile')),
  CONSTRAINT chk_wh_moves_status CHECK (status IN ('open', 'in_progress', 'done', 'cancelled')),
  CONSTRAINT chk_wh_moves_bucket CHECK (bucket IS NULL OR bucket IN ('raw', 'prefilled_raw', 'in_production', 'finished', 'other')),
  CONSTRAINT chk_wh_moves_subject CHECK (container_id IS NOT NULL OR (sku_id IS NOT NULL AND qty IS NOT NULL AND bucket IS NOT NULL)),
  CONSTRAINT chk_wh_moves_qty CHECK (qty IS NULL OR qty > 0),
  CONSTRAINT chk_wh_moves_reason CHECK (suggestion_reason IS NULL OR suggestion_reason IN
    ('same_sku_reserve', 'same_sku_face', 'nearest_empty', 'other_zone_empty', 'breakdown_shelf', 'none'))
);

CREATE UNIQUE INDEX IF NOT EXISTS wh_moves_one_open_putaway_per_container
  ON public.wh_moves (container_id) WHERE kind = 'putaway' AND status IN ('open', 'in_progress') AND container_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS wh_moves_status_kind_created_idx ON public.wh_moves (status, kind, created_at);
CREATE INDEX IF NOT EXISTS wh_moves_suggested_open_idx ON public.wh_moves (suggested_location_id) WHERE status IN ('open', 'in_progress');

-- -------------------------------------------------------------
-- B. Counts
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.wh_count_tasks (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                text NOT NULL,
  status              text NOT NULL DEFAULT 'open',
  location_id         uuid NOT NULL REFERENCES public.wh_locations(id),
  sku_id              uuid REFERENCES public.product_skus(id),
  reason              text,
  due_date            date,
  moved_during_count  boolean NOT NULL DEFAULT false,
  assigned_to         uuid REFERENCES public.profiles(id),
  started_at          timestamptz,
  submitted_by        uuid REFERENCES public.profiles(id),
  submitted_at        timestamptz,
  approved_by         uuid REFERENCES public.profiles(id),
  approved_at         timestamptz,
  source_type         text,
  source_id           uuid,
  created_by          uuid REFERENCES public.profiles(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  row_version         integer NOT NULL DEFAULT 1,
  CONSTRAINT chk_wh_count_tasks_kind CHECK (kind IN ('scheduled', 'pick_triggered', 'reconcile', 'variance_recount', 'ad_hoc')),
  CONSTRAINT chk_wh_count_tasks_status CHECK (status IN ('open', 'counting', 'submitted', 'approved', 'cancelled')),
  CONSTRAINT chk_wh_count_tasks_reason_len CHECK (reason IS NULL OR length(reason) <= 500)
);

CREATE UNIQUE INDEX IF NOT EXISTS wh_count_tasks_one_live_per_location
  ON public.wh_count_tasks (location_id) WHERE status IN ('open', 'counting');
CREATE INDEX IF NOT EXISTS wh_count_tasks_status_due_idx ON public.wh_count_tasks (status, due_date);

CREATE TABLE IF NOT EXISTS public.wh_count_lines (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  count_task_id              uuid NOT NULL REFERENCES public.wh_count_tasks(id) ON DELETE CASCADE,
  sku_id                     uuid NOT NULL REFERENCES public.product_skus(id),
  container_id               uuid REFERENCES public.wh_containers(id),
  bucket                     text NOT NULL,
  expected_qty               integer NOT NULL DEFAULT 0,
  counted_qty                integer NOT NULL,
  variance                   integer GENERATED ALWAYS AS (counted_qty - expected_qty) STORED,
  found_container_elsewhere  boolean NOT NULL DEFAULT false,
  label_flag                 text,
  resolution                 text,
  movement_group_id          uuid,
  ledger_tx_id               uuid REFERENCES public.inventory_transactions(id),
  scan_value                 text,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  row_version                integer NOT NULL DEFAULT 1,
  CONSTRAINT wh_count_lines_key UNIQUE NULLS NOT DISTINCT (count_task_id, sku_id, container_id, bucket),
  CONSTRAINT chk_wh_count_lines_bucket CHECK (bucket IN ('raw', 'prefilled_raw', 'in_production', 'finished', 'other')),
  CONSTRAINT chk_wh_count_lines_counted CHECK (counted_qty >= 0),
  CONSTRAINT chk_wh_count_lines_label_flag CHECK (label_flag IS NULL OR label_flag IN ('needs_green', 'needs_white')),
  CONSTRAINT chk_wh_count_lines_resolution CHECK (resolution IS NULL OR resolution IN ('accept', 'misplaced', 'write_off', 'recount'))
);

CREATE INDEX IF NOT EXISTS wh_count_lines_task_idx ON public.wh_count_lines (count_task_id);

-- -------------------------------------------------------------
-- C. Printers, print jobs, station sessions (§5.5)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.wh_printers (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                 text NOT NULL,
  name                 text NOT NULL,
  station_location_id  uuid REFERENCES public.wh_locations(id),
  transport            text NOT NULL DEFAULT 'agent',
  address              text,
  label_stock          text NOT NULL,
  dpi                  smallint NOT NULL DEFAULT 203,
  agent_id             text,
  last_seen_at         timestamptz,
  active               boolean NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  row_version          integer NOT NULL DEFAULT 1,
  CONSTRAINT wh_printers_code_key UNIQUE (code),
  CONSTRAINT chk_wh_printers_transport CHECK (transport IN ('agent', 'browser')),
  CONSTRAINT chk_wh_printers_label_stock CHECK (label_stock IN ('white_4x2', 'green_4x2', 'white_3x1')),
  CONSTRAINT chk_wh_printers_dpi CHECK (dpi IN (203, 300, 600))
);

CREATE TABLE IF NOT EXISTS public.wh_print_jobs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                 text NOT NULL,
  item_ids             uuid[] NOT NULL,
  payload              jsonb NOT NULL DEFAULT '{}'::jsonb,
  printer_id           uuid REFERENCES public.wh_printers(id),
  station_location_id  uuid REFERENCES public.wh_locations(id),
  status               text NOT NULL DEFAULT 'queued',
  claimed_by           text,
  claimed_at           timestamptz,
  attempts             integer NOT NULL DEFAULT 0,
  requested_by         uuid REFERENCES public.profiles(id),
  requested_from       text,
  printed_at           timestamptz,
  error                text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  row_version          integer NOT NULL DEFAULT 1,
  CONSTRAINT chk_wh_print_jobs_kind CHECK (kind IN ('lpn', 'lpn_rts', 'location', 'station')),
  CONSTRAINT chk_wh_print_jobs_status CHECK (status IN ('queued', 'claimed', 'printed', 'failed', 'blocked', 'cancelled')),
  CONSTRAINT chk_wh_print_jobs_from CHECK (requested_from IS NULL OR requested_from IN ('dock', 'phone', 'desktop', 'workspace')),
  CONSTRAINT chk_wh_print_jobs_items CHECK (cardinality(item_ids) > 0),
  CONSTRAINT chk_wh_print_jobs_attempts CHECK (attempts >= 0)
);

CREATE INDEX IF NOT EXISTS wh_print_jobs_printer_status_created_idx ON public.wh_print_jobs (printer_id, status, created_at);

CREATE TABLE IF NOT EXISTS public.wh_station_sessions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id           uuid NOT NULL REFERENCES public.profiles(id),
  station_location_id  uuid NOT NULL REFERENCES public.wh_locations(id),
  device_id            text,
  started_at           timestamptz NOT NULL DEFAULT now(),
  ended_at             timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  row_version          integer NOT NULL DEFAULT 1,
  CONSTRAINT chk_wh_station_sessions_device CHECK (device_id IS NULL OR length(device_id) <= 100)
);

CREATE UNIQUE INDEX IF NOT EXISTS wh_station_sessions_one_live_per_profile
  ON public.wh_station_sessions (profile_id) WHERE ended_at IS NULL;

-- -------------------------------------------------------------
-- D. Settlement and reconcile (tables only in this slice)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.wh_order_settlements (
  shipstation_order_id  uuid PRIMARY KEY REFERENCES public.shipstation_orders(id) ON DELETE CASCADE,
  method                text NOT NULL,
  settled_units         integer NOT NULL DEFAULT 0,
  shortfall_units       integer NOT NULL DEFAULT 0,
  settled_at            timestamptz,
  last_error            text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  row_version           integer NOT NULL DEFAULT 1,
  CONSTRAINT chk_wh_order_settlements_method CHECK (method IN ('ship_settle', 'pick')),
  CONSTRAINT chk_wh_order_settlements_units CHECK (settled_units >= 0 AND shortfall_units >= 0)
);

CREATE TABLE IF NOT EXISTS public.wh_reconcile_runs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_at                timestamptz NOT NULL DEFAULT now(),
  actor_id              uuid REFERENCES public.profiles(id),
  skus_checked          integer NOT NULL DEFAULT 0,
  mismatched_skus       integer NOT NULL DEFAULT 0,
  abs_residual_units    integer NOT NULL DEFAULT 0,
  unlocated_units       integer NOT NULL DEFAULT 0,
  rts_unplaced_cartons  integer NOT NULL DEFAULT 0,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.wh_reconcile_lines (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                uuid NOT NULL REFERENCES public.wh_reconcile_runs(id),
  sku_id                uuid NOT NULL REFERENCES public.product_skus(id),
  bucket                text NOT NULL,
  physical              integer NOT NULL DEFAULT 0,
  open_order_units      integer NOT NULL DEFAULT 0,
  cancelled_held_units  integer NOT NULL DEFAULT 0,
  unsettled_units       integer NOT NULL DEFAULT 0,
  levels_value          integer NOT NULL DEFAULT 0,
  residual              integer NOT NULL DEFAULT 0,
  count_task_ids        uuid[],
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_wh_reconcile_lines_bucket CHECK (bucket IN ('raw', 'prefilled_raw', 'in_production', 'finished', 'other'))
);

CREATE INDEX IF NOT EXISTS wh_reconcile_lines_run_idx ON public.wh_reconcile_lines (run_id);
CREATE INDEX IF NOT EXISTS wh_reconcile_runs_run_at_idx ON public.wh_reconcile_runs (run_at DESC);

DROP TRIGGER IF EXISTS trg_block_wh_reconcile_runs_mutation ON public.wh_reconcile_runs;
CREATE TRIGGER trg_block_wh_reconcile_runs_mutation
  BEFORE UPDATE OR DELETE ON public.wh_reconcile_runs
  FOR EACH ROW EXECUTE FUNCTION public.block_wh_mutation();
DROP TRIGGER IF EXISTS trg_block_wh_reconcile_lines_mutation ON public.wh_reconcile_lines;
CREATE TRIGGER trg_block_wh_reconcile_lines_mutation
  BEFORE UPDATE OR DELETE ON public.wh_reconcile_lines
  FOR EACH ROW EXECUTE FUNCTION public.block_wh_mutation();

-- -------------------------------------------------------------
-- E. Triggers, RLS, grants
-- -------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['wh_moves', 'wh_count_tasks', 'wh_count_lines', 'wh_printers', 'wh_print_jobs',
                           'wh_station_sessions', 'wh_order_settlements'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', t || '_updated_at', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.update_updated_at()', t || '_updated_at', t);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', t || '_row_version', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.bump_row_version()', t || '_row_version', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['wh_moves', 'wh_count_tasks', 'wh_count_lines', 'wh_printers', 'wh_print_jobs',
                           'wh_station_sessions', 'wh_order_settlements', 'wh_reconcile_runs', 'wh_reconcile_lines'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_select_internal', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.jwt_is_internal())', t || '_select_internal', t);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON TABLE public.%I TO authenticated', t);
    EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', t);
  END LOOP;
END $$;

-- -------------------------------------------------------------
-- F. profiles.is_print_agent (only the print-agent user carries it)
-- -------------------------------------------------------------
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS is_print_agent boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.block_client_print_agent_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.is_print_agent IS DISTINCT FROM OLD.is_print_agent
     AND current_user IN ('authenticated', 'anon') THEN
    RAISE EXCEPTION 'profiles.is_print_agent cannot be changed from a client session.'
      USING HINT = 'An admin sets it for the dedicated print-agent user.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_block_client_print_agent_change ON public.profiles;
CREATE TRIGGER trg_block_client_print_agent_change
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.block_client_print_agent_change();

-- -------------------------------------------------------------
-- G. Settings seeds (merge: existing values win, no key is lost)
-- -------------------------------------------------------------
INSERT INTO public.wh_settings (key, value) VALUES
  ('physical_layer',   '{"enabled": false, "live_since": null, "mint_lpns": false}'::jsonb),
  ('scan_rules',       '{"require_location_scan": true, "location_scan_every_stop": true, "confirm_putaway_location": true}'::jsonb),
  ('putaway',          '{"breakdown_location_code": null, "max_suggestions": 3}'::jsonb),
  ('count_schedule',   '{"A_days": 7, "B_days": 30, "C_days": 90, "daily_cap": 20}'::jsonb),
  ('reconcile',        '{"create_counts": true, "max_counts_per_sku": 3}'::jsonb),
  ('labels',           '{"lpn": "4x2", "location": "3x1", "dpi": 203}'::jsonb),
  ('rts',              '{"require_relabel": true, "allow_no_parent": true}'::jsonb),
  ('printing',         '{"require_station": true, "claim_timeout_s": 60, "max_attempts": 3}'::jsonb),
  ('cart_definitions', '[]'::jsonb)
ON CONFLICT (key) DO UPDATE
  SET value = CASE
                WHEN jsonb_typeof(public.wh_settings.value) = 'object' AND jsonb_typeof(EXCLUDED.value) = 'object'
                  THEN EXCLUDED.value || public.wh_settings.value
                ELSE public.wh_settings.value
              END;

-- -------------------------------------------------------------
-- H. rpc_wh_set_setting(key, value) – admin, validates every key
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
      IF (p_value ? 'lpn' AND COALESCE(p_value->>'lpn', '') !~ '^[0-9]x[0-9]$')
         OR (p_value ? 'location' AND COALESCE(p_value->>'location', '') !~ '^[0-9]x[0-9]$')
         OR (p_value ? 'dpi' AND COALESCE(p_value->>'dpi', '') NOT IN ('203', '300', '600')) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_value', 'message', 'labels.lpn/location are sizes like "4x2"; dpi is 203, 300 or 600 (invalid_value).');
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

REVOKE ALL ON FUNCTION public.rpc_wh_set_setting(text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_wh_set_setting(text, jsonb) TO authenticated;

COMMIT;
