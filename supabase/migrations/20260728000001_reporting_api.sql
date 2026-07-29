-- ============================================================================
-- Reporting API (read-only) — key storage + data sections
-- ============================================================================
-- Serves the CEO's external dashboard app via the reporting-api edge
-- function. Design (owner-approved 2026-07-28):
--   * api_keys stores only a SHA-256 HASH of each key; plaintext is
--     returned exactly once by rpc_rotate_reporting_key (admin-gated) and
--     never persisted. Rotation revokes all prior active keys.
--   * rpc_reporting(section, days) does all the math in SQL, reusing the
--     exact formulas the app itself displays (remaining-based transit,
--     allocation-aware on-order, effective demand with overrides) so the
--     external dashboard can never disagree with the ERP.
--   * v1 exposes operational counts + aggregate valuations only — no
--     per-SKU costs, margins, or supplier pricing (key may live in a
--     client-side dashboard).

-- ---- 1. Key storage ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL DEFAULT 'reporting',
  key_hash text NOT NULL UNIQUE,
  key_hint text NOT NULL,               -- "fpk_…a1b2" — display only
  created_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  last_used_at timestamptz
);
ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS api_keys_admin_read ON public.api_keys;
CREATE POLICY api_keys_admin_read ON public.api_keys FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_active AND role = 'admin'));
-- writes only via SECURITY DEFINER RPCs / service role.

-- ---- 2. Rotate / revoke -----------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_rotate_reporting_key(p_actor_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_role text;
  v_key text;
  v_hash text;
  v_new_id uuid;
BEGIN
  SELECT role INTO v_role FROM profiles WHERE id = p_actor_id AND is_active;
  IF v_role IS DISTINCT FROM 'admin' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'admin_required');
  END IF;

  v_key := 'fpk_' || encode(extensions.gen_random_bytes(24), 'hex');
  v_hash := encode(extensions.digest(v_key, 'sha256'), 'hex');

  UPDATE api_keys SET revoked_at = now() WHERE name = 'reporting' AND revoked_at IS NULL;
  INSERT INTO api_keys (name, key_hash, key_hint, created_by)
  VALUES ('reporting', v_hash, 'fpk_…' || right(v_key, 4), p_actor_id)
  RETURNING id INTO v_new_id;

  INSERT INTO audit_logs (actor_id, action, target_table, target_id, details)
  VALUES (p_actor_id, 'api_key.rotated', 'api_keys', v_new_id,
          jsonb_build_object('name', 'reporting'));

  -- Plaintext leaves the database exactly once, in this response.
  RETURN jsonb_build_object('ok', true, 'key', v_key);
