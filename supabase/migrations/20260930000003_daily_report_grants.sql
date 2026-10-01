-- ============================================================================
-- rpc_daily_report: EXECUTE for service_role (and the owner) only
-- ============================================================================
-- WHY. rpc_daily_report() is SECURITY DEFINER (owner postgres, search_path
-- public, auth) and returns the admin recipient emails from auth.users plus
-- sales, incoming, receiving and low-stock data. Every migration that
-- (re)defined it (20260701000001 .. 20260827000008, 20260930000002) meant
-- "service_role only", but each wrote
--     REVOKE ALL ... FROM public; GRANT EXECUTE ... TO service_role;
-- which strips only the `=X` PUBLIC entry. Supabase's default privileges for
-- functions created by postgres in schema public had already granted anon,
-- authenticated and service_role, so the live ACL stayed
--     {postgres=X, anon=X, authenticated=X, service_role=X}
-- and anyone holding the public anon key could POST /rest/v1/rpc/rpc_daily_report
-- (verified 2026-10-01: SET ROLE anon; SELECT rpc_daily_report() returned the
-- full report). 20260930000002 restates that ACL on purpose (its brief was to
-- keep grants); this file is the tightening, sequenced AFTER it so a re-run of
-- 20260930000002 cannot re-grant anon.
--
-- CALLERS. The only caller is supabase/functions/daily-report/index.ts, which
-- uses the service-role key (createClient(..., SUPABASE_SERVICE_ROLE_KEY) then
-- admin.rpc("rpc_daily_report")). src/ references the function only in the
-- generated database.types.ts. Nothing runs it as anon or as a logged-in user.
--
-- Idempotent; applies twice without error. The function body is untouched.
-- ============================================================================

SET LOCAL lock_timeout = '5s';

REVOKE EXECUTE ON FUNCTION public.rpc_daily_report() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.rpc_daily_report() TO service_role;
