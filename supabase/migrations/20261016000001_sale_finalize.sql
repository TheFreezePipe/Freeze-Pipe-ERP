-- Sale finalization: the end-of-sale writer, overlap detection, and the
-- nightly job that finalizes sales 14 days after close (21 with a gift).
--
-- Finalization writes the measured result where the planner reads priors:
--   mkt_promo_history  one source='measured' row per phase (ea, main),
--                      replacing that sale's backfill rows so mkt_lift_priors
--                      never counts the same sale twice;
--   mkt_offers         actual_orders, actual_lift_pct, actual_gift_units,
--                      actual_attach_pct, post14_ratio;
--   mkt_sales          finalized_at.
-- The same order predicate as rpc_sale_metrics (store filter, ET day,
-- shipped + awaiting, split-deduped) and the frozen baseline. Idempotent:
-- re-running replaces the sale's measured rows.

-- ---------------------------------------------------------------------------
-- Overlap: another sale or a launch inside this sale's after-window makes the
-- post-14 reading unusable (its dip is someone else's lift).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_sale_overlap(p_sale_id uuid)
RETURNS text
LANGUAGE sql STABLE
SET search_path = public
AS $$
  WITH me AS (
    SELECT (s.ends_at AT TIME ZONE 'UTC')::date AS d2,
           (s.ends_at AT TIME ZONE 'UTC')::date + CASE WHEN EXISTS (SELECT 1 FROM mkt_offers o WHERE o.sale_id = s.id AND o.free_item_sku_id IS NOT NULL) THEN 21 ELSE 14 END AS d3
      FROM mkt_sales s WHERE s.id = p_sale_id AND s.ends_at IS NOT NULL
  ), hits AS (
    SELECT s.name
      FROM mkt_sales s, me
     WHERE s.id <> p_sale_id AND s.starts_at IS NOT NULL AND s.ends_at IS NOT NULL
       AND (COALESCE(s.early_access_starts_at, s.starts_at) AT TIME ZONE 'UTC')::date <= me.d3
       AND (s.ends_at AT TIME ZONE 'UTC')::date > me.d2
    UNION ALL
    SELECT l.name
      FROM mkt_launches l, me
     WHERE l.launch_date IS NOT NULL
       AND COALESCE(l.early_access_date, l.launch_date) <= me.d3
       AND l.launch_date > me.d2
  )
  SELECT NULLIF(string_agg(DISTINCT name, ', '), '') FROM hits;
$$;

CREATE OR REPLACE FUNCTION public.rpc_sale_metrics(p_sale_id uuid, p_as_of timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sale    mkt_sales%ROWTYPE;
  v_base    mkt_sale_baseline%ROWTYPE;
  v_stores  bigint[];
  v_d1      date;  -- first selling day
  v_ds      date;  -- public start
  v_d2      date;  -- last selling day
  v_from    date;  -- d1 - 7
  v_to      date;  -- d2 + 21
  v_asof_d  date := (p_as_of AT TIME ZONE 'America/New_York')::date;
  v_asof_h  int  := EXTRACT(HOUR FROM p_as_of AT TIME ZONE 'America/New_York')::int;
  v_asof_ts timestamp := p_as_of AT TIME ZONE 'America/New_York';
  v_has_gift boolean;
  v_days    jsonb; v_offers jsonb; v_skus jsonb; v_bcast jsonb; v_lastrun jsonb; v_hours jsonb; v_codes jsonb;
  v_synced  timestamptz; v_run jsonb; v_unresolved int; v_overlap text;
BEGIN
  SELECT * INTO v_sale FROM mkt_sales WHERE id = p_sale_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'sale % not found', p_sale_id; END IF;
  IF v_sale.starts_at IS NULL OR v_sale.ends_at IS NULL THEN RAISE EXCEPTION 'sale % has no dates', p_sale_id; END IF;

  v_base   := rpc_ensure_sale_baseline(p_sale_id, false);
  v_stores := v_base.store_ids;
  v_d1 := v_base.d1;
  v_ds := (v_sale.starts_at AT TIME ZONE 'UTC')::date;
  v_d2 := (v_sale.ends_at AT TIME ZONE 'UTC')::date;
  v_from := v_d1 - 7;
  v_to   := v_d2 + 21;
  v_has_gift := EXISTS (SELECT 1 FROM mkt_offers o WHERE o.sale_id = p_sale_id AND o.free_item_sku_id IS NOT NULL);

  -- Orders in the whole window, one row per order (split-deduped), ET-keyed.
  DROP TABLE IF EXISTS tmp_w_orders;
  CREATE TEMP TABLE tmp_w_orders (
    id uuid, okey text, d date, h int, status text, is_new boolean, email text) ON COMMIT DROP;
  INSERT INTO tmp_w_orders
  SELECT DISTINCT ON (fn_ss_order_key(so.order_number))
         so.id, fn_ss_order_key(so.order_number), fn_ss_et(so.order_date)::date,
         EXTRACT(HOUR FROM fn_ss_et(so.order_date))::int, so.order_status,
         NOT EXISTS (SELECT 1 FROM shipstation_orders e
                      WHERE so.customer_email IS NOT NULL
                        AND lower(e.customer_email) = lower(so.customer_email)
                        AND e.order_date < so.order_date),
         lower(so.customer_email)
    FROM shipstation_orders so
   WHERE so.store_id = ANY (v_stores)
     AND so.order_status IN ('shipped', 'awaiting_shipment')
     AND fn_ss_et(so.order_date)::date BETWEEN v_from AND v_to
     AND fn_ss_et(so.order_date) <= v_asof_ts
   ORDER BY fn_ss_order_key(so.order_number), so.order_date;

  -- Units per order line (all lines of every ShipStation row sharing the key).
  DROP TABLE IF EXISTS tmp_w_lines;
  CREATE TEMP TABLE tmp_w_lines (okey text, d date, sku_id uuid, qty int, unit_price_cents bigint) ON COMMIT DROP;
  INSERT INTO tmp_w_lines
  SELECT fn_ss_order_key(so.order_number), fn_ss_et(so.order_date)::date, it.sku_id, it.quantity, it.unit_price_cents
    FROM shipstation_orders so JOIN shipstation_order_items it ON it.shipstation_order_id = so.id
   WHERE so.store_id = ANY (v_stores)
     AND so.order_status IN ('shipped', 'awaiting_shipment')
     AND it.sku_id IS NOT NULL
     AND fn_ss_et(so.order_date)::date BETWEEN v_from AND v_to
     AND fn_ss_et(so.order_date) <= v_asof_ts;

  -- Discount lines in the window, classified for THIS sale.
  DROP TABLE IF EXISTS tmp_w_disc;
  CREATE TEMP TABLE tmp_w_disc (okey text, d date, code text, kind text, amount_cents bigint) ON COMMIT DROP;
  INSERT INTO tmp_w_disc
  SELECT fn_ss_order_key(so.order_number), fn_ss_et(so.order_date)::date, dsc.code,
         CASE
           WHEN c.kind = 'operational' THEN 'operational'
           WHEN c.kind = 'everyday' THEN 'everyday'
           WHEN c.kind = 'sale' AND c.sale_id = p_sale_id THEN 'sale'
           WHEN EXISTS (SELECT 1 FROM mkt_offers o WHERE o.sale_id = p_sale_id AND lower(trim(o.code)) = dsc.code) THEN 'sale'
           WHEN c.kind = 'sale' THEN 'other_sale'
           ELSE 'other'
         END,
         dsc.amount_cents
    FROM shipstation_orders so
    JOIN shipstation_order_discounts dsc ON dsc.shipstation_order_id = so.id
    LEFT JOIN mkt_discount_codes c ON c.code = dsc.code
   WHERE so.store_id = ANY (v_stores)
     AND so.order_status IN ('shipped', 'awaiting_shipment')
     AND fn_ss_et(so.order_date)::date BETWEEN v_from AND v_to
     AND fn_ss_et(so.order_date) <= v_asof_ts;

  -- Days
  SELECT jsonb_agg(jsonb_build_object(
           'k', to_char(g.d, 'YYYY-MM-DD'),
           'orders', COALESCE(o.orders, 0), 'awaiting', COALESCE(o.awaiting, 0), 'new', COALESCE(o.new_orders, 0),
           'units', COALESCE(u.units, 0),
           'disc', jsonb_build_object('sale', COALESCE(dd.sale, 0), 'other_sale', COALESCE(dd.other_sale, 0),
                                      'everyday', COALESCE(dd.everyday, 0), 'operational', COALESCE(dd.operational, 0),
                                      'other', COALESCE(dd.other, 0)),
           'sale_code_orders', COALESCE(dd.sale_orders, 0)
         ) ORDER BY g.d) INTO v_days
    FROM generate_series(v_from, LEAST(v_to, v_asof_d), interval '1 day') g(d)
    LEFT JOIN LATERAL (SELECT count(*) AS orders, count(*) FILTER (WHERE w.status = 'awaiting_shipment') AS awaiting,
                              count(*) FILTER (WHERE w.is_new) AS new_orders
                         FROM tmp_w_orders w WHERE w.d = g.d::date) o ON true
    LEFT JOIN LATERAL (SELECT sum(l.qty)::int AS units FROM tmp_w_lines l WHERE l.d = g.d::date) u ON true
    LEFT JOIN LATERAL (SELECT sum(-amount_cents) FILTER (WHERE kind = 'sale') AS sale,
                              sum(-amount_cents) FILTER (WHERE kind = 'other_sale') AS other_sale,
                              sum(-amount_cents) FILTER (WHERE kind = 'everyday') AS everyday,
                              sum(-amount_cents) FILTER (WHERE kind = 'operational') AS operational,
                              sum(-amount_cents) FILTER (WHERE kind = 'other') AS other,
                              count(DISTINCT okey) FILTER (WHERE kind = 'sale') AS sale_orders
                         FROM tmp_w_disc x WHERE x.d = g.d::date) dd ON true;

  -- Orders by ET hour on the as-of day (live partial day).
  SELECT jsonb_agg(COALESCE(c, 0) ORDER BY h) INTO v_hours
    FROM generate_series(0, 23) h(h)
    LEFT JOIN LATERAL (SELECT count(*) AS c FROM tmp_w_orders w WHERE w.d = v_asof_d AND w.h = h.h) x ON true;

  -- Codes seen in the sale window (d1..d2) with counts, for alerts and the offers table.
  SELECT jsonb_agg(jsonb_build_object('code', code, 'kind', kind, 'orders', orders, 'cents', cents) ORDER BY orders DESC) INTO v_codes
    FROM (SELECT code, kind, count(DISTINCT okey) AS orders, sum(-amount_cents) AS cents
            FROM tmp_w_disc WHERE d BETWEEN v_d1 AND v_d2 GROUP BY code, kind) q;

  -- Offers with member SKUs, containing orders, redemptions, discount $, gift attach.
  SELECT jsonb_agg(jsonb_build_object(
           'id', o.id, 'label', o.label, 'format', o.format, 'code', lower(trim(o.code)), 'scope', o.scope, 'category', o.category,
           'percent_off', o.percent_off, 'dollar_off', o.dollar_off, 'min_order_amount', o.min_order_amount,
           'buy_qty', o.buy_qty, 'get_qty', o.get_qty, 'once_per_order', o.once_per_order,
           'expected_orders', o.expected_orders, 'expected_uplift_pct', o.expected_uplift_pct,
           'planner_gift_units', o.planner_gift_units, 'derived_gift_units', o.derived_gift_units,
           'gift_sku_id', o.free_item_sku_id, 'gift_sku', g.sku,
           'member_sku_ids', COALESCE(m.ids, '[]'::jsonb),
           'containing', COALESCE(cnt.containing, 0),
           'qualifying_with_gift', COALESCE(cnt.with_gift, 0),
           'gift_without_qualifying', COALESCE(cnt.gift_only, 0),
           'redemptions', CASE WHEN o.code IS NULL OR o.code = '' THEN NULL ELSE COALESCE(rd.orders, 0) END,
           'discount_cents', CASE WHEN o.code IS NULL OR o.code = '' THEN NULL ELSE COALESCE(rd.cents, 0) END,
           'code_last_seen', rd.last_seen
         ) ORDER BY o.created_at) INTO v_offers
    FROM mkt_offers o
    LEFT JOIN product_skus g ON g.id = o.free_item_sku_id
    LEFT JOIN LATERAL (SELECT jsonb_agg(DISTINCT x.sku_id) AS ids FROM mkt_offer_sku_expansion x
                        WHERE x.offer_id = o.id AND x.role = 'member') m ON true
    LEFT JOIN LATERAL (
      SELECT count(DISTINCT l.okey) FILTER (WHERE mem.sku_id IS NOT NULL) AS containing,
             count(DISTINCT l.okey) FILTER (WHERE mem.sku_id IS NOT NULL AND EXISTS (
                 SELECT 1 FROM tmp_w_lines l2 WHERE l2.okey = l.okey AND l2.sku_id = o.free_item_sku_id)) AS with_gift,
             (SELECT count(DISTINCT l3.okey) FROM tmp_w_lines l3
               WHERE l3.sku_id = o.free_item_sku_id AND l3.d BETWEEN v_d1 AND v_d2
                 AND NOT EXISTS (SELECT 1 FROM tmp_w_lines l4 JOIN mkt_offer_sku_expansion x4
                                   ON x4.sku_id = l4.sku_id AND x4.offer_id = o.id AND x4.role = 'member'
                                  WHERE l4.okey = l3.okey)) AS gift_only
        FROM tmp_w_lines l
        LEFT JOIN mkt_offer_sku_expansion mem ON mem.offer_id = o.id AND mem.role = 'member' AND mem.sku_id = l.sku_id
       WHERE l.d BETWEEN v_d1 AND v_d2) cnt ON true
    LEFT JOIN LATERAL (SELECT count(DISTINCT x.okey) AS orders, sum(-x.amount_cents) AS cents, max(x.d) AS last_seen
                         FROM tmp_w_disc x WHERE x.code = lower(trim(o.code)) AND x.d BETWEEN v_d1 AND v_d2) rd ON true
   WHERE o.sale_id = p_sale_id;

  -- Per-SKU rows: every SKU with units in the window, plus members/gifts with none.
  SELECT jsonb_agg(jsonb_build_object(
           'sku_id', s.id, 'sku', s.sku, 'name', s.product_name, 'category', s.display_category,
           'retail', s.retail_price, 'active', s.is_active,
           'role', r.role,
           'units_sale', COALESCE(w.units_sale, 0), 'units_pre', COALESCE(w.units_pre, 0), 'units_post', COALESCE(w.units_post, 0),
           'daily', COALESCE(w.daily, '[]'::jsonb),
           'rate3', COALESCE(w.rate3, 0),
           'base_rate', COALESCE(b.rate, 0),
           'finished', COALESCE(inv.finished, 0), 'raw', COALESCE(inv.raw, 0), 'prefilled_raw', COALESCE(inv.prefilled, 0)
         ) ORDER BY COALESCE(w.units_sale, 0) DESC) INTO v_skus
    FROM (
      SELECT DISTINCT sku_id FROM tmp_w_lines
      UNION
      SELECT x.sku_id FROM mkt_offer_sku_expansion x JOIN mkt_offers o ON o.id = x.offer_id WHERE o.sale_id = p_sale_id
    ) ids
    JOIN product_skus s ON s.id = ids.sku_id
    LEFT JOIN LATERAL (
      SELECT CASE WHEN bool_or(x.role = 'gift') THEN 'gift' WHEN bool_or(x.role = 'member') THEN 'member' END AS role
        FROM mkt_offer_sku_expansion x JOIN mkt_offers o ON o.id = x.offer_id
       WHERE o.sale_id = p_sale_id AND x.sku_id = s.id) r ON true
    LEFT JOIN LATERAL (
      SELECT sum(qty) FILTER (WHERE d BETWEEN v_d1 AND v_d2) AS units_sale,
             sum(qty) FILTER (WHERE d < v_d1) AS units_pre,
             sum(qty) FILTER (WHERE d > v_d2) AS units_post,
             (SELECT jsonb_agg(jsonb_build_array(to_char(dd.d, 'YYYY-MM-DD'), dd.u) ORDER BY dd.d)
                FROM (SELECT d, sum(qty) AS u FROM tmp_w_lines l2 WHERE l2.sku_id = s.id AND l2.d BETWEEN v_d1 AND v_d2 GROUP BY d) dd) AS daily,
             (SELECT sum(qty) / 3.0 FROM tmp_w_lines l3 WHERE l3.sku_id = s.id
               AND l3.d BETWEEN LEAST(v_asof_d, v_d2) - 2 AND LEAST(v_asof_d, v_d2)) AS rate3
        FROM tmp_w_lines l WHERE l.sku_id = s.id) w ON true
    LEFT JOIN LATERAL (
      SELECT CASE WHEN v_base.n_clean > 0 THEN COALESCE(sum(it.quantity), 0)::numeric / v_base.n_clean ELSE 0 END AS rate
        FROM shipstation_orders so JOIN shipstation_order_items it ON it.shipstation_order_id = so.id
       WHERE it.sku_id = s.id AND so.store_id = ANY (v_stores)
         AND so.order_status IN ('shipped', 'awaiting_shipment')
         AND fn_ss_et(so.order_date)::date = ANY (v_base.clean_days)) b ON true
    LEFT JOIN LATERAL (
      SELECT sum(warehouse_finished) AS finished, sum(warehouse_raw) AS raw, sum(warehouse_prefilled_raw) AS prefilled
        FROM inventory_levels il WHERE il.sku_id = s.id) inv ON true;

  -- Broadcasts
  SELECT jsonb_agg(jsonb_build_object(
           'id', b.id, 'channel', b.channel, 'name', b.name, 'scheduled_at', b.scheduled_at, 'sent_at', b.sent_at,
           'audience_size', b.audience_size, 'recipients', b.recipients, 'opens', b.opens, 'clicks', b.clicks,
           'revenue', b.revenue, 'metrics', b.metrics, 'source', b.source, 'updated_at', b.updated_at
         ) ORDER BY COALESCE(b.sent_at, b.scheduled_at)) INTO v_bcast
    FROM mkt_broadcasts b WHERE b.sale_id = p_sale_id;

  -- Prior runs of the same event (ledger), most recent first.
  SELECT jsonb_agg(jsonb_build_object(
           'name', h.name, 'd1', h.d1, 'd2', h.d2, 'format', h.format, 'depth_pct', h.depth_pct, 'depth_band', h.depth_band,
           'scope_class', h.scope_class, 'holiday', h.holiday, 'orders', h.orders, 'units', h.units,
           'lift_pct', h.lift_pct, 'orders_lift_pct', h.orders_lift_pct, 'post14_ratio', h.post14_ratio,
           'attach_pct', h.attach_pct, 'phase', h.phase, 'source', h.source
         ) ORDER BY h.d1 DESC) INTO v_lastrun
    FROM mkt_promo_history h
   WHERE h.d2 < v_d1 - 60
     AND (h.sale_id IS NULL OR h.sale_id <> p_sale_id);

  v_overlap := fn_sale_overlap(p_sale_id);

  -- Freshness
  SELECT max(last_seen_at) INTO v_synced FROM shipstation_orders WHERE store_id = ANY (v_stores);
  SELECT jsonb_build_object('run_type', r.run_type, 'started_at', r.started_at, 'completed_at', r.completed_at, 'status', r.status, 'error', r.error_message)
    INTO v_run FROM shipstation_sync_runs r ORDER BY r.started_at DESC LIMIT 1;
  SELECT count(DISTINCT so.id) INTO v_unresolved
    FROM shipstation_orders so
   WHERE so.store_id = ANY (v_stores) AND so.order_status IN ('shipped', 'awaiting_shipment')
     AND fn_ss_et(so.order_date)::date BETWEEN v_d1 AND LEAST(v_d2, v_asof_d)
     AND so.inventory_applied_at IS NULL;

  RETURN jsonb_build_object(
    'sale', jsonb_build_object(
      'id', v_sale.id, 'name', v_sale.name, 'notes', v_sale.notes,
      'd1', to_char(v_d1, 'YYYY-MM-DD'), 'start', to_char(v_ds, 'YYYY-MM-DD'), 'end', to_char(v_d2, 'YYYY-MM-DD'),
      'ea', CASE WHEN v_sale.early_access_starts_at IS NULL THEN NULL ELSE to_char(v_d1, 'YYYY-MM-DD') END,
      'plan_orders', v_sale.plan_orders, 'plan_source', v_sale.plan_source,
      'season_index', v_sale.season_index, 'cm_pct', v_sale.cm_pct, 'finalized_at', v_sale.finalized_at,
      'approval_status', v_sale.approval_status, 'has_gift', v_has_gift,
      'final_on', to_char(v_d2 + CASE WHEN v_has_gift THEN 21 ELSE 14 END, 'YYYY-MM-DD')),
    'stores', (SELECT jsonb_agg(jsonb_build_object('store_id', st.store_id, 'name', st.name) ORDER BY st.store_id)
                 FROM mkt_sale_stores st WHERE st.store_id = ANY (v_stores)),
    'as_of', p_as_of, 'as_of_day', to_char(v_asof_d, 'YYYY-MM-DD'), 'as_of_hour', v_asof_h,
    'synced_at', v_synced, 'last_run', v_run, 'unresolved_orders', v_unresolved, 'overlap', v_overlap,
    'baseline', to_jsonb(v_base),
    'days', COALESCE(v_days, '[]'::jsonb),
    'hours_today', COALESCE(v_hours, '[]'::jsonb),
    'codes', COALESCE(v_codes, '[]'::jsonb),
    'offers', COALESCE(v_offers, '[]'::jsonb),
    'skus', COALESCE(v_skus, '[]'::jsonb),
    'broadcasts', COALESCE(v_bcast, '[]'::jsonb),
    'prior_runs', COALESCE(v_lastrun, '[]'::jsonb),
    'sources', jsonb_build_object('orders', 'shipstation', 'units', 'shipstation', 'discounts', 'shipstation',
                                  'revenue', NULL, 'sends', 'manual', 'sessions', NULL)
  );
END;
$$;
REVOKE ALL ON FUNCTION public.rpc_sale_metrics(uuid, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_sale_metrics(uuid, timestamptz) TO authenticated;

-- ---------------------------------------------------------------------------
-- Finalize one sale
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_finalize_sale(p_sale_id uuid, p_force boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sale    mkt_sales%ROWTYPE;
  v_base    mkt_sale_baseline%ROWTYPE;
  v_stores  bigint[];
  v_d1 date; v_ds date; v_d2 date; v_d3 date;
  v_today   date := (now() AT TIME ZONE 'America/New_York')::date;
  v_has_gift boolean;
  v_overlap text;
  v_role    text;
  v_year    text;
  v_format  text; v_depth numeric; v_band text; v_scope text; v_season text; v_holiday boolean;
  v_ea_orders int; v_ea_units int; v_ea_b_orders numeric; v_ea_b_units numeric;
  v_mn_orders int; v_mn_units int; v_mn_b_orders numeric; v_mn_b_units numeric;
  v_po_units int; v_po_b_units numeric; v_post14 numeric;
  v_attach numeric;
  v_offer record;
  v_rows int := 0;
BEGIN
  -- Callers: the nightly job (service role) or an admin/manager forcing it.
  IF auth.uid() IS NOT NULL THEN
    SELECT role INTO v_role FROM profiles WHERE id = auth.uid();
    IF v_role IS DISTINCT FROM 'admin' AND v_role IS DISTINCT FROM 'manager' THEN
      RAISE EXCEPTION 'not allowed';
    END IF;
  END IF;

  SELECT * INTO v_sale FROM mkt_sales WHERE id = p_sale_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'sale % not found', p_sale_id; END IF;
  IF v_sale.starts_at IS NULL OR v_sale.ends_at IS NULL THEN RAISE EXCEPTION 'sale % has no dates', p_sale_id; END IF;

  v_base   := rpc_ensure_sale_baseline(p_sale_id, false);
  v_stores := v_base.store_ids;
  v_d1 := v_base.d1;
  v_ds := (v_sale.starts_at AT TIME ZONE 'UTC')::date;
  v_d2 := (v_sale.ends_at AT TIME ZONE 'UTC')::date;
  v_has_gift := EXISTS (SELECT 1 FROM mkt_offers o WHERE o.sale_id = p_sale_id AND o.free_item_sku_id IS NOT NULL);
  v_d3 := v_d2 + CASE WHEN v_has_gift THEN 21 ELSE 14 END;

  IF v_today < v_d3 AND NOT p_force THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not due', 'final_on', v_d3);
  END IF;
  IF v_sale.finalized_at IS NOT NULL AND NOT p_force THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already final', 'finalized_at', v_sale.finalized_at);
  END IF;

  v_overlap := fn_sale_overlap(p_sale_id);

  -- Orders and units per phase, same predicate as the page.
  DROP TABLE IF EXISTS tmp_f_orders;
  CREATE TEMP TABLE tmp_f_orders ON COMMIT DROP AS
  SELECT DISTINCT ON (fn_ss_order_key(so.order_number))
         so.id, fn_ss_order_key(so.order_number) AS okey, fn_ss_et(so.order_date)::date AS d
    FROM shipstation_orders so
   WHERE so.store_id = ANY (v_stores)
     AND so.order_status IN ('shipped', 'awaiting_shipment')
     AND fn_ss_et(so.order_date)::date BETWEEN v_d1 AND v_d2 + 14
   ORDER BY fn_ss_order_key(so.order_number), so.order_date;
  DROP TABLE IF EXISTS tmp_f_lines;
  CREATE TEMP TABLE tmp_f_lines ON COMMIT DROP AS
  SELECT fn_ss_order_key(so.order_number) AS okey, fn_ss_et(so.order_date)::date AS d, it.sku_id, it.quantity AS qty
    FROM shipstation_orders so JOIN shipstation_order_items it ON it.shipstation_order_id = so.id
   WHERE so.store_id = ANY (v_stores)
     AND so.order_status IN ('shipped', 'awaiting_shipment')
     AND it.sku_id IS NOT NULL
     AND fn_ss_et(so.order_date)::date BETWEEN v_d1 AND v_d2 + 14;

  SELECT count(*) INTO v_ea_orders FROM tmp_f_orders WHERE d >= v_d1 AND d < v_ds;
  SELECT count(*) INTO v_mn_orders FROM tmp_f_orders WHERE d BETWEEN v_ds AND v_d2;
  SELECT COALESCE(sum(qty), 0) INTO v_ea_units FROM tmp_f_lines WHERE d >= v_d1 AND d < v_ds;
  SELECT COALESCE(sum(qty), 0) INTO v_mn_units FROM tmp_f_lines WHERE d BETWEEN v_ds AND v_d2;
  SELECT COALESCE(sum(qty), 0) INTO v_po_units FROM tmp_f_lines WHERE d > v_d2 AND d <= v_d2 + 14;

  -- Baseline per phase from the frozen clean-day baseline × weekday shape × season.
  SELECT COALESCE(sum(v_base.orders_day * v_base.dow_orders[EXTRACT(DOW FROM g.d)::int + 1] * v_sale.season_index), 0),
         COALESCE(sum(v_base.units_day  * v_base.dow_units[EXTRACT(DOW FROM g.d)::int + 1]  * v_sale.season_index), 0)
    INTO v_ea_b_orders, v_ea_b_units
    FROM generate_series(v_d1, v_ds - 1, interval '1 day') g(d);
  SELECT COALESCE(sum(v_base.orders_day * v_base.dow_orders[EXTRACT(DOW FROM g.d)::int + 1] * v_sale.season_index), 0),
         COALESCE(sum(v_base.units_day  * v_base.dow_units[EXTRACT(DOW FROM g.d)::int + 1]  * v_sale.season_index), 0)
    INTO v_mn_b_orders, v_mn_b_units
    FROM generate_series(v_ds, v_d2, interval '1 day') g(d);
  SELECT COALESCE(sum(v_base.units_day * v_base.dow_units[EXTRACT(DOW FROM g.d)::int + 1] * v_sale.season_index), 0)
    INTO v_po_b_units
    FROM generate_series(v_d2 + 1, v_d2 + 14, interval '1 day') g(d);
  v_post14 := CASE WHEN v_overlap IS NOT NULL OR v_po_b_units <= 0 OR v_today <= v_d2 + 14 THEN NULL ELSE ROUND(v_po_units / v_po_b_units, 3) END;

  -- Classification for the priors: the first offer sets format and depth.
  SELECT o.format, COALESCE(o.effective_discount_pct, o.percent_off,
           CASE WHEN o.dollar_off IS NOT NULL THEN 15 END)
    INTO v_format, v_depth
    FROM mkt_offers o WHERE o.sale_id = p_sale_id ORDER BY o.created_at LIMIT 1;
  v_format := CASE WHEN v_format IS NULL THEN 'none' WHEN v_format = 'percent' THEN 'percent'
                   WHEN v_format = 'dollar' THEN 'dollar' ELSE 'gift_code' END;
  v_depth := ROUND(COALESCE(v_depth, 0), 1);
  v_band := CASE WHEN v_depth <= 10 THEN 'low' WHEN v_depth < 16 THEN 'mid' ELSE 'high' END;
  v_scope := CASE WHEN EXISTS (SELECT 1 FROM mkt_offers o WHERE o.sale_id = p_sale_id AND o.scope = 'sitewide') THEN 'sitewide' ELSE 'targeted' END;
  v_holiday := mkt_is_holiday_window(v_ds);
  v_season := CASE WHEN v_holiday THEN 'holiday' ELSE 'other' END;
  v_year := to_char(v_ds, 'YYYY');

  -- Attach: the first gift offer's qualifying orders that received the gift.
  SELECT CASE WHEN q.containing > 0 THEN ROUND(100.0 * q.with_gift / q.containing, 1) END INTO v_attach
    FROM mkt_offers o
    CROSS JOIN LATERAL (
      SELECT count(DISTINCT l.okey) AS containing,
             count(DISTINCT l.okey) FILTER (WHERE EXISTS (SELECT 1 FROM tmp_f_lines l2 WHERE l2.okey = l.okey AND l2.sku_id = o.free_item_sku_id)) AS with_gift
        FROM tmp_f_lines l JOIN mkt_offer_sku_expansion x ON x.offer_id = o.id AND x.role = 'member' AND x.sku_id = l.sku_id
       WHERE l.d BETWEEN v_d1 AND v_d2) q
   WHERE o.sale_id = p_sale_id AND o.free_item_sku_id IS NOT NULL
   ORDER BY o.created_at LIMIT 1;

  -- Ledger: replace this sale's rows (backfill or earlier measured).
  DELETE FROM mkt_promo_history WHERE sale_id = p_sale_id;
  IF v_d1 < v_ds THEN
    INSERT INTO mkt_promo_history
      (sale_id, name, d1, d2, format, depth_pct, depth_band, scope_class, season, holiday, orders, units,
       baseline_daily, lift_pct, orders_lift_pct, post14_ratio, attach_pct, phase, source, notes)
    VALUES
      (p_sale_id, v_sale.name || ' ' || v_year || ' EA', v_d1, v_ds - 1, v_format, v_depth, v_band, v_scope, v_season, v_holiday,
       v_ea_orders, v_ea_units,
       ROUND(v_ea_b_units / GREATEST(1, v_ds - v_d1), 1),
       CASE WHEN v_ea_b_units > 0 THEN ROUND(100.0 * (v_ea_units / v_ea_b_units - 1), 1) END,
       CASE WHEN v_ea_b_orders > 0 THEN ROUND(100.0 * (v_ea_orders / v_ea_b_orders - 1), 1) END,
       NULL, v_attach, 'ea', 'measured',
       'measured ' || to_char(now() AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') || ' · clean days ' || v_base.n_clean || ' · season ×' || v_sale.season_index);
    v_rows := v_rows + 1;
  END IF;
  INSERT INTO mkt_promo_history
    (sale_id, name, d1, d2, format, depth_pct, depth_band, scope_class, season, holiday, orders, units,
     baseline_daily, lift_pct, orders_lift_pct, post14_ratio, attach_pct, phase, source, notes)
  VALUES
    (p_sale_id, v_sale.name || ' ' || v_year, v_ds, v_d2, v_format, v_depth, v_band, v_scope, v_season, v_holiday,
     v_mn_orders, v_mn_units,
     ROUND(v_mn_b_units / GREATEST(1, v_d2 - v_ds + 1), 1),
     CASE WHEN v_mn_b_units > 0 THEN ROUND(100.0 * (v_mn_units / v_mn_b_units - 1), 1) END,
     CASE WHEN v_mn_b_orders > 0 THEN ROUND(100.0 * (v_mn_orders / v_mn_b_orders - 1), 1) END,
     v_post14, v_attach, 'main', 'measured',
     'measured ' || to_char(now() AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') || ' · clean days ' || v_base.n_clean || ' · season ×' || v_sale.season_index
       || CASE WHEN v_overlap IS NOT NULL THEN ' · overlap: ' || v_overlap ELSE '' END);
  v_rows := v_rows + 1;

  -- Offers: actuals.
  FOR v_offer IN SELECT o.id FROM mkt_offers o WHERE o.sale_id = p_sale_id LOOP
    UPDATE mkt_offers o SET
      actual_orders = (SELECT count(DISTINCT l.okey) FROM tmp_f_lines l
                         JOIN mkt_offer_sku_expansion x ON x.offer_id = o.id AND x.role = 'member' AND x.sku_id = l.sku_id
                        WHERE l.d BETWEEN v_d1 AND v_d2),
      actual_lift_pct = (SELECT CASE WHEN b.base > 0 THEN ROUND(100.0 * (a.units / b.base - 1), 1) END
                           FROM (SELECT COALESCE(sum(l.qty), 0)::numeric AS units FROM tmp_f_lines l
                                   JOIN mkt_offer_sku_expansion x ON x.offer_id = o.id AND x.role = 'member' AND x.sku_id = l.sku_id
                                  WHERE l.d BETWEEN v_d1 AND v_d2) a,
                                (SELECT COALESCE(sum(r.rate), 0) * (v_ea_b_units + v_mn_b_units) / NULLIF(v_base.units_day, 0) AS base
                                   FROM (SELECT x.sku_id,
                                                (SELECT COALESCE(sum(it.quantity), 0)::numeric / NULLIF(v_base.n_clean, 0)
                                                   FROM shipstation_orders so JOIN shipstation_order_items it ON it.shipstation_order_id = so.id
                                                  WHERE it.sku_id = x.sku_id AND so.store_id = ANY (v_stores)
                                                    AND so.order_status IN ('shipped', 'awaiting_shipment')
                                                    AND fn_ss_et(so.order_date)::date = ANY (v_base.clean_days)) AS rate
                                           FROM mkt_offer_sku_expansion x WHERE x.offer_id = o.id AND x.role = 'member') r) b),
      actual_gift_units = CASE WHEN o.free_item_sku_id IS NULL THEN NULL ELSE
                            (SELECT count(DISTINCT l.okey) * COALESCE(o.get_qty, 1) FROM tmp_f_lines l
                               JOIN mkt_offer_sku_expansion x ON x.offer_id = o.id AND x.role = 'member' AND x.sku_id = l.sku_id
                              WHERE l.d BETWEEN v_d1 AND v_d2
                                AND EXISTS (SELECT 1 FROM tmp_f_lines l2 WHERE l2.okey = l.okey AND l2.sku_id = o.free_item_sku_id)) END,
      actual_attach_pct = CASE WHEN o.free_item_sku_id IS NULL THEN NULL ELSE
                            (SELECT CASE WHEN count(DISTINCT l.okey) > 0 THEN ROUND(100.0 * count(DISTINCT l.okey) FILTER (WHERE EXISTS (
                                     SELECT 1 FROM tmp_f_lines l2 WHERE l2.okey = l.okey AND l2.sku_id = o.free_item_sku_id)) / count(DISTINCT l.okey), 1) END
                               FROM tmp_f_lines l JOIN mkt_offer_sku_expansion x ON x.offer_id = o.id AND x.role = 'member' AND x.sku_id = l.sku_id
                              WHERE l.d BETWEEN v_d1 AND v_d2) END,
      post14_ratio = v_post14,
      updated_at = now()
    WHERE o.id = v_offer.id;
  END LOOP;

  UPDATE mkt_sales SET finalized_at = now(), updated_at = now() WHERE id = p_sale_id;

  RETURN jsonb_build_object('ok', true, 'sale', v_sale.name, 'ledger_rows', v_rows,
    'ea', jsonb_build_object('orders', v_ea_orders, 'units', v_ea_units, 'base_orders', ROUND(v_ea_b_orders, 1), 'base_units', ROUND(v_ea_b_units, 1)),
    'main', jsonb_build_object('orders', v_mn_orders, 'units', v_mn_units, 'base_orders', ROUND(v_mn_b_orders, 1), 'base_units', ROUND(v_mn_b_units, 1)),
    'post14_ratio', v_post14, 'overlap', v_overlap, 'attach_pct', v_attach,
    'format', v_format, 'depth_pct', v_depth, 'depth_band', v_band, 'scope_class', v_scope, 'season', v_season);
END;
$$;
REVOKE ALL ON FUNCTION public.rpc_finalize_sale(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_finalize_sale(uuid, boolean) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Nightly: finalize every sale that has reached its final date.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_finalize_due_sales()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record; v_out jsonb := '[]'::jsonb; v_res jsonb;
  v_today date := (now() AT TIME ZONE 'America/New_York')::date;
BEGIN
  FOR r IN
    SELECT s.id
      FROM mkt_sales s
     WHERE s.finalized_at IS NULL
       AND s.starts_at IS NOT NULL AND s.ends_at IS NOT NULL
       AND s.starts_at >= '2026-08-01'
       AND (s.ends_at AT TIME ZONE 'UTC')::date
           + CASE WHEN EXISTS (SELECT 1 FROM mkt_offers o WHERE o.sale_id = s.id AND o.free_item_sku_id IS NOT NULL) THEN 21 ELSE 14 END
           <= v_today
     ORDER BY s.ends_at
  LOOP
    BEGIN
      v_res := rpc_finalize_sale(r.id, false);
    EXCEPTION WHEN OTHERS THEN
      v_res := jsonb_build_object('ok', false, 'sale_id', r.id, 'error', SQLERRM);
    END;
    v_out := v_out || jsonb_build_array(v_res);
  END LOOP;
  RETURN v_out;
END;
$$;
REVOKE ALL ON FUNCTION public.rpc_finalize_due_sales() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_finalize_due_sales() TO service_role;

SELECT cron.unschedule('sale-finalize-nightly') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sale-finalize-nightly');
SELECT cron.schedule('sale-finalize-nightly', '30 5 * * *', $$SELECT public.rpc_finalize_due_sales();$$);
