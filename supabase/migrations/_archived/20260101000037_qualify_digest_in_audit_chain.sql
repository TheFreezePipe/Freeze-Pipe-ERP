-- =============================================================
-- Migration 037: qualify extensions.digest() in audit hash chain
-- =============================================================
-- Bug: calling rpc_log_task_completion from the Workspace page fails
-- with `function digest(text, unknown) does not exist (42883)`. The
-- call chain:
--
--   1. Client calls rpc_log_task_completion (SECURITY DEFINER,
--      SET search_path = public).
--   2. The RPC INSERTs into inventory_transactions.
--   3. The BEFORE INSERT trigger `audit_hash_chain` (migration 009)
--      fires and calls `digest(v_payload, 'sha256')`.
--   4. Postgres looks up `digest()` on the current search_path, which
--      is `public` — but in Supabase-hosted Postgres, pgcrypto lives
--      in the `extensions` schema. No match → error.
--
-- The "text, unknown" in the error is Postgres saying it couldn't
-- find any candidates to match against — not an actual type problem.
--
-- Fix: fully qualify every digest() call as `extensions.digest(...)`.
-- This is more robust than twiddling search_path on each caller and
-- makes the dependency on pgcrypto explicit. The hash-chain mechanism
-- is preserved — we're only changing how the function is resolved.
--
-- Two functions need updating:
--   - audit_hash_chain()   — trigger body that computes row_hash on INSERT
--   - verify_audit_chain() — admin-callable verifier that recomputes
--
-- Both definitions are replayed here with the `extensions.` prefix
-- added to digest() calls; no other logic changes.
-- =============================================================

-- -------------------------------------------------------------
-- A. Trigger function — compute row_hash on INSERT
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit_hash_chain()
RETURNS TRIGGER AS $$
DECLARE
  v_prev_hash TEXT;
  v_payload TEXT;
BEGIN
  SELECT row_hash INTO v_prev_hash
    FROM inventory_transactions
   ORDER BY created_at DESC, id DESC
   LIMIT 1;

  NEW.prev_hash := COALESCE(v_prev_hash, '0000000000000000000000000000000000000000000000000000000000000000');

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

  -- Fully qualify to `extensions.digest` so resolution doesn't depend
  -- on the caller's search_path (SECURITY DEFINER RPCs pin it to
  -- `public`, which doesn't contain pgcrypto in Supabase projects).
  NEW.row_hash := encode(extensions.digest(v_payload, 'sha256'), 'hex');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- -------------------------------------------------------------
-- B. Verifier function — recomputes + checks the chain
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION verify_audit_chain(p_start_from TIMESTAMPTZ DEFAULT '-infinity')
RETURNS TABLE (first_broken_id UUID, first_broken_at TIMESTAMPTZ, message TEXT) AS $$
DECLARE
  r RECORD;
  v_expected_prev TEXT := '0000000000000000000000000000000000000000000000000000000000000000';
  v_recomputed TEXT;
BEGIN
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
    v_recomputed := encode(extensions.digest(
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

  RETURN;
END;
$$ LANGUAGE plpgsql;

-- -------------------------------------------------------------
-- C. Sanity: confirm pgcrypto is installed under `extensions`.
--    If this RAISEs, Supabase's extension layout has shifted and we
--    need to adjust the qualification prefix.
-- -------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_extension e
    JOIN pg_namespace n ON n.oid = e.extnamespace
    WHERE e.extname = 'pgcrypto' AND n.nspname = 'extensions'
  ) THEN
    RAISE EXCEPTION 'pgcrypto is not installed in the `extensions` schema; adjust migration 037 qualification prefix';
  END IF;
END$$;
