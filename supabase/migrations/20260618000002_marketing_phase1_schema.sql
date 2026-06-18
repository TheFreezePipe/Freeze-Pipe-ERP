-- =============================================================
-- Migration: Marketing module — Phase 1 schema
-- =============================================================
-- Purely ADDITIVE: new mkt_* tables only. No existing table, RPC, trigger,
-- or policy is touched. Tables reference product_skus / profiles read-only
-- via foreign keys (referencing a row never modifies it). Manual-entry CRUD;
-- no integrations, no inventory/financial writes. See docs/MARKETING_MODULE_PLAN.md.
--
-- Entities (Phase 1):
--   mkt_sales       — a sale (container); dates + status
--   mkt_offers      — composable child offers (% / $ / free-item / threshold / code)
--   mkt_offer_skus  — explicit SKU membership when an offer's scope = sku_set
--   mkt_launches    — product launches / drops / restocks (planned-SKU aware)
--   mkt_broadcasts  — email / SMS blasts, linked to the sale/launch they amplify
--
-- RLS: everyone authenticated can READ; only admin/manager can WRITE
-- (public.jwt_is_internal()). Mirrors the app's established table pattern.
-- =============================================================

-- Shared updated_at touch trigger for the mkt_* tables.
CREATE OR REPLACE FUNCTION public.mkt_touch_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $fn$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$fn$;

