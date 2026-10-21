-- =============================================================
-- Migration: Warehouse settings + outbound guard (Phase 0)
-- =============================================================
-- Design: docs/design/WAREHOUSE_MODULE_PHASE0_1.md §3.3
--
-- One key/value table carries the Warehouse module's switches. The
-- first switch is `outbound`, which decides whether anything may leave
-- the ERP for the outside world (ShipStation tag writes, PrintNode,
-- browser label printing):
--   live     – everything allowed (production only, set by an admin)
--   practice – browser printing allowed, labels carry a PRACTICE band
--   blocked  – nothing outbound (the default; what a staging refresh
--              writes last)
-- A fresh database is therefore safe by default.
--
-- Later switches (same table, added by Phase 1):
--   physical_layer – {"enabled": false, "live_since": null, "mint_lpns": false}
--   scan_rules     – {"require_location_scan": true}
--
-- Smoke after deploy (CLAUDE.md gotcha: CREATE OR REPLACE FUNCTION does
-- not validate referenced relations):
--   SELECT public.fn_outbound_allowed('browser_print');       -- false
--   SELECT public.rpc_wh_get_settings();                      -- {ok:true,...}
--   SELECT public.rpc_wh_set_setting('outbound', '{"mode":"nope"}'); -- {ok:false,...}
-- =============================================================

CREATE TABLE IF NOT EXISTS public.wh_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_by  uuid REFERENCES public.profiles(id),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wh_settings_key_shape CHECK (key ~ '^[a-z][a-z0-9_]{1,40}$')
);

COMMENT ON TABLE public.wh_settings IS
  'Warehouse module switches. Writes go through rpc_wh_set_setting (admin); reads through rpc_wh_get_settings or the SELECT policy.';

DROP TRIGGER IF EXISTS wh_settings_updated_at ON public.wh_settings;
CREATE TRIGGER wh_settings_updated_at
  BEFORE UPDATE ON public.wh_settings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

INSERT INTO public.wh_settings (key, value) VALUES
  ('outbound',       '{"mode": "blocked"}'::jsonb),
  ('physical_layer', '{"enabled": false, "live_since": null, "mint_lpns": false}'::jsonb),
  ('scan_rules',     '{"require_location_scan": true}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- -------------------------------------------------------------
-- RLS: internal roles may read; nobody writes directly.
-- -------------------------------------------------------------
ALTER TABLE public.wh_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS wh_settings_select_internal ON public.wh_settings;
CREATE POLICY wh_settings_select_internal
  ON public.wh_settings
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
       WHERE p.id = auth.uid()
         AND p.role IN ('admin', 'manager', 'user')
         AND p.is_active = true
    )
  );

GRANT SELECT ON TABLE public.wh_settings TO authenticated;
GRANT ALL    ON TABLE public.wh_settings TO service_role;

-- -------------------------------------------------------------
-- fn_outbound_allowed(kind) – the single question every outbound
-- path asks. kinds: 'shipstation_write' | 'printnode' | 'browser_print'
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_outbound_allowed(p_kind text)
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT CASE
           WHEN s.value->>'mode' = 'live' THEN true
           WHEN s.value->>'mode' = 'practice' THEN p_kind = 'browser_print'
           ELSE false
         END
    FROM public.wh_settings s
   WHERE s.key = 'outbound';
$$;

GRANT EXECUTE ON FUNCTION public.fn_outbound_allowed(text) TO authenticated, service_role;

-- -------------------------------------------------------------
-- rpc_wh_get_settings() → {ok, settings:{key: value, ...}}
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_wh_get_settings()
RETURNS jsonb AS $$
DECLARE
  v_role text;
BEGIN
  SELECT role INTO v_role FROM public.profiles WHERE id = auth.uid() AND is_active;
  IF v_role IS NULL OR v_role = 'supplier' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'internal role required');
  END IF;
  RETURN jsonb_build_object(
    'ok', true,
    'settings', COALESCE((SELECT jsonb_object_agg(key, value) FROM public.wh_settings), '{}'::jsonb)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.rpc_wh_get_settings() TO authenticated;

-- -------------------------------------------------------------
-- rpc_wh_set_setting(key, value) – admin only, validates known keys
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_wh_set_setting(p_key text, p_value jsonb)
RETURNS jsonb AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_role  text;
  v_mode  text;
BEGIN
  SELECT role INTO v_role FROM public.profiles WHERE id = v_actor AND is_active;
  IF v_role IS DISTINCT FROM 'admin' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'admin role required');
  END IF;
  IF p_value IS NULL OR jsonb_typeof(p_value) <> 'object' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'value must be a JSON object');
  END IF;

  IF p_key = 'outbound' THEN
    v_mode := p_value->>'mode';
    IF v_mode IS NULL OR v_mode NOT IN ('live', 'practice', 'blocked') THEN
      RETURN jsonb_build_object('ok', false, 'error', 'outbound.mode must be live, practice or blocked');
    END IF;
  ELSIF p_key = 'physical_layer' THEN
    IF p_value ? 'enabled' AND jsonb_typeof(p_value->'enabled') <> 'boolean' THEN
      RETURN jsonb_build_object('ok', false, 'error', 'physical_layer.enabled must be boolean');
    END IF;
  ELSIF p_key = 'scan_rules' THEN
    IF p_value ? 'require_location_scan' AND jsonb_typeof(p_value->'require_location_scan') <> 'boolean' THEN
      RETURN jsonb_build_object('ok', false, 'error', 'scan_rules.require_location_scan must be boolean');
    END IF;
  ELSE
    RETURN jsonb_build_object('ok', false, 'error', 'unknown setting key: ' || p_key);
  END IF;

  INSERT INTO public.wh_settings (key, value, updated_by)
  VALUES (p_key, p_value, v_actor)
  ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by;

  RETURN jsonb_build_object('ok', true, 'key', p_key, 'value', p_value);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.rpc_wh_set_setting(text, jsonb) TO authenticated;
