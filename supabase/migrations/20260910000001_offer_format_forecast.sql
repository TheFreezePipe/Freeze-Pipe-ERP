-- =============================================================
-- Offer formats + Forecast box (2026-09-10)
-- =============================================================
-- 1. mkt_offers gains a required `format` (one of six owner-approved
--    shapes) with a per-format shape CHECK, plus the Forecast-box columns:
--    derived_* (written from rpc_offer_forecast_defaults on every save),
--    planner overrides (expected_uplift_pct / expected_orders /
--    planner_gift_units - NULL means "use derived"), actual_* (post-sale
--    measurement) and post14_ratio.
-- 2. mkt_is_holiday_window(date): Oct 20 - Jan 10 or Apr 1 - 25.
-- 3. mkt_promo_history: the measured promo ledger (28 backfill rows,
--    2024-07 .. 2026-09) that the lift priors are built from.
-- 4. mkt_lift_priors: median lift / post-14d ratio per
--    (format, depth_band, scope_class, season) with parent + season rows.
-- 5. rpc_offer_forecast_defaults(...): the forecast defaults the dialog
--    shows (lift, depth, orders, attach, gift units, after ratio).
-- 6. mkt_offer_sku_expansion: uplift_pct now falls back to derived lift;
--    new gift_units column on the gift row.

-- ---- 1. mkt_offers columns ---------------------------------------------

ALTER TABLE public.mkt_offers
  ADD COLUMN IF NOT EXISTS format text,
  ADD COLUMN IF NOT EXISTS once_per_order boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS derived_lift_pct numeric,
  ADD COLUMN IF NOT EXISTS derived_orders integer,
  ADD COLUMN IF NOT EXISTS derived_attach_pct numeric,
  ADD COLUMN IF NOT EXISTS derived_gift_units integer,
  ADD COLUMN IF NOT EXISTS planner_gift_units integer,
  ADD COLUMN IF NOT EXISTS derived_at timestamptz,
  ADD COLUMN IF NOT EXISTS defaults_source jsonb,
  ADD COLUMN IF NOT EXISTS actual_lift_pct numeric,
  ADD COLUMN IF NOT EXISTS actual_orders integer,
  ADD COLUMN IF NOT EXISTS actual_gift_units integer,
  ADD COLUMN IF NOT EXISTS actual_attach_pct numeric,
  ADD COLUMN IF NOT EXISTS post14_ratio numeric;

COMMENT ON COLUMN public.mkt_offers.format IS
  'percent | dollar | gift_min | gift_skus | gift_code | bxgy. Owns which value columns may be non-NULL (see mkt_offers_format_shape_check).';
COMMENT ON COLUMN public.mkt_offers.once_per_order IS
  'dollar format, targeted scope: the $ off applies once per order rather than per qualifying line.';
COMMENT ON COLUMN public.mkt_offers.expected_uplift_pct IS
  'Planner override of lift. NULL = use derived_lift_pct.';
COMMENT ON COLUMN public.mkt_offers.expected_orders IS
  'Planner override of orders. NULL = use derived_orders.';
COMMENT ON COLUMN public.mkt_offers.planner_gift_units IS
  'Planner override / cap of gift units. NULL = use derived_gift_units.';
COMMENT ON COLUMN public.mkt_offers.defaults_source IS
  'Verbatim rpc_offer_forecast_defaults result at last save (lift_source, orders_source, attach_source, cell ...).';

-- Backfill: gift offers default to one gift unit.
UPDATE public.mkt_offers
   SET get_qty = 1
 WHERE free_item_sku_id IS NOT NULL AND get_qty IS NULL;

-- Backfill: classify existing rows into a format.
UPDATE public.mkt_offers
   SET format = CASE
     WHEN free_item_sku_id IS NULL AND buy_qty IS NOT NULL AND get_qty IS NOT NULL
          AND percent_off IS NULL AND dollar_off IS NULL                          THEN 'bxgy'
     WHEN free_item_sku_id IS NULL AND percent_off IS NOT NULL                    THEN 'percent'
     WHEN free_item_sku_id IS NULL AND dollar_off IS NOT NULL                     THEN 'dollar'
     WHEN free_item_sku_id IS NOT NULL AND min_order_amount IS NOT NULL
          AND scope = 'sitewide'                                                  THEN 'gift_min'
     WHEN free_item_sku_id IS NOT NULL AND scope IN ('category', 'sku_set')
          AND percent_off IS NULL AND dollar_off IS NULL AND code IS NULL         THEN 'gift_skus'
     WHEN free_item_sku_id IS NOT NULL AND code IS NOT NULL                       THEN 'gift_code'
   END
 WHERE format IS NULL;

-- gift_skus keeps buy_qty = 1 (qualifier count) for the expansion view /
-- describeOffer legacy branch.
UPDATE public.mkt_offers SET buy_qty = 1 WHERE format = 'gift_skus' AND buy_qty IS NULL;
-- Formats that do not own min_order_amount must not carry one.
UPDATE public.mkt_offers SET min_order_amount = NULL
 WHERE format IN ('gift_skus', 'gift_code', 'bxgy') AND min_order_amount IS NOT NULL;
-- A threshold gift never has a qualifier count (the old form could save
-- buy_qty beside a free item + min order; that shape is the gift_min trap).
UPDATE public.mkt_offers SET buy_qty = NULL
 WHERE format = 'gift_min' AND buy_qty IS NOT NULL;

