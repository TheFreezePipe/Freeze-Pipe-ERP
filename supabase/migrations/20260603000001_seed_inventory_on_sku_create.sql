-- =============================================================
-- Auto-seed inventory_levels for every product SKU
-- =============================================================
-- Bug: a SKU with no inventory_levels row is invisible on the Stock
-- Levels page (useInventory selects FROM inventory_levels and joins the
-- product, so SKUs without a row are dropped) and can't be cycle-counted
-- or received. SKU Costs reads FROM product_skus, so the SKU still shows
-- there — producing the confusing "in SKU Costs but not Stock Levels"
-- mismatch. Found 4 active SKUs in this state on prod (BW22P, BW56-Base,
-- FP-Grinder, NB7-Base): they were created without an inventory row, and
-- nothing seeds one on SKU creation.
--
-- Fix, two parts:
--   1. Backfill — give every active, non-archived SKU that's missing one
--      a zero-stock inventory_levels row at the Main Warehouse.
--   2. Prevent recurrence — a trigger that seeds the row automatically on
--      every product_skus INSERT, covering all creation paths (UI, RPC,
--      bulk import, direct SQL).
--
-- Location: Main Warehouse (…100) is the operational inventory location —
-- all existing inventory_levels rows live there; Nancy Facility (…301)
-- intentionally has none. New SKUs follow the same convention rather than
-- getting orphan rows at unused locations.
-- =============================================================

-- -------------------------------------------------------------
-- 1. Backfill existing gaps
-- -------------------------------------------------------------
INSERT INTO public.inventory_levels (sku_id, location_id)
SELECT ps.id, '00000000-0000-0000-0000-000000000100'::uuid
  FROM public.product_skus ps
 WHERE ps.archived_at IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM public.inventory_levels il WHERE il.sku_id = ps.id
   )
ON CONFLICT (sku_id, location_id) DO NOTHING;

-- -------------------------------------------------------------
-- 2. Seed automatically for every new SKU
-- -------------------------------------------------------------
-- SECURITY DEFINER so the seed succeeds regardless of the caller's RLS on
-- inventory_levels (SKUs can be created via SECURITY DEFINER RPCs or
-- RLS-scoped inserts). search_path pinned per the standard hardening.
-- The function only touches inventory_levels (no pgcrypto/extensions
-- calls), so no schema-qualified-digest concern here.
CREATE OR REPLACE FUNCTION public.seed_inventory_level_for_new_sku()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  INSERT INTO public.inventory_levels (sku_id, location_id)
  VALUES (NEW.id, '00000000-0000-0000-0000-000000000100'::uuid)
  ON CONFLICT (sku_id, location_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_seed_inventory_level_for_new_sku ON public.product_skus;
CREATE TRIGGER trg_seed_inventory_level_for_new_sku
  AFTER INSERT ON public.product_skus
  FOR EACH ROW EXECUTE FUNCTION public.seed_inventory_level_for_new_sku();
