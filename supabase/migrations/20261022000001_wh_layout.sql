-- =============================================================
-- Migration: Warehouse layout and locations (Phase 1, slice 1)
-- =============================================================
-- Design: docs/design/WAREHOUSE_MODULE_PHASE0_1.md §4.2, §4.3 "Layout"
-- and wh_locations, §4.4, §5.2, §5.3 (generator, pick_sequence).
--
-- Finding: every shelf position needs a code (FF-BB-L), a barcode and a
-- place in the walk, and the Phase 1 RPCs address a handful of named
-- floor locations (IN-01, MFG-LINE, UNLOCATED, the stations) by code.
-- Decision:
--   * Layout tables: wh_rack_templates, wh_racks, wh_rack_faces
--     (proposed in §4.3: R02/R03 carry two faces, face 09 spans R08+R09),
--     wh_fixtures (proposed in §4.3: doors, benches, desks, gaylords).
--   * wh_locations with the §4.3 columns, CHECKs and the generated
--     barcode_value ('%' || code), plus a `name` column (deviation: the
--     station chip and station labels need a display name).
--   * Seeds every named location the RPCs reference (deviation from the
--     doc's "seeds only UNLOCATED", because rpc_wh_take_to_line, the
--     receiving path and the station RPCs look them up by code). All
--     seeded with null geometry until the layout import sets it.
--   * RLS: internal roles read; no client writes. Admin RPCs write:
--     rpc_wh_generate_locations, rpc_wh_save_layout, rpc_wh_save_location,
--     rpc_wh_resequence.
--   * Geometry convention (proposed reading of §4.3): a rack's x_mm/y_mm
--     is the top-left corner of its footprint (workbook "X left edge,
--     Y top edge"); rot_deg 0/180 runs the bays along X, 90/270 along Y.
--     A face's walk_dir decides which end is bay 01; `side` decides the
--     edge the bay centre sits on. zone_by_bay is indexed by the bay's
--     position on this rack (1 = first_bay_no); a short array repeats
--     its last zone.
--   * pick_sequence = walk_pass × 1000 + rank × 10 + level, rank counting
--     every bay of the faces in one walk_pass by position along the walk
--     direction (ties by face code), so facing faces interleave (§5.3).
--     Applying the generator recomputes every bay-level's sequence; it
--     overwrites manual rpc_wh_resequence fixes.
--   * The generator owns a bay-level's code, zone, default bucket,
--     pickable and overflow flags; capacity_cartons is set on create
--     and then left to rpc_wh_save_location. The top level of an
--     overflow template is overflow only when the rack has 2+ levels.
--
-- Smoke after deploy (a validation envelope passes; a relation error fails):
--   SELECT public.rpc_wh_generate_locations(NULL, true);              -- {ok:true, dry_run:true,...}
--   SELECT public.rpc_wh_save_layout('{}'::jsonb);                    -- {ok:true,...} (nothing to save)
--   SELECT public.rpc_wh_save_location('{"code":"UNLOCATED","active":false}'::jsonb); -- {ok:false, error:'location_protected'}
--   SELECT public.rpc_wh_resequence('[]'::jsonb);                     -- {ok:true, updated:0}
--   SELECT count(*) FROM public.wh_locations;                         -- 17 seeded named locations
-- =============================================================

BEGIN;

-- -------------------------------------------------------------
-- A. Shared helpers (used by every Phase 1 warehouse migration)
-- -------------------------------------------------------------

-- True only for trusted non-user callers: the Management API / psql
-- session (session_user postgres, no JWT subject) and service_role.
-- Inside a SECURITY DEFINER function current_user is the owner, so
-- `current_user = 'postgres'` is always true there and cannot be the
-- test (the Phase 0 RPCs used it; 20261022000004 fixes them).
CREATE OR REPLACE FUNCTION public._wh_is_service_call()
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT auth.uid() IS NULL
     AND (session_user = 'postgres' OR COALESCE(auth.role(), '') = 'service_role');
$$;

-- The caller's role when it is one of p_roles (active profile); 'service'
-- for trusted non-user callers; NULL otherwise.
CREATE OR REPLACE FUNCTION public._wh_require_role(p_roles text[])
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
BEGIN
  IF public._wh_is_service_call() THEN
    RETURN 'service';
  END IF;
  SELECT p.role INTO v_role
    FROM public.profiles p
   WHERE p.id = auth.uid() AND p.is_active AND p.role = ANY (p_roles);
  RETURN v_role;
END;
$$;

-- The acting profile: auth.uid() for signed-in callers; p_actor_id (or
-- the system actor …0001) only for service_role or the postgres session.
CREATE OR REPLACE FUNCTION public._wh_actor(p_actor_id uuid DEFAULT NULL)
RETURNS uuid
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT CASE
           WHEN auth.uid() IS NOT NULL THEN auth.uid()
           WHEN public._wh_is_service_call() THEN COALESCE(p_actor_id, '00000000-0000-0000-0000-000000000001'::uuid)
           ELSE NULL
         END;
$$;

CREATE OR REPLACE FUNCTION public._wh_err(p_code text, p_message text, p_extra jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE sql IMMUTABLE
AS $$
  SELECT jsonb_build_object('ok', false, 'error', p_code, 'message', p_message) || COALESCE(p_extra, '{}'::jsonb);
$$;

CREATE OR REPLACE FUNCTION public._wh_setting(p_key text)
RETURNS jsonb
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT value FROM public.wh_settings WHERE key = p_key;
$$;

REVOKE ALL ON FUNCTION public._wh_is_service_call() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._wh_require_role(text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._wh_actor(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._wh_err(text, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._wh_setting(text) FROM PUBLIC, anon, authenticated;

-- -------------------------------------------------------------
-- B. Layout tables
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.wh_rack_templates (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                        text NOT NULL,
  name                        text NOT NULL,
  kind                        text NOT NULL,
  bays                        smallint NOT NULL,
  levels                      smallint NOT NULL,
  bay_width_mm                integer NOT NULL,
  depth_mm                    integer NOT NULL,
  level_heights_mm            integer[] NOT NULL,
  overflow_top_level          boolean NOT NULL DEFAULT false,
  capacity_cartons_per_level  integer,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  row_version                 integer NOT NULL DEFAULT 1,
  CONSTRAINT wh_rack_templates_code_key UNIQUE (code),
  CONSTRAINT chk_wh_rack_templates_kind CHECK (kind IN ('pallet_rack', 'shelving', 'end_cap', 'floor')),
  CONSTRAINT chk_wh_rack_templates_dims CHECK (bays BETWEEN 1 AND 99 AND levels BETWEEN 1 AND 9 AND bay_width_mm > 0 AND depth_mm > 0),
  CONSTRAINT chk_wh_rack_templates_heights CHECK (cardinality(level_heights_mm) = levels),
  CONSTRAINT chk_wh_rack_templates_capacity CHECK (capacity_cartons_per_level IS NULL OR capacity_cartons_per_level > 0)
);

CREATE TABLE IF NOT EXISTS public.wh_racks (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_location_id  uuid NOT NULL DEFAULT public._default_location_id() REFERENCES public.locations(id),
  code              text NOT NULL,
  template_id       uuid REFERENCES public.wh_rack_templates(id),
  description       text,
  x_mm              integer NOT NULL DEFAULT 0,
  y_mm              integer NOT NULL DEFAULT 0,
  rot_deg           smallint NOT NULL DEFAULT 0,
  bays              smallint NOT NULL,
  levels            smallint NOT NULL,
  width_mm          integer,
  depth_mm          integer,
  active            boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  row_version       integer NOT NULL DEFAULT 1,
  CONSTRAINT wh_racks_site_code_key UNIQUE (site_location_id, code),
  CONSTRAINT chk_wh_racks_code CHECK (code ~ '^[A-Z0-9][A-Z0-9-]{0,15}$'),
  CONSTRAINT chk_wh_racks_rot CHECK (rot_deg IN (0, 90, 180, 270)),
  CONSTRAINT chk_wh_racks_dims CHECK (bays BETWEEN 1 AND 99 AND levels BETWEEN 1 AND 9
                                      AND (width_mm IS NULL OR width_mm > 0) AND (depth_mm IS NULL OR depth_mm > 0))
);

CREATE TABLE IF NOT EXISTS public.wh_rack_faces (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rack_id          uuid NOT NULL REFERENCES public.wh_racks(id) ON DELETE CASCADE,
  face_code        char(2) NOT NULL,
  side             text,
  aisle            text,
  walk_pass        smallint NOT NULL DEFAULT 99,
  walk_dir         text,
  first_bay_no     smallint NOT NULL DEFAULT 1,
  zone_by_bay      text[],
  pickable_levels  smallint[] NOT NULL DEFAULT '{1,2}',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  row_version      integer NOT NULL DEFAULT 1,
  CONSTRAINT wh_rack_faces_rack_face_key UNIQUE (rack_id, face_code),
  CONSTRAINT chk_wh_rack_faces_code CHECK (face_code ~ '^[0-9]{2}$'),
  CONSTRAINT chk_wh_rack_faces_side CHECK (side IS NULL OR side IN ('north', 'south', 'east', 'west', 'both')),
  CONSTRAINT chk_wh_rack_faces_walk_dir CHECK (walk_dir IS NULL OR walk_dir IN ('N', 'S', 'E', 'W')),
  CONSTRAINT chk_wh_rack_faces_walk_pass CHECK (walk_pass BETWEEN 0 AND 99),
  CONSTRAINT chk_wh_rack_faces_first_bay CHECK (first_bay_no BETWEEN 1 AND 99),
  CONSTRAINT chk_wh_rack_faces_zones CHECK (zone_by_bay IS NULL OR zone_by_bay <@ ARRAY['RTS','RAW','BOX','WIP','ACC','MISC','IN','OUT','MFG','PACK','SPARE','VIRTUAL']::text[])
);

CREATE TABLE IF NOT EXISTS public.wh_locations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_location_id   uuid NOT NULL DEFAULT public._default_location_id() REFERENCES public.locations(id),
  code               text NOT NULL,
  barcode_value      text GENERATED ALWAYS AS ('%' || code) STORED,
  name               text,
  kind               text NOT NULL,
  rack_id            uuid REFERENCES public.wh_racks(id),
  face_id            uuid REFERENCES public.wh_rack_faces(id),
  face               char(2),
  bay                smallint,
  level              smallint,
  zone               text NOT NULL,
  default_bucket     text,
  bucket_lock        text,
  pickable           boolean NOT NULL DEFAULT false,
  is_overflow        boolean NOT NULL DEFAULT false,
  allow_negative     boolean NOT NULL DEFAULT false,
  pick_sequence      integer,
  x_mm               integer,
  y_mm               integer,
  z_mm               integer,
  width_mm           integer,
  depth_mm           integer,
  height_mm          integer,
  capacity_cartons   integer,
  last_counted_at    timestamptz,
  label_printed_at   timestamptz,
  label_verified_at  timestamptz,
  active             boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  row_version        integer NOT NULL DEFAULT 1,
  CONSTRAINT wh_locations_site_code_key UNIQUE (site_location_id, code),
  CONSTRAINT wh_locations_barcode_value_key UNIQUE (barcode_value),
  CONSTRAINT chk_wh_locations_kind CHECK (kind IN ('bay_level', 'floor', 'station', 'virtual')),
  CONSTRAINT chk_wh_locations_code_shape CHECK (
    CASE WHEN kind = 'bay_level' THEN code ~ '^\d{2}-\d{2}-\d$'
         ELSE code ~ '^[A-Z0-9][A-Z0-9-]{1,23}$' AND code !~ '^(C|T)-' AND code !~ '^Z' AND code !~ '^\d{2}-\d{2}-\d$'
    END),
  CONSTRAINT chk_wh_locations_bay_fields CHECK (
    kind <> 'bay_level' OR (rack_id IS NOT NULL AND face_id IS NOT NULL AND face IS NOT NULL AND bay IS NOT NULL AND level IS NOT NULL)),
  CONSTRAINT chk_wh_locations_zone CHECK (zone IN ('RTS','RAW','BOX','WIP','ACC','MISC','IN','OUT','MFG','PACK','SPARE','VIRTUAL')),
  CONSTRAINT chk_wh_locations_default_bucket CHECK (default_bucket IS NULL OR default_bucket IN ('raw','prefilled_raw','in_production','finished','other')),
  CONSTRAINT chk_wh_locations_bucket_lock CHECK (bucket_lock IS NULL OR bucket_lock IN ('raw','prefilled_raw','in_production','finished','other')),
  CONSTRAINT chk_wh_locations_pick_overflow CHECK (NOT (pickable AND is_overflow)),
  CONSTRAINT chk_wh_locations_allow_negative CHECK (NOT allow_negative OR code IN ('UNLOCATED', 'MFG-LINE')),
  CONSTRAINT chk_wh_locations_capacity CHECK (capacity_cartons IS NULL OR capacity_cartons > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS wh_locations_pick_sequence_active
  ON public.wh_locations (site_location_id, pick_sequence) WHERE active AND pick_sequence IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS wh_locations_face_bay_level_key
  ON public.wh_locations (face_id, bay, level) WHERE kind = 'bay_level';
CREATE INDEX IF NOT EXISTS wh_locations_rack_face_bay_level_idx ON public.wh_locations (rack_id, face, bay, level);
CREATE INDEX IF NOT EXISTS wh_locations_zone_idx ON public.wh_locations (zone);

CREATE TABLE IF NOT EXISTS public.wh_fixtures (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  kind         text NOT NULL,
  x_mm         integer NOT NULL DEFAULT 0,
  y_mm         integer NOT NULL DEFAULT 0,
  width_mm     integer,
  depth_mm     integer,
  rot_deg      smallint NOT NULL DEFAULT 0,
  zone         text,
  location_id  uuid REFERENCES public.wh_locations(id),
  blocked      boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  row_version  integer NOT NULL DEFAULT 1,
  CONSTRAINT wh_fixtures_name_key UNIQUE (name),
  CONSTRAINT chk_wh_fixtures_kind CHECK (kind IN ('door', 'pack_station', 'desk', 'staging', 'obstacle', 'other')),
  CONSTRAINT chk_wh_fixtures_rot CHECK (rot_deg IN (0, 90, 180, 270)),
  CONSTRAINT chk_wh_fixtures_zone CHECK (zone IS NULL OR zone IN ('RTS','RAW','BOX','WIP','ACC','MISC','IN','OUT','MFG','PACK','SPARE','VIRTUAL'))
);

-- updated_at + row_version triggers
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['wh_rack_templates', 'wh_racks', 'wh_rack_faces', 'wh_locations', 'wh_fixtures'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', t || '_updated_at', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.update_updated_at()', t || '_updated_at', t);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', t || '_row_version', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.bump_row_version()', t || '_row_version', t);
  END LOOP;
END $$;

-- RLS: internal roles read, nobody writes directly
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['wh_rack_templates', 'wh_racks', 'wh_rack_faces', 'wh_locations', 'wh_fixtures'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_select_internal', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.jwt_is_internal())', t || '_select_internal', t);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON TABLE public.%I TO authenticated', t);
    EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', t);
  END LOOP;
END $$;

COMMENT ON TABLE public.wh_locations IS
  'Warehouse addresses: bay-levels (FF-BB-L, from rpc_wh_generate_locations), floor spots, stations and the virtual UNLOCATED. barcode_value = ''%'' || code.';

-- -------------------------------------------------------------
-- C. Named locations (null geometry until the layout import)
-- -------------------------------------------------------------
INSERT INTO public.wh_locations (code, name, kind, zone, default_bucket, bucket_lock, allow_negative)
VALUES
  ('UNLOCATED',  'Unlocated',          'virtual', 'VIRTUAL', NULL,    NULL,    true),
  ('MFG-LINE',   'Manufacturing line', 'floor',   'MFG',     NULL,    NULL,    true),
  ('IN-01',      'Inbound staging',    'floor',   'IN',      NULL,    NULL,    false),
  ('SPARES-01',  'Spare parts tote',   'floor',   'SPARE',   'other', 'other', false),
  ('OUT-UPS',    'UPS table',          'floor',   'OUT',     NULL,    NULL,    false),
  ('OUT-GAY-1',  'Gaylord 1',          'floor',   'OUT',     NULL,    NULL,    false),
  ('OUT-GAY-2',  'Gaylord 2',          'floor',   'OUT',     NULL,    NULL,    false),
  ('CART-START', 'Cart start',         'floor',   'PACK',    NULL,    NULL,    false),
  ('ST-S1',      'Pack station 1',     'station', 'PACK',    NULL,    NULL,    false),
  ('ST-S2',      'Pack station 2',     'station', 'PACK',    NULL,    NULL,    false),
  ('ST-S3',      'Pack station 3',     'station', 'PACK',    NULL,    NULL,    false),
  ('ST-S4',      'Pack station 4',     'station', 'PACK',    NULL,    NULL,    false),
  ('ST-DOCK',    'Dock',               'station', 'IN',      NULL,    NULL,    false),
  ('ST-MFG-1',   'Mfg desk 1',         'station', 'MFG',     NULL,    NULL,    false),
  ('ST-MFG-2',   'Mfg desk 2',         'station', 'MFG',     NULL,    NULL,    false),
  ('ST-MFG-3',   'Mfg desk 3',         'station', 'MFG',     NULL,    NULL,    false),
  ('ST-MFG-4',   'Mfg desk 4',         'station', 'MFG',     NULL,    NULL,    false)
ON CONFLICT (site_location_id, code) DO NOTHING;

-- -------------------------------------------------------------
-- D. Stock test used by the generator and rpc_wh_save_location. The
--    stock tables arrive in 20261022000002, which re-issues this body;
--    the stub is only created when missing, so re-running this file
--    never replaces the real one.
-- -------------------------------------------------------------
DO $$
BEGIN
  IF to_regprocedure('public._wh_location_has_stock(uuid)') IS NULL THEN
    CREATE FUNCTION public._wh_location_has_stock(p_location_id uuid)
    RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path = public
    AS 'SELECT false';
    REVOKE ALL ON FUNCTION public._wh_location_has_stock(uuid) FROM PUBLIC, anon, authenticated;
  END IF;
END $$;

-- -------------------------------------------------------------
-- E. Generator plan: every bay-level the active faces imply, with its
--    geometry and its site-wide pick_sequence. Pure read.
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._wh_location_plan()
RETURNS TABLE (
  site_location_id uuid, rack_id uuid, face_id uuid, face char(2), bay smallint, level smallint,
  code text, zone text, default_bucket text, pickable boolean, is_overflow boolean,
  x_mm integer, y_mm integer, z_mm integer, width_mm integer, depth_mm integer, height_mm integer,
  capacity_cartons integer, walk_pass smallint, pick_sequence integer
)
LANGUAGE sql STABLE
SET search_path = public
AS $$
  WITH base AS (
    SELECT r.site_location_id, r.id AS rack_id, f.id AS face_id, f.face_code, f.side, f.walk_dir, f.walk_pass,
           f.first_bay_no, f.zone_by_bay, f.pickable_levels,
           r.x_mm AS rx, r.y_mm AS ry, r.rot_deg, r.bays, r.levels,
           COALESCE(r.width_mm, r.bays * t.bay_width_mm, r.bays * 1000) AS len_mm,
           COALESCE(r.depth_mm, t.depth_mm) AS dep_mm,
           t.level_heights_mm, COALESCE(t.overflow_top_level, false) AS overflow_top,
           t.capacity_cartons_per_level
      FROM public.wh_rack_faces f
      JOIN public.wh_racks r ON r.id = f.rack_id AND r.active
      LEFT JOIN public.wh_rack_templates t ON t.id = r.template_id
  ),
  cells AS (
    SELECT b.*, k.k, l.l,
           (b.first_bay_no + k.k)::smallint AS bay_no,
           COALESCE(b.zone_by_bay[k.k + 1], b.zone_by_bay[cardinality(b.zone_by_bay)], 'MISC') AS zone,
           (b.rot_deg IN (90, 270)) AS vertical,
           (b.len_mm::numeric / b.bays) AS bay_w,
           CASE
             WHEN b.rot_deg IN (90, 270) THEN CASE WHEN b.walk_dir = 'N' THEN b.bays - 1 - k.k ELSE k.k END
             ELSE CASE WHEN b.walk_dir = 'W' THEN b.bays - 1 - k.k ELSE k.k END
           END AS slot
      FROM base b
      CROSS JOIN LATERAL generate_series(0, b.bays - 1) AS k(k)
      CROSS JOIN LATERAL generate_series(1, b.levels) AS l(l)
  ),
  geo AS (
    SELECT c.*,
           (c.overflow_top AND c.l = c.levels AND c.levels > 1) AS overflow,
           (CASE WHEN c.vertical
                 THEN CASE c.side WHEN 'east' THEN c.rx + COALESCE(c.dep_mm, 0) WHEN 'west' THEN c.rx ELSE c.rx + COALESCE(c.dep_mm, 0) / 2 END
                 ELSE c.rx + round((c.slot + 0.5) * c.bay_w) END)::integer AS gx,
           (CASE WHEN c.vertical
                 THEN c.ry + round((c.slot + 0.5) * c.bay_w)
                 ELSE CASE c.side WHEN 'north' THEN c.ry WHEN 'south' THEN c.ry + COALESCE(c.dep_mm, 0) ELSE c.ry + COALESCE(c.dep_mm, 0) / 2 END END)::integer AS gy
      FROM cells c
  ),
  positioned AS (
    SELECT g.*,
           CASE g.walk_dir WHEN 'S' THEN g.gy WHEN 'N' THEN -g.gy WHEN 'E' THEN g.gx WHEN 'W' THEN -g.gx ELSE 0 END AS walk_pos
      FROM geo g
  ),
  ranked AS (
    SELECT x.*,
           dense_rank() OVER (PARTITION BY x.site_location_id, x.walk_pass
                              ORDER BY x.walk_pos, x.face_code, x.bay_no) AS bay_rank
      FROM positioned x
  )
  SELECT q.site_location_id, q.rack_id, q.face_id, q.face_code, q.bay_no, q.l::smallint,
         q.face_code || '-' || lpad(q.bay_no::text, 2, '0') || '-' || q.l::text AS code,
         q.zone,
         CASE q.zone WHEN 'RTS' THEN 'finished' WHEN 'ACC' THEN 'finished' WHEN 'RAW' THEN 'raw'
                     WHEN 'WIP' THEN 'in_production' WHEN 'MISC' THEN 'other' ELSE NULL END AS default_bucket,
         (q.l = ANY (q.pickable_levels) AND q.zone IN ('RTS', 'ACC') AND NOT q.overflow) AS pickable,
         q.overflow AS is_overflow,
         q.gx, q.gy, q.level_heights_mm[q.l],
         round(q.bay_w)::integer, q.dep_mm,
         (q.level_heights_mm[q.l + 1] - q.level_heights_mm[q.l]),
         q.capacity_cartons_per_level,
         q.walk_pass,
         (q.walk_pass * 1000 + q.bay_rank * 10 + q.l)::integer AS pick_sequence
    FROM ranked q;
$$;

REVOKE ALL ON FUNCTION public._wh_location_plan() FROM PUBLIC, anon, authenticated;

-- -------------------------------------------------------------
-- F. rpc_wh_generate_locations(p_rack_id, p_dry_run) – admin (§5.3)
-- Existing rows match on (face_id, bay, level): geometry and the
-- derived flags update in place; a changed or taken code is a conflict
-- with no write; rows no longer generated deactivate only when empty.
-- Applying recomputes every bay-level pick_sequence site-wide.
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_wh_generate_locations(p_rack_id uuid DEFAULT NULL, p_dry_run boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_create     jsonb;
  v_update     jsonb;
  v_conflicts  jsonb;
  v_deact      jsonb;
  v_codes      jsonb;
  n_created    int := 0;
  n_updated    int := 0;
  n_deact      int := 0;
BEGIN
  IF public._wh_require_role(ARRAY['admin']) IS NULL THEN
    RETURN public._wh_err('forbidden', 'Generating locations needs an admin (forbidden).');
  END IF;
  IF p_rack_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.wh_racks WHERE id = p_rack_id) THEN
    RETURN public._wh_err('rack_not_found', 'Rack ' || p_rack_id || ' does not exist (rack_not_found).');
  END IF;

  DROP TABLE IF EXISTS pg_temp._wh_plan;
  CREATE TEMP TABLE _wh_plan ON COMMIT DROP AS SELECT * FROM public._wh_location_plan();

  -- classify each planned row of the target rack(s)
  DROP TABLE IF EXISTS pg_temp._wh_plan_class;
  CREATE TEMP TABLE _wh_plan_class ON COMMIT DROP AS
  SELECT p.face_id, p.bay, p.level, p.code, e.id AS existing_id, e.code AS existing_code,
         CASE
           WHEN count(*) OVER (PARTITION BY p.site_location_id, p.code) > 1 THEN 'conflict'
           WHEN e.id IS NOT NULL AND e.code <> p.code THEN 'conflict'
           WHEN o.id IS NOT NULL THEN 'conflict'
           WHEN e.id IS NOT NULL THEN 'update'
           ELSE 'create'
         END AS action,
         CASE
           WHEN count(*) OVER (PARTITION BY p.site_location_id, p.code) > 1 THEN 'duplicate_in_layout'
           WHEN e.id IS NOT NULL AND e.code <> p.code THEN 'code_changed'
           WHEN o.id IS NOT NULL THEN 'code_taken'
         END AS reason
    FROM _wh_plan p
    LEFT JOIN public.wh_locations e
      ON e.kind = 'bay_level' AND e.face_id = p.face_id AND e.bay = p.bay AND e.level = p.level
    LEFT JOIN public.wh_locations o
      ON o.site_location_id = p.site_location_id AND o.code = p.code
     AND (o.kind <> 'bay_level' OR o.face_id IS DISTINCT FROM p.face_id OR o.bay IS DISTINCT FROM p.bay OR o.level IS DISTINCT FROM p.level)
   WHERE p_rack_id IS NULL OR p.rack_id = p_rack_id;

  -- existing bay-levels of the target rack(s) that the plan no longer implies
  DROP TABLE IF EXISTS pg_temp._wh_plan_gone;
  CREATE TEMP TABLE _wh_plan_gone ON COMMIT DROP AS
  SELECT l.id, l.code, public._wh_location_has_stock(l.id) AS not_empty
    FROM public.wh_locations l
   WHERE l.kind = 'bay_level' AND l.active
     AND (p_rack_id IS NULL OR l.rack_id = p_rack_id)
     AND NOT EXISTS (SELECT 1 FROM _wh_plan p WHERE p.face_id = l.face_id AND p.bay = l.bay AND p.level = l.level);

  SELECT COALESCE(jsonb_agg(code ORDER BY code) FILTER (WHERE action = 'create'), '[]'::jsonb),
         COALESCE(jsonb_agg(code ORDER BY code) FILTER (WHERE action = 'update'), '[]'::jsonb),
         COALESCE(jsonb_agg(jsonb_build_object('code', code, 'existing_code', existing_code, 'reason', reason) ORDER BY code)
                  FILTER (WHERE action = 'conflict'), '[]'::jsonb)
    INTO v_create, v_update, v_conflicts
    FROM _wh_plan_class;

  SELECT v_conflicts || COALESCE(jsonb_agg(jsonb_build_object('code', code, 'existing_code', code, 'reason', 'not_empty') ORDER BY code)
                                 FILTER (WHERE not_empty), '[]'::jsonb),
         COALESCE(jsonb_agg(code ORDER BY code) FILTER (WHERE NOT not_empty), '[]'::jsonb)
    INTO v_conflicts, v_deact
    FROM _wh_plan_gone;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'code', p.code, 'face', p.face, 'bay', p.bay, 'level', p.level, 'zone', p.zone,
           'pickable', p.pickable, 'is_overflow', p.is_overflow, 'pick_sequence', p.pick_sequence,
           'x_mm', p.x_mm, 'y_mm', p.y_mm, 'z_mm', p.z_mm) ORDER BY p.pick_sequence, p.code), '[]'::jsonb)
    INTO v_codes
    FROM _wh_plan p
   WHERE p_rack_id IS NULL OR p.rack_id = p_rack_id;

  IF COALESCE(p_dry_run, true) THEN
    RETURN jsonb_build_object('ok', true, 'dry_run', true,
      'create', v_create, 'update', v_update, 'conflicts', v_conflicts, 'deactivate', v_deact, 'codes', v_codes);
  END IF;

  -- creates
  INSERT INTO public.wh_locations (site_location_id, code, kind, rack_id, face_id, face, bay, level, zone, default_bucket,
                                   pickable, is_overflow, x_mm, y_mm, z_mm, width_mm, depth_mm, height_mm, capacity_cartons)
  SELECT p.site_location_id, p.code, 'bay_level', p.rack_id, p.face_id, p.face, p.bay, p.level, p.zone, p.default_bucket,
         p.pickable, p.is_overflow, p.x_mm, p.y_mm, p.z_mm, p.width_mm, p.depth_mm, p.height_mm, p.capacity_cartons
    FROM _wh_plan p
    JOIN _wh_plan_class c ON c.face_id = p.face_id AND c.bay = p.bay AND c.level = p.level AND c.action = 'create';
  GET DIAGNOSTICS n_created = ROW_COUNT;

  -- in-place updates (code unchanged)
  UPDATE public.wh_locations l
     SET rack_id = p.rack_id, face = p.face, zone = p.zone, default_bucket = p.default_bucket,
         pickable = p.pickable, is_overflow = p.is_overflow,
         x_mm = p.x_mm, y_mm = p.y_mm, z_mm = p.z_mm, width_mm = p.width_mm, depth_mm = p.depth_mm, height_mm = p.height_mm,
         active = true
    FROM _wh_plan p
    JOIN _wh_plan_class c ON c.face_id = p.face_id AND c.bay = p.bay AND c.level = p.level AND c.action = 'update'
   WHERE l.id = c.existing_id;
  GET DIAGNOSTICS n_updated = ROW_COUNT;

  -- rows no longer generated, only when empty
  UPDATE public.wh_locations l
     SET active = false, pick_sequence = NULL
    FROM _wh_plan_gone g
   WHERE l.id = g.id AND NOT g.not_empty;
  GET DIAGNOSTICS n_deact = ROW_COUNT;

  -- recompute every bay-level pick_sequence (cleared first: the partial
  -- unique index is checked row by row)
  UPDATE public.wh_locations SET pick_sequence = NULL
   WHERE kind = 'bay_level' AND pick_sequence IS NOT NULL;
  UPDATE public.wh_locations l
     SET pick_sequence = p.pick_sequence
    FROM _wh_plan p
   WHERE l.kind = 'bay_level' AND l.active
     AND l.face_id = p.face_id AND l.bay = p.bay AND l.level = p.level;

  RETURN jsonb_build_object('ok', true, 'dry_run', false,
    'created', n_created, 'updated', n_updated, 'deactivated', n_deact,
    'create', v_create, 'update', v_update, 'conflicts', v_conflicts, 'deactivate', v_deact, 'codes', v_codes);
END;
$$;

-- -------------------------------------------------------------
-- G. rpc_wh_save_layout(p_payload) – admin
-- payload: {templates:[...], racks:[...], faces:[...], fixtures:[...]}
--   templates by id or code; racks by id or code (template_code or
--   template_id); faces by id or (rack_code|rack_id, face_code);
--   fixtures by id or name ("_delete": true removes one). A row carrying
--   a row_version that no longer matches is a conflict (stale). All or
--   nothing: any problem rolls the whole payload back.
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_wh_save_layout(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r          jsonb;
  v_id       uuid;
  v_ver      integer;
  v_tpl      uuid;
  v_rack     uuid;
  v_loc      uuid;
  v_site     uuid := public._default_location_id();
  v_ctx      text := '';
  v_problems jsonb := '[]'::jsonb;
  c          jsonb := jsonb_build_object(
                 'templates', jsonb_build_object('created', 0, 'updated', 0),
                 'racks',     jsonb_build_object('created', 0, 'updated', 0),
                 'faces',     jsonb_build_object('created', 0, 'updated', 0),
                 'fixtures',  jsonb_build_object('created', 0, 'updated', 0, 'deleted', 0));
BEGIN
  IF public._wh_require_role(ARRAY['admin']) IS NULL THEN
    RETURN public._wh_err('forbidden', 'Saving the layout needs an admin (forbidden).');
  END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RETURN public._wh_err('invalid_payload', 'The layout payload must be a JSON object (invalid_payload).');
  END IF;

  BEGIN
    -- templates ------------------------------------------------
    FOR r IN SELECT * FROM jsonb_array_elements(COALESCE(p_payload->'templates', '[]'::jsonb)) LOOP
      v_ctx := 'template ' || COALESCE(r->>'code', r->>'id', '?');
      v_id := NULL;
      SELECT id, row_version INTO v_id, v_ver FROM public.wh_rack_templates
       WHERE id = NULLIF(r->>'id', '')::uuid OR (r->>'id' IS NULL AND code = r->>'code');
      IF v_id IS NOT NULL AND r ? 'row_version' AND (r->>'row_version')::int <> v_ver THEN
        v_problems := v_problems || jsonb_build_object('row', v_ctx, 'error', 'stale', 'message', v_ctx || ' changed since it was loaded (stale).');
        CONTINUE;
      END IF;
      IF v_id IS NULL THEN
        INSERT INTO public.wh_rack_templates (code, name, kind, bays, levels, bay_width_mm, depth_mm, level_heights_mm, overflow_top_level, capacity_cartons_per_level)
        VALUES (r->>'code', COALESCE(r->>'name', r->>'code'), r->>'kind', (r->>'bays')::smallint, (r->>'levels')::smallint,
                (r->>'bay_width_mm')::int, (r->>'depth_mm')::int,
                ARRAY(SELECT jsonb_array_elements_text(r->'level_heights_mm')::int),
                COALESCE((r->>'overflow_top_level')::boolean, false), NULLIF(r->>'capacity_cartons_per_level', '')::int);
        c := jsonb_set(c, '{templates,created}', to_jsonb((c#>>'{templates,created}')::int + 1));
      ELSE
        UPDATE public.wh_rack_templates SET
          code = COALESCE(r->>'code', code), name = COALESCE(r->>'name', name), kind = COALESCE(r->>'kind', kind),
          bays = COALESCE((r->>'bays')::smallint, bays), levels = COALESCE((r->>'levels')::smallint, levels),
          bay_width_mm = COALESCE((r->>'bay_width_mm')::int, bay_width_mm), depth_mm = COALESCE((r->>'depth_mm')::int, depth_mm),
          level_heights_mm = CASE WHEN r ? 'level_heights_mm' THEN ARRAY(SELECT jsonb_array_elements_text(r->'level_heights_mm')::int) ELSE level_heights_mm END,
          overflow_top_level = COALESCE((r->>'overflow_top_level')::boolean, overflow_top_level),
          capacity_cartons_per_level = CASE WHEN r ? 'capacity_cartons_per_level' THEN NULLIF(r->>'capacity_cartons_per_level', '')::int ELSE capacity_cartons_per_level END
         WHERE id = v_id;
        c := jsonb_set(c, '{templates,updated}', to_jsonb((c#>>'{templates,updated}')::int + 1));
      END IF;
    END LOOP;

    -- racks ----------------------------------------------------
    FOR r IN SELECT * FROM jsonb_array_elements(COALESCE(p_payload->'racks', '[]'::jsonb)) LOOP
      v_ctx := 'rack ' || COALESCE(r->>'code', r->>'id', '?');
      v_tpl := COALESCE(NULLIF(r->>'template_id', '')::uuid,
                        (SELECT id FROM public.wh_rack_templates WHERE code = r->>'template_code'));
      IF (r ? 'template_code' OR r ? 'template_id') AND v_tpl IS NULL THEN
        v_problems := v_problems || jsonb_build_object('row', v_ctx, 'error', 'template_not_found', 'message', v_ctx || ': template not found (template_not_found).');
        CONTINUE;
      END IF;
      v_id := NULL;
      SELECT id, row_version INTO v_id, v_ver FROM public.wh_racks
       WHERE id = NULLIF(r->>'id', '')::uuid OR (r->>'id' IS NULL AND site_location_id = v_site AND code = r->>'code');
      IF v_id IS NOT NULL AND r ? 'row_version' AND (r->>'row_version')::int <> v_ver THEN
        v_problems := v_problems || jsonb_build_object('row', v_ctx, 'error', 'stale', 'message', v_ctx || ' changed since it was loaded (stale).');
        CONTINUE;
      END IF;
      IF v_id IS NULL THEN
        INSERT INTO public.wh_racks (code, template_id, description, x_mm, y_mm, rot_deg, bays, levels, width_mm, depth_mm, active)
        SELECT r->>'code', v_tpl, r->>'description', COALESCE((r->>'x_mm')::int, 0), COALESCE((r->>'y_mm')::int, 0),
               COALESCE((r->>'rot_deg')::smallint, 0),
               COALESCE((r->>'bays')::smallint, t.bays), COALESCE((r->>'levels')::smallint, t.levels),
               NULLIF(r->>'width_mm', '')::int, NULLIF(r->>'depth_mm', '')::int, COALESCE((r->>'active')::boolean, true)
          FROM (SELECT 1) AS one
          LEFT JOIN public.wh_rack_templates t ON t.id = v_tpl;
        c := jsonb_set(c, '{racks,created}', to_jsonb((c#>>'{racks,created}')::int + 1));
      ELSE
        UPDATE public.wh_racks SET
          code = COALESCE(r->>'code', code), template_id = COALESCE(v_tpl, template_id), description = COALESCE(r->>'description', description),
          x_mm = COALESCE((r->>'x_mm')::int, x_mm), y_mm = COALESCE((r->>'y_mm')::int, y_mm), rot_deg = COALESCE((r->>'rot_deg')::smallint, rot_deg),
          bays = COALESCE((r->>'bays')::smallint, bays), levels = COALESCE((r->>'levels')::smallint, levels),
          width_mm = CASE WHEN r ? 'width_mm' THEN NULLIF(r->>'width_mm', '')::int ELSE width_mm END,
          depth_mm = CASE WHEN r ? 'depth_mm' THEN NULLIF(r->>'depth_mm', '')::int ELSE depth_mm END,
          active = COALESCE((r->>'active')::boolean, active)
         WHERE id = v_id;
        c := jsonb_set(c, '{racks,updated}', to_jsonb((c#>>'{racks,updated}')::int + 1));
      END IF;
    END LOOP;

    -- faces ----------------------------------------------------
    FOR r IN SELECT * FROM jsonb_array_elements(COALESCE(p_payload->'faces', '[]'::jsonb)) LOOP
      v_ctx := 'face ' || COALESCE(r->>'face_code', r->>'id', '?') || ' on ' || COALESCE(r->>'rack_code', r->>'rack_id', '?');
      v_rack := COALESCE(NULLIF(r->>'rack_id', '')::uuid,
                         (SELECT id FROM public.wh_racks WHERE site_location_id = v_site AND code = r->>'rack_code'));
      v_id := NULL;
      SELECT id, row_version INTO v_id, v_ver FROM public.wh_rack_faces
       WHERE id = NULLIF(r->>'id', '')::uuid OR (r->>'id' IS NULL AND rack_id = v_rack AND face_code = r->>'face_code');
      IF v_id IS NULL AND v_rack IS NULL THEN
        v_problems := v_problems || jsonb_build_object('row', v_ctx, 'error', 'rack_not_found', 'message', v_ctx || ': rack not found (rack_not_found).');
        CONTINUE;
      END IF;
      IF v_id IS NOT NULL AND r ? 'row_version' AND (r->>'row_version')::int <> v_ver THEN
        v_problems := v_problems || jsonb_build_object('row', v_ctx, 'error', 'stale', 'message', v_ctx || ' changed since it was loaded (stale).');
        CONTINUE;
      END IF;
      IF v_id IS NULL THEN
        INSERT INTO public.wh_rack_faces (rack_id, face_code, side, aisle, walk_pass, walk_dir, first_bay_no, zone_by_bay, pickable_levels)
        VALUES (v_rack, r->>'face_code', NULLIF(r->>'side', ''), NULLIF(r->>'aisle', ''), COALESCE((r->>'walk_pass')::smallint, 99),
                NULLIF(r->>'walk_dir', ''), COALESCE((r->>'first_bay_no')::smallint, 1),
                CASE WHEN jsonb_typeof(r->'zone_by_bay') = 'array' THEN ARRAY(SELECT jsonb_array_elements_text(r->'zone_by_bay')) END,
                CASE WHEN jsonb_typeof(r->'pickable_levels') = 'array' THEN ARRAY(SELECT jsonb_array_elements_text(r->'pickable_levels')::smallint) ELSE '{1,2}'::smallint[] END);
        c := jsonb_set(c, '{faces,created}', to_jsonb((c#>>'{faces,created}')::int + 1));
      ELSE
        UPDATE public.wh_rack_faces SET
          rack_id = COALESCE(v_rack, rack_id), face_code = COALESCE(r->>'face_code', face_code),
          side = CASE WHEN r ? 'side' THEN NULLIF(r->>'side', '') ELSE side END,
          aisle = CASE WHEN r ? 'aisle' THEN NULLIF(r->>'aisle', '') ELSE aisle END,
          walk_pass = COALESCE((r->>'walk_pass')::smallint, walk_pass),
          walk_dir = CASE WHEN r ? 'walk_dir' THEN NULLIF(r->>'walk_dir', '') ELSE walk_dir END,
          first_bay_no = COALESCE((r->>'first_bay_no')::smallint, first_bay_no),
          zone_by_bay = CASE WHEN jsonb_typeof(r->'zone_by_bay') = 'array' THEN ARRAY(SELECT jsonb_array_elements_text(r->'zone_by_bay')) ELSE zone_by_bay END,
          pickable_levels = CASE WHEN jsonb_typeof(r->'pickable_levels') = 'array' THEN ARRAY(SELECT jsonb_array_elements_text(r->'pickable_levels')::smallint) ELSE pickable_levels END
         WHERE id = v_id;
        c := jsonb_set(c, '{faces,updated}', to_jsonb((c#>>'{faces,updated}')::int + 1));
      END IF;
    END LOOP;

    -- fixtures -------------------------------------------------
    FOR r IN SELECT * FROM jsonb_array_elements(COALESCE(p_payload->'fixtures', '[]'::jsonb)) LOOP
      v_ctx := 'fixture ' || COALESCE(r->>'name', r->>'id', '?');
      v_id := NULL;
      SELECT id, row_version INTO v_id, v_ver FROM public.wh_fixtures
       WHERE id = NULLIF(r->>'id', '')::uuid OR (r->>'id' IS NULL AND name = r->>'name');
      IF v_id IS NOT NULL AND r ? 'row_version' AND (r->>'row_version')::int <> v_ver THEN
        v_problems := v_problems || jsonb_build_object('row', v_ctx, 'error', 'stale', 'message', v_ctx || ' changed since it was loaded (stale).');
        CONTINUE;
      END IF;
      IF COALESCE((r->>'_delete')::boolean, false) THEN
        IF v_id IS NOT NULL THEN
          DELETE FROM public.wh_fixtures WHERE id = v_id;
          c := jsonb_set(c, '{fixtures,deleted}', to_jsonb((c#>>'{fixtures,deleted}')::int + 1));
        END IF;
        CONTINUE;
      END IF;
      v_loc := COALESCE(NULLIF(r->>'location_id', '')::uuid,
                        (SELECT id FROM public.wh_locations WHERE site_location_id = v_site AND code = r->>'location_code'));
      IF v_id IS NULL THEN
        INSERT INTO public.wh_fixtures (name, kind, x_mm, y_mm, width_mm, depth_mm, rot_deg, zone, location_id, blocked)
        VALUES (r->>'name', r->>'kind', COALESCE((r->>'x_mm')::int, 0), COALESCE((r->>'y_mm')::int, 0),
                NULLIF(r->>'width_mm', '')::int, NULLIF(r->>'depth_mm', '')::int, COALESCE((r->>'rot_deg')::smallint, 0),
                NULLIF(r->>'zone', ''), v_loc, COALESCE((r->>'blocked')::boolean, false));
        c := jsonb_set(c, '{fixtures,created}', to_jsonb((c#>>'{fixtures,created}')::int + 1));
      ELSE
        UPDATE public.wh_fixtures SET
          name = COALESCE(r->>'name', name), kind = COALESCE(r->>'kind', kind),
          x_mm = COALESCE((r->>'x_mm')::int, x_mm), y_mm = COALESCE((r->>'y_mm')::int, y_mm),
          width_mm = CASE WHEN r ? 'width_mm' THEN NULLIF(r->>'width_mm', '')::int ELSE width_mm END,
          depth_mm = CASE WHEN r ? 'depth_mm' THEN NULLIF(r->>'depth_mm', '')::int ELSE depth_mm END,
          rot_deg = COALESCE((r->>'rot_deg')::smallint, rot_deg),
          zone = CASE WHEN r ? 'zone' THEN NULLIF(r->>'zone', '') ELSE zone END,
          location_id = CASE WHEN r ? 'location_id' OR r ? 'location_code' THEN v_loc ELSE location_id END,
          blocked = COALESCE((r->>'blocked')::boolean, blocked)
         WHERE id = v_id;
        c := jsonb_set(c, '{fixtures,updated}', to_jsonb((c#>>'{fixtures,updated}')::int + 1));
      END IF;
    END LOOP;

    IF jsonb_array_length(v_problems) > 0 THEN
      RAISE EXCEPTION 'wh_layout_rejected';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- every write above is rolled back; local variables survive
    IF jsonb_array_length(v_problems) = 0 THEN
      v_problems := jsonb_build_array(jsonb_build_object('row', v_ctx, 'error', 'invalid_row', 'message', v_ctx || ': ' || SQLERRM || ' (invalid_row).'));
    END IF;
    RETURN public._wh_err('layout_rejected',
      'Nothing was saved: ' || (v_problems->0->>'message') ||
      CASE WHEN jsonb_array_length(v_problems) > 1 THEN ' (+' || (jsonb_array_length(v_problems) - 1) || ' more)' ELSE '' END,
      jsonb_build_object('problems', v_problems));
  END;

  RETURN jsonb_build_object('ok', true) || c;
END;
$$;

-- -------------------------------------------------------------
-- H. rpc_wh_save_location(p_location) – admin
-- Creates or edits a named location (floor, station, virtual); on a
-- bay-level only name, capacity_cartons, active, geometry and the label
-- stamps are editable (the generator owns the rest). Deactivation is
-- refused while any balance is non-zero. UNLOCATED and MFG-LINE cannot
-- be renamed, re-kinded or deactivated.
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_wh_save_location(p_location jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r       jsonb := p_location;
  v_loc   public.wh_locations%ROWTYPE;
  v_site  uuid := public._default_location_id();
  v_code  text := upper(btrim(p_location->>'code'));
BEGIN
  IF public._wh_require_role(ARRAY['admin']) IS NULL THEN
    RETURN public._wh_err('forbidden', 'Editing locations needs an admin (forbidden).');
  END IF;
  IF r IS NULL OR jsonb_typeof(r) <> 'object' THEN
    RETURN public._wh_err('invalid_payload', 'The location must be a JSON object (invalid_payload).');
  END IF;

  SELECT * INTO v_loc FROM public.wh_locations
   WHERE id = NULLIF(r->>'id', '')::uuid OR (r->>'id' IS NULL AND site_location_id = v_site AND code = v_code)
   FOR UPDATE;

  IF FOUND THEN
    IF r ? 'row_version' AND (r->>'row_version')::int <> v_loc.row_version THEN
      RETURN public._wh_err('stale', v_loc.code || ' changed since it was loaded (stale).');
    END IF;
    IF v_loc.code IN ('UNLOCATED', 'MFG-LINE') AND (
         (r ? 'active' AND (r->>'active')::boolean IS DISTINCT FROM true)
         OR (r ? 'code' AND v_code IS DISTINCT FROM v_loc.code)
         OR (r ? 'kind' AND r->>'kind' IS DISTINCT FROM v_loc.kind)) THEN
      RETURN public._wh_err('location_protected', v_loc.code || ' is a system location and cannot be renamed or deactivated (location_protected).');
    END IF;
    IF v_loc.kind = 'bay_level' AND (
         (r ? 'code' AND v_code IS DISTINCT FROM v_loc.code)
         OR (r ? 'kind' AND r->>'kind' IS DISTINCT FROM 'bay_level')
         OR (r ? 'zone' AND r->>'zone' IS DISTINCT FROM v_loc.zone)
         OR (r ? 'pickable' AND (r->>'pickable')::boolean IS DISTINCT FROM v_loc.pickable)
         OR (r ? 'is_overflow' AND (r->>'is_overflow')::boolean IS DISTINCT FROM v_loc.is_overflow)
         OR (r ? 'default_bucket' AND NULLIF(r->>'default_bucket', '') IS DISTINCT FROM v_loc.default_bucket)) THEN
      RETURN public._wh_err('generator_owned', v_loc.code || ': code, zone, bucket and pick flags of a bay-level come from the layout; edit the face and regenerate (generator_owned).');
    END IF;
    IF r ? 'active' AND (r->>'active')::boolean IS NOT TRUE AND v_loc.active AND public._wh_location_has_stock(v_loc.id) THEN
      RETURN public._wh_err('location_not_empty', v_loc.code || ' still holds stock; move or count it out before deactivating (location_not_empty).');
    END IF;
    BEGIN
      UPDATE public.wh_locations SET
        code = CASE WHEN r ? 'code' THEN v_code ELSE code END,
        name = CASE WHEN r ? 'name' THEN NULLIF(r->>'name', '') ELSE name END,
        kind = COALESCE(r->>'kind', kind),
        zone = COALESCE(r->>'zone', zone),
        default_bucket = CASE WHEN r ? 'default_bucket' THEN NULLIF(r->>'default_bucket', '') ELSE default_bucket END,
        bucket_lock = CASE WHEN r ? 'bucket_lock' THEN NULLIF(r->>'bucket_lock', '') ELSE bucket_lock END,
        pickable = COALESCE((r->>'pickable')::boolean, pickable),
        is_overflow = COALESCE((r->>'is_overflow')::boolean, is_overflow),
        x_mm = CASE WHEN r ? 'x_mm' THEN NULLIF(r->>'x_mm', '')::int ELSE x_mm END,
        y_mm = CASE WHEN r ? 'y_mm' THEN NULLIF(r->>'y_mm', '')::int ELSE y_mm END,
        z_mm = CASE WHEN r ? 'z_mm' THEN NULLIF(r->>'z_mm', '')::int ELSE z_mm END,
        width_mm = CASE WHEN r ? 'width_mm' THEN NULLIF(r->>'width_mm', '')::int ELSE width_mm END,
        depth_mm = CASE WHEN r ? 'depth_mm' THEN NULLIF(r->>'depth_mm', '')::int ELSE depth_mm END,
        height_mm = CASE WHEN r ? 'height_mm' THEN NULLIF(r->>'height_mm', '')::int ELSE height_mm END,
        capacity_cartons = CASE WHEN r ? 'capacity_cartons' THEN NULLIF(r->>'capacity_cartons', '')::int ELSE capacity_cartons END,
        label_printed_at = CASE WHEN r ? 'label_printed_at' THEN NULLIF(r->>'label_printed_at', '')::timestamptz ELSE label_printed_at END,
        label_verified_at = CASE WHEN r ? 'label_verified_at' THEN NULLIF(r->>'label_verified_at', '')::timestamptz ELSE label_verified_at END,
        active = COALESCE((r->>'active')::boolean, active)
       WHERE id = v_loc.id
       RETURNING * INTO v_loc;
    EXCEPTION WHEN check_violation OR unique_violation OR invalid_text_representation OR datetime_field_overflow OR invalid_datetime_format THEN
      RETURN public._wh_err('invalid_location', v_loc.code || ': ' || SQLERRM || ' (invalid_location).');
    END;
    RETURN jsonb_build_object('ok', true, 'created', false, 'location', to_jsonb(v_loc));
  END IF;

  -- create
  IF COALESCE(r->>'kind', 'floor') = 'bay_level' THEN
    RETURN public._wh_err('use_generator', 'Bay-levels are created by the generator from racks and faces (use_generator).');
  END IF;
  IF v_code IS NULL OR v_code = '' THEN
    RETURN public._wh_err('code_required', 'A location needs a code (code_required).');
  END IF;
  BEGIN
    INSERT INTO public.wh_locations (code, name, kind, zone, default_bucket, bucket_lock, pickable, is_overflow,
                                     x_mm, y_mm, z_mm, width_mm, depth_mm, height_mm, capacity_cartons, active)
    VALUES (v_code, NULLIF(r->>'name', ''), COALESCE(r->>'kind', 'floor'), r->>'zone',
            NULLIF(r->>'default_bucket', ''), NULLIF(r->>'bucket_lock', ''),
            COALESCE((r->>'pickable')::boolean, false), COALESCE((r->>'is_overflow')::boolean, false),
            NULLIF(r->>'x_mm', '')::int, NULLIF(r->>'y_mm', '')::int, NULLIF(r->>'z_mm', '')::int,
            NULLIF(r->>'width_mm', '')::int, NULLIF(r->>'depth_mm', '')::int, NULLIF(r->>'height_mm', '')::int,
            NULLIF(r->>'capacity_cartons', '')::int, COALESCE((r->>'active')::boolean, true))
    RETURNING * INTO v_loc;
  EXCEPTION WHEN check_violation OR unique_violation OR not_null_violation OR invalid_text_representation THEN
    RETURN public._wh_err('invalid_location', v_code || ': ' || SQLERRM || ' (invalid_location).');
  END;
  RETURN jsonb_build_object('ok', true, 'created', true, 'location', to_jsonb(v_loc));
END;
$$;

-- -------------------------------------------------------------
-- I. rpc_wh_resequence(p_rows) – admin
-- rows: [{location_id | code, pick_sequence}] (Verify-walk fixes)
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_wh_resequence(p_rows jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_site    uuid := public._default_location_id();
  v_missing text;
  n         int := 0;
BEGIN
  IF public._wh_require_role(ARRAY['admin']) IS NULL THEN
    RETURN public._wh_err('forbidden', 'Changing the pick sequence needs an admin (forbidden).');
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RETURN public._wh_err('invalid_payload', 'rows must be a JSON array (invalid_payload).');
  END IF;

  DROP TABLE IF EXISTS pg_temp._wh_reseq;
  CREATE TEMP TABLE _wh_reseq ON COMMIT DROP AS
  SELECT l.id AS location_id, COALESCE(l.code, x->>'code', x->>'location_id') AS code, (x->>'pick_sequence')::int AS seq
    FROM jsonb_array_elements(p_rows) x
    LEFT JOIN public.wh_locations l
      ON l.id = NULLIF(x->>'location_id', '')::uuid
      OR (x->>'location_id' IS NULL AND l.site_location_id = v_site AND l.code = upper(x->>'code'));

  SELECT string_agg(code, ', ') INTO v_missing FROM _wh_reseq WHERE location_id IS NULL;
  IF v_missing IS NOT NULL THEN
    RETURN public._wh_err('location_not_found', 'Unknown locations: ' || v_missing || ' (location_not_found).');
  END IF;
  IF EXISTS (SELECT 1 FROM _wh_reseq WHERE seq IS NOT NULL GROUP BY seq HAVING count(*) > 1) THEN
    RETURN public._wh_err('sequence_conflict', 'Two rows ask for the same pick_sequence (sequence_conflict).');
  END IF;

  BEGIN
    UPDATE public.wh_locations l SET pick_sequence = NULL FROM _wh_reseq s WHERE l.id = s.location_id;
    UPDATE public.wh_locations l SET pick_sequence = s.seq FROM _wh_reseq s WHERE l.id = s.location_id;
    GET DIAGNOSTICS n = ROW_COUNT;
  EXCEPTION WHEN unique_violation THEN
    RETURN public._wh_err('sequence_conflict', 'A requested pick_sequence is already used by another active location (sequence_conflict).');
  END;
  RETURN jsonb_build_object('ok', true, 'updated', n);
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_wh_generate_locations(uuid, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rpc_wh_save_layout(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rpc_wh_save_location(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rpc_wh_resequence(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_wh_generate_locations(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_wh_save_layout(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_wh_save_location(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_wh_resequence(jsonb) TO authenticated;

COMMIT;
