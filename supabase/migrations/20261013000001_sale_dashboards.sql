-- Sale dashboards (live + ended sale results), data layer.
--
-- What this adds:
--   1. mkt_sale_stores — which ShipStation stores count as "the sale".
--      The ERP ingests every store in the ShipStation account (main Shopify
--      store, the Manual Orders store used for samples/one-offs, and a
--      second Shopify site live since 2026-09-24); sale measurement must
--      only read the stores that run the promotion.
--   2. mkt_sales settings: plan_orders / plan_source (the pace tick),
--      season_index, cm_pct, finalized_at, store_ids.
--   3. shipstation_order_discounts — the discount-code lines ShipStation
--      sends inside each order payload (items with adjustment = true;
--      name = the code, unitPrice negative). Parsed by trigger from
--      raw_payload and backfilled. ShipStation is the agreed source for
--      code usage; it is NOT a revenue source.
--   4. mkt_discount_codes — classification of adjustment names: codes of
--      a sale (sale_id), everyday flow codes, operational adjustments.
--   5. ET day helpers. ShipStation's orderDate is a Pacific wall-clock
--      string stored as if UTC (probe 2026-10-13: Shopify createdAt
--      16:46Z == stored 09:46 "UTC" == 09:46 PDT). fn_ss_et converts a
--      stored value to the real Eastern wall clock.
--   6. mkt_sale_baseline + rpc_ensure_sale_baseline — the frozen clean-day
--      baseline (event-free days before the sale, weekday shape, hour
--      shape), previewed until the sale opens and frozen from then on.
--   7. rpc_sale_metrics(sale_id, as_of) — one JSON document with every raw
--      input the sale page needs; all judgement math lives in the
--      frontend (src/lib/marketing/sale-metrics.ts) so the same compute
--      runs on fixtures in tests.
--
-- Revenue (paid $, AOV, margin at realized prices) has no source yet; the
-- RPC returns nulls for those inputs and the page shows them as pending.

