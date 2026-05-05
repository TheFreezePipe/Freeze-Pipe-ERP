-- =============================================================
-- Migration 056: inventory_transactions reference_id/reference_type
--                 constraints + documented append-only contract
-- =============================================================
-- An enterprise-audit pass flagged inventory_transactions's
-- (reference_id UUID, reference_type TEXT) shape as a polymorphic
-- association with no FK — refs can dangle silently when the
-- referenced row is deleted, breaking the migration-009 hash
-- chain.
--
-- The "dangling = bad" framing is wrong for this codebase. The
-- header of migration 046 documents the dangling-ref pattern as
-- INTENTIONAL audit hygiene:
--
--   "Old 'freight_delivered' / 'factory_order_update' rows will
--    retain reference_ids pointing at deleted shipments/orders.
--    That's correct audit hygiene: history records that the
--    thing existed and was then deleted."
--
-- The hash chain (migrations 009 + 037) hashes reference_type
-- and reference_id as TEXT; deleting the referenced row leaves
-- the audit row's hash valid because the chain proves "this
-- audit existed at hash time," not "the referenced entity still
-- exists." Adding BEFORE DELETE triggers to enforce reference
-- integrity would BREAK migration 046's contract — wipes of
-- factory_orders / freight_shipments would be blocked by old
-- audit rows.
--
-- What this migration does instead:
--
--  1. CHECK constraint locking reference_type to the closed set
--     of 6 values actually emitted by RPCs (product_sku, task_log,
--     freight_shipment, factory_order, shipstation_order, profile).
--     Plus the both-NULL pairing rule: if reference_type is NULL,
--     reference_id must also be NULL, and vice versa. This
--     prevents typos and silent additions of new reference types
--     without an explicit migration extending the CHECK.
--
--  2. Composite index on (reference_type, reference_id) for the
--     "show me all audit rows for entity X" query path that the
--     freight detail / factory order detail pages will eventually
--     want. Partial — only non-NULL refs.
--
--  3. Table-level COMMENT spelling out the polymorphic + dangling
--     contract so future schema readers (and future audits) don't
--     re-flag this as a bug.
-- =============================================================

-- -------------------------------------------------------------
-- Phase 1: pre-flight. Bail if any existing row has a
-- reference_type outside the closed set, or violates the
-- both-or-neither pairing rule.
-- -------------------------------------------------------------
DO $$
DECLARE
  v_unexpected_type INTEGER;
  v_unexpected_pair INTEGER;
  v_sample TEXT;
BEGIN
  SELECT COUNT(*),
         string_agg(DISTINCT reference_type, ', ')
    INTO v_unexpected_type, v_sample
    FROM inventory_transactions
   WHERE reference_type IS NOT NULL
     AND reference_type NOT IN (
       'product_sku',
       'task_log',
       'freight_shipment',
       'factory_order',
       'shipstation_order',
       'profile'
     );
  IF v_unexpected_type > 0 THEN
    RAISE EXCEPTION
      'Migration 056: % inventory_transactions rows have unexpected reference_type values (%) — extend the CHECK or clean the data first',
      v_unexpected_type, v_sample;
  END IF;

  SELECT COUNT(*) INTO v_unexpected_pair
    FROM inventory_transactions
   WHERE (reference_id IS NULL) <> (reference_type IS NULL);
  IF v_unexpected_pair > 0 THEN
    RAISE EXCEPTION
      'Migration 056: % rows violate the both-or-neither pairing rule (one of reference_id / reference_type is NULL while the other is not)',
      v_unexpected_pair;
  END IF;
END$$;

-- -------------------------------------------------------------
-- Phase 2: add the CHECK constraint. Idempotent via pg_constraint
-- name lookup.
-- -------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_inv_tx_reference_shape'
      AND conrelid = 'inventory_transactions'::regclass
  ) THEN
    ALTER TABLE inventory_transactions
      ADD CONSTRAINT chk_inv_tx_reference_shape
      CHECK (
        -- Both NULL is fine (cycle counts, oversell warnings,
        -- etc. legitimately have no referenced entity).
        (reference_id IS NULL AND reference_type IS NULL)
        OR
        -- Both populated AND the type is in the closed set.
        (
          reference_id IS NOT NULL
          AND reference_type IS NOT NULL
          AND reference_type IN (
            'product_sku',
            'task_log',
            'freight_shipment',
            'factory_order',
            'shipstation_order',
            'profile'
          )
        )
      );
    RAISE NOTICE 'Migration 056: added chk_inv_tx_reference_shape';
  ELSE
    RAISE NOTICE 'Migration 056: chk_inv_tx_reference_shape already exists, no-op';
  END IF;
END$$;

-- -------------------------------------------------------------
-- Phase 3: composite index for "all audit rows for entity X"
-- queries. Partial on reference_id IS NOT NULL because the
-- both-NULL rows (cycle counts etc.) are never queried via this
-- path. Reduces index size meaningfully.
-- -------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_inv_tx_reference
  ON inventory_transactions(reference_type, reference_id)
  WHERE reference_id IS NOT NULL;

-- -------------------------------------------------------------
-- Phase 4: documenting COMMENT. The polymorphic-ref shape +
-- intentional-dangling contract is non-obvious without context.
-- This makes the contract explicit in the schema itself so the
-- next pg_dump-driven audit doesn't re-flag it.
-- -------------------------------------------------------------
COMMENT ON COLUMN inventory_transactions.reference_id IS
  'UUID of the entity that triggered this audit row (factory_order, freight_shipment, etc.). Polymorphic — interpret with reference_type. Intentionally NOT a FK: the referenced entity may be hard-deleted (see migration 046), and we keep the audit row pointing at the now-gone UUID as historical record. The hash chain (migration 009/037) preserves audit integrity regardless of whether the referenced row still exists.';

COMMENT ON COLUMN inventory_transactions.reference_type IS
  'Discriminator for reference_id. Closed set enforced by chk_inv_tx_reference_shape: product_sku | task_log | freight_shipment | factory_order | shipstation_order | profile. Adding a new value requires extending the CHECK constraint in a new migration — no silent additions.';
