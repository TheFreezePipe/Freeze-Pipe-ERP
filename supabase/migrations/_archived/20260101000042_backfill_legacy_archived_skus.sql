-- =============================================================
-- Migration 042: backfill archive_at on legacy half-archived SKUs
-- =============================================================
-- One-off data fix. Before the SKU detail modal was wired to the
-- archive_sku() RPC (migrations 008 + 041), the modal directly flipped
-- product_skus.is_active to false and never touched the canonical
-- archive columns. Result: rows ended up in a "half-archived" state —
--
--   is_active     = false
--   archived_at   = NULL
--   archived_by   = NULL
--   archive_reason = NULL
--
-- The modal's "archived" derivation includes the !is_active fallback,
-- so it correctly displayed those rows as archived. The inventory
-- dashboard filter checked only archived_at, so the same rows kept
-- reappearing in the active list. Two views, two definitions, user-
-- visible inconsistency.
--
-- The frontend has been updated so the dashboard filter now also
-- recognizes is_active=false as archived (covering the legacy state and
-- any future Deactivate-button rows). This migration backfills the
-- canonical columns so the data itself is internally consistent —
-- belt-and-suspenders against any other reader that ever queries on
-- archived_at directly.
--
-- Idempotent: only touches rows where archived_at IS NULL AND
-- is_active = false. Re-running this migration is a no-op.
-- =============================================================

-- -------------------------------------------------------------
-- Backfill: copy updated_at into archived_at for half-archived rows.
-- updated_at is the closest proxy for "when was this row archived" we
-- have without an audit_logs lookup. Falls back to now() if null.
-- archived_by stays NULL — there's no actor to attribute. archive_reason
-- gets a fixed marker so future debugging can trace these rows back to
-- this migration.
-- -------------------------------------------------------------
UPDATE product_skus
SET
  archived_at    = COALESCE(updated_at, now()),
  archive_reason = 'backfill: pre-RPC archive flow set is_active only (migration 042)'
WHERE is_active = false
  AND archived_at IS NULL;

-- -------------------------------------------------------------
-- Sanity guard: no half-archived rows should remain. If this RAISEs,
-- something else (an active trigger? a concurrent write?) is creating
-- is_active=false rows without archived_at and we want to know.
-- -------------------------------------------------------------
DO $$
DECLARE
  v_remaining INTEGER;
BEGIN
  SELECT count(*) INTO v_remaining
  FROM product_skus
  WHERE is_active = false
    AND archived_at IS NULL;

  IF v_remaining > 0 THEN
    RAISE EXCEPTION
      'Migration 042 left % half-archived row(s) — UPDATE filter or trigger interference.',
      v_remaining;
  END IF;
END$$;
