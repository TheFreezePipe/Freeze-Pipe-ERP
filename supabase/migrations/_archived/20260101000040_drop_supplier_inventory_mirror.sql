-- =============================================================
-- Migration 040: drop orphaned supplier_inventory mirror
-- =============================================================
-- Migration 017 introduced `supplier_inventory` as a normalized
-- replacement for the `inventory_levels.nancy_* / yx_*` legacy columns.
-- The plan was:
--
--   1. Create supplier_inventory + bidirectional sync triggers.
--   2. Migrate every app reader/writer off the legacy columns.
--   3. Drop legacy columns + sync triggers in a follow-up.
--
-- Step 2 never happened the way it was planned. The supplier portal
-- (migrations 020+) shipped with its own data model — factory_orders +
-- factory_order_items for "what's on order", freight_shipments +
-- freight_line_items for "what's in transit" — and never wired into
-- supplier_inventory. The bidirectional sync kept the mirror consistent
-- with writes to the legacy columns, but nothing in the app writes to
-- either side anymore:
--
--   - No src/ call site inserts/updates supplier_inventory
--   - No RPC on the supplier portal modifies nancy_* / yx_* columns
--   - The only user of supplier_inventory was rpc_advance_factory_order_stage,
--     which migration 039 just dropped (it was dead code from migration 010
--     even after migration 017 redefined its body).
--
-- After migration 039 the supplier_inventory table has literally no
-- reader or writer in the running system. Dropping it now:
--
--   1. Removes the sync trigger on inventory_levels (which currently
--      fires on every nancy_*/yx_* write — also dead, but still
--      consuming BEFORE-UPDATE cycles).
--   2. Drops the two dependent views (supplier_inventory_by_sku and
--      supplier_inventory_detailed) that would otherwise fail once the
--      underlying table is gone.
--   3. Removes the two sync functions.
--
-- The legacy `inventory_levels.nancy_* / yx_* / in_transit_*` columns
-- themselves survive this migration — they'll be dropped in 041, after
-- a round of verification that nothing else reads them. That gives us a
-- rollback window: if anything surfaces that still depends on those
-- columns, we catch it before data loss.
--
-- Types impact: src/lib/database.types.ts will lose the
-- supplier_inventory, supplier_inventory_by_sku, and
-- supplier_inventory_detailed entries on regen. No src/ business code
-- references these, so the regen is a pure delete (verified by grep).
-- =============================================================

-- -------------------------------------------------------------
-- 1. Drop dependent views first. CASCADE just in case anything
--    external (logical replication publications, etc.) has references.
-- -------------------------------------------------------------
DROP VIEW IF EXISTS supplier_inventory_detailed CASCADE;
DROP VIEW IF EXISTS supplier_inventory_by_sku CASCADE;

-- -------------------------------------------------------------
-- 2. Drop the sync trigger that lives on inventory_levels. This one
--    is NOT dropped with the supplier_inventory table — it's attached
--    to the legacy-columns table itself.
-- -------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_sync_legacy_to_supplier_inv ON inventory_levels;

-- -------------------------------------------------------------
-- 3. Drop the supplier_inventory table. CASCADE takes its own triggers
--    (trg_sync_supplier_inv_to_legacy, trg_bump_version_supplier_inventory,
--    set_updated_at) and indexes with it.
-- -------------------------------------------------------------
DROP TABLE IF EXISTS supplier_inventory CASCADE;

-- -------------------------------------------------------------
-- 4. Drop the now-unreferenced trigger functions. The bump_row_version
--    and update_updated_at functions are SHARED across many tables and
--    MUST NOT be dropped — only the two sync-specific functions go.
-- -------------------------------------------------------------
DROP FUNCTION IF EXISTS sync_supplier_inventory_to_legacy() CASCADE;
DROP FUNCTION IF EXISTS sync_legacy_to_supplier_inventory() CASCADE;

-- -------------------------------------------------------------
-- 5. Sanity: confirm the shared trigger functions we depend on are
--    still present. bump_row_version() is used by ~15 tables across
--    the schema; update_updated_at() by ~20. If either went missing,
--    we'd have dropped the wrong thing in step 4.
-- -------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'bump_row_version'
  ) THEN
    RAISE EXCEPTION 'bump_row_version() missing after migration 040 — dropped a shared function';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'update_updated_at'
  ) THEN
    RAISE EXCEPTION 'update_updated_at() missing after migration 040 — dropped a shared function';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'supplier_inventory'
  ) THEN
    RAISE EXCEPTION 'supplier_inventory table still exists after migration 040 — DROP TABLE silently failed';
  END IF;
END$$;
