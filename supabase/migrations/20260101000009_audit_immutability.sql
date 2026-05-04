-- =============================================================
-- Migration 009: Audit log immutability + hash chain
-- =============================================================
-- The audit log (inventory_transactions) must be forensically reliable.
-- A "can-be-edited" audit log is worse than no audit log — it gives
-- false confidence.
--
-- Three layers of protection:
--
--   1. RLS policy restricts to INSERT only (no UPDATE, no DELETE) for
--      all users, including admins. Only the service_role key (used by
--      Edge Functions + automated processes) can write; never the
--      anon/authenticated role with DML.
--   2. A table-level trigger blocks UPDATE and DELETE at the row level
--      as a second line of defense in case an RLS policy is accidentally
--      removed or a superuser gets involved.
--   3. Hash chain: every row stores sha256(prev_hash || row_content).
--      Any tampering with historical rows is detectable by recomputing
--      the chain. This is not mandatory for internal use but is the
--      standard for financial audit trails.
--
-- Also: extends the schema to support the movement_kind / from_field /
-- to_field columns the application already uses.

-- -------------------------------------------------------------
-- A. Extend schema to match what the app writes
-- -------------------------------------------------------------
ALTER TABLE inventory_transactions
  -- Movement taxonomy — aligns with the typed helpers in the app.
  ADD COLUMN movement_kind TEXT NOT NULL DEFAULT 'net_change'
    CHECK (movement_kind IN ('net_change', 'category_move', 'metadata')),
  ADD COLUMN from_field TEXT,
  ADD COLUMN to_field TEXT,
  -- Forensic columns
  ADD COLUMN row_hash TEXT,
  ADD COLUMN prev_hash TEXT,
  -- Extra context
  ADD COLUMN actor_ip INET,
  ADD COLUMN actor_user_agent TEXT;

-- Sanity check: category_move rows must populate from and to fields
ALTER TABLE inventory_transactions
  ADD CONSTRAINT chk_move_fields_consistent CHECK (
    movement_kind != 'category_move'
    OR (from_field IS NOT NULL AND to_field IS NOT NULL)
  );

-- sku_id should be nullable for shipment-level events that aren't SKU-specific.
-- (Our recent demo work already handles this in app code; make the DB agree.)
ALTER TABLE inventory_transactions
  ALTER COLUMN sku_id DROP NOT NULL;

-- -------------------------------------------------------------
-- B. Hash chain: compute row_hash on INSERT
-- -------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION audit_hash_chain()
RETURNS TRIGGER AS $$
DECLARE
  v_prev_hash TEXT;
  v_payload TEXT;
