-- Sale baseline preview: clean days never extend into the future.
-- Before this, an upcoming sale whose pre-window had not happened yet
-- (Cyber Monday, Evergreen) previewed a baseline of zero orders a day.

CREATE OR REPLACE FUNCTION public.rpc_ensure_sale_baseline(p_sale_id uuid, p_force boolean DEFAULT false)
RETURNS public.mkt_sale_baseline
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sale   mkt_sales%ROWTYPE;
  v_row    mkt_sale_baseline%ROWTYPE;
  v_d1     date;
  v_has_ea boolean;
  v_win_to date;        -- exclusive
  v_from   date;
  v_stores bigint[];
  v_clean  date[];
  v_today  date := (now() AT TIME ZONE 'America/New_York')::date;
  v_opened boolean;
  v_dow_o  numeric[] := ARRAY[1,1,1,1,1,1,1];
  v_dow_u  numeric[] := ARRAY[1,1,1,1,1,1,1];
  v_hours  numeric[];
  v_mean_o numeric; v_mean_u numeric; v_new numeric; v_disc numeric;
  v_tmp_o numeric; v_tmp_u numeric;
  i int;
BEGIN
  SELECT * INTO v_sale FROM mkt_sales WHERE id = p_sale_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'sale % not found', p_sale_id; END IF;
  IF v_sale.starts_at IS NULL OR v_sale.ends_at IS NULL THEN RAISE EXCEPTION 'sale % has no dates', p_sale_id; END IF;

  SELECT * INTO v_row FROM mkt_sale_baseline WHERE sale_id = p_sale_id;
  IF FOUND AND v_row.frozen AND NOT p_force THEN RETURN v_row; END IF;

  v_has_ea := v_sale.early_access_starts_at IS NOT NULL;
  v_d1     := (COALESCE(v_sale.early_access_starts_at, v_sale.starts_at) AT TIME ZONE 'UTC')::date;
  v_opened := v_today >= v_d1;
  -- Exclusive end of the clean-day window: the day before the first selling
  -- day, and never later than yesterday (a preview for a sale weeks away
  -- must not count empty future days as clean days).
  v_win_to := LEAST(v_d1, v_today);
  v_stores := fn_sale_store_ids(p_sale_id);

  -- Most recent 28 clean days inside the last 56 when at least 10 exist,
  -- else extend the window to 91 days.
  v_from := v_d1 - 56;
  SELECT array_agg(d ORDER BY d) INTO v_clean FROM (
    SELECT g.d::date AS d
      FROM generate_series(v_from, v_win_to - 1, interval '1 day') g(d)
     WHERE g.d::date NOT IN (SELECT fn_sale_event_days(p_sale_id, v_from, v_win_to - 1))
     ORDER BY g.d DESC LIMIT 28) q;
  IF COALESCE(cardinality(v_clean), 0) < 10 THEN
    v_from := v_d1 - 91;
    SELECT array_agg(d ORDER BY d) INTO v_clean FROM (
      SELECT g.d::date AS d
        FROM generate_series(v_from, v_win_to - 1, interval '1 day') g(d)
       WHERE g.d::date NOT IN (SELECT fn_sale_event_days(p_sale_id, v_from, v_win_to - 1))
       ORDER BY g.d DESC LIMIT 28) q;
  END IF;
  v_clean := COALESCE(v_clean, ARRAY[]::date[]);

  -- Per clean day: orders, units, new, everyday discount.
  DROP TABLE IF EXISTS tmp_clean;
  CREATE TEMP TABLE tmp_clean (d date, dow int, orders int, units int, new_orders int, disc_cents bigint) ON COMMIT DROP;
  INSERT INTO tmp_clean
  SELECT cd.d, EXTRACT(DOW FROM cd.d)::int,
         COALESCE(o.orders, 0), COALESCE(u.units, 0), COALESCE(o.new_orders, 0), COALESCE(dc.cents, 0)
    FROM unnest(v_clean) cd(d)
    LEFT JOIN LATERAL (
      SELECT count(DISTINCT fn_ss_order_key(x.order_number)) AS orders,
             count(DISTINCT fn_ss_order_key(x.order_number)) FILTER (WHERE x.is_new) AS new_orders
        FROM (SELECT so.order_number,
                     NOT EXISTS (SELECT 1 FROM shipstation_orders e
                                  WHERE lower(e.customer_email) = lower(so.customer_email)
                                    AND e.customer_email IS NOT NULL
                                    AND e.order_date < so.order_date) AS is_new
                FROM shipstation_orders so
               WHERE so.store_id = ANY (v_stores)
                 AND so.order_status IN ('shipped', 'awaiting_shipment')
                 AND fn_ss_et(so.order_date)::date = cd.d) x) o ON true
    LEFT JOIN LATERAL (
      SELECT COALESCE(sum(it.quantity), 0)::int AS units
        FROM shipstation_orders so JOIN shipstation_order_items it ON it.shipstation_order_id = so.id
       WHERE so.store_id = ANY (v_stores)
         AND so.order_status IN ('shipped', 'awaiting_shipment')
         AND it.sku_id IS NOT NULL
         AND fn_ss_et(so.order_date)::date = cd.d) u ON true
    LEFT JOIN LATERAL (
      SELECT COALESCE(sum(-d.amount_cents), 0) AS cents
        FROM shipstation_orders so JOIN shipstation_order_discounts d ON d.shipstation_order_id = so.id
        JOIN mkt_discount_codes c ON c.code = d.code AND c.kind = 'everyday'
       WHERE so.store_id = ANY (v_stores)
         AND so.order_status IN ('shipped', 'awaiting_shipment')
         AND fn_ss_et(so.order_date)::date = cd.d) dc ON true;

  SELECT avg(orders), avg(units),
         CASE WHEN sum(orders) > 0 THEN sum(new_orders)::numeric / sum(orders) END,
         CASE WHEN sum(orders) > 0 THEN sum(disc_cents)::numeric / sum(orders) END
    INTO v_mean_o, v_mean_u, v_new, v_disc FROM tmp_clean;
  v_mean_o := COALESCE(v_mean_o, 0); v_mean_u := COALESCE(v_mean_u, 0);

  FOR i IN 0..6 LOOP
    SELECT CASE WHEN count(*) >= 2 AND v_mean_o > 0 THEN avg(orders) / v_mean_o ELSE 1 END,
           CASE WHEN count(*) >= 2 AND v_mean_u > 0 THEN avg(units) / v_mean_u ELSE 1 END
      INTO v_tmp_o, v_tmp_u
      FROM tmp_clean WHERE dow = i;
    v_dow_o[i + 1] := COALESCE(v_tmp_o, 1);
    v_dow_u[i + 1] := COALESCE(v_tmp_u, 1);
  END LOOP;

  -- Hour shape: cumulative share of clean-day orders placed by the end of each ET hour.
  SELECT array_agg(share ORDER BY h) INTO v_hours FROM (
    SELECT h.h,
           CASE WHEN t.total > 0 THEN (SELECT count(*) FROM shipstation_orders so
                                        WHERE so.store_id = ANY (v_stores)
                                          AND so.order_status IN ('shipped', 'awaiting_shipment')
                                          AND fn_ss_et(so.order_date)::date = ANY (v_clean)
                                          AND EXTRACT(HOUR FROM fn_ss_et(so.order_date)) <= h.h)::numeric / t.total
                ELSE (h.h + 1) / 24.0 END AS share
      FROM generate_series(0, 23) h(h)
      CROSS JOIN (SELECT count(*) AS total FROM shipstation_orders so
                   WHERE so.store_id = ANY (v_stores)
                     AND so.order_status IN ('shipped', 'awaiting_shipment')
                     AND fn_ss_et(so.order_date)::date = ANY (v_clean)) t) q;

  INSERT INTO mkt_sale_baseline AS b
    (sale_id, computed_at, frozen, d1, window_from, window_to, clean_days, n_clean, short,
     orders_day, units_day, dow_orders, dow_units, hour_share, new_share, everyday_disc_cents_per_order, store_ids)
  VALUES
    (p_sale_id, now(), v_opened, v_d1, v_from, v_win_to, v_clean, cardinality(v_clean), cardinality(v_clean) < 12,
     v_mean_o, v_mean_u, v_dow_o, v_dow_u, v_hours, v_new, v_disc, v_stores)
  ON CONFLICT (sale_id) DO UPDATE SET
     computed_at = EXCLUDED.computed_at, frozen = EXCLUDED.frozen, d1 = EXCLUDED.d1,
     window_from = EXCLUDED.window_from, window_to = EXCLUDED.window_to, clean_days = EXCLUDED.clean_days,
     n_clean = EXCLUDED.n_clean, short = EXCLUDED.short, orders_day = EXCLUDED.orders_day, units_day = EXCLUDED.units_day,
     dow_orders = EXCLUDED.dow_orders, dow_units = EXCLUDED.dow_units, hour_share = EXCLUDED.hour_share,
     new_share = EXCLUDED.new_share, everyday_disc_cents_per_order = EXCLUDED.everyday_disc_cents_per_order,
     store_ids = EXCLUDED.store_ids
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;
