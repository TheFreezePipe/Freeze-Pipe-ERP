-- =============================================================
-- post_refresh.sql - warehouse settings after every refresh (design 3.1)
-- =============================================================
-- Runs on STAGING only, last, by refresh.py. Both sections are no-ops until
-- the warehouse tables exist, so the same file serves today's schema and
-- the Phase 1 schema.
--   realtime : the publication entries of design 3.5, for whichever wh_*
--              tables exist and are not yet in supabase_realtime.
--   outbound : wh_settings.outbound = {"mode":"blocked"}. refresh.py runs it
--              as the very last write of a refresh, and again from its
--              safety net if a run is cut short after the schema was touched.
-- The ERP_OUTBOUND_MODE edge secret cannot be set from SQL; keep it away
-- from `live` on staging by hand (README, check 10).
--
-- Placeholder: {{SYSTEM_ACTOR_ID}} text literal, used as updated_by.

-- @@ realtime stg
DO $rt$
DECLARE
  v_table text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    RETURN;
  END IF;
  FOREACH v_table IN ARRAY ARRAY['wh_inventory_balances', 'wh_containers', 'wh_moves',
                                 'wh_count_tasks', 'wh_print_jobs'] LOOP
    IF to_regclass('public.' || v_table) IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM pg_publication_tables
                        WHERE pubname = 'supabase_realtime'
                          AND schemaname = 'public' AND tablename = v_table) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', v_table);
    END IF;
  END LOOP;
END
$rt$;

-- @@ outbound stg
DO $ob$
BEGIN
  IF to_regclass('public.wh_settings') IS NULL THEN
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'wh_settings' AND column_name = 'updated_by') THEN
    EXECUTE $q$
      INSERT INTO public.wh_settings (key, value, updated_by)
      VALUES ('outbound', '{"mode":"blocked"}'::jsonb, {{SYSTEM_ACTOR_ID}}::uuid)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by
    $q$;
  ELSE
    EXECUTE $q$
      INSERT INTO public.wh_settings (key, value)
      VALUES ('outbound', '{"mode":"blocked"}'::jsonb)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    $q$;
  END IF;
END
$ob$;