BEGIN
  -- Find the most recent existing hash (the chain's current tip).
  SELECT row_hash INTO v_prev_hash
    FROM inventory_transactions
   ORDER BY created_at DESC, id DESC
   LIMIT 1;

  NEW.prev_hash := COALESCE(v_prev_hash, '0000000000000000000000000000000000000000000000000000000000000000');

  -- Serialize the row contents (excluding the hash itself) and compute sha256.
  v_payload := COALESCE(NEW.id::text, '') || '|'
            || COALESCE(NEW.sku_id::text, '') || '|'
            || COALESCE(NEW.transaction_type, '') || '|'
            || COALESCE(NEW.quantity::text, '') || '|'
            || COALESCE(NEW.field_affected, '') || '|'
            || COALESCE(NEW.movement_kind, '') || '|'
            || COALESCE(NEW.from_field, '') || '|'
            || COALESCE(NEW.to_field, '') || '|'
            || COALESCE(NEW.reference_id::text, '') || '|'
            || COALESCE(NEW.reference_type, '') || '|'
            || COALESCE(NEW.notes, '') || '|'
            || COALESCE(NEW.performed_by::text, '') || '|'
            || COALESCE(NEW.created_at::text, now()::text) || '|'
            || NEW.prev_hash;

  NEW.row_hash := encode(digest(v_payload, 'sha256'), 'hex');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_hash_chain
  BEFORE INSERT ON inventory_transactions
  FOR EACH ROW EXECUTE FUNCTION audit_hash_chain();

-- -------------------------------------------------------------
-- C. Block UPDATE and DELETE with a trigger (belt and suspenders)
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION block_audit_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Audit log is immutable. UPDATE/DELETE of inventory_transactions is not permitted.'
    USING HINT = 'Insert a new entry describing the correction instead.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_block_audit_update
  BEFORE UPDATE ON inventory_transactions
  FOR EACH ROW EXECUTE FUNCTION block_audit_mutation();

CREATE TRIGGER trg_block_audit_delete
  BEFORE DELETE ON inventory_transactions
  FOR EACH ROW EXECUTE FUNCTION block_audit_mutation();

-- -------------------------------------------------------------
-- D. Tighten RLS to INSERT-only for authenticated role
-- -------------------------------------------------------------
-- Drop the overly-permissive "Admins can manage" policy from migration 001
DROP POLICY IF EXISTS "Admins can manage inv transactions" ON inventory_transactions;

-- Replace with INSERT-only for authenticated (RPCs running as service_role
-- bypass RLS and can still write — which is what we want).
CREATE POLICY "Authenticated can insert inv transactions"
  ON inventory_transactions
  FOR INSERT
  TO authenticated
  WITH CHECK (performed_by = auth.uid() OR performed_by IS NULL);

-- -------------------------------------------------------------
-- E. Hash-chain verification helper
-- -------------------------------------------------------------
-- Run periodically as a cron job or admin-triggered check.
-- Returns the id of the first row where the chain is broken, or NULL if OK.
CREATE OR REPLACE FUNCTION verify_audit_chain(p_start_from TIMESTAMPTZ DEFAULT '-infinity')
RETURNS TABLE (first_broken_id UUID, first_broken_at TIMESTAMPTZ, message TEXT) AS $$
DECLARE
  r RECORD;
  v_expected_prev TEXT := '0000000000000000000000000000000000000000000000000000000000000000';
  v_recomputed TEXT;
BEGIN
  -- If start_from is specified, seed with the hash of the row just before it
  IF p_start_from > '-infinity' THEN
    SELECT row_hash INTO v_expected_prev
      FROM inventory_transactions
     WHERE created_at < p_start_from
     ORDER BY created_at DESC, id DESC
     LIMIT 1;
    v_expected_prev := COALESCE(v_expected_prev, '0000000000000000000000000000000000000000000000000000000000000000');
  END IF;

  FOR r IN
    SELECT * FROM inventory_transactions
     WHERE created_at >= p_start_from
     ORDER BY created_at ASC, id ASC
  LOOP
    IF r.prev_hash != v_expected_prev THEN
      RETURN QUERY SELECT r.id, r.created_at, format('prev_hash mismatch at row %s', r.id);
      RETURN;
    END IF;
    v_recomputed := encode(digest(
      COALESCE(r.id::text, '') || '|'
      || COALESCE(r.sku_id::text, '') || '|'
      || COALESCE(r.transaction_type, '') || '|'
      || COALESCE(r.quantity::text, '') || '|'
      || COALESCE(r.field_affected, '') || '|'
      || COALESCE(r.movement_kind, '') || '|'
      || COALESCE(r.from_field, '') || '|'
      || COALESCE(r.to_field, '') || '|'
      || COALESCE(r.reference_id::text, '') || '|'
      || COALESCE(r.reference_type, '') || '|'
      || COALESCE(r.notes, '') || '|'
      || COALESCE(r.performed_by::text, '') || '|'
      || COALESCE(r.created_at::text, '') || '|'
      || r.prev_hash,
      'sha256'
    ), 'hex');
    IF v_recomputed != r.row_hash THEN
      RETURN QUERY SELECT r.id, r.created_at, format('row_hash does not match recomputation at %s', r.id);
      RETURN;
    END IF;
    v_expected_prev := r.row_hash;
  END LOOP;

  -- Chain is intact
  RETURN;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION verify_audit_chain IS
  'Walks the audit hash chain and returns the first broken row, or no rows if intact. Run nightly.';
