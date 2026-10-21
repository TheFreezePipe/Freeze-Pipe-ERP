-- =============================================================
-- verify.sql - the checklist of design 3.1, run by refresh.py
-- =============================================================
-- Every section is ONE read-only query returning ONE row with ONE jsonb
-- column named v. A section marked `both` runs on staging and on production
-- and refresh.py compares the two; `stg` runs on staging only. refresh.py
-- turns the answers into the numbered table in last-report.txt:
--
--   1 Migration history   migrations          (+ file list in supabase/migrations)
--   2 Schema parity       schema_parity       md5 per component, both projects
--   3 RLS and grants      rls_grants          both projects
--   4 Auth trigger        auth_probe.sql      rolled-back throwaway user, staging
--   5 Cron                cron                no job points at production
--   6 Copied data         copied_pks          primary-key sets, same filter
--   7 PII                 pii                 staging only
--   8 Smoke               smoke               rpc_daily_report()
--   9 App                 not automated       log in on staging by hand
--  10 Outbound            outbound_table, outbound_mode
--
-- Nothing here writes. Placeholders (SQL fragments made by refresh.py):
--   {{PROD_REF}}   text literal, the production project ref
--   {{ALLOW_TOP}}  text[] literal, allowed top-level raw_payload keys
--   {{ALLOW_ADV}}  text[] literal, allowed raw_payload.advancedOptions keys
--   {{PK_ROWS}}    UNION ALL of one count + md5(primary-key set) row per
--                  copied table, with the same filters the copy used

-- @@ migrations both
SELECT jsonb_build_object(
         'count', count(*),
         'versions', coalesce(jsonb_agg(m.version ORDER BY m.version), '[]'::jsonb)
       ) AS v
  FROM supabase_migrations.schema_migrations m;

