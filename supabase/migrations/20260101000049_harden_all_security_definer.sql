-- =============================================================
-- Migration 049: project-wide SECURITY DEFINER search_path sweep
-- =============================================================
-- Migration 043 hardened six named functions. The audit-style
-- problem with that approach is it doesn't catch:
--   (a) SECURITY DEFINER functions added between 020 and 043 that
--       happened to land without `SET search_path = public`,
--   (b) any future SECURITY DEFINER function added by a migration
--       that forgets the pragma.
--
-- This migration replaces the named-list pattern with a project-
-- wide sweep:
--   1. Find every SECURITY DEFINER function in schema `public` that
--      lacks `search_path=public` in its proconfig.
--   2. ALTER FUNCTION ... SET search_path = public on each, by oid.
--   3. Sanity guard: assert zero remaining offenders.
--
-- ALTER FUNCTION ... SET search_path is a metadata-only change; it
-- doesn't recompile the body or touch dependents. Safe to re-run.
--
-- Future migrations that add SECURITY DEFINER functions should
-- still include the pragma inline (clearer review signal), but if
-- one slips through, re-applying this migration's logic via a new
-- migration heals it. (We don't put the heal in a trigger / cron
-- because dynamic SQL on system catalogs from inside DML triggers
-- is brittle; an explicit migration is the right surface.)
-- =============================================================

DO $$
DECLARE
  r RECORD;
  v_signature TEXT;
  v_count INTEGER := 0;
BEGIN
  FOR r IN
    SELECT p.oid,
           p.proname,
           pg_get_function_identity_arguments(p.oid) AS args
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prosecdef = true
       AND (
         p.proconfig IS NULL
         OR NOT EXISTS (
           SELECT 1
             FROM unnest(p.proconfig) AS cfg
            WHERE cfg = 'search_path=public'
               OR cfg LIKE 'search_path=%public%'
         )
       )
  LOOP
    v_signature := format('public.%I(%s)', r.proname, r.args);
    -- ALTER FUNCTION ... SET search_path is idempotent and metadata-only.
    EXECUTE format('ALTER FUNCTION %s SET search_path = public', v_signature);
    RAISE NOTICE 'Migration 049: hardened search_path on %', v_signature;
    v_count := v_count + 1;
  END LOOP;

  RAISE NOTICE 'Migration 049: hardened % SECURITY DEFINER function(s)', v_count;
END$$;

-- -------------------------------------------------------------
-- Sanity guard: zero SECURITY DEFINER functions in `public` may
-- remain without a pinned search_path. If anything is left after
-- the sweep above, fail the migration so the deploy aborts and a
-- human investigates instead of silently shipping a CVE-class
-- vulnerability.
-- -------------------------------------------------------------
DO $$
DECLARE
  v_offender_count INTEGER;
  v_offender_names TEXT;
BEGIN
  SELECT COUNT(*),
         string_agg(format('%s(%s)', p.proname, pg_get_function_identity_arguments(p.oid)), ', ')
    INTO v_offender_count, v_offender_names
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.prosecdef = true
     AND (
       p.proconfig IS NULL
       OR NOT EXISTS (
         SELECT 1
           FROM unnest(p.proconfig) AS cfg
          WHERE cfg = 'search_path=public'
             OR cfg LIKE 'search_path=%public%'
       )
     );

  IF v_offender_count > 0 THEN
    RAISE EXCEPTION
      'Migration 049: % SECURITY DEFINER function(s) still lack search_path: %',
      v_offender_count, v_offender_names;
  END IF;
END$$;
