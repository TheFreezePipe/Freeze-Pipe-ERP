-- =============================================================
-- Migration 036: drop stale rpc_log_task_completion 7-arg overload
-- =============================================================
-- Bug: task logging failed at the Workspace page with PostgREST error
-- PGRST203 ("Could not choose the best candidate function between...").
-- Two overloads of rpc_log_task_completion were live in the database:
--
--   (A) 7-arg from migration 010:
--       (p_sku_id UUID, p_task_type TEXT, p_quantity INTEGER, p_notes TEXT,
--        p_actor_id UUID, p_time_started TIMESTAMPTZ, p_time_completed TIMESTAMPTZ)
--
--   (B) 8-arg from migration 014, adding location support:
--       (..., p_location_id UUID DEFAULT NULL)
--
-- Migration 014 used CREATE OR REPLACE FUNCTION, but changing the arg
-- list changes the function identity in Postgres — so instead of
-- replacing (A), it created (B) alongside it. The frontend hook passes
-- 7 arguments; PostgREST sees both overloads as viable candidates (the
-- DEFAULT NULL on p_location_id in (B) makes the 7-arg call signature
-- match) and refuses to pick.
--
-- Fix: drop the dead 7-arg version. The 8-arg version with
-- p_location_id DEFAULT NULL already handles 7-arg callers correctly.
--
-- Idempotent: DROP FUNCTION IF EXISTS with the exact signature, so
-- re-runs are safe if the overload has already been cleaned up.
-- =============================================================

DROP FUNCTION IF EXISTS rpc_log_task_completion(
  UUID, TEXT, INTEGER, TEXT, UUID, TIMESTAMPTZ, TIMESTAMPTZ
);

-- Sanity: the 8-arg version (with p_location_id) should still exist.
-- If it doesn't, someone deleted the wrong one — raise loudly rather
-- than leaving the system without a task logging RPC at all.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'rpc_log_task_completion'
      AND pg_get_function_identity_arguments(p.oid) =
        'p_sku_id uuid, p_task_type text, p_quantity integer, p_notes text, p_actor_id uuid, p_time_started timestamp with time zone, p_time_completed timestamp with time zone, p_location_id uuid'
  ) THEN
    RAISE EXCEPTION 'rpc_log_task_completion 8-arg overload missing after drop — migration 014 never applied correctly';
  END IF;
END$$;
