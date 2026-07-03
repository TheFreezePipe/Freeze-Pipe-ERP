-- =============================================================
-- Demand source picker: per-SKU mode on demand_overrides
-- =============================================================
-- Operators can now PIN which number drives a SKU's demand instead of
-- always trusting the auto chain:
--   (no row)    auto     — forecast when trusted (>=60/mo), else trailing-30d
--   'trailing'  pin the ShipStation trailing-30d baseline (suppresses forecast)
--   'forecast'  pin the engine forecast, even below the trust gate
--               (falls back to trailing if the SKU has no forecast row)
--   'manual'    pin an operator-entered number (previous behavior; all
--               existing rows default to this, so nothing changes for them)
-- monthly_demand is only meaningful for 'manual' and becomes nullable.

ALTER TABLE public.demand_overrides
  ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'manual';
ALTER TABLE public.demand_overrides
  DROP CONSTRAINT IF EXISTS demand_overrides_mode_check;
ALTER TABLE public.demand_overrides
  ADD CONSTRAINT demand_overrides_mode_check CHECK (mode IN ('manual', 'trailing', 'forecast'));
ALTER TABLE public.demand_overrides
  ALTER COLUMN monthly_demand DROP NOT NULL;
ALTER TABLE public.demand_overrides
  DROP CONSTRAINT IF EXISTS demand_overrides_manual_needs_value;
ALTER TABLE public.demand_overrides
  ADD CONSTRAINT demand_overrides_manual_needs_value CHECK (mode <> 'manual' OR monthly_demand IS NOT NULL);

COMMENT ON COLUMN public.demand_overrides.mode IS
  'Demand source pin: manual (use monthly_demand), trailing (pin ShipStation baseline), forecast (pin engine forecast even below trust gate). No row = auto.';

