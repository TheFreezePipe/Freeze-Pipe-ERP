-- ============================================================================
-- Partial receiving: fix the SQL twins of the in-transit math
-- ============================================================================
-- Rule (mirrors src/lib/inventory-aggregates.ts): in-transit per line =
-- GREATEST(quantity - quantity_received, 0), for EVERY shipment regardless
-- of status. Fully received/closed shipments contribute 0 automatically.
--
-- rpc_inventory_retail_value_history needs NO change: future days read the
-- nightly snapshot (fixed below); its ledger/interval reconstruction only
-- fills pre-snapshot history, where the backfill set received == quantity.
-- (Today's provisional point may overstate transit slightly until tonight's
-- snapshot lands — bounded to same-day, self-correcting.)

-- ---- 1. rpc_daily_report v6 -------------------------------------------------
-- Changes vs 20260703000004: transit CTE remaining-based + statusless;
-- incoming items show remaining units; NEW receiving_outstanding key
-- (partially received >= 7 days, per the owner's threshold).
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
         SUM(fli.quantity)::int AS units_total
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

-- ---- 2. Nightly retail snapshot: transit = remaining ------------------------
CREATE OR REPLACE FUNCTION public.rpc_snapshot_inventory_retail_value()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_day       date := (now() AT TIME ZONE 'America/New_York')::date;
  v_warehouse numeric(14,2);
  v_transit   numeric(14,2);
  v_onorder   numeric(14,2);
BEGIN
  SELECT COALESCE(SUM(
           ( COALESCE(il.warehouse_raw,0)
           + COALESCE(il.warehouse_prefilled_raw,0)
           + COALESCE(il.warehouse_in_production,0)
           + COALESCE(il.warehouse_finished,0)
           + COALESCE(il.warehouse_other,0) ) * COALESCE(ps.retail_price,0)
         ), 0)
    INTO v_warehouse
    FROM public.inventory_levels il
    JOIN public.product_skus ps ON ps.id = il.sku_id;

  -- In transit: REMAINING units only (quantity - quantity_received),
  -- statusless — received units are already in the warehouse leg above.
  SELECT COALESCE(SUM(GREATEST(fl.quantity - fl.quantity_received, 0) * COALESCE(ps.retail_price,0)), 0)
    INTO v_transit
    FROM public.freight_line_items fl
    JOIN public.product_skus ps ON ps.id = fl.sku_id
   WHERE fl.sku_id IS NOT NULL;

  WITH foiship AS (
    SELECT source_factory_order_item_id AS foi_id, SUM(quantity) AS q
      FROM public.freight_line_items
     WHERE source_factory_order_item_id IS NOT NULL
     GROUP BY source_factory_order_item_id
  )
  SELECT COALESCE(SUM(
           GREATEST(
             COALESCE(foi.quantity_ordered,0)
             - COALESCE(foi.quantity_breakage,0)
             - COALESCE(foi.quantity_shipped_manual,0)
             - COALESCE(foi.quantity_consumed_by_parent,0)
             - COALESCE(fsh.q,0)
           , 0) * COALESCE(ps.retail_price,0)
         ), 0)
    INTO v_onorder
    FROM public.factory_order_items foi
    JOIN public.factory_orders o ON o.id = foi.factory_order_id
    JOIN public.product_skus ps ON ps.id = foi.sku_id
    LEFT JOIN foiship fsh ON fsh.foi_id = foi.id
   WHERE o.status IN ('ordered','in_production','finished');

  INSERT INTO public.inventory_retail_value_daily
    (snapshot_date, warehouse_retail, transit_retail, onorder_retail, source, updated_at)
  VALUES (v_day, v_warehouse, v_transit, v_onorder, 'snapshot', now())
  ON CONFLICT (snapshot_date) DO UPDATE
    SET warehouse_retail = EXCLUDED.warehouse_retail,
        transit_retail   = EXCLUDED.transit_retail,
        onorder_retail   = EXCLUDED.onorder_retail,
        source           = 'snapshot',
        updated_at       = now();
END;
$function$;

-- ---- 3. Clear estimate: incoming = remaining --------------------------------
CREATE OR REPLACE FUNCTION public.rpc_manufacturing_clear_estimate(p_days integer DEFAULT 30)
RETURNS TABLE(unfilled_now integer, prefilled_now integer, incoming_raw integer,
              incoming_prefilled integer, rtsing_per_day numeric, prefilled_rtsing_per_day numeric)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH params AS (
    SELECT LEAST(GREATEST(COALESCE(p_days, 30), 1), 365) AS n
  ),
  fillable AS (
    SELECT id FROM product_skus WHERE category = 'fillable'
  ),
  inv AS (
    SELECT
      COALESCE(SUM(il.warehouse_raw + il.warehouse_in_production), 0) AS unfilled_now,
      COALESCE(SUM(il.warehouse_prefilled_raw), 0)                    AS prefilled_now
    FROM inventory_levels il
    JOIN fillable f ON f.id = il.sku_id
  ),
  freight AS (
    -- Remaining units only; the prefilled share of the remainder follows the
    -- line's declared ratio (same proportional rule the receipt RPC credits by).
    SELECT
      COALESCE(SUM(rem.total - rem.pref), 0) AS incoming_raw,
      COALESCE(SUM(rem.pref), 0)             AS incoming_prefilled
    FROM (
      SELECT
        GREATEST(fli.quantity - fli.quantity_received, 0) AS total,
        LEAST(
          GREATEST(fli.quantity - fli.quantity_received, 0),
          round(LEAST(GREATEST(COALESCE(fli.quantity_prefilled, 0), 0), fli.quantity)::numeric
                * GREATEST(fli.quantity - fli.quantity_received, 0)
                / GREATEST(fli.quantity, 1))::int
        ) AS pref
      FROM freight_line_items fli
      JOIN fillable f ON f.id = fli.sku_id
      WHERE fli.quantity > fli.quantity_received
    ) rem
  ),
  thru AS (
    SELECT
      COALESCE(SUM(tl.quantity_processed) FILTER (WHERE tl.task_type = 'rtsing'), 0)::numeric          AS rtsing_units,
      COALESCE(SUM(tl.quantity_processed) FILTER (WHERE tl.task_type = 'prefilled_rtsing'), 0)::numeric AS prefilled_rtsing_units
    FROM task_logs tl
    JOIN fillable f ON f.id = tl.sku_id
    WHERE COALESCE(tl.time_completed, tl.created_at) >= now() - make_interval(days => (SELECT n FROM params))
  )
  SELECT
    inv.unfilled_now::int,
    inv.prefilled_now::int,
    freight.incoming_raw::int,
    freight.incoming_prefilled::int,
    ROUND(thru.rtsing_units / (SELECT n FROM params), 2)          AS rtsing_per_day,
    ROUND(thru.prefilled_rtsing_units / (SELECT n FROM params), 2) AS prefilled_rtsing_per_day
  FROM inv, freight, thru;
$function$;

REVOKE ALL ON FUNCTION public.rpc_manufacturing_clear_estimate(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_manufacturing_clear_estimate(integer) TO authenticated;
