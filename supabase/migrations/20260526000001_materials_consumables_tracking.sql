-- =============================================================
-- Migration: Materials / consumables tracking
-- =============================================================
-- Adds inventory tracking for non-sellable inputs the team needs to
-- finish product but doesn't sell directly: glycerin (1L barrels),
-- plastic caps (multiple sizes), packaging boxes (8 standard sizes).
--
-- Architecture: 4 new tables parallel to product_skus / inventory_levels
-- / inventory_transactions / product_boms. Materials live in their own
-- table family rather than being flagged on product_skus because:
--   - Different metadata (no retail_price, no display_category, etc.)
--   - Different consumption model (derived from SKU production, not
--     customer demand / forecast)
--   - Avoids "WHERE is_consumable = false" filters everywhere a SKU
--     is read for sales / forecast / freight purposes
--
-- This migration is purely ADDITIVE — no changes to existing tables,
-- RPCs, triggers, or constraints. Safe to apply to production with
-- zero risk to existing data flows; the new tables sit unused until
-- the UI feature flag exposes them.
--
-- RLS pattern mirrors product_skus:
--   - All authenticated users can READ
--   - Admin/manager can manage (INSERT/UPDATE/DELETE)
--
-- Categories (constants live in src/lib/constants.ts):
--   "Filling Materials" (glycerin)
--   "Caps"             (plastic cap sizes)
--   "Packaging"        (boxes — 8 sizes from ShipStation dimension audit)
--   "Other"            (catchall)
-- =============================================================

-- -------------------------------------------------------------
-- A. materials — catalog
-- -------------------------------------------------------------
-- One row per consumable input. code is the human-readable identifier
-- (e.g. "GLYCERIN", "CAP-14MM", "BOX-12X5X5"). dim_* columns are
-- populated only for packaging materials so a lookup function can
-- map a ShipStation order's dimensions to the right box material.
CREATE TABLE IF NOT EXISTS public.materials (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code                 TEXT NOT NULL UNIQUE,
  name                 TEXT NOT NULL,
  category             TEXT NOT NULL,
  unit_of_measure      TEXT NOT NULL,           -- "L", "each", "kg", "box"
  unit_cost            NUMERIC(14, 4) NOT NULL DEFAULT 0,
  reorder_point_qty    NUMERIC(14, 4),          -- nullable; null = no alert
  lead_time_days       INTEGER,                 -- nullable; for runway forecasting
  supplier_id          UUID REFERENCES public.suppliers(id) ON DELETE SET NULL,
  -- Box-specific exact-match dimensions (inches). NULL for non-box
  -- materials. The ShipStation lookup function uses these for box
  -- consumption deduction; not used for non-box materials.
  dim_length_in        INTEGER,
  dim_width_in         INTEGER,
  dim_height_in        INTEGER,
  notes                TEXT,
  is_active            BOOLEAN NOT NULL DEFAULT true,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  row_version          INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT chk_materials_unit_cost_nonneg CHECK (unit_cost >= 0),
  CONSTRAINT chk_materials_reorder_point_nonneg CHECK (reorder_point_qty IS NULL OR reorder_point_qty >= 0),
  CONSTRAINT chk_materials_lead_time_nonneg CHECK (lead_time_days IS NULL OR lead_time_days >= 0),
  -- Dimensions are either all set (boxes) or all null (everything else).
  -- Prevents partial / nonsensical box rows.
  CONSTRAINT chk_materials_dims_coherent CHECK (
    (dim_length_in IS NULL AND dim_width_in IS NULL AND dim_height_in IS NULL)
    OR (dim_length_in IS NOT NULL AND dim_width_in IS NOT NULL AND dim_height_in IS NOT NULL
        AND dim_length_in > 0 AND dim_width_in > 0 AND dim_height_in > 0)
  )
);

CREATE INDEX IF NOT EXISTS idx_materials_category ON public.materials(category);
CREATE INDEX IF NOT EXISTS idx_materials_active   ON public.materials(is_active) WHERE is_active = true;
-- Unique partial index for the ShipStation dimension lookup. Lets us
-- INSERT box rows safely AND guarantees one box material per dimension
-- triple (so the lookup function always returns exactly one match).
CREATE UNIQUE INDEX IF NOT EXISTS uq_materials_box_dimensions
  ON public.materials(dim_length_in, dim_width_in, dim_height_in)
  WHERE dim_length_in IS NOT NULL;

CREATE TRIGGER trg_materials_updated_at
  BEFORE UPDATE ON public.materials
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

CREATE TRIGGER trg_materials_bump_row_version
  BEFORE UPDATE ON public.materials
  FOR EACH ROW EXECUTE FUNCTION public.bump_row_version();

