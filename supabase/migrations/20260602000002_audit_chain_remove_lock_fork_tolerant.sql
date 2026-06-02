-- =============================================================
-- Audit chain: drop the serialization lock, make the verifier
-- fork-tolerant
-- =============================================================
-- 20260601000001_audit_chain_seq_fix.sql added a transaction-level
-- advisory lock to audit_hash_chain() to prevent the hash chain from
-- forking under concurrency. That lock turned out to be operationally
-- dangerous in two ways:
--
--   1. DEADLOCK. The lock is taken inside the BEFORE INSERT trigger —
--      i.e. AFTER the calling RPC has already grabbed inventory_levels
--      row locks (rpc_log_task_completion, rpc_apply_shipstation_sale,
--      rpc_apply_freight_delivery, rpc_cycle_count, rpc_bulk_cycle_count
--      all FOR UPDATE before their audit insert). A task log and a
--      multi-item ShipStation apply touching the same SKU acquire the
--      row lock and the advisory lock in opposite orders → deadlock →
--      one transaction aborts → "internal error" for the employee.
--
--   2. HEAD-OF-LINE BLOCKING. The advisory lock is held from a
--      transaction's first audit insert until COMMIT. rpc_bulk_cycle_count
--      writes one audit row per SKU in a single transaction, so a bulk
--      count holds the lock for its whole duration and every concurrent
--      task log queues behind it — long enough and they time out.
--
-- Both stem from serializing chain extension with a lock acquired
-- mid-transaction. There is no lock placement that avoids both deadlock
-- and blocking while still preventing forks, so we stop trying to
-- prevent forks at write time and instead tolerate them at verify time.
--
-- WRITE SIDE: drop the advisory lock. The `seq` column still gives a
-- correct linear chain for the common case (multiple audit rows in one
-- transaction — the bulk of historical "breaks" — chain off each other
-- via seq with no lock needed). Only genuinely simultaneous, separate
-- transactions can now fork: each reads the same committed tip and both
-- chain onto it.
--
-- VERIFY SIDE: a benign concurrency fork is NOT corruption — both
-- branches are real, untampered rows; one is just a dead-end. So the
-- verifier no longer demands a strictly linear walk. For each row it
-- checks two things that DO indicate tampering:
--
--   (a) INTEGRITY — recompute row_hash from the row's own content; a
--       mismatch means the row (or its prev_hash) was edited. This is
--       the strong guarantee and catches any modification.
--   (b) LINKAGE — the row's prev_hash must reference some EARLIER row
--       that still exists. A missing parent means a referenced row was
--       deleted.
--
-- A fork passes both checks (both siblings point at the same real
-- parent). Edits and deletions of referenced rows still fail. The only
-- thing this no longer detects is a *crafted* forged row that chains
-- validly off an existing row — which requires an attacker who can both
-- compute SHA-256 chain values and write to the table directly, who
-- could equally just disable the trigger. Acceptable for an internal,
-- append-only audit log.
--
-- NOTE: this migration intentionally KEEPS the extensions.digest()
-- qualification from the 20260602000001 hotfix. Do not let any future
-- replay drop the `extensions.` prefix — see migration 037.
-- =============================================================

-- -------------------------------------------------------------
-- 1. Trigger: chain by seq, NO advisory lock
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.audit_hash_chain()
RETURNS TRIGGER AS $$
DECLARE
  v_prev_hash TEXT;
  v_payload   TEXT;
BEGIN
  -- Current chain tip by the monotonic seq (insertion order, no ties).
  -- No lock: concurrent transactions may both read this tip and fork —
  -- which the verifier now tolerates (see header).
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

  -- Fully qualified: pgcrypto lives in `extensions`; SECURITY DEFINER
  -- callers pin search_path to `public`. (See migration 037 / hotfix
  -- 20260602000001 — never drop the `extensions.` prefix.)
  NEW.row_hash := encode(extensions.digest(v_payload, 'sha256'), 'hex');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- -------------------------------------------------------------
-- 2. Index to make the verifier's linkage lookup cheap
-- -------------------------------------------------------------
-- The fork-tolerant verifier looks up each row's prev_hash against
-- existing row_hashes. Index row_hash so that's a point lookup rather
-- than a full scan per row.
CREATE INDEX IF NOT EXISTS idx_inventory_tx_row_hash
  ON public.inventory_transactions (row_hash);

-- -------------------------------------------------------------
-- 3. Fork-tolerant verifier: integrity + linkage, walk by seq
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.verify_audit_chain(p_from_seq BIGINT DEFAULT NULL)
RETURNS TABLE (first_broken_id UUID, first_broken_at TIMESTAMPTZ, message TEXT) AS $$
DECLARE
  r            RECORD;
  v_start_seq  BIGINT;
  v_recomputed TEXT;
  v_genesis    CONSTANT TEXT := '0000000000000000000000000000000000000000000000000000000000000000';
BEGIN
  v_start_seq := COALESCE(
    p_from_seq,
    (SELECT checkpoint_seq FROM public.audit_chain_config WHERE id = 1),
    0
  );

  FOR r IN
    SELECT * FROM public.inventory_transactions
     WHERE seq > v_start_seq
     ORDER BY seq ASC
  LOOP
    -- (a) INTEGRITY: recompute row_hash from this row's own content.
    -- Catches any edit to the row, including a tampered prev_hash
    -- (prev_hash is part of the hashed payload).
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
    IF v_recomputed <> r.row_hash THEN
      RETURN QUERY SELECT r.id, r.created_at,
        format('row_hash does not match recomputation at %s (content altered)', r.id);
      RETURN;
    END IF;

    -- (b) LINKAGE: prev_hash must point at some earlier row that still
    -- exists (or genesis for the very first row). A missing parent means
    -- a referenced row was deleted. A concurrency fork passes here —
    -- both siblings point at the same real, earlier parent.
    IF r.prev_hash <> v_genesis AND NOT EXISTS (
      SELECT 1 FROM public.inventory_transactions p
       WHERE p.row_hash = r.prev_hash
         AND p.seq < r.seq
    ) THEN
      RETURN QUERY SELECT r.id, r.created_at,
        format('prev_hash references no existing earlier row at %s (referenced row deleted)', r.id);
      RETURN;
    END IF;
  END LOOP;

  -- Chain is intact (forks tolerated; no tampering detected).
  RETURN;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION public.verify_audit_chain IS
  'Fork-tolerant audit verifier. For each row after the checkpoint (audit_chain_config), recomputes row_hash (catches edits) and confirms prev_hash references an existing earlier row (catches deletions). Benign concurrency forks are not flagged. Pass 0 to scan from genesis. Run nightly by the audit-chain-verify cron.';

-- -------------------------------------------------------------
-- 4. Sanity: pgcrypto must be in `extensions`
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
