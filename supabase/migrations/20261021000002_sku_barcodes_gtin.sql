-- =============================================================
-- Migration: SKU barcodes, GTIN matching, box dimensions,
--            catalog import, scan resolution, baseline KPIs (Phase 0)
-- =============================================================
-- Design: docs/design/WAREHOUSE_MODULE_PHASE0_1.md §3.6 and §3.7
--
-- * sku_barcodes: one row per barcode, normalised to GTIN-12 for UPC-A
--   and UPC-E, GTIN-13 for EAN-13 not starting with 0, 8 digits for
--   EAN-8. UNIQUE(code) guarantees one barcode never resolves to two
--   SKUs. product_skus.upc_code keeps the primary GTIN-12 for display
--   and the ShipStation product CSV; lookups never read it.
-- * product_skus gains the three product-box dimensions (inches) that
--   drive tote classes in Phase 2. Nothing else (owner decision).
-- * fn_gtin_candidates(scan) turns whatever a scanner sends (7, 8, 11,
--   12 or 13 digits) into the normalised forms to look up. Its twin is
--   src/lib/warehouse/gtin.ts; tests on both sides use the catalog.
-- * rpc_wh_import_sku_master loads docs/research/warehouse-map/
--   sku_catalog_with_upc.csv rows (and later the workbook's SKU boxes
--   tab). Codes already on another SKU are reported, never overwritten.
-- * rpc_wh_resolve_scan / rpc_wh_link_barcode / rpc_wh_barcode_coverage
--   back the Floor "Look up" page.
-- * rpc_wh_baseline_kpis is the order-derived half of the Phase 0
--   baseline (the stopwatch half lives in the workbook).
--
-- Smoke after deploy:
--   SELECT public.fn_gtin_candidates('1383325');   -- {138332000051}
--   SELECT public.fn_gtin_candidates('13833251');  -- {138332000051,13833251}
--   SELECT public.rpc_wh_import_sku_master('[]'::jsonb, true);
--   SELECT public.rpc_wh_resolve_scan('102696441041');
--   SELECT public.rpc_wh_barcode_coverage();
--   SELECT public.rpc_wh_baseline_kpis(current_date - 14, current_date);
-- =============================================================

-- -------------------------------------------------------------
-- A. product_skus box dimensions (inches, product box before wrap)
-- -------------------------------------------------------------
ALTER TABLE public.product_skus
  ADD COLUMN IF NOT EXISTS box_length_in numeric(5,2),
  ADD COLUMN IF NOT EXISTS box_width_in  numeric(5,2),
  ADD COLUMN IF NOT EXISTS box_height_in numeric(5,2);

ALTER TABLE public.product_skus DROP CONSTRAINT IF EXISTS chk_product_skus_box_dims_positive;
ALTER TABLE public.product_skus
  ADD CONSTRAINT chk_product_skus_box_dims_positive CHECK (
    (box_length_in IS NULL OR box_length_in > 0) AND
    (box_width_in  IS NULL OR box_width_in  > 0) AND
    (box_height_in IS NULL OR box_height_in > 0)
  );

-- -------------------------------------------------------------
-- B. GTIN helpers (IMMUTABLE, pure SQL/plpgsql)
-- -------------------------------------------------------------
-- UPC-A / GTIN-12 check digit for an 11-digit body.
CREATE OR REPLACE FUNCTION public.fn_upca_check_digit(p_body11 text)
RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE
AS $$
DECLARE
  v_sum int := 0;
  v_i   int;
BEGIN
  IF p_body11 !~ '^[0-9]{11}$' THEN
    RETURN NULL;
  END IF;
  FOR v_i IN 1..11 LOOP
    -- positions 1,3,5,... (odd, 1-based) weigh 3
    v_sum := v_sum + (substr(p_body11, v_i, 1)::int) * CASE WHEN v_i % 2 = 1 THEN 3 ELSE 1 END;
  END LOOP;
  RETURN ((10 - (v_sum % 10)) % 10)::text;
