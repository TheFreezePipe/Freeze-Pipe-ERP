-- =============================================================
-- Migration: Warehouse tables in the Realtime publication (Phase 1)
-- =============================================================
-- Design: docs/design/WAREHOUSE_MODULE_PHASE0_1.md §3.5 (migration 11)
-- and §9.4 (channels wh-stock, wh-tasks, wh-print).
--
-- Finding: phones and the print agent need pushes for balances,
-- containers, tasks, print jobs, printers and station sessions; staging
-- had no tables in supabase_realtime (read 2026-10-22).
-- Decision: add the seven tables to supabase_realtime, creating the
-- publication if a project lacks it, and skipping tables already in it,
-- so the file can run any number of times. The SELECT policies
-- (jwt_is_internal) keep suppliers out of every payload.
--
-- Smoke after deploy:
--   SELECT count(*) FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename LIKE 'wh\_%';  -- 7
-- =============================================================

BEGIN;

DO $$
DECLARE
  t text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;
  FOREACH t IN ARRAY ARRAY['wh_inventory_balances', 'wh_containers', 'wh_moves', 'wh_count_tasks',
                           'wh_print_jobs', 'wh_printers', 'wh_station_sessions'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END $$;

COMMIT;
