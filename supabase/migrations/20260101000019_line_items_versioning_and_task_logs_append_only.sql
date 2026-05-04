-- =============================================================
-- Migration 019: freight_line_items versioning + task_logs append-only
-- =============================================================
-- Closes two schema-hygiene gaps surfaced by the operational audit:
--
--   A. freight_line_items lacked updated_at + row_version. Line items do
--      legitimately change post-creation (unit_cost corrections when the
--      supplier invoice arrives, quantity corrections when physical receiving
--      differs from PO). They deserve the same concurrency / timestamping
--      posture as the parent freight_shipments table.
--
--   B. task_logs was mutable and had no integrity protection. Task logs
--      are used for performance reviews, capacity planning, and (in some
--      regulatory contexts) wage-hour audits. A mutable task log is a
--      trust issue — a worker or a malicious actor could rewrite yesterday
--      to make metrics look better.
--
--      This migration makes task_logs append-only via BEFORE UPDATE/DELETE
--      triggers that raise exceptions, matching the pattern used by
--      inventory_transactions in migration 009.
--
--      Corrections: the pattern is "insert a new task_log entry that
--      describes the correction" — exactly how accountants handle journal
--      entries. Never edit history in place.
--      If we later formalize corrections, the additive path is to add a
--      `corrective_for_task_log_id UUID REFERENCES task_logs(id)` column
--      and a `rpc_void_task_log(id, reason, actor)` RPC. Not needed today.

-- =============================================================
-- A. freight_line_items: add updated_at + row_version + triggers
-- =============================================================

ALTER TABLE freight_line_items
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS row_version INTEGER NOT NULL DEFAULT 1;

-- Backfill updated_at for existing rows so it reflects their actual
-- creation time rather than the moment this migration ran.
-- Safe to run multiple times: only touches rows where updated_at defaulted
-- to now() just now (i.e., is within a few seconds of migration execution).
UPDATE freight_line_items
   SET updated_at = created_at
 WHERE updated_at > now() - interval '1 minute'
   AND updated_at != created_at;

-- Reuse the existing update_updated_at() trigger function from migration 001.
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON freight_line_items
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Reuse the existing bump_row_version() trigger function from migration 007.
CREATE TRIGGER trg_bump_version_freight_line_items
  BEFORE UPDATE ON freight_line_items
  FOR EACH ROW EXECUTE FUNCTION bump_row_version();

COMMENT ON COLUMN freight_line_items.row_version IS
  'Optimistic-concurrency guard — app must include in WHERE on UPDATE.';
COMMENT ON COLUMN freight_line_items.updated_at IS
  'Auto-maintained by trigger. Reflects the last modification time.';

-- =============================================================
-- B. task_logs: append-only (block UPDATE + DELETE)
-- =============================================================

-- Drop the overly-permissive "Admins can manage task logs" RLS policy that
-- implied admins could UPDATE or DELETE. The triggers below make it
-- structurally impossible, but cleaning up the policy prevents confusion.
DROP POLICY IF EXISTS "Admins can manage task logs" ON task_logs;

-- SELECT and INSERT policies from migration 001 remain in place:
--   "Authenticated can read task logs"   — SELECT to authenticated
--   "Authenticated can insert task logs" — INSERT WITH CHECK (employee_id = auth.uid())
--
-- No UPDATE or DELETE policy = default deny at the RLS layer.
-- The triggers below add a second layer of defense (also catches direct
-- SQL Editor attempts by a superuser who'd bypass RLS).

CREATE OR REPLACE FUNCTION block_task_log_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'task_logs is append-only. UPDATE/DELETE is not permitted.'
    USING HINT = 'Log a new corrective task entry with a note explaining the fix. Never edit history in place.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_block_task_log_update
  BEFORE UPDATE ON task_logs
  FOR EACH ROW EXECUTE FUNCTION block_task_log_mutation();

CREATE TRIGGER trg_block_task_log_delete
  BEFORE DELETE ON task_logs
  FOR EACH ROW EXECUTE FUNCTION block_task_log_mutation();

COMMENT ON TABLE task_logs IS
  'Append-only manufacturing task history. UPDATE and DELETE are blocked by trigger (migration 019). Corrections happen via INSERT of a corrective entry.';