-- ---------------------------------------------------------------------------
-- 1. Stores
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.mkt_sale_stores (
  store_id        bigint PRIMARY KEY,
  name            text NOT NULL,
  counts_as_sale  boolean NOT NULL DEFAULT false,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.mkt_sale_stores IS
  'ShipStation stores seen in shipstation_orders.store_id and whether their orders count as sale orders by default. mkt_sales.store_ids overrides per sale.';

INSERT INTO public.mkt_sale_stores (store_id, name, counts_as_sale, notes) VALUES
  (229438, 'Freeze Pipe (Shopify)', true,  'Main store. advancedOptions.source: web / shopify_draft_order / app ids.'),
  (229435, 'Manual Orders',         false, 'Staff-entered samples and one-off orders. Never a sale order.'),
  (383716, 'Second Shopify store',  false, 'Live since 2026-09-24; counts once it runs its own promotions.')
ON CONFLICT (store_id) DO NOTHING;

ALTER TABLE public.mkt_sale_stores ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mkt_sale_stores_read ON public.mkt_sale_stores;
CREATE POLICY mkt_sale_stores_read ON public.mkt_sale_stores FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS mkt_sale_stores_admin ON public.mkt_sale_stores;
CREATE POLICY mkt_sale_stores_admin ON public.mkt_sale_stores FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin'));

-- ---------------------------------------------------------------------------
-- 2. Sale settings
-- ---------------------------------------------------------------------------
ALTER TABLE public.mkt_sales
  ADD COLUMN IF NOT EXISTS plan_orders   integer,
  ADD COLUMN IF NOT EXISTS plan_source   text,
  ADD COLUMN IF NOT EXISTS season_index  numeric NOT NULL DEFAULT 1.00,
  ADD COLUMN IF NOT EXISTS cm_pct        numeric NOT NULL DEFAULT 55,
  ADD COLUMN IF NOT EXISTS finalized_at  timestamptz,
  ADD COLUMN IF NOT EXISTS store_ids     bigint[];

DO $$ BEGIN
  ALTER TABLE public.mkt_sales ADD CONSTRAINT mkt_sales_plan_source_chk
    CHECK (plan_source IS NULL OR plan_source IN ('planner', 'derived'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.mkt_sales ADD CONSTRAINT mkt_sales_season_index_chk
    CHECK (season_index > 0 AND season_index <= 3);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON COLUMN public.mkt_sales.plan_orders IS 'Expected orders across early access + public window (planner-typed). NULL = derived from the baseline curve.';
COMMENT ON COLUMN public.mkt_sales.season_index IS 'Multiplier on the clean-day baseline (same weeks last year); 1.00 = off.';
COMMENT ON COLUMN public.mkt_sales.cm_pct IS 'Contribution margin % of list used for modeled margin until landed costs exist.';
COMMENT ON COLUMN public.mkt_sales.finalized_at IS 'Set by the actuals writer at end + 14 days (+21 with a gift offer).';
COMMENT ON COLUMN public.mkt_sales.store_ids IS 'ShipStation stores whose orders count for this sale. NULL = mkt_sale_stores.counts_as_sale.';

-- ---------------------------------------------------------------------------
-- 3. Discount lines parsed from ShipStation payloads
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.shipstation_order_discounts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shipstation_order_id uuid NOT NULL REFERENCES public.shipstation_orders(id) ON DELETE CASCADE,
  line_item_id         bigint,
  name                 text NOT NULL,
  code                 text NOT NULL,            -- lower(trim(name))
  amount_cents         bigint NOT NULL,          -- unitPrice × quantity, cents (negative = discount)
  quantity             integer NOT NULL DEFAULT 1,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shipstation_order_id, line_item_id)
);
CREATE INDEX IF NOT EXISTS ss_order_discounts_code_idx ON public.shipstation_order_discounts (code);
CREATE INDEX IF NOT EXISTS ss_order_discounts_order_idx ON public.shipstation_order_discounts (shipstation_order_id);
COMMENT ON TABLE public.shipstation_order_discounts IS
  'Adjustment lines (adjustment = true) from shipstation_orders.raw_payload->items: discount codes applied to the order, plus operational adjustments (shiptection, broken, defective). Parsed by trigger; never edited by hand.';

ALTER TABLE public.shipstation_order_discounts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ss_order_discounts_read ON public.shipstation_order_discounts;
CREATE POLICY ss_order_discounts_read ON public.shipstation_order_discounts FOR SELECT TO authenticated USING (true);

CREATE OR REPLACE FUNCTION public.fn_parse_shipstation_discounts(p_order_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_payload jsonb;
  v_n integer := 0;
BEGIN
  SELECT raw_payload INTO v_payload FROM public.shipstation_orders WHERE id = p_order_id;
  IF v_payload IS NULL OR jsonb_typeof(v_payload -> 'items') <> 'array' THEN
    DELETE FROM public.shipstation_order_discounts WHERE shipstation_order_id = p_order_id;
    RETURN 0;
  END IF;

  DELETE FROM public.shipstation_order_discounts WHERE shipstation_order_id = p_order_id;

  INSERT INTO public.shipstation_order_discounts
    (shipstation_order_id, line_item_id, name, code, amount_cents, quantity)
  SELECT p_order_id,
         NULLIF(it ->> 'orderItemId', '')::bigint,
         COALESCE(NULLIF(trim(it ->> 'name'), ''), '(unnamed)'),
         lower(COALESCE(NULLIF(trim(it ->> 'name'), ''), '(unnamed)')),
         ROUND(COALESCE((it ->> 'unitPrice')::numeric, 0) * COALESCE(NULLIF(it ->> 'quantity', '')::integer, 1) * 100)::bigint,
         COALESCE(NULLIF(it ->> 'quantity', '')::integer, 1)
    FROM jsonb_array_elements(v_payload -> 'items') it
   WHERE COALESCE((it ->> 'adjustment')::boolean, false)
  ON CONFLICT (shipstation_order_id, line_item_id) DO UPDATE
    SET name = EXCLUDED.name, code = EXCLUDED.code,
        amount_cents = EXCLUDED.amount_cents, quantity = EXCLUDED.quantity;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION public.fn_parse_shipstation_discounts(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.trg_parse_shipstation_discounts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.fn_parse_shipstation_discounts(NEW.id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS shipstation_orders_parse_discounts ON public.shipstation_orders;
CREATE TRIGGER shipstation_orders_parse_discounts
  AFTER INSERT OR UPDATE OF raw_payload ON public.shipstation_orders
  FOR EACH ROW EXECUTE FUNCTION public.trg_parse_shipstation_discounts();

-- Backfill every stored payload (adjustment lines exist from April 2026).
DO $$
DECLARE r record; n integer := 0;
BEGIN
  FOR r IN SELECT id FROM public.shipstation_orders
            WHERE raw_payload @? '$.items[*] ? (@.adjustment == true)'
  LOOP
    n := n + public.fn_parse_shipstation_discounts(r.id);
  END LOOP;
  RAISE NOTICE 'shipstation_order_discounts backfilled: % lines', n;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Code classification
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.mkt_discount_codes (
  code        text PRIMARY KEY,                 -- lower(trim(name)) as in shipstation_order_discounts.code
  kind        text NOT NULL CHECK (kind IN ('sale', 'everyday', 'operational')),
  sale_id     uuid REFERENCES public.mkt_sales(id) ON DELETE SET NULL,
  label       text,
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.mkt_discount_codes IS
  'Classifies adjustment names: sale (a promotion code; sale_id when the sale exists in mkt_sales), everyday (always-on flow/welcome/cart codes), operational (shiptection, broken, defective...). Unlisted names count as "other" codes.';

ALTER TABLE public.mkt_discount_codes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mkt_discount_codes_read ON public.mkt_discount_codes;
CREATE POLICY mkt_discount_codes_read ON public.mkt_discount_codes FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS mkt_discount_codes_manage ON public.mkt_discount_codes;
CREATE POLICY mkt_discount_codes_manage ON public.mkt_discount_codes FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin', 'manager')))
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin', 'manager')));

INSERT INTO public.mkt_discount_codes (code, kind, label) VALUES
  ('shiptection adjustment', 'operational', 'Shiptection claim'),
  ('broken',                 'operational', 'Broken replacement'),
  ('defective',              'operational', 'Defective replacement'),
  ('leaking',                'operational', 'Leaking replacement'),
  ('missing item',           'operational', 'Missing item'),
  ('custom discount',        'operational', 'Custom discount (manual)'),
  ('discount',               'operational', 'Discount (manual)'),
  ('carbon',                 'operational', 'Carbon offset line'),
  ('chill10',         'everyday', 'Chill10'),
  ('chill15',         'everyday', 'Chill15'),
  ('cart15',          'everyday', 'Cart15'),
  ('sesh15',          'everyday', 'Sesh15'),
  ('cc63022',         'everyday', 'cc63022'),
  ('abandonedcart15', 'everyday', 'Abandoned cart 15'),
  ('abandonedcart10', 'everyday', 'Abandoned cart 10'),
  ('save15',          'everyday', 'Save15'),
  ('return15',        'everyday', 'Return15'),
  ('fp15off',         'everyday', 'FP15OFF'),
  ('upgrade10',       'everyday', 'Upgrade10'),
  ('raffle15',        'everyday', 'Raffle15'),
  ('welcomeback15',   'everyday', 'Welcome back 15'),
  ('vip15',           'everyday', 'VIP15'),
  ('vip20',           'everyday', 'VIP20'),
  ('flagrant',        'everyday', 'Flagrant'),
  ('freeze10',        'everyday', 'Freeze10'),
  ('ty25xlr',         'everyday', 'TY25XLR'),
  ('drenched',        'everyday', 'Drenched'),
  ('bears',           'everyday', 'Bears'),
  ('welcome10',       'everyday', 'Welcome10'),
  ('welcome15',       'everyday', 'Welcome15'),
  ('next15',          'everyday', 'Next15'),
  ('joey',            'everyday', 'Joey'),
  ('khan',            'everyday', 'Khan'),
  ('bundle',          'everyday', 'Bundle')
ON CONFLICT (code) DO NOTHING;

-- Sale codes: link to the 2026 sale rows by name where the sale exists.
INSERT INTO public.mkt_discount_codes (code, kind, sale_id, label, notes)
SELECT v.code, 'sale', s.id, v.label, v.notes
FROM (VALUES
  ('labor',   'Labor Day Sale',   2026, 'labor',   'Created 2020, 15% sitewide, no end date in Shopify'),
  ('fall10',  'Fall Sale',        2026, 'FALL10',  NULL),
  ('coil',    'Fall Sale',        2026, 'COIL',    'Free HT-5 coil with 8 bongs'),
  ('420',     '4/20 Sale',        2026, '420',     NULL),
  ('freedom', '4th of July Sale', 2026, 'freedom', NULL),
  ('liberty', '4th of July Sale', 2026, 'liberty', NULL),
  ('boom',    '4th of July Sale', 2026, 'boom',    NULL)
) AS v(code, sale_name, yr, label, notes)
LEFT JOIN public.mkt_sales s
  ON s.name = v.sale_name AND EXTRACT(YEAR FROM s.starts_at AT TIME ZONE 'UTC') = v.yr
ON CONFLICT (code) DO NOTHING;

-- Codes of past sales with no mkt_sales row (still redeeming).
INSERT INTO public.mkt_discount_codes (code, kind, label, notes) VALUES
  ('fall15', 'sale', 'fall15', 'Fall 2025 code, 15%, still active in Shopify'),
  ('cm20',   'sale', 'cm20',   'Cyber Monday 2025'),
  ('mother', 'sale', 'mother', 'Mother''s Day 2026'),
  ('jc20',   'sale', 'jc20',   'Joint chiller promo Aug 2026')
ON CONFLICT (code) DO NOTHING;

-- The Labor Day 2026 offer was entered without its code.
UPDATE public.mkt_offers o SET code = 'labor'
  FROM public.mkt_sales s
 WHERE o.sale_id = s.id AND s.name = 'Labor Day Sale'
   AND EXTRACT(YEAR FROM s.starts_at AT TIME ZONE 'UTC') = 2026
   AND (o.code IS NULL OR o.code = '');

-- ---------------------------------------------------------------------------
-- 5. ET helpers
-- ---------------------------------------------------------------------------
-- Stored ShipStation timestamps are Pacific wall-clock labelled UTC. This
-- returns the Eastern wall clock as a plain timestamp.
CREATE OR REPLACE FUNCTION public.fn_ss_et(ts timestamptz)
RETURNS timestamp
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT ((ts AT TIME ZONE 'UTC') AT TIME ZONE 'America/Los_Angeles') AT TIME ZONE 'America/New_York';
$$;

-- Order identity across ShipStation splits/duplicates: the order number
-- without a "-NN" split suffix.
CREATE OR REPLACE FUNCTION public.fn_ss_order_key(order_number text)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT regexp_replace(COALESCE(order_number, ''), '-[0-9]{1,3}$', '');
$$;

CREATE INDEX IF NOT EXISTS ss_orders_et_day_idx
  ON public.shipstation_orders ((public.fn_ss_et(order_date)::date));
CREATE INDEX IF NOT EXISTS ss_orders_email_lower_idx
  ON public.shipstation_orders (lower(customer_email), order_date);
CREATE INDEX IF NOT EXISTS ss_orders_store_idx ON public.shipstation_orders (store_id);

-- Which stores a sale reads.
CREATE OR REPLACE FUNCTION public.fn_sale_store_ids(p_sale_id uuid)
RETURNS bigint[]
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT s.store_ids FROM mkt_sales s WHERE s.id = p_sale_id AND s.store_ids IS NOT NULL AND cardinality(s.store_ids) > 0),
    (SELECT array_agg(store_id) FROM mkt_sale_stores WHERE counts_as_sale),
    ARRAY[229438]::bigint[]);
$$;

-- ---------------------------------------------------------------------------
-- 6. Frozen baseline
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.mkt_sale_baseline (
  sale_id           uuid PRIMARY KEY REFERENCES public.mkt_sales(id) ON DELETE CASCADE,
  computed_at       timestamptz NOT NULL DEFAULT now(),
  frozen            boolean NOT NULL DEFAULT false,   -- true once the sale has opened
  d1                date NOT NULL,                     -- first selling day (EA if set)
  window_from       date NOT NULL,
  window_to         date NOT NULL,                     -- exclusive end of the pre-window
  clean_days        date[] NOT NULL,
  n_clean           integer NOT NULL,
  short             boolean NOT NULL,
  orders_day        numeric NOT NULL,
  units_day         numeric NOT NULL,
  dow_orders        numeric[] NOT NULL,                -- 7 entries, Sunday first, ratio to mean
  dow_units         numeric[] NOT NULL,
  hour_share        numeric[] NOT NULL,                -- 24 entries, cumulative share of clean-day orders by ET hour end
  new_share         numeric,
  everyday_disc_cents_per_order numeric,               -- everyday-code discount per order on clean days
  store_ids         bigint[] NOT NULL
);
COMMENT ON TABLE public.mkt_sale_baseline IS
  'Clean-day baseline per sale: event-free days before the sale, weekday shape, hour shape. Previewed until the sale opens, frozen from then on (rpc_ensure_sale_baseline).';
ALTER TABLE public.mkt_sale_baseline ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mkt_sale_baseline_read ON public.mkt_sale_baseline;
CREATE POLICY mkt_sale_baseline_read ON public.mkt_sale_baseline FOR SELECT TO authenticated USING (true);

-- Days inside any promotion window: other sales (early access through 14 days
-- after close) and promo-ledger windows + 14. Product launches are not
-- excluded (a drop is not a store-wide discount).
CREATE OR REPLACE FUNCTION public.fn_sale_event_days(p_sale_id uuid, p_from date, p_to date)
RETURNS SETOF date
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT DISTINCT g.d::date
    FROM generate_series(p_from, p_to, interval '1 day') g(d)
   WHERE EXISTS (SELECT 1 FROM mkt_sales s
                  WHERE s.id <> p_sale_id AND s.starts_at IS NOT NULL AND s.ends_at IS NOT NULL
                    AND g.d::date BETWEEN (COALESCE(s.early_access_starts_at, s.starts_at) AT TIME ZONE 'UTC')::date
                                      AND (s.ends_at AT TIME ZONE 'UTC')::date + 14)
      OR EXISTS (SELECT 1 FROM mkt_promo_history h
                  WHERE (h.sale_id IS NULL OR h.sale_id <> p_sale_id)
                    AND g.d::date BETWEEN h.d1 AND h.d2 + 14);
$$;

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
  v_win_to := v_d1;   -- exclusive: clean days end the day before the first selling day
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
REVOKE ALL ON FUNCTION public.rpc_ensure_sale_baseline(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_ensure_sale_baseline(uuid, boolean) TO authenticated;

-- ---------------------------------------------------------------------------
-- 7. rpc_sale_metrics — every raw input for one sale, as JSON
-- ---------------------------------------------------------------------------
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
  v_synced  timestamptz; v_run jsonb; v_unresolved int;
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
    'synced_at', v_synced, 'last_run', v_run, 'unresolved_orders', v_unresolved,
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

-- Settings writer: one call per setting, audited through row_version/updated_at.
CREATE OR REPLACE FUNCTION public.rpc_set_sale_setting(p_sale_id uuid, p_key text, p_value jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_role text;
BEGIN
  SELECT role INTO v_role FROM profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin', 'manager') THEN RAISE EXCEPTION 'not allowed'; END IF;
  IF p_key = 'plan_orders' THEN
    UPDATE mkt_sales SET plan_orders = NULLIF(p_value #>> '{}', '')::integer,
                         plan_source = CASE WHEN NULLIF(p_value #>> '{}', '') IS NULL THEN NULL ELSE 'planner' END,
                         updated_at = now()
     WHERE id = p_sale_id;
  ELSIF p_key = 'season_index' THEN
    UPDATE mkt_sales SET season_index = COALESCE((p_value #>> '{}')::numeric, 1), updated_at = now() WHERE id = p_sale_id;
  ELSIF p_key = 'cm_pct' THEN
    UPDATE mkt_sales SET cm_pct = COALESCE((p_value #>> '{}')::numeric, 55), updated_at = now() WHERE id = p_sale_id;
  ELSIF p_key = 'store_ids' THEN
    UPDATE mkt_sales SET store_ids = (SELECT array_agg(x::bigint) FROM jsonb_array_elements_text(p_value) x), updated_at = now()
     WHERE id = p_sale_id;
    PERFORM rpc_ensure_sale_baseline(p_sale_id, true);
  ELSE
    RAISE EXCEPTION 'unknown setting %', p_key;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.rpc_set_sale_setting(uuid, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_set_sale_setting(uuid, text, jsonb) TO authenticated;
