-- =============================================================
-- Migration 051: drop redundant / unused indexes
-- =============================================================
-- Two indexes are pure write-side overhead:
--
--   idx_product_skus_sku
--     Created in initial schema (migration 001) ON product_skus(sku),
--     which already has UNIQUE NOT NULL on `sku`. UNIQUE creates an
--     implicit b-tree index automatically — `idx_product_skus_sku` is
--     a strict duplicate. Every insert/update to product_skus pays
--     two index-maintenance hits for one logical operation. Drop the
--     explicit one; the UNIQUE-backed index continues to serve all
--     `WHERE sku = $1` lookups.
--
--   idx_inv_finished
--     Created in migration 013 ON inventory_levels(warehouse_finished).
--     `warehouse_finished` is updated on virtually every inventory
--     transaction — write-heavy column. The index was speculatively
--     added for a "low-stock filter" use case that the application
--     never wired up: a project-wide grep for SQL filters on
--     warehouse_finished comes back empty. The dashboard reads every
--     inventory row and filters client-side, so the b-tree maintenance
--     cost on every shipment / receive / cycle-count is paying for a
--     query path that doesn't exist.
--
-- Both DROPs use IF EXISTS so the migration is idempotent. No data
-- changes — index drops are metadata-only.
-- =============================================================

DROP INDEX IF EXISTS idx_product_skus_sku;
DROP INDEX IF EXISTS idx_inv_finished;

-- Sanity guard: the implicit UNIQUE-constraint index on
-- product_skus(sku) MUST still exist after the drop above. It is
-- named after the constraint (auto-generated, typically
-- `product_skus_sku_key`), and Postgres won't let us drop it
-- without dropping the constraint. We assert presence by walking
-- pg_constraint, not pg_indexes, so a future rename of the
-- auto-generated index name doesn't break this check.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint c
      JOIN pg_class r ON r.oid = c.conrelid
     WHERE r.relname = 'product_skus'
       AND c.contype = 'u'
       AND 'sku' = ANY (
         SELECT a.attname
           FROM pg_attribute a
          WHERE a.attrelid = r.oid
            AND a.attnum = ANY (c.conkey)
       )
  ) THEN
    RAISE EXCEPTION
      'Migration 051: product_skus.sku UNIQUE constraint missing — refusing to ship without a sku-lookup index';
  END IF;

  -- Both targeted indexes must be gone.
  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'idx_product_skus_sku'
  ) THEN
    RAISE EXCEPTION 'Migration 051: idx_product_skus_sku still present';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'idx_inv_finished'
  ) THEN
    RAISE EXCEPTION 'Migration 051: idx_inv_finished still present';
  END IF;
END$$;