-- @@ schema_parity both
-- Five components decide pass or fail (design: columns, function bodies,
-- policies, triggers, CHECKs). column_order is reported but only warns:
-- production's column positions carry the history of dropped columns.
SELECT jsonb_build_object(
  'columns', (
    SELECT jsonb_build_object('n', count(*),
             'md5', md5(coalesce(string_agg(
                format('%s.%s:%s:%s:%s:%s', c.table_name, c.column_name, c.udt_name, c.is_nullable,
                       coalesce(c.column_default, ''), coalesce(c.generation_expression, '')),
                E'\n' ORDER BY c.table_name, c.column_name), '')))
      FROM information_schema.columns c
     WHERE c.table_schema = 'public'),
  'column_order', (
    SELECT jsonb_build_object('n', count(*),
             'md5', md5(coalesce(string_agg(c.table_name || '.' || c.column_name,
                E'\n' ORDER BY c.table_name, c.ordinal_position), '')))
      FROM information_schema.columns c
     WHERE c.table_schema = 'public'),
  'functions', (
    SELECT jsonb_build_object('n', count(*),
             'md5', md5(coalesce(string_agg(pg_get_functiondef(p.oid),
                E'\n--\n' ORDER BY p.oid::regprocedure::text), '')))
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prokind IN ('f', 'p')
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')),
  'policies', (
    SELECT jsonb_build_object('n', count(*),
             'md5', md5(coalesce(string_agg(
                format('%s.%s|%s|%s|%s|%s|%s', pol.tablename, pol.policyname, pol.permissive,
                       pol.roles::text, pol.cmd, coalesce(pol.qual, ''), coalesce(pol.with_check, '')),
                E'\n' ORDER BY pol.tablename, pol.policyname), '')))
      FROM pg_policies pol
     WHERE pol.schemaname = 'public'),
  'triggers', (
    SELECT jsonb_build_object('n', count(*),
             'md5', md5(coalesce(string_agg(
                format('%s|%s|%s', c.relname, tg.tgenabled, pg_get_triggerdef(tg.oid)),
                E'\n' ORDER BY c.relname, tg.tgname), '')))
      FROM pg_trigger tg
      JOIN pg_class c ON c.oid = tg.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND NOT tg.tgisinternal),
  'checks', (
    SELECT jsonb_build_object('n', count(*),
             'md5', md5(coalesce(string_agg(
                format('%s.%s:%s', con.conrelid::regclass::text, con.conname, pg_get_constraintdef(con.oid)),
                E'\n' ORDER BY con.conrelid::regclass::text, con.conname), '')))
      FROM pg_constraint con
     WHERE con.contype = 'c' AND con.connamespace = 'public'::regnamespace)
) AS v;

-- @@ rls_grants both
-- rls_off and schema_usage decide pass or fail. The two grant digests only
-- warn: they depend on default privileges, which differ between a project
-- that grew over years and one rebuilt from files.
SELECT jsonb_build_object(
  'rls_off', coalesce((
    SELECT jsonb_agg(c.relname ORDER BY c.relname)
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity), '[]'::jsonb),
  'schema_usage', jsonb_build_object(
    'anon', has_schema_privilege('anon', 'public', 'USAGE'),
    'authenticated', has_schema_privilege('authenticated', 'public', 'USAGE'),
    'service_role', has_schema_privilege('service_role', 'public', 'USAGE')),
  'table_grants', (
    SELECT jsonb_build_object('n', count(*),
             'md5', md5(coalesce(string_agg(
                format('%s|%s|%s', c.relname, a.grantee::regrole::text, a.privilege_type),
                E'\n' ORDER BY c.relname, a.grantee::regrole::text, a.privilege_type), '')))
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     CROSS JOIN LATERAL aclexplode(c.relacl) a
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm')
       AND a.grantee::regrole::text IN ('anon', 'authenticated', 'service_role', '-')),
  'function_grants', (
    SELECT jsonb_build_object('n', count(*),
             'md5', md5(coalesce(string_agg(
                format('%s|%s', p.oid::regprocedure::text, a.grantee::regrole::text),
                E'\n' ORDER BY p.oid::regprocedure::text, a.grantee::regrole::text), '')))
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
     WHERE n.nspname = 'public'
       AND p.prokind IN ('f', 'p')
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
       AND a.privilege_type = 'EXECUTE'
       AND a.grantee::regrole::text IN ('anon', 'authenticated', 'service_role', '-'))
) AS v;

-- @@ cron both
-- prod_ref_jobs must be 0 on staging. The same count on production is
-- expected to be large and is shown only for contrast.
SELECT jsonb_build_object(
  'jobs', coalesce((
    SELECT jsonb_agg(jsonb_build_object('name', j.jobname, 'active', j.active) ORDER BY j.jobname)
      FROM cron.job j), '[]'::jsonb),
  'prod_ref_jobs', (SELECT count(*) FROM cron.job j WHERE j.command ILIKE '%' || {{PROD_REF}} || '%')
) AS v;

-- @@ copied_pks both
-- One row per copied table (the TABLES list of scripts/staging/copy_to_staging.py
-- plus suppliers): row count and md5 of the sorted primary keys, under the
-- same filter on both sides (orders from the start date, created before the
-- copy cutoff; order lines of orders not touched since the cutoff).
SELECT coalesce(jsonb_agg(jsonb_build_object('t', s.t, 'n', s.n, 'h', s.h) ORDER BY s.t), '[]'::jsonb) AS v
  FROM (
    {{PK_ROWS}}
  ) s;

-- @@ pii stg
-- Check 7. Every figure must be 0 or empty for the check to pass.
SELECT jsonb_build_object(
  'orders', (SELECT count(*) FROM public.shipstation_orders),
  'non_example_emails', (
    SELECT count(*) FROM public.shipstation_orders o
     WHERE o.customer_email IS NOT NULL AND o.customer_email NOT LIKE '%@example.com'),
  'non_scrubbed_names', (
    SELECT count(*) FROM public.shipstation_orders o
     WHERE o.customer_name IS NOT NULL AND o.customer_name NOT LIKE 'Customer %'),
  'keys_outside_allowlist', coalesce((
    SELECT jsonb_agg(k.key ORDER BY k.key)
      FROM (SELECT DISTINCT jsonb_object_keys(o.raw_payload) AS key
              FROM public.shipstation_orders o
             WHERE jsonb_typeof(o.raw_payload) = 'object') k
     WHERE k.key <> ALL ({{ALLOW_TOP}})), '[]'::jsonb),
  'advanced_keys_outside', coalesce((
    SELECT jsonb_agg(k.key ORDER BY k.key)
      FROM (SELECT DISTINCT jsonb_object_keys(o.raw_payload->'advancedOptions') AS key
              FROM public.shipstation_orders o
             WHERE jsonb_typeof(o.raw_payload->'advancedOptions') = 'object') k
     WHERE k.key <> ALL ({{ALLOW_ADV}})), '[]'::jsonb),
  'at_sign_payloads', (
    SELECT count(*) FROM public.shipstation_orders o WHERE o.raw_payload::text LIKE '%@%'),
  'at_sign_samples', coalesce((
    SELECT jsonb_agg(x.order_number)
      FROM (SELECT o.order_number FROM public.shipstation_orders o
             WHERE o.raw_payload::text LIKE '%@%' ORDER BY o.order_number LIMIT 5) x), '[]'::jsonb)
) AS v;

-- @@ smoke stg
-- Check 8 (part). rpc_daily_report() reads only. rpc_apply_shipstation_sale
-- is not called: it writes, and shipped orders have no ledger rows on staging.
SELECT jsonb_build_object(
         'type', jsonb_typeof(s.r),
         'keys', (SELECT count(*) FROM jsonb_each(CASE WHEN jsonb_typeof(s.r) = 'object' THEN s.r ELSE '{}'::jsonb END))
       ) AS v
  FROM (SELECT public.rpc_daily_report() AS r) s;

-- @@ outbound_table stg
SELECT jsonb_build_object('table', to_regclass('public.wh_settings') IS NOT NULL) AS v;

-- @@ outbound_mode stg
-- Only run when outbound_table says the table exists.
SELECT coalesce((SELECT jsonb_build_object('mode', w.value->>'mode')
                   FROM public.wh_settings w WHERE w.key = 'outbound'),
                jsonb_build_object('mode', NULL)) AS v;
