-- =============================================================
-- Migration 048: missing FK indexes
-- =============================================================
-- Two foreign-key columns sit on hot read paths but lack their own
-- single-column index, forcing seq scans on tables that grow with
-- every transaction:
--
--   freight_line_items.sku_id
--     "show all freight movements for SKU X" — SKU detail page,
--     landed-cost rollup, prefilled-stats hook. The composite index
--     idx_freight_items_unique_per_shipment_sku starts with
--     freight_shipment_id, so it can't satisfy a sku_id-only filter.
--
--   inventory_transactions.performed_by
--     "what did this user do?" — admin audit views, profile detail.
--     Audit-style append-only table; grows monotonically, so the
--     seq-scan cost compounds. Migration 026 added the analogous
--     idx_audit_logs_actor for audit_logs; this one was missed.
--
-- Both are simple b-tree indexes on a uuid FK. CREATE INDEX IF NOT
-- EXISTS so the migration is idempotent if anyone has already added
-- one of these manually.
--
-- We deliberately use plain CREATE INDEX (not CONCURRENTLY) because
-- this migration runs in a transaction with the rest of the deploy.
-- These tables are small enough today that the brief AccessExclusive
-- lock is fine; revisit (split into a separate non-transactional
-- migration with CONCURRENTLY) if the tables grow into the millions.
-- =============================================================

CREATE INDEX IF NOT EXISTS idx_freight_line_items_sku_id
  ON freight_line_items(sku_id);

CREATE INDEX IF NOT EXISTS idx_inv_tx_performed_by
  ON inventory_transactions(performed_by);

-- Sanity guard: both indexes must exist after this migration. If
-- something blocked the CREATE (extension privilege oddity, prior
-- failed run leaving a partial state) the migration should fail
-- loudly instead of silently shipping an unindexed FK.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'freight_line_items'
      AND indexname = 'idx_freight_line_items_sku_id'
  ) THEN
    RAISE EXCEPTION 'Migration 048: idx_freight_line_items_sku_id failed to land';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'inventory_transactions'
      AND indexname = 'idx_inv_tx_performed_by'
  ) THEN
    RAISE EXCEPTION 'Migration 048: idx_inv_tx_performed_by failed to land';
  END IF;
END$$;
