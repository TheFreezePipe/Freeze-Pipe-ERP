-- ============================================================================
-- Daily report v7: carrier piece counts on the outstanding-receiving rows
-- ============================================================================
-- receiving_outstanding rows gain carrier_delivered / carrier_total /
-- carrier_last_movement (nullable - populated only once the carrier
-- enumerates pieces on the ground leg). Function body otherwise identical
-- to 20260722000002.

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
           jsonb_agg(jsonb_build_object('sku', COALESCE(ps.sku, fli.custom_description), 'name', ps.product_name,
                     'qty', GREATEST(fli.quantity - fli.quantity_received, 0))
                     ORDER BY ps.sku)
           FILTER (WHERE fli.id IS NOT NULL AND GREATEST(fli.quantity - fli.quantity_received, 0) > 0
                   AND COALESCE(ps.display_category, '') NOT IN ('Bases', 'Coils')),
           '[]'::jsonb
         ) AS items
  FROM freight_shipments fs
  LEFT JOIN freight_line_items fli ON fli.freight_shipment_id = fs.id
  LEFT JOIN product_skus ps ON ps.id = fli.sku_id
  WHERE fs.status = 'tracking'
  GROUP BY fs.id, fs.shipment_number, fs.carrier_name, fs.freight_type, fs.eta
  HAVING count(*) FILTER (WHERE fli.id IS NOT NULL AND GREATEST(fli.quantity - fli.quantity_received, 0) > 0
                          AND COALESCE(ps.display_category, '') NOT IN ('Bases', 'Coils')) > 0
),
eff AS (
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
  -- Remaining units only, statusless: received units are already on-hand.
  SELECT fli.sku_id, SUM(GREATEST(fli.quantity - fli.quantity_received, 0))::int AS units,
         MIN(fs.eta) AS next_eta
  FROM freight_line_items fli
  JOIN freight_shipments fs ON fs.id = fli.freight_shipment_id
  WHERE fli.sku_id IS NOT NULL
    AND fli.quantity > fli.quantity_received
  GROUP BY fli.sku_id
),
recv_out AS (
  -- Shipments sitting partially received >= 7 days since first check-in.
  SELECT fs.shipment_number,
         ((SELECT today FROM d) - MIN((fr.received_at AT TIME ZONE 'America/New_York')::date))::int AS days_outstanding,
         (SELECT SUM(g.received_cartons)::int FROM freight_carton_groups g WHERE g.freight_shipment_id = fs.id) AS cartons_received,
         (SELECT SUM(g.carton_qty)::int FROM freight_carton_groups g WHERE g.freight_shipment_id = fs.id) AS cartons_total,
         SUM(fli.quantity_received)::int AS units_received,
         SUM(fli.quantity)::int AS units_total,
         fs.carrier_pieces_delivered AS carrier_delivered,
         fs.carrier_pieces_total AS carrier_total,
         fs.carrier_last_piece_event_at::date AS carrier_last_movement
  FROM freight_shipments fs
  JOIN freight_line_items fli ON fli.freight_shipment_id = fs.id AND fli.sku_id IS NOT NULL
  JOIN freight_receipts fr ON fr.freight_shipment_id = fs.id
  WHERE fs.receipt_confirmed_at IS NULL
  GROUP BY fs.id, fs.shipment_number
  HAVING SUM(fli.quantity_received) > 0
     AND ((SELECT today FROM d) - MIN((fr.received_at AT TIME ZONE 'America/New_York')::date)) >= 7
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
  'receiving_outstanding', COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.days_outstanding DESC) FROM recv_out r), '[]'::jsonb),
  'marketing', jsonb_build_object(
    'sales', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'name', ms.name, 'starts_at', ms.starts_at::date, 'ends_at', ms.ends_at::date,
        'approval', ms.approval_status,
        'sku_count', (SELECT count(DISTINCT e.sku_id) FROM mkt_offer_sku_expansion e WHERE e.sale_id = ms.id)
      ) ORDER BY ms.starts_at)
      FROM mkt_sales ms
      WHERE ms.starts_at::date <= (SELECT today FROM d) + 14 AND ms.ends_at::date >= (SELECT today FROM d)), '[]'::jsonb),
    'launches', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'name', ml.name, 'kind', ml.kind, 'launch_date', ml.launch_date, 'approval', ml.approval_status,
        'sku_count', (SELECT count(*) FROM mkt_launch_skus k WHERE k.launch_id = ml.id)
      ) ORDER BY ml.launch_date)
      FROM mkt_launches ml
      WHERE ml.launch_date BETWEEN (SELECT today FROM d) AND (SELECT today FROM d) + 14), '[]'::jsonb),
    'broadcasts', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'name', mb.name, 'channel', mb.channel, 'scheduled_at', mb.scheduled_at::date
      ) ORDER BY mb.scheduled_at)
      FROM mkt_broadcasts mb
      WHERE mb.scheduled_at::date BETWEEN (SELECT today FROM d) AND (SELECT today FROM d) + 14), '[]'::jsonb),
    'awaiting_confirmation', COALESCE((
      SELECT jsonb_agg(t.x ORDER BY t.x->>'date') FROM (
        SELECT jsonb_build_object('type', 'sale', 'name', ms.name, 'date', ms.starts_at::date) AS x
          FROM mkt_sales ms WHERE ms.approval_status = 'proposed' AND ms.ends_at::date >= (SELECT today FROM d)
        UNION ALL
        SELECT jsonb_build_object('type', 'launch', 'name', ml.name, 'date', ml.launch_date)
          FROM mkt_launches ml WHERE ml.approval_status = 'proposed' AND ml.launch_date >= (SELECT today FROM d)
      ) t), '[]'::jsonb)
  ),
  'low_stock', COALESCE((SELECT jsonb_agg(to_jsonb(lr) ORDER BY lr.dos_days ASC) FROM low_rows lr), '[]'::jsonb)
);
$$;

REVOKE ALL ON FUNCTION public.rpc_daily_report() FROM public;
GRANT EXECUTE ON FUNCTION public.rpc_daily_report() TO service_role;
