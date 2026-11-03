-- Measured outbound shipping cost per SKU ("as sold").
--
-- The typed-in sku_economics.shipping_cost stays as the ESTIMATE. The
-- weekly shipping-measure edge function solves item weights and box tares
-- from the team's scale-measured order totals (shipstation_shipments),
-- allocates each free-tier order's real label cost across its lines by
-- weight, and writes one row per SKU here. v_sku_shipping_cost picks the
-- measured figure when confidence is high, else the estimate; the daily
-- report's COGS line and the app's D2C model read through that choice.

CREATE TABLE public.shipping_box_tare (
  box          text PRIMARY KEY,            -- "LxWxH" inches as ShipStation reports it
  tare_oz      numeric(8,2) NOT NULL,       -- box + void fill + packing, solved
  tare_oz_prev numeric(8,2),
  orders       integer NOT NULL,
  computed_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.sku_shipping_measured (
  sku_id            uuid PRIMARY KEY REFERENCES public.product_skus(id) ON DELETE CASCADE,
  window_days       integer NOT NULL,          -- 90, or 180 for slow SKUs
  orders            integer NOT NULL,          -- free-tier orders containing the SKU in the window
  solo_orders       integer NOT NULL,          -- single-item orders of the SKU
  item_oz           numeric(8,2),              -- solved item weight, box excluded
  item_oz_prev      numeric(8,2),
  as_sold_cost      numeric(8,2),              -- label $ allocated by weight, per unit
  as_sold_cost_prev numeric(8,2),
  solo_median_cost  numeric(8,2),              -- median label $ when shipped alone
  confidence        text NOT NULL CHECK (confidence IN ('high', 'low', 'none')),
  flags             text[] NOT NULL DEFAULT '{}',   -- drift_cost, drift_weight, joint, low_confidence, stale
  joint_with        text,                     -- SKU it always ships with (weights solved jointly)
  computed_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.shipping_measure_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,
  window_from      date,
  window_to        date,
  orders_used      integer,
  orders_kept      integer,
  skus_written     integer,
  r2               numeric(6,4),
  median_resid_oz  numeric(6,2),
  -- orders whose measured total misses the fitted weight by > 1 lb:
  -- [{order_number, ship_date, box, measured_oz, fitted_oz, skus}]
  exceptions       jsonb NOT NULL DEFAULT '[]'::jsonb,
  summary          jsonb,
  error            text
);
CREATE INDEX shipping_measure_runs_started_idx ON public.shipping_measure_runs (started_at DESC);

ALTER TABLE public.shipping_box_tare ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sku_shipping_measured ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shipping_measure_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated can read box tares" ON public.shipping_box_tare FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated can read measured shipping" ON public.sku_shipping_measured FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated can read shipping measure runs" ON public.shipping_measure_runs FOR SELECT TO authenticated USING (true);

-- The number of record: measured when confident, else the estimate.
CREATE VIEW public.v_sku_shipping_cost WITH (security_invoker = true) AS
SELECT ps.id AS sku_id,
       CASE WHEN m.confidence = 'high' THEN m.as_sold_cost ELSE e.shipping_cost END AS cost,
       CASE WHEN m.confidence = 'high' THEN 'measured' ELSE 'estimate' END AS source,
       m.as_sold_cost  AS measured_cost,
       e.shipping_cost AS estimate_cost,
       m.confidence
FROM public.product_skus ps
LEFT JOIN public.sku_economics e ON e.sku_id = ps.id
LEFT JOIN public.sku_shipping_measured m ON m.sku_id = ps.id;

-- Input for the weekly solve: one JSON array of order lines (free-tier,
-- main store, one label per order, label cost > 0). Service role only.
CREATE OR REPLACE FUNCTION public.rpc_shipping_measure_input(
  p_from date, p_to date,
  p_service text DEFAULT 'Free Standard Shipping (5-8 Days)')
RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'order_id', so.shipstation_order_id, 'order_number', so.order_number,
           'ship_date', sh.ship_date, 'weight_oz', sh.weight_oz, 'box', sh.box, 'cost', sh.cost,
           'sku_id', i.sku_id, 'sku', ps.sku, 'cat', ps.display_category, 'qty', i.quantity)), '[]'::jsonb)
  FROM shipstation_orders so
  JOIN (SELECT order_id, MAX(ship_date) ship_date, MAX(weight_oz) weight_oz, SUM(shipment_cost) cost,
               MAX(COALESCE(length_in::text, '?') || 'x' || COALESCE(width_in::text, '?') || 'x' || COALESCE(height_in::text, '?')) box
        FROM shipstation_shipments WHERE NOT voided
        GROUP BY order_id HAVING COUNT(*) = 1 AND SUM(shipment_cost) > 0 AND MAX(weight_oz) > 0) sh
    ON sh.order_id = so.shipstation_order_id
  JOIN shipstation_order_items i ON i.shipstation_order_id = so.id AND i.sku_id IS NOT NULL
  JOIN product_skus ps ON ps.id = i.sku_id
  WHERE so.order_status = 'shipped'
    AND so.store_id = 229438                      -- main Shopify store
    AND sh.ship_date >= p_from AND sh.ship_date < p_to
    AND so.raw_payload->>'requestedShippingService' = p_service;
