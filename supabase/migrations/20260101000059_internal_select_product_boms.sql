-- =============================================================
-- Migration 059: internal-user SELECT policy on product_boms
-- =============================================================
-- product_boms had RLS enabled in migration 020 but only one SELECT
-- policy: `supplier_select_assembled_boms`, gated to suppliers who
-- assemble the row (assembled_at_supplier_id ∈ jwt_supplier_scope()).
-- Internal staff (admin / manager / user) had no policy at all, so
-- direct queries returned zero rows for them — silently breaking
-- the admin Factory Orders missing-component warnings, which depend
-- on `useProductBoms()` reading the table.
--
-- The component-status RPCs (migration 057, 058) ran as SECURITY
-- DEFINER and bypassed this gap, which is why the supplier portal
-- detail page (RPC-driven) showed components while the admin list
-- (table-query-driven) didn't. The asymmetry was a real bug, not a
-- "show via RPC only" decision.
--
-- This migration adds the missing internal-user policy. No data
-- changes; only an RLS rule that grants SELECT to authenticated
-- callers whose profile.role ∈ ('admin', 'manager', 'user').
-- Suppliers continue to be governed by the existing
-- `supplier_select_assembled_boms` policy — multiple SELECT
-- policies on a table OR together, so the union is "internal can
-- see all rows; suppliers see rows they assemble." Matches the
-- shape of every other table in the schema.
-- =============================================================

CREATE POLICY "internal_select_product_boms" ON product_boms
  FOR SELECT TO authenticated
  USING (jwt_is_internal());

COMMENT ON POLICY "internal_select_product_boms" ON product_boms IS
  'Admins / managers / regular internal users see every BoM row. Pairs with supplier_select_assembled_boms (suppliers see only rows they assemble). Without this policy, admin queries returned zero rows because RLS was enabled with no internal-side rule.';

-- Sanity guard: both SELECT policies must be present after this lands.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'product_boms'
      AND policyname = 'internal_select_product_boms'
  ) THEN
    RAISE EXCEPTION 'Migration 059: internal_select_product_boms policy did not land';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'product_boms'
      AND policyname = 'supplier_select_assembled_boms'
  ) THEN
    RAISE EXCEPTION 'Migration 059: supplier_select_assembled_boms policy missing — refusing to ship without supplier-side coverage';
  END IF;
END$$;