-- rpc_daily_report: eff CTE mirrors the client resolution incl. modes.
CREATE OR REPLACE FUNCTION public.rpc_daily_report()
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, auth
AS $$
WITH d AS (
  SELECT (now() AT TIME ZONE 'America/New_York')::date AS today,
         ((now() AT TIME ZONE 'America/New_York')::date - 1) AS yday
),
sold AS (
  SELECT sd.sku_id, SUM(sd.units)::int AS units
  FROM sales_daily sd, d
  WHERE sd.sale_date = d.yday
  GROUP BY sd.sku_id
),
avg30 AS (
  SELECT sd.sku_id, SUM(sd.units)::numeric / 30 AS avg_daily
  FROM sales_daily sd, d
  WHERE sd.sale_date >= d.yday - 30 AND sd.sale_date < d.yday
  GROUP BY sd.sku_id
),
sales_rows AS (
  SELECT ps.sku, ps.product_name, sold.units,
         ROUND(COALESCE(avg30.avg_daily, 0), 1) AS avg_daily,
         CASE
           WHEN COALESCE(avg30.avg_daily, 0) >= 1 AND sold.units >= 2 * avg30.avg_daily THEN 'above'
           WHEN COALESCE(avg30.avg_daily, 0) >= 1 AND sold.units <= 0.5 * avg30.avg_daily THEN 'below'
           ELSE NULL
         END AS flag
  FROM sold
  JOIN product_skus ps ON ps.id = sold.sku_id
  LEFT JOIN avg30 ON avg30.sku_id = sold.sku_id
  WHERE COALESCE(ps.display_category, '') NOT IN ('Bases', 'Coils')
),
incoming_rows AS (
  SELECT fs.shipment_number, fs.carrier_name, fs.freight_type, fs.eta,
         (fs.eta - (SELECT today FROM d)) AS days_out,
         COALESCE(
           jsonb_agg(jsonb_build_object('sku', COALESCE(ps.sku, fli.custom_description), 'name', ps.product_name, 'qty', fli.quantity)
                     ORDER BY ps.sku)
           FILTER (WHERE fli.id IS NOT NULL AND fli.quantity > 0
                   AND COALESCE(ps.display_category, '') NOT IN ('Bases', 'Coils')),
           '[]'::jsonb
         ) AS items
  FROM freight_shipments fs
  LEFT JOIN freight_line_items fli ON fli.freight_shipment_id = fs.id
  LEFT JOIN product_skus ps ON ps.id = fli.sku_id
  WHERE fs.status = 'tracking'
  GROUP BY fs.id, fs.shipment_number, fs.carrier_name, fs.freight_type, fs.eta
  HAVING count(*) FILTER (WHERE fli.id IS NOT NULL AND fli.quantity > 0
                          AND COALESCE(ps.display_category, '') NOT IN ('Bases', 'Coils')) > 0
),
eff AS (
  -- Effective demand, mirroring the client: pinned source wins; no row =
  -- auto (forecast >= 60/mo trust gate, else trailing baseline).
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
  WHERE ps.is_active
    AND COALESCE(ps.display_category, '') NOT IN ('Bases', 'Coils')
),
wh AS (
  SELECT il.sku_id,
    (COALESCE(il.warehouse_raw, 0) + COALESCE(il.warehouse_prefilled_raw, 0)
     + COALESCE(il.warehouse_in_production, 0) + COALESCE(il.warehouse_finished, 0)
     + COALESCE(il.warehouse_other, 0)) AS wh_units
  FROM inventory_levels il
),
transit AS (
  SELECT fli.sku_id, SUM(fli.quantity)::int AS units, MIN(fs.eta) AS next_eta
  FROM freight_line_items fli
  JOIN freight_shipments fs ON fs.id = fli.freight_shipment_id
  WHERE fs.status IN ('pending', 'on_the_water', 'high_risk', 'cleared_customs', 'tracking')
    AND fli.sku_id IS NOT NULL
  GROUP BY fli.sku_id
),
low_rows AS (
  SELECT eff.sku, eff.product_name,
         GREATEST(COALESCE(wh.wh_units, 0), 0) AS wh_units,
         eff.monthly_demand,
         ROUND(GREATEST(COALESCE(wh.wh_units, 0), 0) / (eff.monthly_demand / 30.0), 1) AS dos_days,
         COALESCE(transit.units, 0) AS in_transit, transit.next_eta
  FROM eff
  JOIN wh ON wh.sku_id = eff.sku_id
  LEFT JOIN transit ON transit.sku_id = eff.sku_id
  WHERE eff.monthly_demand > 0
    AND (COALESCE(wh.wh_units, 0) / (eff.monthly_demand / 30.0)) <= 7
)
SELECT jsonb_build_object(
  'report_date', (SELECT yday FROM d),
  'generated_at', now(),
  'recipients', COALESCE(
    (SELECT jsonb_agg(u.email ORDER BY u.email)
     FROM profiles p JOIN auth.users u ON u.id = p.id
     WHERE p.role = 'admin' AND p.is_active AND u.email IS NOT NULL),
    '[]'::jsonb),
  'sales', COALESCE((SELECT jsonb_agg(to_jsonb(sr) ORDER BY sr.units DESC) FROM sales_rows sr), '[]'::jsonb),
  'sales_totals', (SELECT jsonb_build_object(
     'units', COALESCE(SUM(units), 0),
     'sku_count', COUNT(*)) FROM sales_rows),
  'incoming', COALESCE((SELECT jsonb_agg(to_jsonb(ir) ORDER BY ir.eta NULLS LAST) FROM incoming_rows ir), '[]'::jsonb),
  'low_stock', COALESCE((SELECT jsonb_agg(to_jsonb(lr) ORDER BY lr.dos_days ASC) FROM low_rows lr), '[]'::jsonb)
);
$$;

REVOKE ALL ON FUNCTION public.rpc_daily_report() FROM public;
GRANT EXECUTE ON FUNCTION public.rpc_daily_report() TO service_role;
