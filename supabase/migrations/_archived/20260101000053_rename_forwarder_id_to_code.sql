-- =============================================================
-- Migration 053: rename freight_shipments.forwarder_id → forwarder_code
-- =============================================================
-- The column was created in migration 001 as `forwarder_id TEXT` —
-- the `_id` suffix follows the project's FK naming convention, but
-- the column is not a foreign key and never has been. It carries an
-- external identifier (a code or name string from whichever
-- forwarder partner the operator is using). Every other `_id`
-- column in the schema is a UUID FK; this one is the lone outlier.
-- The misleading name has cost time in code review ("why isn't this
-- referencing a forwarders table?") and risks becoming a real bug
-- if someone later writes a JOIN against it expecting an FK.
--
-- Rename to `forwarder_code` so the shape is self-describing. Pure
-- metadata change (no data movement, no constraints touched).
-- The frontend updates that pair with this migration are atomic —
-- ship together so there's no window where the running build reads
-- a column that no longer exists by that name.
-- =============================================================

ALTER TABLE freight_shipments
  RENAME COLUMN forwarder_id TO forwarder_code;

COMMENT ON COLUMN freight_shipments.forwarder_code IS
  'External forwarder identifier (string code or name). Not a FK — there is no forwarders table. Renamed from forwarder_id in migration 053 to stop the _id suffix from implying a foreign key relationship.';

-- Sanity guard: new column must exist, old column must not.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'freight_shipments'
      AND column_name = 'forwarder_code'
  ) THEN
    RAISE EXCEPTION 'Migration 053: forwarder_code column did not land';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'freight_shipments'
      AND column_name = 'forwarder_id'
  ) THEN
    RAISE EXCEPTION 'Migration 053: forwarder_id column still present after rename';
  END IF;
END$$;
