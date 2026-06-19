-- =============================================================
-- Migration: launches become a titled event with member SKUs
-- =============================================================
-- A launch used to point at ONE product (sku_id / planned_name). Studio
-- Drops bundle several SKUs under one event, so we unify: every launch now
-- has a `name` (event title) + a list of member SKUs in mkt_launch_skus
-- (a normal launch is just a 1-member list). Per-SKU quantities live on each
-- member (expected units / limited qty / confidence). Adds the 'studio_drop'
-- kind. The single existing launch is backfilled into a member row.
-- =============================================================

-- 1. New launch-level title + member table -------------------
ALTER TABLE public.mkt_launches ADD COLUMN IF NOT EXISTS name text;

CREATE TABLE IF NOT EXISTS public.mkt_launch_skus (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  launch_id                 uuid NOT NULL REFERENCES public.mkt_launches(id) ON DELETE CASCADE,
  sku_id                    uuid REFERENCES public.product_skus(id) ON DELETE SET NULL,
  planned_name              text,
  expected_first_30d_units  integer CHECK (expected_first_30d_units IS NULL OR expected_first_30d_units >= 0),
  limited_qty               integer CHECK (limited_qty IS NULL OR limited_qty >= 0),
  planner_confidence        integer CHECK (planner_confidence IS NULL OR (planner_confidence BETWEEN 1 AND 5)),
  sort_order                integer NOT NULL DEFAULT 0,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mkt_launch_skus_identity CHECK (sku_id IS NOT NULL OR planned_name IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_mkt_launch_skus_launch ON public.mkt_launch_skus (launch_id);
CREATE INDEX IF NOT EXISTS idx_mkt_launch_skus_sku ON public.mkt_launch_skus (sku_id);

-- 2. Backfill existing single-product launches into member rows
INSERT INTO public.mkt_launch_skus
  (launch_id, sku_id, planned_name, expected_first_30d_units, limited_qty, planner_confidence)
SELECT id, sku_id, planned_name, expected_first_30d_units, limited_qty, planner_confidence
  FROM public.mkt_launches
 WHERE sku_id IS NOT NULL OR planned_name IS NOT NULL;

-- 3. Backfill the launch title from its old product / planned name
UPDATE public.mkt_launches l
   SET name = COALESCE(
     l.name,
     (SELECT ps.product_name FROM public.product_skus ps WHERE ps.id = l.sku_id),
     l.planned_name,
     'Launch'
   )
 WHERE l.name IS NULL;

ALTER TABLE public.mkt_launches ALTER COLUMN name SET NOT NULL;

-- 4. Add the studio_drop kind
ALTER TABLE public.mkt_launches DROP CONSTRAINT IF EXISTS mkt_launches_kind_check;
ALTER TABLE public.mkt_launches
  ADD CONSTRAINT mkt_launches_kind_check CHECK (kind IN ('launch','drop','restock','studio_drop'));

-- 5. Drop the now-per-member columns + the old single-product identity check
ALTER TABLE public.mkt_launches DROP CONSTRAINT IF EXISTS mkt_launches_identity;
ALTER TABLE public.mkt_launches DROP COLUMN IF EXISTS sku_id;
ALTER TABLE public.mkt_launches DROP COLUMN IF EXISTS planned_name;
ALTER TABLE public.mkt_launches DROP COLUMN IF EXISTS limited_qty;
ALTER TABLE public.mkt_launches DROP COLUMN IF EXISTS expected_first_30d_units;
ALTER TABLE public.mkt_launches DROP COLUMN IF EXISTS planner_confidence;

-- 6. updated_at trigger + grants + RLS for the member table
DROP TRIGGER IF EXISTS trg_mkt_launch_skus_touch ON public.mkt_launch_skus;
CREATE TRIGGER trg_mkt_launch_skus_touch BEFORE UPDATE ON public.mkt_launch_skus
  FOR EACH ROW EXECUTE FUNCTION public.mkt_touch_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON public.mkt_launch_skus TO authenticated;
ALTER TABLE public.mkt_launch_skus ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mkt_launch_skus_read ON public.mkt_launch_skus;
CREATE POLICY mkt_launch_skus_read ON public.mkt_launch_skus FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS mkt_launch_skus_manage ON public.mkt_launch_skus;
CREATE POLICY mkt_launch_skus_manage ON public.mkt_launch_skus FOR ALL TO authenticated
  USING (public.jwt_is_internal()) WITH CHECK (public.jwt_is_internal());

INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES
  ('20260618000005', 'launch_members_studio_drop')
ON CONFLICT (version) DO NOTHING;
