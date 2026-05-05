-- =============================================================
-- Migration 047: sku_economics.additional_raw_cost_reason
-- =============================================================
-- The `additional_raw_cost` column captures one-off costs that don't
-- fit cleanly into the per-supplier raw cost — e.g. tooling
-- amortization on BW64P, custom packaging fees, line-item charges
-- from a one-off vendor. Without a reason field every dollar in that
-- bucket is opaque six months later: "why is BW64P showing $1 extra
-- raw cost?" requires DM-ing whoever entered it.
--
-- This migration adds a free-form text column to capture that reason
-- inline with the cost. Optional (nullable). The SKU detail page
-- exposes a small input next to the dollar field; the SKU list shows
-- the reason as a hover tooltip on the Raw column when present.
-- =============================================================

ALTER TABLE sku_economics
  ADD COLUMN additional_raw_cost_reason TEXT;

COMMENT ON COLUMN sku_economics.additional_raw_cost_reason IS
  'Free-form note explaining what additional_raw_cost represents (e.g. "tooling amortization", "custom packaging fee"). Surfaced inline on the SKU detail + as a tooltip on the SKU list raw cost column.';

-- Sanity guard: column must land. If something prevented the ALTER
-- (extension privilege oddity etc.) the migration should fail loudly.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'sku_economics'
      AND column_name = 'additional_raw_cost_reason'
  ) THEN
    RAISE EXCEPTION 'Migration 047: additional_raw_cost_reason column failed to land';
  END IF;
END$$;
