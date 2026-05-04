-- =============================================================
-- Migration 026: create audit_logs — the generic action audit stream
-- =============================================================
-- Root cause capture: migrations 020, 021, 024, 025 all INSERT into an
-- `audit_logs` table that no prior migration ever created. Migration 009's
-- "audit log" was specifically `inventory_transactions` (inventory-domain
-- hash-chained audit), not this generic action log. The RPCs deployed just
-- fine because `CREATE OR REPLACE FUNCTION` doesn't validate referenced
-- relations — the failure only surfaces at first call.
--
-- This migration creates the missing table. No RPC changes needed — every
-- downstream RPC starts working as soon as this lands.
--
-- Scope: generic workflow-action audit (order created, status advanced,
-- cancellation, receive, variance ack, user promoted, etc.). Parallel to
-- inventory_transactions, not a replacement. No hash chain here — that
-- discipline is reserved for money-adjacent rows; for workflow actions the
-- append-only triggers + RLS are enough.

CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Nullable because some actions are attributable to system / service
  -- role callers where auth.uid() returns NULL.
  actor_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  -- Dotted action name, e.g. 'factory_order.create',
  -- 'shipment_variance.acknowledge', 'profile.promote_to_supplier'.
  action TEXT NOT NULL CHECK (length(trim(action)) > 0),
  -- Free-form table name — this table logs across many domains so we don't
  -- add a FK. Matches the convention the RPCs already use.
  target_table TEXT NOT NULL CHECK (length(trim(target_table)) > 0),
  -- UUID of the affected row. Not a FK for the same reason as target_table.
  target_id UUID NOT NULL,
  -- Arbitrary structured payload: diffs, pre/post values, reason text, etc.
  -- Default '{}' so callers don't have to pass it explicitly.
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Hot path: "what happened to this row?" — join from any target table.
CREATE INDEX idx_audit_logs_target
  ON audit_logs(target_table, target_id, created_at DESC);

-- "What did this actor do?" — used by per-user activity views.
CREATE INDEX idx_audit_logs_actor
  ON audit_logs(actor_id, created_at DESC)
 WHERE actor_id IS NOT NULL;

-- "Show me all cancellations" — used by the internal dashboard.
CREATE INDEX idx_audit_logs_action
  ON audit_logs(action, created_at DESC);

-- =============================================================
-- Append-only guards — same pattern as task_logs / inventory_transactions.
-- =============================================================
CREATE OR REPLACE FUNCTION block_audit_logs_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only. UPDATE/DELETE is not permitted.'
    USING HINT = 'Log a corrective entry with a reference to the original. Never edit history in place.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_block_audit_logs_update
  BEFORE UPDATE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION block_audit_logs_mutation();

CREATE TRIGGER trg_block_audit_logs_delete
  BEFORE DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION block_audit_logs_mutation();

-- =============================================================
-- RLS — enforce who can read audit entries.
-- No INSERT policy: writes happen exclusively through SECURITY DEFINER RPCs
-- which run as the function owner and bypass RLS. That's the correct
-- channel; direct client INSERTs from authenticated role should not work.
-- =============================================================
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

-- Internal staff (admin, manager, user) can read everything. The admin
-- dashboard's "recent activity" feed, performance reviews, and compliance
-- exports all live on this policy.
CREATE POLICY "internal_select_audit_logs" ON audit_logs
  FOR SELECT TO authenticated
  USING (jwt_is_internal());

-- Supplier users see only entries they initiated. This is a narrower slice
-- than "entries targeting their scope" — rather than trying to filter by
-- target_table/target_id (which would require expensive cross-table joins
-- for every read), we just show suppliers their own activity. Good enough
-- for "what did I click yesterday?" diagnostics.
CREATE POLICY "supplier_select_own_audit_logs" ON audit_logs
  FOR SELECT TO authenticated
  USING (actor_id = auth.uid());

COMMENT ON TABLE audit_logs IS
  'Append-only cross-domain action audit. Separate from inventory_transactions (which hash-chains money-adjacent state). Written by SECURITY DEFINER RPCs only.';
