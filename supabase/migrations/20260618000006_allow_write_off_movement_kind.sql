-- =============================================================
-- Fix: allow 'write_off' as an inventory_transactions movement_kind
-- =============================================================
-- The "Log Breakage" task type records a pure decrement (units removed from
-- warehouse_finished with no destination), which rpc_log_task_completion
-- writes as movement_kind = 'write_off'. But the movement_kind CHECK only
-- permitted net_change / category_move / metadata, so EVERY breakage insert
-- failed the constraint and the RPC returned 'internal_error' (sqlstate 23514).
-- Breakage had therefore never succeeded (0 breakage task_logs, 0 write_off
-- rows in prod). Widen the constraint to include 'write_off'. The read paths
-- (manufacturing-completion + retail-value reconstruction) already interpret
-- write_off, so they pick it up automatically.
-- =============================================================

ALTER TABLE public.inventory_transactions
  DROP CONSTRAINT IF EXISTS inventory_transactions_movement_kind_check;
ALTER TABLE public.inventory_transactions
  ADD CONSTRAINT inventory_transactions_movement_kind_check
  CHECK (movement_kind = ANY (ARRAY['net_change'::text, 'category_move'::text, 'metadata'::text, 'write_off'::text]));

INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES
  ('20260618000006', 'allow_write_off_movement_kind')
ON CONFLICT (version) DO NOTHING;
