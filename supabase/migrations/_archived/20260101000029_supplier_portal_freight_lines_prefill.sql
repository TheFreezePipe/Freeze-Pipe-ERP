-- =============================================================
-- Migration 029: expose quantity_prefilled on the supplier_portal freight
--                 line items view
-- =============================================================
-- Migration 027 added freight_line_items.quantity_prefilled and wired both
-- create paths (supplier portal RPC + admin freight form) to write it.
-- Migration 020's supplier_portal_freight_line_items view was built with an
-- explicit column list that predates the new column, so suppliers can SET
-- quantity_prefilled at create time but can't SEE it when they read their
-- own shipment list back.
--
-- One-line fix: re-project the view with the new column. CREATE OR REPLACE
-- keeps security_invoker and all downstream grants intact. PostgreSQL's
-- CREATE OR REPLACE VIEW only allows APPENDING columns at the end of the
-- SELECT list (existing column positions/names are frozen), so
-- quantity_prefilled lands last even though it'd read more naturally next
-- to supplier_declared_quantity. Column order in a projection view doesn't
-- change anything functional.
CREATE OR REPLACE VIEW supplier_portal_freight_line_items
  WITH (security_invoker = true) AS
  SELECT
    fli.id,
    fli.freight_shipment_id,
    fli.sku_id,
    fli.quantity,
    fli.supplier_declared_quantity,
    fli.source_factory_order_item_id,
    fli.created_at,
    fli.updated_at,
    fli.quantity_prefilled
  FROM freight_line_items fli;

COMMENT ON VIEW supplier_portal_freight_line_items IS
  'Freight line items for supplier portal. Excludes unit_cost / line_cost. Includes quantity_prefilled so suppliers can see their own prefill declarations on past shipments.';