END;
$$;

-- UPC-E (number system + 6 body digits) → GTIN-12 with check digit.
CREATE OR REPLACE FUNCTION public.fn_upce_expand(p_ns text, p_body6 text)
RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE
AS $$
DECLARE
  d1 text := substr(p_body6, 1, 1);
  d2 text := substr(p_body6, 2, 1);
  d3 text := substr(p_body6, 3, 1);
  d4 text := substr(p_body6, 4, 1);
  d5 text := substr(p_body6, 5, 1);
  d6 text := substr(p_body6, 6, 1);
  v_body11 text;
BEGIN
  IF p_ns !~ '^[01]$' OR p_body6 !~ '^[0-9]{6}$' THEN
    RETURN NULL;
  END IF;
  v_body11 := CASE
    WHEN d6 IN ('0','1','2') THEN p_ns || d1 || d2 || d6 || '0000' || d3 || d4 || d5
    WHEN d6 = '3'            THEN p_ns || d1 || d2 || d3 || '00000' || d4 || d5
    WHEN d6 = '4'            THEN p_ns || d1 || d2 || d3 || d4 || '00000' || d5
    ELSE                          p_ns || d1 || d2 || d3 || d4 || d5 || '0000' || d6
  END;
  RETURN v_body11 || public.fn_upca_check_digit(v_body11);
END;
$$;

-- Every normalised form a scan could mean, most likely first.
--   13 digits: EAN-13; a leading 0 is a UPC-A → drop it, else keep 13
--   12 digits: UPC-A as scanned (plus the check-corrected form if wrong)
--   11 digits: UPC-A without its check digit → append it
--    8 digits: UPC-E with check (NS 0/1) → expanded 12 + raw 8; else EAN-8 raw
--    7 digits: UPC-E without check (NS + body) → expanded 12
--    6 digits: UPC-E body, NS 0 → expanded 12
CREATE OR REPLACE FUNCTION public.fn_gtin_candidates(p_scan text)
RETURNS text[]
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
AS $$
DECLARE
  d text := regexp_replace(COALESCE(p_scan, ''), '[^0-9]', '', 'g');
  v_out text[] := '{}';
  v_x   text;
BEGIN
  CASE length(d)
    WHEN 13 THEN
      IF left(d, 1) = '0' THEN v_out := ARRAY[substr(d, 2)]; ELSE v_out := ARRAY[d]; END IF;
    WHEN 12 THEN
      v_out := ARRAY[d];
      v_x := left(d, 11) || public.fn_upca_check_digit(left(d, 11));
      IF v_x <> d THEN v_out := v_out || v_x; END IF;
    WHEN 11 THEN
      v_out := ARRAY[d || public.fn_upca_check_digit(d)];
    WHEN 8 THEN
      IF left(d, 1) IN ('0', '1') THEN
        v_x := public.fn_upce_expand(left(d, 1), substr(d, 2, 6));
        v_out := ARRAY[v_x, d];
      ELSE
        v_out := ARRAY[d];
      END IF;
    WHEN 7 THEN
      IF left(d, 1) IN ('0', '1') THEN
        v_out := ARRAY[public.fn_upce_expand(left(d, 1), substr(d, 2, 6))];
      END IF;
    WHEN 6 THEN
      v_out := ARRAY[public.fn_upce_expand('0', d)];
    ELSE
      v_out := '{}';
  END CASE;
  RETURN array_remove(v_out, NULL);
END;
$$;

-- The canonical stored form for a scan: its first candidate.
CREATE OR REPLACE FUNCTION public.fn_gtin_normalize(p_scan text)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT (public.fn_gtin_candidates(p_scan))[1];
$$;

