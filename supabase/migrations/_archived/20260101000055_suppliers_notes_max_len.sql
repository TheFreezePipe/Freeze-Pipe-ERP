-- =============================================================
-- Migration 055: suppliers.notes length cap
-- =============================================================
-- Migration 054 added defensive 4000-char CHECK constraints on 9
-- free-text columns across the schema. The spec list had a typo:
-- it referenced `suppliers.address` (which doesn't exist — the
-- real columns are address_line1 / address_line2 / city / etc.)
-- and silently skipped via the column-existence guard. The
-- column actually intended for a cap was `suppliers.notes`,
-- which exists and is admin-writable.
--
-- Today suppliers.notes is admin-only (not exposed via the
-- supplier portal), so the unbounded TEXT shape is bounded-risk
-- — but the whole point of migration 054 was defense-in-depth
-- against future code paths exposing these columns to less-
-- trusted callers. Closing the gap.
-- =============================================================

DO $$
DECLARE
  v_constraint TEXT := 'chk_suppliers_notes_max_len';
  v_violations INTEGER;
BEGIN
  -- Idempotent: skip if the constraint already exists.
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = v_constraint) THEN
    RAISE NOTICE 'Migration 055: % already exists, no-op', v_constraint;
    RETURN;
  END IF;

  -- Pre-flight check matches the migration 054 pattern: count
  -- existing rows that would violate, abort loudly if any do.
  SELECT COUNT(*) INTO v_violations
    FROM suppliers
   WHERE notes IS NOT NULL AND length(notes) > 4000;

  IF v_violations > 0 THEN
    RAISE EXCEPTION
      'Migration 055: % suppliers row(s) have notes > 4000 chars — refusing to add CHECK',
      v_violations;
  END IF;

  ALTER TABLE suppliers
    ADD CONSTRAINT chk_suppliers_notes_max_len
    CHECK (notes IS NULL OR length(notes) <= 4000);

  RAISE NOTICE 'Migration 055: added chk_suppliers_notes_max_len';
END$$;

-- Sanity guard: constraint must be present after the DO block.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_suppliers_notes_max_len'
  ) THEN
    RAISE EXCEPTION 'Migration 055: chk_suppliers_notes_max_len failed to land';
  END IF;
END$$;
