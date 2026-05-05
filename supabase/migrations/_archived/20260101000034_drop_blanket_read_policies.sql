-- =============================================================
-- Migration 034: drop blanket authenticated-read policies
-- =============================================================
-- CRITICAL SECURITY FIX — supplier data isolation was broken.
--
-- Migration 001 created four "Authenticated can read ..." policies with
-- USING (true), which grant every authenticated session unrestricted
-- SELECT on factory_orders, factory_order_items, freight_shipments, and
-- freight_line_items. Migration 020 later added supplier-scoped SELECT
-- policies (supplier_select_in_scope_factory_orders, etc.), but Postgres
-- combines PERMISSIVE policies with OR — so the blanket USING(true)
-- policies short-circuit every scoped check. Result: supplier YX logging
-- into the portal saw supplier Nancy's full order + shipment history.
--
-- Why it's safe to drop the blanket policies:
--   - Admins/managers keep full access via the "Admins can manage …"
--     FOR ALL policies from migration 001 (covers SELECT too).
--   - Suppliers keep scope-limited access via migration 020's
--     supplier_select_* policies.
--   - Internal 'user'-role profiles currently have no UI that reads these
--     tables directly; if any future use case needs it, add a narrow
--     scoped policy for that role.
--
-- After this migration, a supplier session returns rows only where
-- supplier_id (or origin_supplier_id / ship_via_supplier_id) is present
-- in jwt_supplier_scope() — exactly the intended isolation.
--
-- Idempotent: DROP POLICY IF EXISTS so re-runs are safe.
-- =============================================================

DROP POLICY IF EXISTS "Authenticated can read factory orders" ON factory_orders;
DROP POLICY IF EXISTS "Authenticated can read factory order items" ON factory_order_items;
DROP POLICY IF EXISTS "Authenticated can read freight" ON freight_shipments;
DROP POLICY IF EXISTS "Authenticated can read freight items" ON freight_line_items;

-- Sanity: leave RLS enabled on all four (no-op if already enabled).
ALTER TABLE factory_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE factory_order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE freight_shipments ENABLE ROW LEVEL SECURITY;
ALTER TABLE freight_line_items ENABLE ROW LEVEL SECURITY;