END;
$$;
REVOKE ALL ON FUNCTION public.rpc_rotate_reporting_key(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.rpc_rotate_reporting_key(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.rpc_revoke_reporting_key(p_actor_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_n int;
BEGIN
  SELECT role INTO v_role FROM profiles WHERE id = p_actor_id AND is_active;
  IF v_role IS DISTINCT FROM 'admin' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'admin_required');
  END IF;
  UPDATE api_keys SET revoked_at = now() WHERE name = 'reporting' AND revoked_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN
    INSERT INTO audit_logs (actor_id, action, target_table, target_id, details)
    SELECT p_actor_id, 'api_key.revoked', 'api_keys', k.id,
           jsonb_build_object('name', 'reporting')
      FROM api_keys k
     WHERE k.name = 'reporting'
     ORDER BY k.revoked_at DESC NULLS LAST LIMIT 1;
  END IF;
  RETURN jsonb_build_object('ok', true, 'revoked', v_n);
END;
$$;
REVOKE ALL ON FUNCTION public.rpc_revoke_reporting_key(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.rpc_revoke_reporting_key(uuid) TO authenticated;

-- ---- 3. Data sections ---------------------------------------------------------
-- All math mirrors the ERP's own displays:
--   transit  = GREATEST(quantity - quantity_received, 0)   (statusless)
--   on-order = ordered - breakage - manual - GREATEST(consumed, planned) - shipped
--   demand   = override mode > forecast (>=60 gate) > trailing baseline
CREATE OR REPLACE FUNCTION public.rpc_reporting(p_section text, p_days int DEFAULT 90)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_days int := LEAST(GREATEST(COALESCE(p_days, 90), 1), 365);
  v_out jsonb;
BEGIN
  IF p_section = 'kpis' THEN
    WITH d AS (
      SELECT ((now() AT TIME ZONE 'America/New_York')::date - 1) AS yday
    ),
    planned AS (
      SELECT ci.id AS foi_id,
             LEAST(ci.quantity_ordered, COALESCE(SUM(b.units_per_parent * pi.quantity_ordered), 0))::int AS planned
        FROM factory_order_items ci
        JOIN factory_orders co ON co.id = ci.factory_order_id AND co.parent_factory_order_id IS NOT NULL
        JOIN factory_order_items pi ON pi.factory_order_id = co.parent_factory_order_id
        JOIN product_boms b ON b.parent_sku_id = pi.sku_id AND b.component_sku_id = ci.sku_id
       GROUP BY ci.id, ci.quantity_ordered
    ),
    foiship AS (
      SELECT source_factory_order_item_id AS foi_id, SUM(quantity) AS q
        FROM freight_line_items WHERE source_factory_order_item_id IS NOT NULL
       GROUP BY source_factory_order_item_id
    ),
    onord AS (
      SELECT COALESCE(SUM(GREATEST(
               COALESCE(foi.quantity_ordered,0) - COALESCE(foi.quantity_breakage,0)
               - COALESCE(foi.quantity_shipped_manual,0)
               - GREATEST(COALESCE(foi.quantity_consumed_by_parent,0), COALESCE(pl.planned,0))
               - COALESCE(fsh.q,0), 0)), 0)::int AS free_units
        FROM factory_order_items foi
        JOIN factory_orders o ON o.id = foi.factory_order_id
        LEFT JOIN foiship fsh ON fsh.foi_id = foi.id
        LEFT JOIN planned pl ON pl.foi_id = foi.id
       WHERE o.status IN ('ordered','in_production','finished')
    )
    SELECT jsonb_build_object(
      'as_of', now(),
      'yesterday_date', (SELECT yday FROM d),
      'yesterday_units_sold', COALESCE((SELECT SUM(units) FROM sales_daily, d WHERE sale_date = d.yday), 0),
      'warehouse_units', COALESCE((SELECT SUM(
          COALESCE(warehouse_raw,0)+COALESCE(warehouse_prefilled_raw,0)
          +COALESCE(warehouse_in_production,0)+COALESCE(warehouse_finished,0)
          +COALESCE(warehouse_other,0)) FROM inventory_levels), 0),
      'in_transit_units', COALESCE((SELECT SUM(GREATEST(quantity - quantity_received, 0))
          FROM freight_line_items WHERE sku_id IS NOT NULL), 0),
      'on_order_free_units', (SELECT free_units FROM onord),
      'retail_value', (SELECT jsonb_build_object(
          'warehouse', warehouse_retail, 'in_transit', transit_retail,
          'on_order', onorder_retail, 'snapshot_date', snapshot_date)
        FROM inventory_retail_value_daily ORDER BY snapshot_date DESC LIMIT 1),
      'low_stock_count', (SELECT COALESCE(jsonb_array_length(rpc_reporting('low_stock', 7)->'rows'), 0))
    ) INTO v_out;
    RETURN v_out;

  ELSIF p_section = 'sales_daily' THEN
    SELECT jsonb_build_object('as_of', now(), 'days', v_days, 'rows', COALESCE(jsonb_agg(r ORDER BY r->>'date', r->>'sku'), '[]'::jsonb))
      INTO v_out
      FROM (
        SELECT jsonb_build_object(
                 'date', sd.sale_date, 'sku', ps.sku, 'product_name', ps.product_name,
                 'category', ps.display_category, 'units', sd.units) AS r
          FROM sales_daily sd
          JOIN product_skus ps ON ps.id = sd.sku_id
         WHERE sd.sale_date >= (now() AT TIME ZONE 'America/New_York')::date - v_days
           AND sd.units <> 0
      ) t;
    RETURN v_out;

  ELSIF p_section = 'stock_levels' THEN
    WITH planned AS (
      SELECT ci.id AS foi_id,
             LEAST(ci.quantity_ordered, COALESCE(SUM(b.units_per_parent * pi.quantity_ordered), 0))::int AS planned
        FROM factory_order_items ci
        JOIN factory_orders co ON co.id = ci.factory_order_id AND co.parent_factory_order_id IS NOT NULL
        JOIN factory_order_items pi ON pi.factory_order_id = co.parent_factory_order_id
        JOIN product_boms b ON b.parent_sku_id = pi.sku_id AND b.component_sku_id = ci.sku_id
       GROUP BY ci.id, ci.quantity_ordered
    ),
    foiship AS (
      SELECT source_factory_order_item_id AS foi_id, SUM(quantity) AS q
        FROM freight_line_items WHERE source_factory_order_item_id IS NOT NULL
       GROUP BY source_factory_order_item_id
    ),
    onord AS (
      SELECT foi.sku_id,
             SUM(GREATEST(COALESCE(foi.quantity_ordered,0) - COALESCE(foi.quantity_breakage,0)
                 - COALESCE(foi.quantity_shipped_manual,0)
                 - GREATEST(COALESCE(foi.quantity_consumed_by_parent,0), COALESCE(pl.planned,0))
                 - COALESCE(fsh.q,0), 0))::int AS free_units,
             SUM(GREATEST(COALESCE(foi.quantity_consumed_by_parent,0), COALESCE(pl.planned,0)))::int AS allocated_units
        FROM factory_order_items foi
        JOIN factory_orders o ON o.id = foi.factory_order_id
        LEFT JOIN foiship fsh ON fsh.foi_id = foi.id
        LEFT JOIN planned pl ON pl.foi_id = foi.id
       WHERE o.status IN ('ordered','in_production','finished')
       GROUP BY foi.sku_id
    ),
    transit AS (
      SELECT sku_id, SUM(GREATEST(quantity - quantity_received, 0))::int AS units
        FROM freight_line_items WHERE sku_id IS NOT NULL GROUP BY sku_id
    ),
    eff AS (
      SELECT ps.id AS sku_id,
             COALESCE(
               CASE ov.mode
                 WHEN 'manual'   THEN ov.monthly_demand
                 WHEN 'trailing' THEN COALESCE(ps.monthly_demand, 0)
                 WHEN 'forecast' THEN COALESCE(f.forecast_30d, ps.monthly_demand, 0)
               END,
               CASE WHEN COALESCE(f.forecast_30d, 0) >= 60 THEN f.forecast_30d
                    ELSE COALESCE(ps.monthly_demand, 0) END
             ) AS monthly_demand
        FROM product_skus ps
        LEFT JOIN sku_forecasts f ON f.sku_id = ps.id
        LEFT JOIN demand_overrides ov ON ov.sku_id = ps.id
    )
    SELECT jsonb_build_object('as_of', now(), 'rows', COALESCE(jsonb_agg(r ORDER BY r->>'sku'), '[]'::jsonb))
      INTO v_out
      FROM (
        SELECT jsonb_build_object(
                 'sku', ps.sku, 'product_name', ps.product_name, 'category', ps.display_category,
                 'warehouse_units', (COALESCE(il.warehouse_raw,0)+COALESCE(il.warehouse_prefilled_raw,0)
                    +COALESCE(il.warehouse_in_production,0)+COALESCE(il.warehouse_finished,0)
                    +COALESCE(il.warehouse_other,0)),
                 'in_transit_units', COALESCE(t.units, 0),
                 'on_order_free_units', COALESCE(oo.free_units, 0),
                 'on_order_allocated_units', COALESCE(oo.allocated_units, 0),
                 'monthly_demand', COALESCE(e.monthly_demand, 0),
                 'dos_days', CASE WHEN COALESCE(e.monthly_demand,0) > 0
                   THEN ROUND((COALESCE(il.warehouse_raw,0)+COALESCE(il.warehouse_prefilled_raw,0)
                        +COALESCE(il.warehouse_in_production,0)+COALESCE(il.warehouse_finished,0)
                        +COALESCE(il.warehouse_other,0)) / (e.monthly_demand / 30.0), 1)
                   ELSE NULL END) AS r
          FROM product_skus ps
          LEFT JOIN inventory_levels il ON il.sku_id = ps.id
          LEFT JOIN transit t ON t.sku_id = ps.id
          LEFT JOIN onord oo ON oo.sku_id = ps.id
          LEFT JOIN eff e ON e.sku_id = ps.id
         WHERE ps.is_active
      ) x;
    RETURN v_out;

  ELSIF p_section = 'incoming' THEN
    SELECT jsonb_build_object('as_of', now(), 'rows', COALESCE(jsonb_agg(r ORDER BY (r->>'eta') NULLS LAST), '[]'::jsonb))
      INTO v_out
      FROM (
        SELECT jsonb_build_object(
                 'shipment_number', fs.shipment_number, 'freight_type', fs.freight_type,
                 'carrier', fs.carrier_name, 'status', fs.status, 'eta', fs.eta,
                 'ship_date', fs.ship_date,
                 'units_total', SUM(fli.quantity), 'units_received', SUM(fli.quantity_received),
                 'units_remaining', SUM(GREATEST(fli.quantity - fli.quantity_received, 0)),
                 'cartons_total', fs.total_cartons,
                 'cartons_received', (SELECT SUM(g.received_cartons)::int FROM freight_carton_groups g
                                       WHERE g.freight_shipment_id = fs.id)) AS r
          FROM freight_shipments fs
          JOIN freight_line_items fli ON fli.freight_shipment_id = fs.id AND fli.sku_id IS NOT NULL
         WHERE fs.receipt_confirmed_at IS NULL
         GROUP BY fs.id
        HAVING SUM(GREATEST(fli.quantity - fli.quantity_received, 0)) > 0
      ) t;
    RETURN v_out;

  ELSIF p_section = 'low_stock' THEN
    WITH eff AS (
      SELECT ps.id AS sku_id, ps.sku, ps.product_name,
             COALESCE(
               CASE ov.mode
                 WHEN 'manual'   THEN ov.monthly_demand
                 WHEN 'trailing' THEN COALESCE(ps.monthly_demand, 0)
                 WHEN 'forecast' THEN COALESCE(f.forecast_30d, ps.monthly_demand, 0)
               END,
               CASE WHEN COALESCE(f.forecast_30d, 0) >= 60 THEN f.forecast_30d
                    ELSE COALESCE(ps.monthly_demand, 0) END
             ) AS monthly_demand
        FROM product_skus ps
        LEFT JOIN sku_forecasts f ON f.sku_id = ps.id
        LEFT JOIN demand_overrides ov ON ov.sku_id = ps.id
       WHERE ps.is_active AND COALESCE(ps.display_category, '') NOT IN ('Bases', 'Coils')
    ),
    wh AS (
      SELECT sku_id, (COALESCE(warehouse_raw,0)+COALESCE(warehouse_prefilled_raw,0)
             +COALESCE(warehouse_in_production,0)+COALESCE(warehouse_finished,0)
             +COALESCE(warehouse_other,0)) AS wh_units
        FROM inventory_levels
    ),
    transit AS (
      SELECT fli.sku_id, SUM(GREATEST(fli.quantity - fli.quantity_received, 0))::int AS units,
             MIN(fs.eta) AS next_eta
        FROM freight_line_items fli
        JOIN freight_shipments fs ON fs.id = fli.freight_shipment_id
       WHERE fli.sku_id IS NOT NULL AND fli.quantity > fli.quantity_received
       GROUP BY fli.sku_id
    )
    SELECT jsonb_build_object('as_of', now(), 'threshold_days', v_days,
                              'rows', COALESCE(jsonb_agg(r ORDER BY (r->>'dos_days')::numeric), '[]'::jsonb))
      INTO v_out
      FROM (
        SELECT jsonb_build_object(
                 'sku', eff.sku, 'product_name', eff.product_name,
                 'warehouse_units', GREATEST(COALESCE(wh.wh_units,0),0),
                 'dos_days', ROUND(GREATEST(COALESCE(wh.wh_units,0),0) / (eff.monthly_demand / 30.0), 1),
                 'in_transit_units', COALESCE(transit.units, 0),
                 'next_eta', transit.next_eta) AS r
          FROM eff
          JOIN wh ON wh.sku_id = eff.sku_id
          LEFT JOIN transit ON transit.sku_id = eff.sku_id
         WHERE eff.monthly_demand > 0
           AND (COALESCE(wh.wh_units,0) / (eff.monthly_demand / 30.0)) <= v_days
      ) t;
    RETURN v_out;

  ELSE
    RETURN jsonb_build_object('ok', false, 'error', 'unknown_section',
                              'sections', jsonb_build_array('kpis','sales_daily','stock_levels','incoming','low_stock'));
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.rpc_reporting(text, int) FROM public;
GRANT EXECUTE ON FUNCTION public.rpc_reporting(text, int) TO service_role;
