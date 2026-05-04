-- =============================================================
-- Migration 046: wipe orders + shipments test data
-- =============================================================
-- One-shot data wipe. The factory_orders + freight_shipments rows
-- accumulated during pre-launch testing aren't real production data
-- and need to come out. Deletes touch four operational tables plus
-- their dependents:
--
--   shipment_variances           (FK → freight_shipments, ON DELETE RESTRICT)
--   component_breakage_reports   (FK → factory_order_items / factory_orders,
--                                 ON DELETE RESTRICT)
--   freight_shipments            (CASCADEs to freight_line_items)
--   factory_orders               (CASCADEs to factory_order_items)
--
-- The supplier_portal_* tables you may see in the catalog
-- (supplier_portal_factory_orders, _items, _freight_shipments, etc.)
-- are VIEWS over these base tables (defined in migration 020) — they
-- empty automatically once the base data is gone, no separate wipe.
--
-- Deletion order matters because of the RESTRICT constraints:
--
--   1. shipment_variances first — blocks freight_shipments delete.
--   2. component_breakage_reports next — blocks both factory_order_items
--      (via factory_order_item_id RESTRICT) and factory_orders
--      (via replacement_factory_order_id RESTRICT).
--   3. freight_shipments — CASCADE drops freight_line_items, which
--      removes the source_factory_order_item_id RESTRICT references
--      that would otherwise block factory_order_items deletion.
--   4. factory_orders — CASCADE drops factory_order_items.
--
-- Explicitly NOT touched:
--
--   - inventory_levels — warehouse counts stay where they are. Per
--     the user, the physical warehouse state is canonical; we're
--     just wiping the paper trail of how units got there.
--   - inventory_transactions — append-only by design (migration 009).
--     Old "freight_delivered" / "factory_order_update" rows will
--     retain reference_ids pointing at deleted shipments/orders.
--     That's correct audit hygiene: history records that the thing
--     existed and was then deleted.
--   - audit_logs — same append-only contract (migration 026).
--     Workflow events tied to deleted rows stay in history.
--   - task_logs, product_skus, sku_economics, sku_supplier_costs,
--     suppliers, profiles — separate domains, untouched.
--
-- Idempotent — re-running deletes from already-empty tables is a
-- harmless no-op.
-- =============================================================

DELETE FROM shipment_variances;
DELETE FROM component_breakage_reports;
DELETE FROM freight_shipments;   -- CASCADE → freight_line_items
DELETE FROM factory_orders;      -- CASCADE → factory_order_items

-- -------------------------------------------------------------
-- Sanity: every operational table should now be empty.
-- -------------------------------------------------------------
DO $$
DECLARE
  v_factory_orders INTEGER;
  v_factory_order_items INTEGER;
  v_freight_shipments INTEGER;
  v_freight_line_items INTEGER;
  v_shipment_variances INTEGER;
  v_component_breakage_reports INTEGER;
BEGIN
  SELECT count(*) INTO v_factory_orders FROM factory_orders;
  SELECT count(*) INTO v_factory_order_items FROM factory_order_items;
  SELECT count(*) INTO v_freight_shipments FROM freight_shipments;
  SELECT count(*) INTO v_freight_line_items FROM freight_line_items;
  SELECT count(*) INTO v_shipment_variances FROM shipment_variances;
  SELECT count(*) INTO v_component_breakage_reports FROM component_breakage_reports;

  RAISE NOTICE 'Migration 046 result:';
  RAISE NOTICE '  factory_orders:        %', v_factory_orders;
  RAISE NOTICE '  factory_order_items:   %', v_factory_order_items;
  RAISE NOTICE '  freight_shipments:     %', v_freight_shipments;
  RAISE NOTICE '  freight_line_items:    %', v_freight_line_items;
  RAISE NOTICE '  shipment_variances:    %', v_shipment_var