-- -------------------------------------------------------------
-- mkt_sales — the sale container
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.mkt_sales (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  starts_at   timestamptz,
  ends_at     timestamptz,
  status      text NOT NULL DEFAULT 'planned'
                CHECK (status IN ('planned','scheduled','live','ended','canceled')),
  notes       text,
  created_by  uuid DEFAULT auth.uid() REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mkt_sales_starts_at ON public.mkt_sales (starts_at);
CREATE INDEX IF NOT EXISTS idx_mkt_sales_ends_at   ON public.mkt_sales (ends_at);

-- -------------------------------------------------------------
-- mkt_offers — composable child offers of a sale
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.mkt_offers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id           uuid NOT NULL REFERENCES public.mkt_sales(id) ON DELETE CASCADE,
  label             text NOT NULL,
  code              text,
  scope             text NOT NULL DEFAULT 'sitewide'
                      CHECK (scope IN ('sitewide','category','sku_set')),
  -- a product_skus.display_category value when scope = 'category'
  category          text,
  percent_off       numeric CHECK (percent_off IS NULL OR (percent_off >= 0 AND percent_off <= 100)),
  dollar_off        numeric CHECK (dollar_off IS NULL OR dollar_off >= 0),
  free_item_sku_id  uuid REFERENCES public.product_skus(id) ON DELETE SET NULL,
  min_order_amount  numeric CHECK (min_order_amount IS NULL OR min_order_amount >= 0),
  buy_qty           integer CHECK (buy_qty IS NULL OR buy_qty > 0),
  get_qty           integer CHECK (get_qty IS NULL OR get_qty > 0),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mkt_offers_sale_id ON public.mkt_offers (sale_id);

-- -------------------------------------------------------------
-- mkt_offer_skus — explicit SKU membership (scope = 'sku_set')
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.mkt_offer_skus (
  offer_id  uuid NOT NULL REFERENCES public.mkt_offers(id) ON DELETE CASCADE,
  sku_id    uuid NOT NULL REFERENCES public.product_skus(id) ON DELETE CASCADE,
  PRIMARY KEY (offer_id, sku_id)
);
CREATE INDEX IF NOT EXISTS idx_mkt_offer_skus_sku_id ON public.mkt_offer_skus (sku_id);

-- -------------------------------------------------------------
-- mkt_launches — launches / drops / restocks (planned-SKU aware)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.mkt_launches (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                      text NOT NULL DEFAULT 'launch'
                              CHECK (kind IN ('launch','drop','restock')),
  -- null until the real SKU exists; planned_name holds the working name meanwhile
  sku_id                    uuid REFERENCES public.product_skus(id) ON DELETE SET NULL,
  planned_name              text,
  launch_date               date,
  inventory_ready_by        date,
  limited_qty               integer CHECK (limited_qty IS NULL OR limited_qty >= 0),
  preorder                  boolean NOT NULL DEFAULT false,
  expected_first_30d_units  integer CHECK (expected_first_30d_units IS NULL OR expected_first_30d_units >= 0),
  planner_confidence        integer CHECK (planner_confidence IS NULL OR (planner_confidence BETWEEN 1 AND 5)),
  status                    text NOT NULL DEFAULT 'planned'
                              CHECK (status IN ('planned','scheduled','live','sold_out','ended','canceled')),
  notes                     text,
  created_by                uuid DEFAULT auth.uid() REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  -- a launch must identify its product somehow
  CONSTRAINT mkt_launches_identity CHECK (sku_id IS NOT NULL OR planned_name IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_mkt_launches_launch_date ON public.mkt_launches (launch_date);

-- -------------------------------------------------------------
-- mkt_broadcasts — email / SMS blasts
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.mkt_broadcasts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel           text NOT NULL CHECK (channel IN ('email','sms')),
  name              text NOT NULL,
  scheduled_at      timestamptz,
  sent_at           timestamptz,
  audience_segment  text,
  audience_size     integer CHECK (audience_size IS NULL OR audience_size >= 0),
  sale_id           uuid REFERENCES public.mkt_sales(id) ON DELETE SET NULL,
  launch_id         uuid REFERENCES public.mkt_launches(id) ON DELETE SET NULL,
  -- channel-specific metrics (email: opens/clicks/revenue/recipients;
  -- sms: clicks/revenue/recipients). Manually entered in v1.
  metrics           jsonb,
  created_by        uuid DEFAULT auth.uid() REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mkt_broadcasts_scheduled_at ON public.mkt_broadcasts (scheduled_at);

-- -------------------------------------------------------------
-- updated_at triggers
-- -------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_mkt_sales_touch ON public.mkt_sales;
CREATE TRIGGER trg_mkt_sales_touch BEFORE UPDATE ON public.mkt_sales
  FOR EACH ROW EXECUTE FUNCTION public.mkt_touch_updated_at();
DROP TRIGGER IF EXISTS trg_mkt_offers_touch ON public.mkt_offers;
CREATE TRIGGER trg_mkt_offers_touch BEFORE UPDATE ON public.mkt_offers
  FOR EACH ROW EXECUTE FUNCTION public.mkt_touch_updated_at();
DROP TRIGGER IF EXISTS trg_mkt_launches_touch ON public.mkt_launches;
CREATE TRIGGER trg_mkt_launches_touch BEFORE UPDATE ON public.mkt_launches
  FOR EACH ROW EXECUTE FUNCTION public.mkt_touch_updated_at();
DROP TRIGGER IF EXISTS trg_mkt_broadcasts_touch ON public.mkt_broadcasts;
CREATE TRIGGER trg_mkt_broadcasts_touch BEFORE UPDATE ON public.mkt_broadcasts
  FOR EACH ROW EXECUTE FUNCTION public.mkt_touch_updated_at();

-- -------------------------------------------------------------
-- Grants + RLS — read = any authenticated; write = admin/manager
-- (public.jwt_is_internal()). Two policies per table: an open SELECT plus a
-- manage-ALL gated to internal staff (policies are OR'd, so reads stay open).
-- -------------------------------------------------------------
DO $rls$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['mkt_sales','mkt_offers','mkt_offer_skus','mkt_launches','mkt_broadcasts']
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated;', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', t);

    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I;', t || '_read', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (true);',
      t || '_read', t);

    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I;', t || '_manage', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (public.jwt_is_internal()) WITH CHECK (public.jwt_is_internal());',
      t || '_manage', t);
  END LOOP;
END
$rls$;

-- Record into the migration ledger (this project applies via psql and
-- records the version explicitly).
INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES
  ('20260618000002', 'marketing_phase1_schema')
ON CONFLICT (version) DO NOTHING;