-- -------------------------------------------------------------
-- B. material_inventory_levels — current on-hand per material
-- -------------------------------------------------------------
-- One row per material, mirrors inventory_levels' relationship to
-- product_skus. Updated by cycle counts (manual) or auto-deduction
-- from task_logs (deferred to Phase 6). The reorder-point alert
-- references this table's on_hand_qty against materials.reorder_point_qty.
CREATE TABLE IF NOT EXISTS public.material_inventory_levels (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  material_id          UUID NOT NULL UNIQUE REFERENCES public.materials(id) ON DELETE CASCADE,
  on_hand_qty          NUMERIC(14, 4) NOT NULL DEFAULT 0,
  last_counted_at      TIMESTAMPTZ,
  last_counted_by      UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_material_inv_nonneg CHECK (on_hand_qty >= 0)
);

CREATE TRIGGER trg_material_inv_updated_at
  BEFORE UPDATE ON public.material_inventory_levels
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- -------------------------------------------------------------
-- C. material_transactions — append-only audit log
-- -------------------------------------------------------------
-- Every change to a material's on_hand_qty writes a row here. Mirrors
-- inventory_transactions for SKUs. transaction_type values include:
--   'cycle_count'           — manual count adjustment
--   'task_consumption'      — auto-deducted when a fillable SKU is
--                             produced (Phase 6)
--   'shipstation_box_use'   — auto-deducted when a ShipStation order
--                             ingests with a matching box dimension (Phase 6)
--   'receipt'               — new stock arrived (cycle-count or manual entry)
--   'metadata'              — audit-only annotation, no qty change
CREATE TABLE IF NOT EXISTS public.material_transactions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  material_id          UUID NOT NULL REFERENCES public.materials(id) ON DELETE RESTRICT,
  transaction_type     TEXT NOT NULL,
  quantity_change      NUMERIC(14, 4) NOT NULL,
  reference_type       TEXT,
  reference_id         UUID,
  notes                TEXT,
  performed_by         UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_mt_reference_shape CHECK (
    (reference_id IS NULL AND reference_type IS NULL)
    OR (reference_id IS NOT NULL AND reference_type IS NOT NULL
        AND reference_type = ANY (ARRAY['material','task_log','shipstation_order','factory_order','profile']))
  ),
  CONSTRAINT chk_mt_notes_max_len CHECK (notes IS NULL OR length(notes) <= 4000)
);

CREATE INDEX IF NOT EXISTS idx_mt_material      ON public.material_transactions(material_id);
CREATE INDEX IF NOT EXISTS idx_mt_created       ON public.material_transactions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mt_performed_by  ON public.material_transactions(performed_by);
CREATE INDEX IF NOT EXISTS idx_mt_reference     ON public.material_transactions(reference_type, reference_id) WHERE reference_id IS NOT NULL;

-- Block UPDATE/DELETE on material_transactions — same append-only
-- pattern enforced on inventory_transactions and task_logs. Audit
-- integrity requires history never be edited in place; corrections
-- get a new offsetting transaction.
CREATE OR REPLACE FUNCTION public.block_material_transaction_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'material_transactions is append-only. UPDATE/DELETE is not permitted.'
    USING HINT = 'Log a new corrective transaction with a note explaining the fix.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_block_material_tx_update
  BEFORE UPDATE ON public.material_transactions
  FOR EACH ROW EXECUTE FUNCTION public.block_material_transaction_mutation();

CREATE TRIGGER trg_block_material_tx_delete
  BEFORE DELETE ON public.material_transactions
  FOR EACH ROW EXECUTE FUNCTION public.block_material_transaction_mutation();

-- -------------------------------------------------------------
-- D. sku_material_consumption — recipe table
-- -------------------------------------------------------------
-- "How much of material M does one unit of SKU S consume." Used to:
--   1. Compute pipeline_consumption (how much material will be used to
--      finish everything currently in production / raw / in-transit)
--   2. Auto-deduct material balances when task_logs records a finished
--      task (Phase 6)
--
-- One row per (sku_id, material_id) pair. quantity_per_unit is in
-- the material's unit_of_measure (e.g. 0.05 for glycerin in L,
-- 1 for caps in "each").
CREATE TABLE IF NOT EXISTS public.sku_material_consumption (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku_id               UUID NOT NULL REFERENCES public.product_skus(id) ON DELETE CASCADE,
  material_id          UUID NOT NULL REFERENCES public.materials(id) ON DELETE RESTRICT,
  quantity_per_unit    NUMERIC(14, 6) NOT NULL,
  notes                TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_smc_qty_positive CHECK (quantity_per_unit > 0),
  CONSTRAINT uq_smc_sku_material UNIQUE (sku_id, material_id)
);

