-- =============================================================
-- Daily report — data RPC + 8am-ET cron fire helper
-- =============================================================
-- rpc_daily_report() returns everything the morning email needs as one
-- jsonb payload (recipients + three sections). The edge function
-- `daily-report` just formats + sends it via Resend.
--
--   Section 1 — Yesterday's sales by SKU, flagged vs the trailing-30d
--               daily average (above ≥2×, below ≤0.5×; only when the
--               30d average is a meaningful ≥1/day so lumpy tail SKUs
--               don't spam flags).
--   Section 2 — Freight shipments in 'tracking' status + their line items.
--   Section 3 — SKUs whose WAREHOUSE runway is ≤7 days at effective
--               demand (forecast when ≥60/mo, else trailing-30d
--               monthly_demand — mirrors getEffectiveDemand), with any
--               in-transit relief + nearest ETA.
--
-- "Yesterday"/"today" are computed in America/New_York so the day window
-- matches the 8am-ET send. SECURITY DEFINER so it can read auth.users for
-- recipient emails; execute is restricted to service_role (the edge fn).
-- =============================================================

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
         ROUND(sold.units * COALESCE(ps.retail_price, 0), 2) AS revenue,
         CASE
           WHEN COALESCE(avg30.avg_daily, 0) >= 1 AND sold.units >= 2 * avg30.avg_daily THEN 'above'
           WHEN COALESCE(avg30.avg_daily, 0) >= 1 AND sold.units <= 0.5 * avg30.avg_daily THEN 'below'
           ELSE NULL
         END AS flag
  FROM sold
  JOIN product_skus ps ON ps.id = sold.sku_id
  LEFT JOIN avg30 ON avg30.sku_id = sold.sku_id
  -- Bases & Coils product lines are excluded from the report per ops request.
  WHERE COALESCE(ps.display_category, '') NOT IN ('Bases', 'Coils')
),
incoming_rows AS (
  SELECT fs.shipment_number, fs.carrier_name, fs.freight_type, fs.eta,
         (fs.eta - (SELECT today FROM d)) AS days_out,
         COALESCE(
           jsonb_agg(jsonb_build_object('sku', COALESCE(ps.sku, fli.custom_description), 'qty', fli.quantity)
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
  -- Drop shipments whose only contents are excluded (Bases/Coils) items.
  HAVING count(*) FILTER (WHERE fli.id IS NOT NULL AND fli.quantity > 0
                          AND COALESCE(ps.display_category, '') NOT IN ('Bases', 'Coils')) > 0
),
eff AS (
  SELECT ps.id AS sku_id, ps.sku, ps.product_name,
         CASE WHEN COALESCE(f.forecast_30d, 0) >= 60 THEN f.forecast_30d
              ELSE COALESCE(ps.monthly_demand, 0) END AS monthly_demand
  FROM product_skus ps
  LEFT JOIN sku_forecasts f ON f.sku_id = ps.id
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
  -- Warehouse units/days floored at 0 for display: an oversold SKU (negative
  -- warehouse_finished from the ShipStation backfill) reads as "out now"
  -- rather than a confusing "-30 days". The <=7 filter still uses the real
  -- (possibly negative) runway so those genuinely-out SKUs stay included.
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
     'revenue', COALESCE(SUM(revenue), 0),
     'sku_count', COUNT(*)) FROM sales_rows),
  'incoming', COALESCE((SELECT jsonb_agg(to_jsonb(ir) ORDER BY ir.eta NULLS LAST) FROM incoming_rows ir), '[]'::jsonb),
  'low_stock', COALESCE((SELECT jsonb_agg(to_jsonb(lr) ORDER BY lr.dos_days ASC) FROM low_rows lr), '[]'::jsonb)
);
$$;

REVOKE ALL ON FUNCTION public.rpc_daily_report() FROM public;
GRANT EXECUTE ON FUNCTION public.rpc_daily_report() TO service_role;

-- Cron fires this at 12:00 AND 13:00 UTC; it only proceeds when the local
-- New York hour is 8, so exactly one send lands at 8am ET year-round
-- (12:00 UTC in EDT, 13:00 UTC in EST). The edge function itself has no
-- time guard, so manual test invocations still work.
CREATE OR REPLACE FUNCTION public.fire_daily_report()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF extract(hour FROM (now() AT TIME ZONE 'America/New_York'))::int <> 8 THEN
    RETURN;
  END IF;
  PERFORM net.http_post(
    url := 'https://pnqujtugddxusllkikje.supabase.co/functions/v1/daily-report',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_jwt')
    ),
    body := '{}'::jsonb
  );
END;
$$;

REVOKE ALL ON FUNCTION public.fire_daily_report() FROM public;