$$;
REVOKE EXECUTE ON FUNCTION public.rpc_shipping_measure_input(date, date, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_shipping_measure_input(date, date, text) TO service_role;

-- Apply one run atomically: shift current -> prev, add drift flags, mark
-- SKUs that dropped out of the window as stale, record the run.
CREATE OR REPLACE FUNCTION public.rpc_shipping_measure_apply(p_result jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_tares int; v_skus int; v_run uuid;
BEGIN
  INSERT INTO shipping_box_tare (box, tare_oz, tare_oz_prev, orders, computed_at)
  SELECT t->>'box', (t->>'tare_oz')::numeric, old.tare_oz, (t->>'orders')::int, now()
  FROM jsonb_array_elements(p_result->'tares') t
  LEFT JOIN shipping_box_tare old ON old.box = t->>'box'
  ON CONFLICT (box) DO UPDATE
    SET tare_oz_prev = EXCLUDED.tare_oz_prev, tare_oz = EXCLUDED.tare_oz,
        orders = EXCLUDED.orders, computed_at = now();
  GET DIAGNOSTICS v_tares = ROW_COUNT;

  INSERT INTO sku_shipping_measured
    (sku_id, window_days, orders, solo_orders, item_oz, item_oz_prev, as_sold_cost, as_sold_cost_prev,
     solo_median_cost, confidence, flags, joint_with, computed_at)
  SELECT (s->>'sku_id')::uuid, (s->>'window_days')::int, (s->>'orders')::int, (s->>'solo_orders')::int,
         (s->>'item_oz')::numeric, old.item_oz,
         (s->>'as_sold_cost')::numeric, old.as_sold_cost,
         (s->>'solo_median_cost')::numeric, s->>'confidence',
         ARRAY(SELECT jsonb_array_elements_text(COALESCE(s->'flags', '[]'::jsonb)))
           || CASE WHEN old.as_sold_cost > 0 AND (s->>'as_sold_cost') IS NOT NULL
                    AND abs((s->>'as_sold_cost')::numeric - old.as_sold_cost) / old.as_sold_cost > 0.10
                   THEN ARRAY['drift_cost'] ELSE '{}'::text[] END
           || CASE WHEN old.item_oz > 0 AND (s->>'item_oz') IS NOT NULL
                    AND abs((s->>'item_oz')::numeric - old.item_oz) / old.item_oz > 0.10
                   THEN ARRAY['drift_weight'] ELSE '{}'::text[] END,
         s->>'joint_with', now()
  FROM jsonb_array_elements(p_result->'skus') s
  LEFT JOIN sku_shipping_measured old ON old.sku_id = (s->>'sku_id')::uuid
  ON CONFLICT (sku_id) DO UPDATE
    SET window_days = EXCLUDED.window_days, orders = EXCLUDED.orders, solo_orders = EXCLUDED.solo_orders,
        item_oz_prev = EXCLUDED.item_oz_prev, item_oz = EXCLUDED.item_oz,
        as_sold_cost_prev = EXCLUDED.as_sold_cost_prev, as_sold_cost = EXCLUDED.as_sold_cost,
        solo_median_cost = EXCLUDED.solo_median_cost, confidence = EXCLUDED.confidence,
        flags = EXCLUDED.flags, joint_with = EXCLUDED.joint_with, computed_at = now();
  GET DIAGNOSTICS v_skus = ROW_COUNT;

  -- SKUs that no longer appear in the window keep their last numbers but stop being used.
  UPDATE sku_shipping_measured m
     SET confidence = 'none', flags = array_append(array_remove(m.flags, 'stale'), 'stale')
   WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_result->'skus') s WHERE (s->>'sku_id')::uuid = m.sku_id)
     AND m.confidence <> 'none';

  INSERT INTO shipping_measure_runs
    (started_at, completed_at, window_from, window_to, orders_used, orders_kept, skus_written, r2, median_resid_oz, exceptions, summary)
  VALUES ((p_result->'run'->>'started_at')::timestamptz, now(),
          (p_result->'run'->>'window_from')::date, (p_result->'run'->>'window_to')::date,
          (p_result->'run'->>'orders_used')::int, (p_result->'run'->>'orders_kept')::int, v_skus,
          (p_result->'run'->>'r2')::numeric, (p_result->'run'->>'median_resid_oz')::numeric,
          COALESCE(p_result->'exceptions', '[]'::jsonb), p_result->'run')
  RETURNING id INTO v_run;

  RETURN jsonb_build_object('run_id', v_run, 'tares', v_tares, 'skus', v_skus);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.rpc_shipping_measure_apply(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_shipping_measure_apply(jsonb) TO service_role;

-- Schedules: shipments sync nightly (trailing 3 days), measure weekly (Mondays).
CREATE OR REPLACE FUNCTION public.fire_shipping_shipments_sync()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
BEGIN
  PERFORM net.http_post(
    url := 'https://pnqujtugddxusllkikje.supabase.co/functions/v1/shipstation-shipments-sync',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_jwt')),
    body := '{"days": 3}'::jsonb);
END;
$$;
CREATE OR REPLACE FUNCTION public.fire_shipping_measure()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
BEGIN
  PERFORM net.http_post(
    url := 'https://pnqujtugddxusllkikje.supabase.co/functions/v1/shipping-measure',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_jwt')),
    body := '{}'::jsonb);
END;
$$;
SELECT cron.schedule('shipstation-shipments-nightly', '20 6 * * *', $$SELECT public.fire_shipping_shipments_sync()$$);
SELECT cron.schedule('shipping-measure-weekly', '40 6 * * 1', $$SELECT public.fire_shipping_measure()$$);

-- Daily report COGS: shipping through the measured/estimate choice.
CREATE OR REPLACE FUNCTION public.rpc_daily_report()
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
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
prim AS (
  -- Primary supplier unit cost per SKU (same pick as the SKU Economics list).
  SELECT DISTINCT ON (sku_id) sku_id, unit_cost
  FROM sku_supplier_costs
  ORDER BY sku_id, is_primary DESC, updated_at DESC
),
cogs AS (
  -- Yesterday's full D2C cost: the SKU Economics list model (computeListD2C),
  -- shipping = measured as-sold cost when confident, else the estimate.
  -- applied to every unit sold, bases and coils included. SKUs with no
  -- economics row or no supplier cost contribute $0 and are counted.
  SELECT SUM(s.units)::int AS units,
         ROUND(SUM(s.units * (
             COALESCE(p.unit_cost, 0) + COALESCE(e.additional_raw_cost, 0)
           + COALESCE(e.pct_sea, 0) / 100 * COALESCE(e.sea_freight_cost_per_unit, 0)
           + COALESCE(e.pct_air, 0) / 100 * COALESCE(e.air_freight_cost_per_unit, 0)
           + COALESCE(e.breakage_issue_cost, 0)
           + CASE WHEN ps.category = 'non_fillable' THEN 0
                  ELSE (1 - pf.frac) * (COALESCE(e.labor_cost_us, 0) + COALESCE(e.glycerin_cost_us, 0))
                       + pf.frac * COALESCE(e.manufacturing_cost_cn, 0) END
           + COALESCE(e.packing_material_cost, 0) + COALESCE(e.packing_labor_cost, 0)
           + COALESCE(CASE WHEN m.confidence = 'high' THEN m.as_sold_cost END, e.shipping_cost, 0)
           + CASE WHEN COALESCE(e.credit_card_fees, 0) > 0 THEN e.credit_card_fees
                  ELSE COALESCE(ps.retail_price, 0) * 0.03 END
         )), 2) AS d2c,
         COUNT(*) FILTER (WHERE e.id IS NULL OR p.sku_id IS NULL)::int AS uncosted_skus,
         COALESCE(SUM(s.units) FILTER (WHERE e.id IS NULL OR p.sku_id IS NULL), 0)::int AS uncosted_units
  FROM sold s
  JOIN product_skus ps ON ps.id = s.sku_id
  LEFT JOIN sku_economics e ON e.sku_id = s.sku_id
  LEFT JOIN prim p ON p.sku_id = s.sku_id
  LEFT JOIN sku_shipping_measured m ON m.sku_id = s.sku_id
  CROSS JOIN LATERAL (
    SELECT CASE WHEN e.mfg_override_active AND e.mfg_override_pct_prefilled IS NOT NULL
                THEN e.mfg_override_pct_prefilled / 100 ELSE 0 END AS frac
  ) pf
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
        'early_access', ms.early_access_starts_at::date,
        'approval', ms.approval_status,
        'sku_count', (SELECT count(DISTINCT e.sku_id) FROM mkt_offer_sku_expansion e WHERE e.sale_id = ms.id)
      ) ORDER BY ms.starts_at)
      FROM mkt_sales ms
      WHERE COALESCE(ms.early_access_starts_at, ms.starts_at)::date <= (SELECT today FROM d) + 14 AND ms.ends_at::date >= (SELECT today FROM d)), '[]'::jsonb),
    'launches', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'name', ml.name, 'kind', ml.kind, 'launch_date', ml.launch_date,
        'early_access', ml.early_access_date, 'approval', ml.approval_status,
        -- one definition of "product": member rows minus rows whose card is halted
        'sku_count', (SELECT count(*)
                        FROM mkt_launch_skus k
                        LEFT JOIN mkt_pd_projects c ON c.id = k.pd_project_id
                       WHERE k.launch_id = ml.id
                         AND (c.id IS NULL OR c.stage <> 'halted'))
      ) ORDER BY ml.launch_date)
      FROM mkt_launches ml
      WHERE ml.launch_date >= (SELECT today FROM d)
        AND COALESCE(ml.early_access_date, ml.launch_date) <= (SELECT today FROM d) + 14), '[]'::jsonb),
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
  'cogs', (SELECT jsonb_build_object(
     'units', COALESCE(units, 0), 'd2c', COALESCE(d2c, 0),
     'uncosted_skus', COALESCE(uncosted_skus, 0), 'uncosted_units', COALESCE(uncosted_units, 0)) FROM cogs),
  'low_stock', COALESCE((SELECT jsonb_agg(to_jsonb(lr) ORDER BY lr.dos_days ASC) FROM low_rows lr), '[]'::jsonb)
);
$function$;