CREATE INDEX IF NOT EXISTS idx_smc_sku      ON public.sku_material_consumption(sku_id);
CREATE INDEX IF NOT EXISTS idx_smc_material ON public.sku_material_consumption(material_id);

CREATE TRIGGER trg_smc_updated_at
  BEFORE UPDATE ON public.sku_material_consumption
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- -------------------------------------------------------------
-- E. RLS policies — admin/manager write, all authenticated read
-- -------------------------------------------------------------
ALTER TABLE public.materials                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.material_inventory_levels    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.material_transactions        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sku_material_consumption     ENABLE ROW LEVEL SECURITY;

-- SELECT (read) — any authenticated user
CREATE POLICY "Authenticated can read materials"
  ON public.materials FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated can read material inventory levels"
  ON public.material_inventory_levels FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated can read material transactions"
  ON public.material_transactions FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated can read sku material consumption"
  ON public.sku_material_consumption FOR SELECT TO authenticated USING (true);

-- ALL (write) — admin/manager only
CREATE POLICY "Admins can manage materials"
  ON public.materials FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = auth.uid() AND p.role IN ('admin', 'manager') AND p.is_active = true
  ));

CREATE POLICY "Admins can manage material inventory levels"
  ON public.material_inventory_levels FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = auth.uid() AND p.role IN ('admin', 'manager') AND p.is_active = true
  ));

CREATE POLICY "Admins can insert material transactions"
  ON public.material_transactions FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = auth.uid() AND p.role IN ('admin', 'manager') AND p.is_active = true
  ));

CREATE POLICY "Admins can manage sku material consumption"
  ON public.sku_material_consumption FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = auth.uid() AND p.role IN ('admin', 'manager') AND p.is_active = true
  ));

-- -------------------------------------------------------------
-- F. Grants for the Data API (Supabase will require these on new
--    tables from October 30 — adding upfront for consistency)
-- -------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON public.materials                 TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.materials                 TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.material_inventory_levels TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.material_inventory_levels TO service_role;

GRANT SELECT, INSERT                 ON public.material_transactions     TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.material_transactions     TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.sku_material_consumption  TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sku_material_consumption  TO service_role;

-- -------------------------------------------------------------
-- G. Seed catalog — 1 glycerin row + 8 box rows from the
--    dimension audit. Caps are intentionally NOT seeded; you'll
--    enter the specific sizes via the UI once you tell me which
--    sizes you stock. Glycerin starts with on_hand=0 and a
--    reorder point of 2 barrels (~416L) — typical 4-barrel order
--    means a 2-barrel low alerts you in time to reorder one cycle.
-- -------------------------------------------------------------
-- Materials catalog rows
INSERT INTO public.materials (
  code, name, category, unit_of_measure, unit_cost, reorder_point_qty, lead_time_days,
  dim_length_in, dim_width_in, dim_height_in
) VALUES
  ('GLYCERIN', 'Glycerin (55-gal drums)', 'Filling Materials', 'L', 0, 416, 7, NULL, NULL, NULL),
  -- Box rows. Dimensions verified against the 3,758-order ShipStation
  -- audit on 2026-05-22. Names are guesses you can rename via the UI.
  ('BOX-12X5X5',   'Pipe Box (12x5x5)',       'Packaging', 'each', 0, NULL, NULL, 12,  5,  5),
  ('BOX-14X12X6',  'Medium Box (14x12x6)',    'Packaging', 'each', 0, NULL, NULL, 14, 12,  6),
  ('BOX-18X12X8',  'Large Box (18x12x8)',     'Packaging', 'each', 0, NULL, NULL, 18, 12,  8),
  ('BOX-10X8X6',   'Small-Medium (10x8x6)',   'Packaging', 'each', 0, NULL, NULL, 10,  8,  6),
  ('BOX-4X4X4',    'Tiny Box (4x4x4)',        'Packaging', 'each', 0, NULL, NULL,  4,  4,  4),
  ('BOX-15X12X12', 'Square Box (15x12x12)',   'Packaging', 'each', 0, NULL, NULL, 15, 12, 12),
  ('BOX-18X16X8',  'Big Box (18x16x8)',       'Packaging', 'each', 0, NULL, NULL, 18, 16,  8),
  ('BOX-20X20X12', 'XL Box (20x20x12)',       'Packaging', 'each', 0, NULL, NULL, 20, 20, 12);

-- Inventory rows (all start at 0; first cycle count will populate).
INSERT INTO public.material_inventory_levels (material_id, on_hand_qty)
SELECT id, 0 FROM public.materials;
