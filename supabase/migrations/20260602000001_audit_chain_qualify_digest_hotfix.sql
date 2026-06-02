-- =============================================================
-- HOTFIX: re-qualify extensions.digest() in the audit hash chain
-- =============================================================
-- Regression introduced by 20260601000001_audit_chain_seq_fix.sql.
--
-- That migration rewrote audit_hash_chain() and verify_audit_chain()
-- to add the `seq` ordering + checkpoint logic, but replayed the
-- digest() calls UNQUALIFIED — silently reverting the fix from
-- 20260101000037_qualify_digest_in_audit_chain.sql.
--
-- pgcrypto's digest() lives in the `extensions` schema on Supabase, not
-- `public`. The BEFORE INSERT trigger on inventory_transactions runs in
-- whatever search_path the caller has. SECURITY DEFINER RPCs pin it to
-- `SET search_path = public` (rpc_log_task_completion,
-- rpc_apply_shipstation_sale, rpc_bulk_cycle_count,
-- rpc_apply_freight_delivery, ...), so unqualified digest() fails to
-- resolve:
--
--   function digest(text, unknown) does not exist  (SQLSTATE 42883)
--
-- Effect (prod, from 2026-06-02 01:48 UTC when the seq migration landed):
-- every audit-writing SECURITY DEFINER RPC threw. rpc_log_task_completion
-- catches it in its EXCEPTION block and returns {error:'internal_error'},
-- which is the "internal error" employees saw on the Workspace page when
-- logging a task. ShipStation inventory application, cycle counts, and
-- freight delivery were broken the same way. (Edge-function inserts via
-- PostgREST were unaffected — their role's search_path includes
-- `extensions`.)
--
-- Fix: replay both functions exactly as the seq-fix migration defined
-- them (seq-based tip, advisory lock, checkpoint verifier) but with
-- digest() qualified as extensions.digest() — matching migration 037.
-- No logic change beyond the qualification.
-- =============================================================

-- -------------------------------------------------------------
-- A. Trigger: serialize + chain by seq  (extensions.digest)
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.audit_hash_chain()
RETURNS TRIGGER AS $$
DECLARE
  v_prev_hash TEXT;
  v_payload   TEXT;
BEGIN
  -- Serialize audit-chain inserts so concurrent transactions can't both
  -- read the same tip and fork the chain. Auto-releases at COMMIT.
  PERFORM pg_advisory_xact_lock(74010983);

  SELECT row_hash INTO v_prev_hash
    FROM public.inventory_transactions
   ORDER BY seq DESC
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

  -- Fully qualified: pgcrypto lives in `extensions`, and SECURITY DEFINER
  -- callers pin search_path to `public`. (See migration 037.)
  NEW.row_hash := encode(extensions.digest(v_payload, 'sha256'), 'hex');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- -------------------------------------------------------------
-- B. Verifier: walk by seq from the checkpoint  (extensions.digest)
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.verify_audit_chain(p_from_seq BIGINT DEFAULT NULL)
RETURNS TABLE (first_broken_id UUID, first_broken_at TIMESTAMPTZ, message TEXT) AS $$
DECLARE
  r              RECORD;
  v_start_seq    BIGINT;
  v_expected_prev TEXT;
  v_recomputed   TEXT;
BEGIN
  v_start_seq := COALESCE(
    p_from_seq,
    (SELECT checkpoint_seq FROM public.audit_chain_config WHERE id = 1),
    0
  );

  SELECT row_hash INTO v_expected_prev
    FROM public.inventory_transactions
   WHERE seq = v_start_seq
   LIMIT 1;
  v_expected_prev := COALESCE(v_expected_prev,
    '0000000000000000000000000000000000000000000000000000000000000000');

  FOR r IN
    SELECT * FROM public.inventory_transactions
     WHERE seq > v_start_seq
     ORDER BY seq ASC
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
-- C. Sanity: pgcrypto must be in `extensions` (mirrors migration 037)
-- -------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_extension e
    JOIN pg_namespace n ON n.oid = e.extnamespace
    WHERE e.extname = 'pgcrypto' AND n.nspname = 'extensions'
  ) THEN
    RAISE EXCEPTION 'pgcrypto is not installed in the `extensions` schema; adjust the digest() qualification prefix';
  END IF;
END$$;