ALTER TABLE public.mkt_offers DROP CONSTRAINT IF EXISTS mkt_offers_format_check;
ALTER TABLE public.mkt_offers ADD CONSTRAINT mkt_offers_format_check
  CHECK (format IN ('percent', 'dollar', 'gift_min', 'gift_skus', 'gift_code', 'bxgy'));

-- One CHECK per format: the columns a format owns must be set, every other
-- value column must be NULL. `code` is allowed on all formats (blank =
-- automatic) and required on gift_code.
ALTER TABLE public.mkt_offers DROP CONSTRAINT IF EXISTS mkt_offers_format_shape_check;
ALTER TABLE public.mkt_offers ADD CONSTRAINT mkt_offers_format_shape_check CHECK (
  CASE format
    WHEN 'percent' THEN
          percent_off IS NOT NULL AND percent_off >= 1 AND percent_off <= 100
      AND dollar_off IS NULL AND free_item_sku_id IS NULL
      AND buy_qty IS NULL AND get_qty IS NULL
      AND (min_order_amount IS NULL OR scope = 'sitewide')
    WHEN 'dollar' THEN
          dollar_off IS NOT NULL AND dollar_off > 0
      AND percent_off IS NULL AND free_item_sku_id IS NULL
      AND buy_qty IS NULL AND get_qty IS NULL
      AND (min_order_amount IS NULL OR scope = 'sitewide')
    WHEN 'gift_min' THEN
          free_item_sku_id IS NOT NULL
      AND get_qty IS NOT NULL AND get_qty >= 1
      AND min_order_amount IS NOT NULL AND min_order_amount > 0
      AND scope = 'sitewide'
      AND percent_off IS NULL AND dollar_off IS NULL AND buy_qty IS NULL
    WHEN 'gift_skus' THEN
          free_item_sku_id IS NOT NULL
      AND get_qty IS NOT NULL AND get_qty >= 1
      AND scope IN ('category', 'sku_set')
      AND buy_qty = 1
      AND min_order_amount IS NULL AND percent_off IS NULL AND dollar_off IS NULL
    WHEN 'gift_code' THEN
          code IS NOT NULL AND btrim(code) <> ''
      AND free_item_sku_id IS NOT NULL
      AND get_qty IS NOT NULL AND get_qty >= 1
      AND NOT (percent_off IS NOT NULL AND dollar_off IS NOT NULL)
      AND (percent_off IS NOT NULL OR dollar_off IS NOT NULL OR scope = 'sitewide')
      AND (percent_off IS NULL OR (percent_off >= 1 AND percent_off <= 100))
      AND (dollar_off IS NULL OR dollar_off > 0)
      AND min_order_amount IS NULL AND buy_qty IS NULL
    WHEN 'bxgy' THEN
          buy_qty IS NOT NULL AND buy_qty >= 1
      AND get_qty IS NOT NULL AND get_qty >= 1
      AND scope IN ('category', 'sku_set')
      AND free_item_sku_id IS NULL AND percent_off IS NULL AND dollar_off IS NULL
      AND min_order_amount IS NULL
    ELSE false
  END
);

ALTER TABLE public.mkt_offers ALTER COLUMN format SET NOT NULL;

-- ---- 2. Holiday window ---------------------------------------------------

CREATE OR REPLACE FUNCTION public.mkt_is_holiday_window(d date)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT d IS NOT NULL AND (
       (EXTRACT(MONTH FROM d) = 10 AND EXTRACT(DAY FROM d) >= 20)
    OR  EXTRACT(MONTH FROM d) IN (11, 12)
    OR (EXTRACT(MONTH FROM d) = 1  AND EXTRACT(DAY FROM d) <= 10)
    OR (EXTRACT(MONTH FROM d) = 4  AND EXTRACT(DAY FROM d) <= 25)
  );
$$;

COMMENT ON FUNCTION public.mkt_is_holiday_window(date) IS
  'True when the date sits in a holiday demand window: Oct 20 - Jan 10 or Apr 1 - 25.';

-- ---- 3. mkt_promo_history ------------------------------------------------

CREATE TABLE IF NOT EXISTS public.mkt_promo_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id uuid NULL REFERENCES public.mkt_sales(id) ON DELETE SET NULL,
  name text NOT NULL,
  d1 date NOT NULL,
  d2 date NOT NULL,
  format text NOT NULL CHECK (format IN ('percent', 'dollar', 'gift_min', 'gift_skus', 'gift_code', 'bxgy', 'none')),
  depth_pct numeric,
  depth_band text CHECK (depth_band IN ('low', 'mid', 'high')),
  scope_class text CHECK (scope_class IN ('sitewide', 'targeted')),
  season text CHECK (season IN ('holiday', 'other')),
  holiday boolean NOT NULL DEFAULT false,
  orders integer,
  units integer,
  baseline_daily numeric,
  lift_pct numeric,
  orders_lift_pct numeric,
  post14_ratio numeric,
  attach_pct numeric,
  phase text CHECK (phase IN ('ea', 'main', 'full')),
  source text NOT NULL CHECK (source IN ('backfill', 'measured')),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (d2 >= d1)
);

COMMENT ON TABLE public.mkt_promo_history IS
  'Measured promo ledger. lift_pct = catalog units during the window vs the trailing-28d clean baseline. Rows with format=none or phase=ea are kept for clean-day exclusion but excluded from mkt_lift_priors.';

