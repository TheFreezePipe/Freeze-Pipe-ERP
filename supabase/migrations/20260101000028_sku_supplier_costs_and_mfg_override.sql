-- =============================================================
-- Migration 028: per-supplier SKU costs + mfg cost overrides on sku_economics
-- =============================================================
-- Two SKU-detail-page features landed together:
--
--   A. sku_supplier_costs — per-(sku, supplier) unit cost rows. Supersedes
--      the hardcoded nancy_raw_cost / yx_raw_cost columns on sku_economics
--      by supporting arbitrary suppliers (Nancy, YX, and any "other" vendor
--      added to the suppliers table). One row per supplier per SKU. A
--      partial unique index enforces exactly one `is_primary = true` row
--      per SKU — that's the cost used in the raw-cost rollup. Secondary
--      rows preserve historical pricing for comparison.
--
--   B. sku_economics manufacturing-cost override fields — the SKU detail
--      page auto-derives "% prefilled" from freight arrivals (via
--      freight_line_items.quantity_prefilled from migration 027). These
--      columns let an admin pin a value, change the rolling window, or
--      both.
--
--   Note: the existing nancy_raw_cost / yx_raw_cost / pct_from_nancy /
--   pct_from_yx columns on sku_economics stay in place for now. New UI
--   reads from sku_supplier_costs; old columns are unused but not dropped
--   (avoids breaking any read paths we haven't refactored yet). Cleanup is
--   a follow-up.

-- =============================================================
-- A. sku_supplier_costs
-- =============================================================
CREATE TABLE sku_supplier_costs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku_id UUID NOT NULL REFERENCES product_skus(id) ON DELETE CASCADE,
  supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  unit_cost NUMERIC(10, 4) NOT NULL CHECK (unit_cost >= 0),
  -- Exactly one primary per SKU — this is the cost the SKU detail page uses
  -- for the raw-cost rollup. Secondary rows exist for reference only.
  is_primary BOOLEAN NOT NULL DEFAULT false,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  row_version INTEGER NOT NULL DEFAULT 1,
  -- One row per (sku, supplier) pair. Switching a supplier from primary
  -- to secondary happens via UPDATE on the existing row, not via delete+insert.
  CONSTRAINT uniq_sku_supplier_costs UNIQUE (sku_id, supplier_id)
);

-- At most one is_primary=true per sku. Partial unique index = database-
-- enforced "exactly one primary" without having to write a trigger.
CREATE UNIQUE INDEX uniq_sku_supplier_costs_primary
  ON sku_supplier_costs(sku_id)
  WHERE is_primary = true;

-- Lookup index for "what does this supplier charge across all their SKUs?"
CREATE INDEX idx_sku_supplier_costs_supplier
  ON sku_supplier_costs(supplier_id);

-- Row bookkeeping triggers consistent with the rest of the schema.
CREATE TRIGGER set_updated_at BEFORE UPDATE ON sku_supplier_costs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_bump_version_sku_supplier_costs
  BEFORE UPDATE ON sku_supplier_costs
  FOR EACH ROW EXECUTE FUNCTION bump_row_version();

-- RLS: authenticated users read, admin + manager write. Mirrors the
-- existing sku_economics policies.
ALTER TABLE sku_supplier_costs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can read sku supplier costs"
  ON sku_supplier_costs FOR SELECT TO authenticated USING (true);

CREATE POLICY "Admins can manage sku supplier costs"
  ON sku_supplier_costs FOR ALL TO authenticated
  USING (
    EXISTS (SELECT 1 FROM profiles
             WHERE id = auth.uid() AND role IN ('admin', 'manager'))
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM profiles
             WHERE id = auth.uid() AND role IN ('admin', 'manager'))
  );

COMMENT ON TABLE sku_supplier_costs IS
  'Per-supplier raw unit cost for a SKU. Exactly one row per (sku, supplier); exactly one is_primary per SKU.';

-- =============================================================
-- B. sku_economics — manufacturing-cost override fields
-- =============================================================
-- The SKU detail page's Manufacturing Cost section auto-derives the
-- prefilled/unfilled split from recent freight arrivals. These columns
-- let an admin pin a value (when the auto-derive is noisy) and/or change
-- the rolling window from the default 30 days.
ALTER TABLE sku_economics
  -- Admin-supplied prefilled % (0-100). NULL = use the auto-derived value.
  ADD COLUMN mfg_override_pct_prefilled NUMERIC(5, 2)
    CHECK (mfg_override_pct_prefilled IS NULL
           OR (mfg_override_pct_prefilled >= 0 AND mfg_override_pct_prefilled <= 100)),
  -- Explicit on/off so an admin can stash a value without using it yet.
  -- Belt-and-suspenders: even if the column above is set, the UI respects
  -- this flag. Keeps the "I'd like to remember that value but not apply it
  -- right now" pattern working cleanly.
  ADD COLUMN mfg_override_active BOOLEAN NOT NULL DEFAULT false,
  -- Rolling-window size for the auto-derive. Default 30, slider 30-90.
  ADD COLUMN mfg_window_days SMALLINT NOT NULL DEFAULT 30
    CHECK (mfg_window_days BETWEEN 30 AND 90);

COMMENT ON COLUMN sku_economics.mfg_override_pct_prefilled IS
  'Admin override for the prefilled % used in manufacturing cost. Applied only when mfg_override_active = true. NULL means no stashed override.';
COMMENT ON COLUMN sku_economics.mfg_override_active IS
  'Gate for mfg_override_pct_prefilled. When false, the SKU detail page uses the freight-derived ratio.';
COMMENT ON COLUMN sku_economics.mfg_window_days IS
  'Rolling-window size (days) for the freight-derived prefilled % on the SKU detail page.';