GRANT EXECUTE ON FUNCTION public.fn_upca_check_digit(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_upce_expand(text, text)  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_gtin_candidates(text)    TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_gtin_normalize(text)     TO authenticated, service_role;

-- -------------------------------------------------------------
-- C. sku_barcodes
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.sku_barcodes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku_id      uuid NOT NULL REFERENCES public.product_skus(id) ON DELETE CASCADE,
  code        text NOT NULL,
  code_raw    text,
  symbology   text NOT NULL DEFAULT 'upca',
  source      text NOT NULL DEFAULT 'manual',
  is_primary  boolean NOT NULL DEFAULT false,
  created_by  uuid REFERENCES public.profiles(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sku_barcodes_code_key UNIQUE (code),
  CONSTRAINT chk_sku_barcodes_code_digits CHECK (code ~ '^[0-9]{8}$' OR code ~ '^[0-9]{12,13}$'),
  CONSTRAINT chk_sku_barcodes_symbology CHECK (symbology IN ('upca', 'upce', 'ean13', 'ean8', 'other')),
  CONSTRAINT chk_sku_barcodes_source CHECK (source IN ('catalog_csv', 'scan_link', 'manual'))
);

CREATE INDEX IF NOT EXISTS sku_barcodes_sku_id_idx ON public.sku_barcodes (sku_id);
CREATE UNIQUE INDEX IF NOT EXISTS sku_barcodes_one_primary_per_sku
  ON public.sku_barcodes (sku_id) WHERE is_primary;

COMMENT ON TABLE public.sku_barcodes IS
  'Normalised product barcodes (GTIN-12/13/8). Lookups use fn_gtin_candidates(scan) = ANY. Writes via rpc_wh_import_sku_master / rpc_wh_link_barcode.';

ALTER TABLE public.sku_barcodes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sku_barcodes_select_internal ON public.sku_barcodes;
CREATE POLICY sku_barcodes_select_internal
  ON public.sku_barcodes
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

GRANT SELECT ON TABLE public.sku_barcodes TO authenticated;
GRANT ALL    ON TABLE public.sku_barcodes TO service_role;

-- -------------------------------------------------------------
-- D. rpc_wh_import_sku_master(rows, dry_run) – admin
-- rows: [{sku, upc_gtin12, upc_upce8, upc_raw, upc_symbology,
--         box_length_in, box_width_in, box_height_in}]
-- -------------------------------------------------------------
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
  IF v_role IS DISTINCT FROM 'admin' AND current_user <> 'postgres' THEN
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

GRANT EXECUTE ON FUNCTION public.rpc_wh_import_sku_master(jsonb, boolean) TO authenticated;

-- -------------------------------------------------------------
-- E. rpc_wh_resolve_scan(scan) → {ok, kind, match|null, candidates}
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_wh_resolve_scan(p_scan text)
RETURNS jsonb AS $$
DECLARE
  v_role  text;
  v_cands text[];
  v_match jsonb;
  v_scan  text := btrim(COALESCE(p_scan, ''));
BEGIN
  SELECT role INTO v_role FROM public.profiles WHERE id = auth.uid() AND is_active;
  IF (v_role IS NULL OR v_role = 'supplier') AND current_user <> 'postgres' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'internal role required');
  END IF;
  IF v_scan = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'empty scan');
  END IF;

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
      RETURN jsonb_build_object('ok', true, 'kind', 'gtin', 'match', v_match, 'candidates', to_jsonb(v_cands));
    END IF;
    RETURN jsonb_build_object('ok', true, 'kind', 'gtin', 'match', NULL, 'candidates', to_jsonb(v_cands));
  END IF;

  -- not a barcode shape: try the SKU code itself
  SELECT jsonb_build_object(
           'sku_id', ps.id, 'sku', ps.sku, 'product_name', ps.product_name,
           'display_category', ps.display_category, 'is_active', ps.is_active,
           'code', NULL, 'symbology', NULL)
    INTO v_match
    FROM public.product_skus ps
   WHERE lower(ps.sku) = lower(v_scan)
   LIMIT 1;
  RETURN jsonb_build_object('ok', true, 'kind', 'sku', 'match', v_match, 'candidates', '[]'::jsonb);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.rpc_wh_resolve_scan(text) TO authenticated;