ALTER TABLE public.mkt_promo_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mkt_promo_history_read ON public.mkt_promo_history;
CREATE POLICY mkt_promo_history_read
  ON public.mkt_promo_history FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS mkt_promo_history_manage ON public.mkt_promo_history;
CREATE POLICY mkt_promo_history_manage
  ON public.mkt_promo_history FOR ALL TO authenticated
  USING (public.jwt_is_internal()) WITH CHECK (public.jwt_is_internal());

CREATE INDEX IF NOT EXISTS mkt_promo_history_d1_idx ON public.mkt_promo_history (d1, d2);

-- Seed: 28 backfill rows measured 2026-09-09 from sales_daily + Shopify.
INSERT INTO public.mkt_promo_history
  (name, d1, d2, format, depth_pct, depth_band, scope_class, season, holiday, orders, units,
   baseline_daily, lift_pct, orders_lift_pct, post14_ratio, attach_pct, phase, source, notes)
SELECT v.name, v.d1::date, v.d2::date, v.format, v.depth_pct, v.depth_band, v.scope_class, v.season, v.holiday,
       v.orders, v.units, v.baseline_daily, v.lift_pct, v.orders_lift_pct, v.post14_ratio, v.attach_pct,
       v.phase, 'backfill', NULLIF(v.notes, '')
FROM (VALUES
  ('July 4 2024',         '2024-07-01', '2024-07-08', 'dollar',    15::numeric, 'mid',  'targeted', 'other',   false, 1076,  1470, NULL::numeric,  18.2::numeric,  18.2::numeric, 0.995::numeric, NULL::numeric, 'full', 'orders-based lift; sales_daily starts 2024-07-01'),
  ('Prime Day 2024',      '2024-10-09', '2024-10-16', 'dollar',    17, 'high', 'sitewide', 'other',   false, 1407,  2594, 265.7,  22,    4.6,  0.993, NULL, 'full', 'cart-threshold $ off; basket lift not traffic'),
  ('Halloween 2024',      '2024-10-25', '2024-10-31', 'percent',   10, 'low',  'sitewide', 'holiday', true,  1377,  2497, 270.1,  32.1,  16.4, 1.019, NULL, 'full', 'late-Oct ramp'),
  ('BF 2024 early',       '2024-11-11', '2024-11-21', 'dollar',    12, 'mid',  'targeted', 'holiday', true,  2391,  4725, 270.2,  59,    40.6, NULL,  NULL, 'ea',   'tiers + gift; post = main BF'),
  ('BF 2024 main',        '2024-11-22', '2024-12-01', 'dollar',    12, 'mid',  'targeted', 'holiday', true,  3670,  7205, 275.2,  161.8, 136,  NULL,  9.3,  'main', 'tiers + free gift 340 orders; 10 clean base days'),
  ('Cyber Monday 2024',   '2024-12-02', '2024-12-04', 'percent',   20, 'high', 'targeted', 'holiday', true,  1434,  2773, 266.4,  246.9, 211,  NULL,  NULL, 'full', '3-day season effect'),
  ('Evergreen 2024',      '2024-12-05', '2024-12-25', 'gift_code',  5, 'low',  'sitewide', 'holiday', true,  7802, 14052, 270.2,  147.7, 140,  1.144, 9.9,  'full', 'free stone code + 10% + flash codes'),
  ('New Year 2025',       '2025-01-05', '2025-01-12', 'dollar',    15, 'mid',  'targeted', 'holiday', true,  1662,  2967, 309.2,  19.9,  11.6, 1.049, NULL, 'full', 'holiday-elevated baseline'),
  ('Valentines 2025',     '2025-02-10', '2025-02-16', 'percent',   10, 'low',  'targeted', 'other',   false, 1517,  2562, 313.6,  16.7,  27.5, 0.864, NULL, 'full', 'full giveback'),
  ('St Patricks 2025',    '2025-03-16', '2025-03-22', 'dollar',    15, 'mid',  'targeted', 'other',   false, 1059,  2212, 251.6,  25.6,  13,   1.191, NULL, 'full', 'post = 420 pre-ramp'),
  ('420 2025',            '2025-04-04', '2025-04-22', 'percent',   20, 'high', 'sitewide', 'holiday', true,  3730,  9611, 269.1,  88,    53,   0.884, NULL, 'full', 'tiered function + keychain gift'),
  ('take20 2025',         '2025-04-28', '2025-05-04', 'percent',   20, 'high', 'targeted', 'other',   false, 1094,  2283, 263,    24,    23,   0.70,  NULL, 'full', 'post = May trough'),
  ('July 4 2025',         '2025-06-30', '2025-07-07', 'dollar',    12, 'mid',  'targeted', 'other',   false, 1354,  2519, 256.9,  22.6,  28,   1.016, NULL, 'full', ''),
  ('Labor Day 2025',      '2025-09-02', '2025-09-05', 'none',       0, 'low',  'sitewide', 'other',   false,  755,  1511, 280.3,  34.8,  25,   1.047, NULL, 'full', 'no code; holiday moment only'),
  ('Fall Prime Day 2025', '2025-10-06', '2025-10-13', 'percent',   15, 'mid',  'sitewide', 'other',   false, 1900,  3320, 305.3,  35.9,  48,   1.161, NULL, 'full', 'post = Q4 ramp'),
  ('BF 2025 early',       '2025-11-03', '2025-11-12', 'dollar',    15, 'mid',  'targeted', 'holiday', true,  2140,  4329, 363.6,  19.1,  9,    NULL,  8.0,  'ea',   'tiers + bottle gift'),
  ('BF 2025 main',        '2025-11-13', '2025-11-30', 'dollar',    15, 'mid',  'targeted', 'holiday', true,  5103, 11124, 365.1,  69.3,  44,   NULL,  24.5, 'main', 'tiers + bottle gift 1252 orders'),
  ('Cyber Monday 2025',   '2025-12-01', '2025-12-03', 'percent',   20, 'high', 'targeted', 'holiday', true,  1188,  2929, 363.6,  168.6, 102,  NULL,  45.9, 'full', 'cm20 + gift'),
  ('Evergreen 2025',      '2025-12-04', '2025-12-25', 'gift_code',  8, 'low',  'sitewide', 'holiday', true,  6929, 14052, 363.6,  75.7,  61,   1.062, 8.2,  'full', 'DNA coil code + holiday 10%'),
  ('New Year 2026',       '2025-12-29', '2026-01-11', 'dollar',    15, 'mid',  'targeted', 'holiday', true,  3130,  6018, 386,    11.4,  4,    1.028, NULL, 'full', '3 clean baseline days; unreliable'),
  ('Valentines 2026',     '2026-02-09', '2026-02-16', 'percent',   10, 'low',  'targeted', 'other',   false, 1974,  3728, 401.9,  15.9,  14,   0.90,  NULL, 'full', 'full giveback'),
  ('St Patricks 2026',    '2026-03-09', '2026-03-17', 'gift_code', 10, 'low',  'sitewide', 'other',   false, 1881,  4912, 357.8,  52.5,  10,   0.794, 17.3, 'full', 'koozie gift inflates units'),
  ('420 2026',            '2026-04-01', '2026-04-22', 'percent',   20, 'high', 'sitewide', 'holiday', true,  4656, 10075, 300.9,  52.2,  43,   0.868, 12.6, 'full', 'tiered function + discounted gift'),
  ('Mothers Day 2026',    '2026-05-07', '2026-05-10', 'percent',   10, 'low',  'targeted', 'other',   false,  520,  1032, 261.1,  -1.2,  0.4,  0.956, NULL, 'full', 'no lift'),
  ('July 4 2026',         '2026-06-29', '2026-07-06', 'dollar',    12, 'mid',  'targeted', 'other',   false, 1174,  2248, 215.5,  30.4,  36,   0.892, NULL, 'full', ''),
  ('JC20 Aug 2026',       '2026-08-13', '2026-08-21', 'dollar',    15, 'mid',  'targeted', 'other',   false, 1022,  2015, 202.3,  10.7,  19,   1.002, NULL, 'full', 'only its own line lifted'),
  ('Labor Day 2026 EA',   '2026-08-27', '2026-08-31', 'percent',   15, 'mid',  'sitewide', 'other',   false,  540,  1082, 214.8,  0.7,   9,    NULL,  NULL, 'ea',   'email-only early access'),
  ('Labor Day 2026',      '2026-09-01', '2026-09-08', 'percent',   15, 'mid',  'sitewide', 'other',   false, 1414,  2874, 218.9,  64.1,  76,   NULL,  NULL, 'main', 'provisional; measured mid-run')
) AS v(name, d1, d2, format, depth_pct, depth_band, scope_class, season, holiday, orders, units,
       baseline_daily, lift_pct, orders_lift_pct, post14_ratio, attach_pct, phase, notes)
