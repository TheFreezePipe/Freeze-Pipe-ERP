-- =============================================================
-- Migration: allow split-source FO lines on a single shipment
-- =============================================================
-- Background: a shipment can legitimately ship the same SKU from
-- multiple factory orders — e.g., "2 BW20 from FO-OLD + 198 BW20
-- from FO-NEW = 200 BW20 total on this freight." The original
-- unique index on (freight_shipment_id, sku_id) forced both into
-- one row, which the frontend aggregation handled by keeping one
-- source_factory_order_item_id and silently dropping the other.
-- Result: one FO got credited for all 200 units, the other for 0.
-- Bug visible on the factory-order list page's stacked progress
-- bar and on the Stock Levels "X on order" badge.
--
-- Fix: drop the (shipment, sku) unique index. Replace with
-- (shipment, sku, source_factory_order_item_id) so the SAME
-- combination can't be duplicated, but the same SKU shipped from
-- different FOs (or from "no FO link" + from a specific FO) lands
-- as separate rows. Each row gets its own factory-order
-- attribution.
--
-- Postgres treats NULLs as distinct in unique indexes by default,
-- so two rows with sku=X and source_FO=NULL would coexist (matches
-- "non-FO-linked unique-per-SKU" expectation isn't true anymore).
-- For most cases this is fine; if an operator accidentally creates
-- two unlinked lines for the same SKU on the same shipment, that's
-- a real user error worth surfacing in the UI rather than blocking
-- in the DB.
--
-- Legacy 89 rows in prod all have source_factory_order_item_id=NULL
-- so the new index treats them as distinct. They keep their
-- pre-existing (shipment, sku) uniqueness since none collide with
-- a non-null counterpart.
-- =============================================================

DROP INDEX IF EXISTS public.idx_freight_items_unique_per_shipment_sku;

CREATE UNIQUE INDEX idx_freight_items_unique_shipment_sku_source_fo
  ON public.freight_line_items
    (freight_shipment_id, sku_id, source_factory_order_item_id);