-- -------------------------------------------------------------
-- F. rpc_wh_link_barcode(sku_id, scan) – admin/manager
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_wh_link_barcode(p_sku_id uuid, p_scan text)
RETURNS jsonb AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_role  text;
  v_code  text;
  v_sym   text;
  v_other text;
  v_digits text := regexp_replace(COALESCE(p_scan, ''), '[^0-9]', '', 'g');
BEGIN
  SELECT role INTO v_role FROM public.profiles WHERE id = v_actor AND is_active;
  IF v_role NOT IN ('admin', 'manager') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'admin or manager role required');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.product_skus WHERE id = p_sku_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'sku_not_found');
  END IF;
  v_code := public.fn_gtin_normalize(p_scan);
  IF v_code IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not a barcode: ' || COALESCE(p_scan, ''));
  END IF;
  v_sym := CASE WHEN length(v_digits) IN (6,7,8) AND length(v_code) = 12 THEN 'upce'
                WHEN length(v_code) = 13 THEN 'ean13'
                WHEN length(v_code) = 8  THEN 'ean8'
                ELSE 'upca' END;

  SELECT ps.sku INTO v_other
    FROM public.sku_barcodes b JOIN public.product_skus ps ON ps.id = b.sku_id
   WHERE b.code = v_code AND b.sku_id <> p_sku_id;
  IF v_other IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'code ' || v_code || ' is already linked to ' || v_other);
  END IF;

  INSERT INTO public.sku_barcodes (sku_id, code, code_raw, symbology, source, is_primary, created_by)
  VALUES (p_sku_id, v_code, p_scan, v_sym, 'scan_link',
          NOT EXISTS (SELECT 1 FROM public.sku_barcodes WHERE sku_id = p_sku_id AND is_primary),
          v_actor)
  ON CONFLICT (code) DO NOTHING;

  UPDATE public.product_skus SET upc_code = v_code
   WHERE id = p_sku_id AND (upc_code IS NULL OR upc_code = '');

  RETURN jsonb_build_object('ok', true, 'code', v_code, 'symbology', v_sym);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.rpc_wh_link_barcode(uuid, text) TO authenticated;

-- -------------------------------------------------------------
-- G. rpc_wh_barcode_coverage() → {ok, with_code, active_total}
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_wh_barcode_coverage()
RETURNS jsonb AS $$
DECLARE
  v_role text;
BEGIN
  SELECT role INTO v_role FROM public.profiles WHERE id = auth.uid() AND is_active;
  IF (v_role IS NULL OR v_role = 'supplier') AND current_user <> 'postgres' THEN
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

GRANT EXECUTE ON FUNCTION public.rpc_wh_barcode_coverage() TO authenticated;

-- -------------------------------------------------------------
-- H. rpc_wh_baseline_kpis(from, to) – order-derived baseline
-- Per Eastern-time ship day (fn_ss_et, as the sale dashboards use):
--   orders shipped, lines shipped, median days from import to ship
--   (ShipStation's ship date carries no time of day, so hours are not measurable),
--   same-day share = orders imported before 14:00 ET that shipped the
--   same ET day / orders imported before 14:00 ET that day.
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_wh_baseline_kpis(p_from date, p_to date)
RETURNS jsonb AS $$
DECLARE
  v_role text;
  v_days jsonb;
  v_sum  jsonb;
BEGIN
  SELECT role INTO v_role FROM public.profiles WHERE id = auth.uid() AND is_active;
  IF (v_role IS NULL OR v_role = 'supplier') AND current_user <> 'postgres' THEN
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

GRANT EXECUTE ON FUNCTION public.rpc_wh_baseline_kpis(date, date) TO authenticated;