WHERE NOT EXISTS (SELECT 1 FROM public.mkt_promo_history h WHERE h.name = v.name);

-- Link to the planned sale whose window overlaps the history window
-- (Labor Day 2026 EA + main -> "Labor Day Sale"; BF 2025 has no sale row).
UPDATE public.mkt_promo_history h
   SET sale_id = s.id
  FROM public.mkt_sales s
 WHERE h.sale_id IS NULL
   AND s.starts_at IS NOT NULL AND s.ends_at IS NOT NULL
   AND (COALESCE(s.early_access_starts_at, s.starts_at) AT TIME ZONE 'UTC')::date <= h.d2
   AND (s.ends_at AT TIME ZONE 'UTC')::date >= h.d1;

-- ---- 4. mkt_lift_priors --------------------------------------------------

DROP VIEW IF EXISTS public.mkt_lift_priors;
CREATE VIEW public.mkt_lift_priors
WITH (security_invoker = true) AS
WITH base AS (
  SELECT format, depth_band, scope_class, season, lift_pct, post14_ratio, source
    FROM public.mkt_promo_history
   WHERE format <> 'none' AND phase IN ('main', 'full')
)
SELECT 'cell'::text AS level, format, depth_band, scope_class, season,
       count(*)::int AS n,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY lift_pct)::numeric AS lift_pct,
       count(*) FILTER (WHERE source = 'measured')::int AS n_measured,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY post14_ratio)::numeric AS post14_ratio,
       count(post14_ratio)::int AS after_n
  FROM base
 GROUP BY format, depth_band, scope_class, season
UNION ALL
SELECT 'parent', format, NULL, NULL, season,
       count(*)::int,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY lift_pct)::numeric,
       count(*) FILTER (WHERE source = 'measured')::int,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY post14_ratio)::numeric,
       count(post14_ratio)::int
  FROM base
 GROUP BY format, season
