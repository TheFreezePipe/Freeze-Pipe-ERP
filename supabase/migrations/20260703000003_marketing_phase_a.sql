-- =============================================================
-- Marketing Phase A (plan v0.3.1 section 0): connective schema
-- =============================================================
-- 1) Approval track on sales + launches: draft -> proposed -> confirmed,
--    stamped who/when. Orthogonal to the derived Upcoming/Live/Ended phase.
--    Ops confirmation is what later gates an event's uplift into the
--    forecast overlay (Phase C).
-- 2) Uplift-as-data on offers (percent over baseline, never absolute) +
--    per-SKU offer overrides — restoring what the original spec (§2.1) had.
-- 3) Backfill/sync hooks: source + external_ref for idempotent imports.
-- 4) annual_recurring guard flag (recurring events show + label history but
--    are NOT overlaid on the forecast — YoY baseline already contains them).
-- 5) mkt_offer_sku_expansion: THE scope→SKU resolver every downstream
--    consumer keys on (ops badges, digest, lift reports, forecast overlay).
-- 6) Hardening: date CHECK, category CHECK, launch-member uniqueness,
--    broadcast FK indexes.

-- ---- 1. Approval track --------------------------------------------------
ALTER TABLE public.mkt_sales
  ADD COLUMN IF NOT EXISTS approval_status text NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS ops_confirmed_by uuid REFERENCES public.profiles(id),
  ADD COLUMN IF NOT EXISTS ops_confirmed_at timestamptz;
ALTER TABLE public.mkt_sales DROP CONSTRAINT IF EXISTS mkt_sales_approval_check;
ALTER TABLE public.mkt_sales
  ADD CONSTRAINT mkt_sales_approval_check CHECK (approval_status IN ('draft', 'proposed', 'confirmed'));

ALTER TABLE public.mkt_launches
  ADD COLUMN IF NOT EXISTS approval_status text NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS ops_confirmed_by uuid REFERENCES public.profiles(id),
  ADD COLUMN IF NOT EXISTS ops_confirmed_at timestamptz;
ALTER TABLE public.mkt_launches DROP CONSTRAINT IF EXISTS mkt_launches_approval_check;
ALTER TABLE public.mkt_launches
  ADD CONSTRAINT mkt_launches_approval_check CHECK (approval_status IN ('draft', 'proposed', 'confirmed'));

-- ---- 2. Uplift as data ----------------------------------------------------
ALTER TABLE public.mkt_offers
  ADD COLUMN IF NOT EXISTS expected_uplift_pct numeric,
  ADD COLUMN IF NOT EXISTS effective_discount_pct numeric;
ALTER TABLE public.mkt_offer_skus
  ADD COLUMN IF NOT EXISTS percent_off numeric,
  ADD COLUMN IF NOT EXISTS dollar_off numeric,
  ADD COLUMN IF NOT EXISTS planner_uplift_pct numeric;

-- ---- 3. Import hooks -------------------------------------------------------
ALTER TABLE public.mkt_sales
  ADD COLUMN IF NOT EXISTS source text,
  ADD COLUMN IF NOT EXISTS external_ref text;
ALTER TABLE public.mkt_offers
  ADD COLUMN IF NOT EXISTS source text,
  ADD COLUMN IF NOT EXISTS external_ref text;
ALTER TABLE public.mkt_broadcasts
  ADD COLUMN IF NOT EXISTS source text,
  ADD COLUMN IF NOT EXISTS external_ref text;
CREATE UNIQUE INDEX IF NOT EXISTS ux_mkt_sales_source_ref
  ON public.mkt_sales (source, external_ref) WHERE source IS NOT NULL AND external_ref IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_mkt_offers_source_ref
  ON public.mkt_offers (source, external_ref) WHERE source IS NOT NULL AND external_ref IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_mkt_broadcasts_source_ref
  ON public.mkt_broadcasts (source, external_ref) WHERE source IS NOT NULL AND external_ref IS NOT NULL;

-- ---- 4. Recurring guard -----------------------------------------------------
ALTER TABLE public.mkt_sales
  ADD COLUMN IF NOT EXISTS annual_recurring boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.mkt_sales.annual_recurring IS
  'Annual events (BFCM, 4/20...) render + label history but their uplift is NOT overlaid on the forecast — the YoY baseline already contains them.';

-- ---- 5. Scope→SKU expansion view -------------------------------------------
-- security_invoker so callers hit the underlying tables' RLS (all readable
-- by authenticated). One row per (offer, sku) with resolved discount depth
-- and uplift; sitewide/category resolve against the live active catalog.
DROP VIEW IF EXISTS public.mkt_offer_sku_expansion;
CREATE VIEW public.mkt_offer_sku_expansion
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
       COALESCE(x.percent_off, o.percent_off) AS percent_off,
       COALESCE(x.dollar_off, o.dollar_off) AS dollar_off,
       COALESCE(x.planner_uplift_pct, o.expected_uplift_pct) AS uplift_pct,
       COALESCE(o.effective_discount_pct, x.percent_off, o.percent_off) AS effective_discount_pct
FROM public.mkt_offers o
JOIN public.mkt_sales s ON s.id = o.sale_id
JOIN LATERAL (
  SELECT ps.id AS sku_id, NULL::numeric AS percent_off, NULL::numeric AS dollar_off, NULL::numeric AS planner_uplift_pct
    FROM public.product_skus ps
   WHERE o.scope = 'sitewide' AND ps.is_active
  UNION ALL
  SELECT ps.id, NULL::numeric, NULL::numeric, NULL::numeric
    FROM public.product_skus ps
   WHERE o.scope = 'category' AND ps.is_active AND ps.display_category = o.category
  UNION ALL
  SELECT os.sku_id, os.percent_off, os.dollar_off, os.planner_uplift_pct
    FROM public.mkt_offer_skus os
   WHERE o.scope = 'sku_set' AND os.offer_id = o.id
) x ON true;

COMMENT ON VIEW public.mkt_offer_sku_expansion IS
  'Resolves every offer to concrete SKUs by scope (sitewide→active catalog, category→display_category, sku_set→mkt_offer_skus). The single source for "which SKUs are on sale when" — ops badges, digest, lift reports, forecast overlay all key on this.';

-- ---- 6. Hardening ------------------------------------------------------------
ALTER TABLE public.mkt_sales DROP CONSTRAINT IF EXISTS mkt_sales_dates_check;
ALTER TABLE public.mkt_sales
  ADD CONSTRAINT mkt_sales_dates_check CHECK (ends_at >= starts_at);
ALTER TABLE public.mkt_offers DROP CONSTRAINT IF EXISTS mkt_offers_category_scope_check;
ALTER TABLE public.mkt_offers
  ADD CONSTRAINT mkt_offers_category_scope_check CHECK (scope <> 'category' OR category IS NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS ux_mkt_launch_skus_launch_sku
  ON public.mkt_launch_skus (launch_id, sku_id) WHERE sku_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mkt_broadcasts_sale ON public.mkt_broadcasts (sale_id);
CREATE INDEX IF NOT EXISTS idx_mkt_broadcasts_launch ON public.mkt_broadcasts (launch_id);