UNION ALL
SELECT 'season', NULL, NULL, NULL, season,
       count(*)::int,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY lift_pct)::numeric,
       count(*) FILTER (WHERE source = 'measured')::int,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY post14_ratio)::numeric,
       count(post14_ratio)::int
  FROM base
 GROUP BY season;

COMMENT ON VIEW public.mkt_lift_priors IS
  'Lift priors from mkt_promo_history (format <> none, phase main|full). level=cell keyed (format, depth_band, scope_class, season); level=parent keyed (format, season); level=season keyed (season). lift_pct / post14_ratio are medians.';

-- ---- 5. rpc_offer_forecast_defaults ---------------------------------------

CREATE OR REPLACE FUNCTION public.rpc_offer_forecast_defaults(
  p_sale_id uuid,
  p_format text,
  p_scope text,
  p_category text,
  p_sku_ids uuid[],
  p_percent_off numeric,
  p_dollar_off numeric,
  p_min_order numeric,
  p_free_item_sku_id uuid,
  p_get_qty int,
  p_buy_qty int
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_scope text := COALESCE(p_scope, 'sitewide');
  v_scope_class text;
  v_get_qty int := GREATEST(COALESCE(p_get_qty, 1), 1);
  v_buy_qty int := GREATEST(COALESCE(p_buy_qty, 1), 1);

  v_start date;
  v_end date;
  v_ea date;
  v_main_days numeric;
  v_ea_days numeric := 0;
  v_holiday boolean := false;
  v_season text;

  v_members uuid[];
  v_member_price numeric;
  v_gift_price numeric;
  v_aov numeric;

  v_depth numeric;
  v_depth_band text;

  -- lift
  v_lift numeric;
  v_lift_source text;
  v_lift_n int;
  v_cell_lift numeric;
  v_cell_n int := 0;
  v_cell_measured int := 0;
  v_parent_lift numeric;
  v_parent_n int := 0;
  v_parent_measured int := 0;
  v_const numeric;
  v_w numeric;
  v_parent_value numeric;
  v_ly_lift numeric;
  v_ly_orders int;
  v_ly_found boolean := false;

  -- orders
  v_orders int;
  v_orders_source text;
  v_clean56 date[];
  v_clean28 date[];
  v_clean date[];
  v_base_orders numeric;
  v_base_days int;
  v_baseline numeric;
  v_units_now numeric;
  v_units_ly numeric;
  v_yoy numeric;

  -- attach
  v_attach numeric;
  v_attach_source text;
  v_attach_override numeric;
  v_orders90 int;
  v_gift_units int;

  -- after
  v_after_ratio numeric;
  v_after_n int;
BEGIN
  v_scope_class := CASE WHEN v_scope = 'sitewide' THEN 'sitewide' ELSE 'targeted' END;

  -- ---- sale window ------------------------------------------------------
  SELECT (s.starts_at AT TIME ZONE 'UTC')::date,
         (s.ends_at AT TIME ZONE 'UTC')::date,
         (s.early_access_starts_at AT TIME ZONE 'UTC')::date
    INTO v_start, v_end, v_ea
    FROM mkt_sales s
   WHERE s.id = p_sale_id;

  v_holiday := v_start IS NOT NULL AND mkt_is_holiday_window(v_start);
  v_season := CASE WHEN v_holiday THEN 'holiday' ELSE 'other' END;
  v_const := CASE WHEN v_holiday THEN 69 ELSE 23 END;

  IF v_start IS NOT NULL AND v_end IS NOT NULL AND v_end >= v_start THEN
    v_main_days := (v_end - v_start + 1)::numeric;
    IF v_ea IS NOT NULL AND v_ea < v_start THEN
      v_ea_days := (v_start - v_ea)::numeric;
    END IF;
  END IF;

  -- ---- member SKUs (qualifier / discounted set) ---------------------------
  IF v_scope = 'category' THEN
    SELECT array_agg(ps.id) INTO v_members
      FROM product_skus ps
     WHERE ps.is_active AND ps.display_category = p_category;
  ELSIF v_scope = 'sku_set' THEN
    v_members := p_sku_ids;
  ELSE
    SELECT array_agg(ps.id) INTO v_members FROM product_skus ps WHERE ps.is_active;
  END IF;
  v_members := COALESCE(v_members, ARRAY[]::uuid[]);

  SELECT avg(ps.retail_price) INTO v_member_price
    FROM product_skus ps
   WHERE ps.id = ANY (v_members) AND ps.retail_price > 0;

  IF p_free_item_sku_id IS NOT NULL THEN
    SELECT NULLIF(ps.retail_price, 0) INTO v_gift_price
      FROM product_skus ps WHERE ps.id = p_free_item_sku_id;
  END IF;

  -- last-90-day order book (subtotal = total - shipping - tax, cancelled excluded)
  SELECT count(*)::int,
         avg((o.order_total_cents - COALESCE(o.shipping_amount_cents, 0) - COALESCE(o.tax_amount_cents, 0)) / 100.0)
    INTO v_orders90, v_aov
    FROM shipstation_orders o
   WHERE o.order_date >= now() - interval '90 days'
     AND o.order_status IS DISTINCT FROM 'cancelled';
  IF v_orders90 = 0 THEN v_aov := NULL; END IF;

  -- ---- depth ---------------------------------------------------------------
  IF p_format = 'percent' THEN
    v_depth := p_percent_off;

  ELSIF p_format = 'dollar' THEN
    IF p_dollar_off IS NOT NULL AND v_member_price IS NOT NULL THEN
      v_depth := p_dollar_off / v_member_price * 100;
    END IF;

  ELSIF p_format = 'gift_min' THEN
    IF v_gift_price IS NOT NULL AND p_min_order IS NOT NULL THEN
      SELECT avg(sub.subtotal) INTO v_depth
        FROM (
          SELECT (o.order_total_cents - COALESCE(o.shipping_amount_cents, 0) - COALESCE(o.tax_amount_cents, 0)) / 100.0 AS subtotal
            FROM shipstation_orders o
           WHERE o.order_date >= now() - interval '90 days'
             AND o.order_status IS DISTINCT FROM 'cancelled'
        ) sub
       WHERE sub.subtotal >= p_min_order;
      IF v_depth IS NOT NULL AND v_depth > 0 THEN
        v_depth := v_gift_price / v_depth * 100;
      ELSE
        v_depth := NULL;
      END IF;
    END IF;

  ELSIF p_format = 'gift_skus' THEN
    IF v_gift_price IS NOT NULL AND cardinality(v_members) > 0 THEN
      SELECT avg((o.order_total_cents - COALESCE(o.shipping_amount_cents, 0) - COALESCE(o.tax_amount_cents, 0)) / 100.0)
        INTO v_depth
        FROM shipstation_orders o
       WHERE o.order_date >= now() - interval '90 days'
         AND o.order_status IS DISTINCT FROM 'cancelled'
         AND EXISTS (SELECT 1 FROM shipstation_order_items i
                      WHERE i.shipstation_order_id = o.id AND i.sku_id = ANY (v_members));
      IF v_depth IS NOT NULL AND v_depth > 0 THEN
        v_depth := v_gift_price / v_depth * 100;
      ELSE
        v_depth := NULL;
      END IF;
    END IF;

  ELSIF p_format = 'gift_code' THEN
    IF v_gift_price IS NOT NULL AND v_aov IS NOT NULL AND v_aov > 0 THEN
      v_depth := v_gift_price / v_aov * 100;
      IF p_percent_off IS NOT NULL THEN
        v_depth := v_depth + p_percent_off;
      ELSIF p_dollar_off IS NOT NULL THEN
        IF v_member_price IS NOT NULL THEN
          v_depth := v_depth + p_dollar_off / v_member_price * 100;
        ELSE
          v_depth := NULL;
        END IF;
      END IF;
    END IF;

  ELSIF p_format = 'bxgy' THEN
    IF v_member_price IS NOT NULL THEN
      v_depth := (v_get_qty * v_member_price)
               / ((v_buy_qty * v_member_price) + (v_get_qty * v_member_price)) * 100;
    END IF;
  END IF;

  v_depth := ROUND(v_depth, 1);
  v_depth_band := CASE
    WHEN v_depth IS NULL THEN NULL
    WHEN v_depth <= 10 THEN 'low'
    WHEN v_depth < 16 THEN 'mid'
    ELSE 'high'
  END;

  -- ---- lift ----------------------------------------------------------------
  SELECT lp.lift_pct, lp.n, lp.n_measured
    INTO v_cell_lift, v_cell_n, v_cell_measured
    FROM mkt_lift_priors lp
   WHERE lp.level = 'cell' AND lp.format = p_format AND lp.depth_band = v_depth_band
     AND lp.scope_class = v_scope_class AND lp.season = v_season;
  v_cell_n := COALESCE(v_cell_n, 0);
  v_cell_measured := COALESCE(v_cell_measured, 0);

  SELECT lp.lift_pct, lp.n, lp.n_measured
    INTO v_parent_lift, v_parent_n, v_parent_measured
    FROM mkt_lift_priors lp
   WHERE lp.level = 'parent' AND lp.format = p_format AND lp.season = v_season;
  v_parent_n := COALESCE(v_parent_n, 0);
  v_parent_measured := COALESCE(v_parent_measured, 0);

  -- parent value: parent median shrunk toward the season constant when thin
  IF v_parent_n >= 3 THEN
    v_parent_value := v_parent_lift;
  ELSIF v_parent_n > 0 THEN
    v_w := v_parent_n::numeric / (v_parent_n + 2);
    v_parent_value := v_w * v_parent_lift + (1 - v_w) * v_const;
  ELSE
    v_parent_value := v_const;
  END IF;

  IF v_cell_n >= 3 THEN
    v_lift := v_cell_lift;
    v_lift_n := v_cell_n;
  ELSIF v_cell_n > 0 THEN
    v_w := v_cell_n::numeric / (v_cell_n + 2);
    v_lift := v_w * v_cell_lift + (1 - v_w) * v_parent_value;
    v_lift_n := v_cell_n;
  ELSE
    v_lift := v_parent_value;
    v_lift_n := NULLIF(v_parent_n, 0);
  END IF;

  v_lift_source := CASE
    WHEN v_cell_measured >= 1 THEN 'measured'
    WHEN v_cell_n > 0 OR v_parent_n > 0 THEN 'seeded'
    ELSE 'default'
  END;

  -- holiday: last year's overlapping holiday promo wins (main/full preferred)
  IF v_holiday AND v_start IS NOT NULL THEN
    SELECT h.lift_pct, h.orders, true
      INTO v_ly_lift, v_ly_orders, v_ly_found
      FROM mkt_promo_history h
     WHERE h.holiday
       AND h.format <> 'none'
       AND h.d1 <= (v_start - 365 + 7)
       AND h.d2 >= (v_start - 365 - 7)
     ORDER BY (h.phase = 'ea') ASC,
              (LEAST(h.d2, v_start - 365 + 7) - GREATEST(h.d1, v_start - 365 - 7)) DESC,
              h.d1 DESC
     LIMIT 1;
    IF v_ly_found AND v_ly_lift IS NOT NULL THEN
      v_lift := v_ly_lift;
      v_lift_source := 'last_year';
      v_lift_n := NULL;
    END IF;
  END IF;

  v_lift := ROUND(v_lift, 1);

  -- ---- clean days (not inside any planned sale or history window) --------
  SELECT array_agg(g.d::date ORDER BY g.d) INTO v_clean56
    FROM generate_series(current_date - 56, current_date - 1, interval '1 day') g(d)
   WHERE NOT EXISTS (
           SELECT 1 FROM mkt_sales s
            WHERE s.starts_at IS NOT NULL AND s.ends_at IS NOT NULL
              AND g.d::date BETWEEN (COALESCE(s.early_access_starts_at, s.starts_at) AT TIME ZONE 'UTC')::date
                                AND (s.ends_at AT TIME ZONE 'UTC')::date)
     AND NOT EXISTS (
           SELECT 1 FROM mkt_promo_history h
            WHERE g.d::date BETWEEN h.d1 AND h.d2);
  v_clean56 := COALESCE(v_clean56, ARRAY[]::date[]);
  SELECT array_agg(d) INTO v_clean28 FROM unnest(v_clean56) d WHERE d >= current_date - 28;
  v_clean28 := COALESCE(v_clean28, ARRAY[]::date[]);
  v_clean := CASE WHEN cardinality(v_clean28) >= 10 THEN v_clean28 ELSE v_clean56 END;
  v_base_days := cardinality(v_clean);

  IF v_base_days > 0 THEN
    SELECT count(*)::numeric INTO v_base_orders
      FROM shipstation_orders o
     WHERE (o.order_date AT TIME ZONE 'UTC')::date = ANY (v_clean)
       AND o.order_status IS DISTINCT FROM 'cancelled';
    v_baseline := v_base_orders / v_base_days;
  END IF;

  -- ---- orders --------------------------------------------------------------
  IF v_holiday AND v_ly_found AND v_ly_orders IS NOT NULL AND cardinality(v_clean56) > 0 THEN
    SELECT COALESCE(sum(sd.units), 0) INTO v_units_now
      FROM sales_daily sd WHERE sd.sale_date = ANY (v_clean56);
    SELECT COALESCE(sum(sd.units), 0) INTO v_units_ly
      FROM sales_daily sd
     WHERE sd.sale_date = ANY (SELECT (d - 365)::date FROM unnest(v_clean56) d);
    IF v_units_ly > 0 THEN
      v_yoy := v_units_now / v_units_ly;
      v_orders := ROUND(v_ly_orders * v_yoy)::int;
      v_orders_source := 'last_year';
    END IF;
  END IF;

  IF v_orders IS NULL AND v_baseline IS NOT NULL AND v_baseline > 0 AND v_main_days IS NOT NULL THEN
    v_orders := ROUND(v_baseline * (v_main_days + 0.3 * v_ea_days) * (1 + COALESCE(v_lift, 0) / 100))::int;
    v_orders_source := 'derived';
  END IF;

  -- ---- attach --------------------------------------------------------------
  IF p_format IN ('gift_min', 'gift_skus', 'gift_code', 'bxgy') THEN
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY o.actual_attach_pct)
      INTO v_attach_override
      FROM mkt_offers o
     WHERE o.format = p_format AND o.actual_attach_pct IS NOT NULL;

    IF v_attach_override IS NOT NULL THEN
      v_attach := v_attach_override;
      v_attach_source := 'measured';

    ELSIF p_format = 'gift_min' THEN
      IF p_min_order IS NOT NULL AND v_orders90 > 0 THEN
        SELECT count(*)::numeric / v_orders90 * 100 INTO v_attach
          FROM shipstation_orders o
         WHERE o.order_date >= now() - interval '90 days'
           AND o.order_status IS DISTINCT FROM 'cancelled'
           AND (o.order_total_cents - COALESCE(o.shipping_amount_cents, 0) - COALESCE(o.tax_amount_cents, 0)) / 100.0 >= p_min_order;
        v_attach_source := 'measured';
      END IF;

    ELSIF p_format = 'gift_skus' THEN
      IF cardinality(v_members) > 0 AND v_orders90 > 0 THEN
        SELECT count(*)::numeric / v_orders90 * 100 * 0.45 INTO v_attach
          FROM shipstation_orders o
         WHERE o.order_date >= now() - interval '90 days'
           AND o.order_status IS DISTINCT FROM 'cancelled'
           AND EXISTS (SELECT 1 FROM shipstation_order_items i
                        WHERE i.shipstation_order_id = o.id AND i.sku_id = ANY (v_members));
        v_attach_source := 'default';
      END IF;

    ELSIF p_format = 'gift_code' THEN
      v_attach := 17;
      v_attach_source := 'default';

    ELSIF p_format = 'bxgy' THEN
      IF cardinality(v_members) > 0 AND v_orders90 > 0 THEN
        SELECT count(*)::numeric / v_orders90 * 100 INTO v_attach
          FROM shipstation_orders o
         WHERE o.order_date >= now() - interval '90 days'
           AND o.order_status IS DISTINCT FROM 'cancelled'
           AND EXISTS (SELECT 1 FROM shipstation_order_items i
                        WHERE i.shipstation_order_id = o.id AND i.sku_id = ANY (v_members));
        v_attach_source := 'measured';
      END IF;
    END IF;

    v_attach := ROUND(v_attach, 1);
    IF v_orders IS NOT NULL AND v_attach IS NOT NULL THEN
      v_gift_units := ROUND(v_orders * v_attach / 100 * v_get_qty)::int;
    END IF;
  END IF;

  -- ---- after ratio -----------------------------------------------------------
  IF NOT v_holiday THEN
    SELECT lp.post14_ratio, lp.after_n INTO v_after_ratio, v_after_n
      FROM mkt_lift_priors lp
     WHERE lp.level = 'cell' AND lp.format = p_format AND lp.depth_band = v_depth_band
       AND lp.scope_class = v_scope_class AND lp.season = v_season
       AND lp.after_n >= 2;
    IF v_after_ratio IS NULL THEN v_after_n := NULL; END IF;
    v_after_ratio := ROUND(v_after_ratio, 3);
  END IF;

  RETURN jsonb_build_object(
    'lift_pct',      v_lift,
    'lift_source',   v_lift_source,
    'lift_n',        v_lift_n,
    'depth_pct',     v_depth,
    'orders',        v_orders,
    'orders_source', v_orders_source,
    'attach_pct',    v_attach,
    'attach_source', v_attach_source,
    'gift_units',    v_gift_units,
    'after_ratio',   v_after_ratio,
    'after_n',       v_after_n,
    'holiday',       v_holiday,
    'cell', jsonb_build_object(
      'format',      p_format,
      'depth_band',  v_depth_band,
      'scope_class', v_scope_class,
      'season',      v_season
    )
  );
END;
$$;

COMMENT ON FUNCTION public.rpc_offer_forecast_defaults(uuid, text, text, text, uuid[], numeric, numeric, numeric, uuid, int, int) IS
  'Forecast-box defaults for an offer being edited: lift (cell prior / last-year holiday match), depth, orders (clean-day baseline or last-year x YoY), attach, gift units, post-14d ratio. Never raises; nulls where data is missing.';

-- ---- 6. Expansion view: derived lift fallback + gift_units --------------

CREATE OR REPLACE VIEW public.mkt_offer_sku_expansion
WITH (security_invoker = true) AS
SELECT o.id AS offer_id,
       s.id AS sale_id,
       s.name AS sale_name,
       s.starts_at,
       s.ends_at,
       s.annual_recurring,
       s.approval_status,
       o.scope,
       x.sku_id,
       CASE WHEN x.role = 'gift' THEN NULL ELSE COALESCE(x.percent_off, o.percent_off) END AS percent_off,
       CASE WHEN x.role = 'gift' THEN NULL ELSE COALESCE(x.dollar_off, o.dollar_off) END AS dollar_off,
       CASE WHEN x.role = 'gift' THEN NULL ELSE COALESCE(o.expected_uplift_pct, o.derived_lift_pct) END AS uplift_pct,
       CASE WHEN x.role = 'gift' THEN NULL ELSE COALESCE(o.effective_discount_pct, x.percent_off, o.percent_off) END AS effective_discount_pct,
       x.role,
       o.get_qty,
       o.expected_orders,
       s.early_access_starts_at,
       CASE WHEN x.role = 'gift' THEN COALESCE(o.planner_gift_units, o.derived_gift_units) END AS gift_units
FROM public.mkt_offers o
JOIN public.mkt_sales s ON s.id = o.sale_id
JOIN LATERAL (
  SELECT ps.id AS sku_id, NULL::numeric AS percent_off, NULL::numeric AS dollar_off, 'member'::text AS role
    FROM public.product_skus ps
   WHERE o.scope = 'sitewide' AND ps.is_active
  UNION ALL
  SELECT ps.id, NULL::numeric, NULL::numeric, 'member'
    FROM public.product_skus ps
   WHERE o.scope = 'category' AND ps.is_active AND ps.display_category = o.category
  UNION ALL
  SELECT os.sku_id, os.percent_off, os.dollar_off, 'member'
    FROM public.mkt_offer_skus os
   WHERE o.scope = 'sku_set' AND os.offer_id = o.id
  UNION ALL
  -- the gift: one row whatever the qualifier scope is
  SELECT o.free_item_sku_id, NULL::numeric, NULL::numeric, 'gift'
   WHERE o.free_item_sku_id IS NOT NULL
) x ON true;

COMMENT ON VIEW public.mkt_offer_sku_expansion IS
  'Resolves every offer to concrete SKUs. role=member: qualifier/discounted SKU by scope (sitewide->active catalog, category->display_category, sku_set->mkt_offer_skus); uplift_pct = planner override else derived lift. role=gift: the offer''s free_item_sku_id (any scope; no discount depth; excluded from lift); gift_units = planner override else derived. early_access_starts_at: the sale''s EA open, when set.';

-- ---- 7. Grants ---------------------------------------------------------------

GRANT SELECT ON public.mkt_promo_history TO authenticated, service_role;
GRANT SELECT ON public.mkt_lift_priors TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mkt_is_holiday_window(date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_offer_forecast_defaults(uuid, text, text, text, uuid[], numeric, numeric, numeric, uuid, int, int) TO authenticated, service_role;
